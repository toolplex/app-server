// ---------------------------------------------------------------------------
// The query database of one app's records.
//
// An in-memory DuckDB database holding the tables a kind declares. Every row
// comes from a record and the records stay the truth. It is built from them
// each time the server starts and follows them from then on, so there is no
// file of its own that could be damaged, go stale after an upgrade, or be
// changed by anything but the records.
//
// Keeping it level with the records:
//
//   - at startup every record that counts is read and written to the tables;
//   - from then on the store names each record it has just stored; the
//     record is read again and its rows replaced;
//   - a record that cannot be read or written is skipped, said in the log,
//     and tried again later. One bad record never stops the rest.
//
// Storing a record never waits for this, and never fails because of it. A
// reader waits for whatever is still being written, so a page asked for the
// moment an approval returns already shows it.
//
// Writes go one at a time on one connection. Each read uses a connection of
// its own and never waits for another read.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBTimestampTZValue,
  DuckDBTypeId,
  StatementType,
  type DuckDBConnection,
  type DuckDBResult,
  type DuckDBValue,
} from "@duckdb/node-api";
import type { ColumnFilter, FetchRequest, Selection } from "../../types.js";
import { UNFIT_TABLE, type RecordColumn, type RecordColumnType, type RecordProjection, type RecordRow, type RecordTable, type RecordsSource } from "./types.js";
import { dayOf, daysOf, held, numberOf } from "./values.js";

/** Records read and written together while building, in one transaction. */
const BATCH = 500;
const READ_WIDTH = 16;
const DELETE_IDS = 200;
/** A page this large is an export: it is read from one view of the data, a piece at a time. */
const EXPORT_FROM = 10_000;
/** An export nobody has asked the next part of for this long is closed. */
const CURSOR_IDLE_MS = 120_000;
const MAX_CURSORS = 8;
/** A record that could not be read or written is tried again after this long. */
const RETRY_MS = 30_000;
/** After a failed start, how long before the next one is attempted. */
const REOPEN_MS = 5_000;
/** Queries someone else wrote that may run at once, and how many may wait behind them. */
const QUERY_SLOTS = 2;
const QUERY_WAITING = 16;
/** After its time limit a query is answered this soon, whether or not it could be stopped. */
const QUERY_GRACE_MS = 1_000;
const MAX_SQL = 20_000;
/** Queries of the client's own that may be read at once; a table answers in milliseconds, one of these can be anything. */
// One, and two for queries someone else wrote: together fewer than the four
// threads Node gives everything that waits on a disk or a database, so slow
// work can never take them all.
const VIEW_SLOTS = 1;
const VIEW_WAITING = 32;
/** How much text one query's result may hold in all (characters), for the assistant. */
const MAX_RESULT_TEXT = 4_000_000;
/**
 * The kinds of value a query's result may carry as they are. Any other kind
 * (a list, a structure, binary data, a bit string) can be of any size and is
 * costly to turn into text here, so it is not built at all: a fixed sentence
 * stands in for it, and a query that wants it casts it to text, where it
 * counts against the result's limit like any text.
 */
const PLAIN_TYPES: ReadonlySet<DuckDBTypeId> = new Set([
  DuckDBTypeId.BOOLEAN,
  DuckDBTypeId.TINYINT,
  DuckDBTypeId.SMALLINT,
  DuckDBTypeId.INTEGER,
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.UTINYINT,
  DuckDBTypeId.USMALLINT,
  DuckDBTypeId.UINTEGER,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
  DuckDBTypeId.FLOAT,
  DuckDBTypeId.DOUBLE,
  DuckDBTypeId.DECIMAL,
  DuckDBTypeId.VARCHAR,
  DuckDBTypeId.ENUM,
  DuckDBTypeId.UUID,
  DuckDBTypeId.DATE,
  DuckDBTypeId.TIME,
  DuckDBTypeId.TIME_TZ,
  DuckDBTypeId.TIMESTAMP,
  DuckDBTypeId.TIMESTAMP_S,
  DuckDBTypeId.TIMESTAMP_MS,
  DuckDBTypeId.TIMESTAMP_NS,
  DuckDBTypeId.TIMESTAMP_TZ,
  DuckDBTypeId.INTERVAL,
  DuckDBTypeId.SQLNULL,
]);
const OTHER_VALUE = "(a list, a structure or binary data; cast it to text in the query to see it)";

/**
 * What a query may read rows from besides the tables: functions that make
 * rows out of what they are given, and ones that describe the tables. Every
 * other table function is refused. Some switch things on and off for the
 * whole database (a different parser, logging of every statement), which a
 * reading transaction does not prevent; some run SQL they are handed as
 * text, where nothing here could look at it; the rest read files.
 */
const TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  "range",
  "generate_series",
  "unnest",
  "repeat",
  "repeat_row",
  "json_each",
  "json_tree",
  "duckdb_tables",
  "duckdb_columns",
  "duckdb_views",
  "duckdb_types",
  "duckdb_keywords",
  "duckdb_functions",
  "pragma_table_info",
]);
/** Functions that do something besides compute, and that do no harm here. Any other such function is refused, whatever a later version of the database adds. */
const HARMLESS_EFFECTS: ReadonlySet<string> = new Set(["random", "setseed", "uuid", "gen_random_uuid", "uuidv4", "uuidv7", "current_query", "current_query_id", "current_connection_id", "current_transaction_id", "error", "stats"]);
/** Refused by name whatever the database says of them: they wait, write, or read the server's surroundings. */
const NEVER_CALLED = ["sleep_ms", "pg_sleep", "write_log", "getenv", "nextval", "currval", "json_serialize_plan", "json_deserialize_sql", "json_execute_serialized_sql"];
/** A statement whose tree is larger than this is refused rather than examined: it is not a question anyone asked. */
const MAX_TREE = 2_000_000;
/** The most columns a query's result may have. */
const MAX_COLUMNS = 300;
const GAVE_UP = Symbol("gave up");
const MAX_TEXT = 2_000;
const MAX_SELECTED = 1_000;
/** How long a page may take to read before it is stopped (a client's own query can be slow). */
const READ_TIMEOUT_MS = 30_000;
/** How long a reader waits for the tables to be built before it is told they are still being built. */
const BUILD_WAIT_MS = 20_000;
/** How much of a value that did not fit its column is kept for showing. */
const UNFIT_TEXT = 500;

const SQL_TYPE: Record<RecordColumnType, string> = {
  text: "VARCHAR",
  number: "DOUBLE",
  integer: "BIGINT",
  boolean: "BOOLEAN",
  // A moment, not a wall-clock reading: what day it falls on is decided by
  // the zone the database is set to, never by where the server happens to be.
  timestamp: "TIMESTAMP WITH TIME ZONE",
  date: "DATE",
};
const MOMENT = "TIMESTAMP WITH TIME ZONE";

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;
const likeText = (s: string): string => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/** A table or view a page, the assistant or a query can read. */
export interface Relation {
  name: string;
  label: string;
  /** One row per record, one per line of a record, or whatever a client's own query returns. */
  grain: "record" | "line" | "query";
  /** The column that identifies a row. A client's own query has none it can promise. */
  key: string | null;
  columns: RecordColumn[];
  /** The columns rows fall back to when what a page sorts by ties. */
  order: string[];
  defaultSort?: { column: string; direction: "asc" | "desc" };
  /** The tables whose values it shows, when that is known (it is not for a client's own query). */
  shows?: string[];
}

/** The columns of the table of values that did not fit (see UNFIT_TABLE). */
const UNFIT_RELATION: Relation = {
  name: UNFIT_TABLE,
  label: "values typed into a number or date column that are not one: left empty in their column, so out of every total, and listed here as written",
  grain: "query",
  key: null,
  columns: [
    { name: "record_id", type: "text", label: "Record", system: true },
    { name: "table_name", type: "text", label: "Table", system: true },
    { name: "column_name", type: "text", label: "Column", system: true },
    { name: "line_no", type: "integer", label: "Line number", system: true },
    { name: "value", type: "text", label: "As written" },
  ],
  order: ["record_id", "table_name", "line_no", "column_name"],
};

/** The name of the view that shows each line of `lineTable` with its record's columns. */
export const withRecord = (lineTable: string): string => `${lineTable}_with_record`;

/**
 * Every table, plus for each line table the view that shows its lines with
 * their record's columns. A pure function of the tables, so what a page may
 * ask for can be checked at startup, before any database exists.
 */
export function relationsOf(tables: RecordTable[]): Map<string, Relation> {
  const out = new Map<string, Relation>();
  for (const t of tables) {
    const order = t.order ?? [t.key];
    out.set(t.name, { name: t.name, label: t.label, grain: t.grain, key: t.key, columns: t.columns, order, defaultSort: t.defaultSort, shows: [t.name] });
    const parent = t.parent ? tables.find((p) => p.name === t.parent) : undefined;
    if (!parent) continue;
    // The record's id is on both sides; it is kept once.
    const own = new Set(t.columns.map((c) => c.name));
    out.set(withRecord(t.name), {
      name: withRecord(t.name),
      label: `${t.label}, each with its record's values`,
      grain: "line",
      key: t.key,
      columns: [...t.columns, ...parent.columns.filter((c) => !own.has(c.name))],
      order,
      // Lines follow their record: the newest record's lines first, in the order they were written.
      defaultSort: t.defaultSort ?? parent.defaultSort,
      shows: [t.name, parent.name],
    });
  }
  return out;
}

export class RecordsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RecordsDatabaseOptions {
  /** A directory this database may use for what does not fit in memory. Nothing in it outlives the process. */
  dir: string;
  /** The zone days and months are counted in (an IANA name such as "Asia/Singapore"). */
  timezone: string;
  /** The client's own queries, kept as views: name → one SELECT statement. */
  views?: Record<string, { sql: string; label: string }>;
  /**
   * Resolves once the records themselves can be listed. Nothing is built
   * before it: a store that is still loading would look like an empty one.
   */
  after?: Promise<void>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** How long before a record that could not be read or written is tried again. Default 30 s. */
  retryMs?: number;
  /** How long after a failed start before the next is attempted. Default 5 s. */
  reopenMs?: number;
  /** How long a page may take to read before it is stopped. Default 30 s. */
  readTimeoutMs?: number;
  /** How long a reader waits for the tables to be built before being told they still are. Default 20 s. */
  buildWaitMs?: number;
}

interface OpenCursor {
  conn: DuckDBConnection;
  result: DuckDBResult;
  rel: Relation;
  names: string[];
  pending: RecordRow[];
  done: boolean;
  touched: number;
  busy: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** More rows matched than were returned. */
  truncated: boolean;
}

export class RecordsDatabase {
  private inst: DuckDBInstance | null = null;
  private writer: DuckDBConnection | null = null;
  private relations: Map<string, Relation>;
  private laid: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private openFailed: { at: number; error: unknown } | null = null;
  private built = false;
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  /** What is in the tables: record id → the signature its rows were written under. */
  private known = new Map<string, string>();
  /** Records stored since their rows were last written. */
  private dirty = new Set<string>();
  private draining: Promise<void> | null = null;
  /** Records whose rows could not be brought up to date, and when that was last tried. */
  private failed = new Map<string, { at: number; message: string }>();
  /** While building: values that did not fit their column, by "table.column". */
  private misses: Map<string, number> | null = null;
  private unplaced: Map<string, number> | null = null;
  /** How far the build has got, for whoever is told to come back. */
  private progress = { done: 0, total: 0 };
  private cursors = new Map<string, OpenCursor>();
  private sweeper: NodeJS.Timeout | null = null;
  private running = new Set<DuckDBConnection>();
  /** Statements that were given up on and have not stopped yet. */
  private stuck = new Set<Promise<unknown>>();
  private readonly slots = new Slots(QUERY_SLOTS, QUERY_WAITING);
  private readonly viewSlots = new Slots(VIEW_SLOTS, VIEW_WAITING);
  /** Functions a query may not call (see NEVER_CALLED); filled in from the database's own list when it is laid out. */
  private refused = new Set<string>(NEVER_CALLED);
  /** Connections being opened right now. The database is not closed under one. */
  private connecting = 0;
  private readonly spill: string;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private readonly after: Promise<void>;

  constructor(
    private readonly source: RecordsSource,
    private readonly options: RecordsDatabaseOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.after = options.after ?? Promise.resolve();
    if (source.tables.some((t) => t.name === UNFIT_TABLE)) throw new Error(`"${UNFIT_TABLE}" is a table every app's records have; a kind cannot have one of its own`);
    this.relations = this.kindRelations();
    this.spill = join(options.dir, ".records-tmp", `${process.pid}-${randomUUID()}`);
  }

  /** The kind's tables and views, and the table of values that did not fit. */
  private kindRelations(): Map<string, Relation> {
    return relationsOf(this.source.tables).set(UNFIT_TABLE, UNFIT_RELATION);
  }

  /** How things stand, for whoever watches over the server and for tests. */
  status(): { built: boolean; records: number; failed: number; queryTurns: { free: number; waiting: number }; viewTurns: { free: number; waiting: number }; stuck: number } {
    return { built: this.built, records: this.known.size, failed: this.failed.size, queryTurns: this.slots.state(), viewTurns: this.viewSlots.state(), stuck: this.stuck.size };
  }

  /** Every table and view, for the assistant and for checks at startup. */
  listRelations(): Relation[] {
    return [...this.relations.values()];
  }

  relation(name: string): Relation | undefined {
    return this.relations.get(name);
  }

  get timezone(): string {
    return this.options.timezone;
  }

  // ── Laying out ───────────────────────────────────────────────────────────

  /**
   * Create the database with its tables and views, empty. Quick, and it
   * fails with a plain reason when the zone or one of the client's own
   * queries is wrong, so a server with such a mistake does not start.
   */
  prepare(): Promise<void> {
    if (!this.laid) {
      const run = this.lay();
      this.laid = run;
      run.catch(() => {
        if (this.laid === run) this.laid = null;
        this.teardown();
      });
    }
    return this.laid;
  }

  private async lay(): Promise<void> {
    await mkdir(join(this.options.dir, ".records-tmp"), { recursive: true });
    await this.clearSpill();
    this.inst = await DuckDBInstance.create(":memory:", {
      memory_limit: "512MB",
      threads: "2",
      temp_directory: this.spill,
      max_temp_directory_size: "2GB",
    });
    const conn = (this.writer = await this.inst.connect());
    try {
      await conn.run(`SET GLOBAL TimeZone = ${quote(this.options.timezone)}`);
    } catch {
      throw new Error(`"${this.options.timezone}" is not a time zone this server knows; use a name such as "Asia/Singapore"`);
    }
    // From here on the database cannot open, read or write any file, whatever
    // SQL it is handed, and nothing can turn that back on.
    await conn.run("SET GLOBAL enable_external_access = false");
    for (const t of this.source.tables) {
      await conn.run(`CREATE TABLE ${ident(t.name)} (${t.columns.map((c) => `${ident(c.name)} ${SQL_TYPE[c.type]}`).join(", ")})`);
    }
    for (const t of this.source.tables) {
      const view = t.parent ? this.relations.get(withRecord(t.name)) : undefined;
      if (!t.parent || !view) continue;
      const own = new Set(t.columns.map((c) => c.name));
      const cols = view.columns.map((c) => `${own.has(c.name) ? "l" : "r"}.${ident(c.name)}`).join(", ");
      await conn.run(`CREATE VIEW ${ident(view.name)} AS SELECT ${cols} FROM ${ident(t.name)} l JOIN ${ident(t.parent)} r ON l.record_id = r.record_id`);
    }
    // Functions that only wait cannot be stopped once begun, and one would
    // hold a turn for as long as it was told to. A function of our own by the
    // same name stands in front of each, however the call is written.
    for (const waits of ["pg_sleep", "sleep_ms"]) await conn.run(`CREATE MACRO ${waits}(x) AS error('Functions that wait are not available here.')`);
    // Every function the database itself says does more than compute is
    // refused to a query, save the few known to do no harm.
    const effects = (await conn.runAndReadAll("SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type = 'scalar' AND has_side_effects")).getRowObjects();
    this.refused = new Set([...NEVER_CALLED, ...effects.map((row) => String(row.function_name).toLowerCase()).filter((name) => !HARMLESS_EFFECTS.has(name))]);
    // And every shorthand the database has for one of those (pg_sleep is
    // sleep_ms under another name): a shorthand is refused when what it
    // stands for names a refused function.
    const shorthands = (await conn.runAndReadAll("SELECT DISTINCT function_name, macro_definition FROM duckdb_functions() WHERE function_type IN ('macro', 'table_macro') AND macro_definition IS NOT NULL")).getRowObjects();
    for (const row of shorthands) {
      const stands = String(row.macro_definition).toLowerCase();
      if ([...this.refused].some((name) => new RegExp(`(^|[^a-z0-9_])${name}\\s*\\(`).test(stands))) this.refused.add(String(row.function_name).toLowerCase());
    }
    await conn.run(`CREATE TABLE ${ident(UNFIT_TABLE)} (${UNFIT_RELATION.columns.map((c) => `${ident(c.name)} ${SQL_TYPE[c.type]}`).join(", ")})`);
    // The client's own queries, each kept as a view. One may read another,
    // in whatever order they were declared: those that cannot be made yet
    // are tried again after the rest, until a round makes none.
    let pending = Object.entries(this.options.views ?? {});
    for (const [name] of pending) {
      if (this.relations.has(name)) throw new Error(`"${name}" is already the name of one of the app's tables; name the resource something else`);
    }
    while (pending.length > 0) {
      const later: typeof pending = [];
      let firstError: Error | null = null;
      for (const [name, view] of pending) {
        try {
          this.relations.set(name, await this.makeView(conn, name, view));
        } catch (err) {
          firstError ??= new Error(`the query of "${name}" cannot be used: ${firstLine(err)}`);
          later.push([name, view]);
        }
      }
      if (later.length === pending.length) throw firstError!;
      pending = later;
    }
    // The lock last: nothing after it is accepted, and nothing a query says can undo it.
    await conn.run("SET GLOBAL lock_configuration = true");
  }

  /**
   * One of the client's queries as a view. Whatever types its columns come
   * out as, the view gives them as one of the six a record column can be
   * (anything else as text), so sorting, filtering, paging and an alert's
   * snapshot treat it exactly like a table.
   */
  private async makeView(conn: DuckDBConnection, name: string, view: { sql: string; label: string }): Promise<Relation> {
    const sql = view.sql.trim().replace(/;\s*$/, "");
    const extracted = await conn.extractStatements(sql);
    if (extracted.count !== 1) throw new Error("it must be a single SELECT statement");
    if ((await extracted.prepare(0)).statementType !== StatementType.SELECT) throw new Error("it must be a SELECT statement");
    // On lines of its own: the query may end in a comment, which must not swallow what follows it here.
    const described = (await conn.runAndReadAll(`SELECT column_name, column_type FROM (DESCRIBE\n${sql}\n)`)).getRowObjects();
    const columns: RecordColumn[] = described.map((row) => ({ name: String(row.column_name), type: typeOfSql(String(row.column_type)), label: String(row.column_name) }));
    if (columns.length === 0) throw new Error("it returns no columns");
    // The database does not tell names apart by case; nor may two columns here.
    if (new Set(columns.map((c) => c.name.toLowerCase())).size !== columns.length) throw new Error("two of its columns have the same name (names that differ only in upper and lower case are the same); give each its own with AS");
    if (columns.some((c) => c.name.trim() === "")) throw new Error("one of its columns has no name; give it one with AS");
    const cast = (c: RecordColumn, from: string): string => {
      const col = `q.${ident(c.name)}`;
      // A reading with no zone is a wall-clock time in the organization's zone.
      if (c.type === "timestamp" && from !== MOMENT) return `CAST(CAST(${col} AS TIMESTAMP) AS ${MOMENT})`;
      return from === SQL_TYPE[c.type] ? col : `CAST(${col} AS ${SQL_TYPE[c.type]})`;
    };
    const cols = columns.map((c, i) => `${cast(c, String(described[i].column_type).toUpperCase())} AS ${ident(c.name)}`).join(", ");
    await conn.run(`CREATE VIEW ${ident(name)} AS SELECT ${cols} FROM (\n${sql}\n) AS q`);
    return { name, label: view.label, grain: "query", key: null, columns, order: columns.map((c) => c.name) };
  }

  /** Spill directories left by processes that are gone. */
  private async clearSpill(): Promise<void> {
    const parent = join(this.options.dir, ".records-tmp");
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      const pid = Number(name.split("-")[0]);
      let alive = false;
      try {
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          alive = pid !== process.pid;
        }
      } catch (err) {
        // EPERM: it exists and is someone else's. Anything else: it is gone.
        alive = (err as NodeJS.ErrnoException).code === "EPERM";
      }
      if (!alive) await rm(join(parent, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  private teardown(): void {
    for (const c of this.cursors.values()) this.release(c);
    this.cursors.clear();
    try {
      this.writer?.disconnectSync();
    } catch {
      /* already gone */
    }
    try {
      this.inst?.closeSync();
    } catch {
      /* already gone */
    }
    this.writer = null;
    this.inst = null;
    this.laid = null;
    this.built = false;
    this.known.clear();
    // The views a client declared are found again when the tables are laid out.
    this.relations = this.kindRelations();
  }

  // ── Building ─────────────────────────────────────────────────────────────

  /**
   * Lay the tables out and fill them from the records. Safe to call any
   * number of times; a start that failed is tried again on a later call.
   */
  open(): Promise<void> {
    if (this.closed) return Promise.reject(new RecordsError(503, "The server is shutting down."));
    if (this.opening) return this.opening;
    if (this.openFailed && Date.now() - this.openFailed.at < (this.options.reopenMs ?? REOPEN_MS)) return Promise.reject(this.openFailed.error);
    const run = this.start();
    this.opening = run;
    run.catch((error: unknown) => {
      if (this.opening === run) this.opening = null;
      this.openFailed = { at: Date.now(), error };
      this.teardown();
    });
    return run;
  }

  private async start(): Promise<void> {
    await this.after;
    await this.prepare();
    await this.build();
    this.built = true;
    this.openFailed = null;
    this.schedule();
  }

  private async build(): Promise<void> {
    const expected = this.source.expected();
    const started = Date.now();
    this.misses = new Map();
    this.unplaced = new Map();
    this.progress = { done: 0, total: expected.length };
    let written = 0;
    for (let at = 0; at < expected.length && !this.closed; at += BATCH) {
      const projections = (await this.projectAll(expected.slice(at, at + BATCH).map((e) => e.id))).filter((p) => p.signature !== "");
      await this.enqueue(() => this.apply(projections));
      written += projections.length;
      this.progress.done = Math.min(expected.length, at + BATCH);
    }
    if (this.closed) return;
    this.log("info", `records tables built: ${written} record${written === 1 ? "" : "s"} in ${Date.now() - started} ms; days are counted in ${this.options.timezone}`);
    for (const [where, n] of top(this.misses)) {
      this.log("warn", `${n} value${n === 1 ? "" : "s"} in ${where} ${n === 1 ? "does" : "do"} not fit the column and ${n === 1 ? "is" : "are"} left empty in the tables (the records still hold ${n === 1 ? "it" : "them"} as written)`);
    }
    for (const [what, n] of top(this.unplaced)) {
      this.log("warn", `${n} record${n === 1 ? "" : "s"} hold${n === 1 ? "s" : ""} ${what}, which the app's configuration no longer has, so no table shows it. If it was renamed, say what it was called (was: [...]).`);
    }
    if (this.failed.size > 0) this.log("error", `${this.failed.size} record${this.failed.size === 1 ? "" : "s"} could not be put in the tables; see the lines above. They are tried again as the tables are read.`);
    this.misses = null;
    this.unplaced = null;
  }

  /** Each record's contribution, read from the record. One that cannot be read is noted and left out. */
  private async projectAll(ids: string[]): Promise<RecordProjection[]> {
    const out: RecordProjection[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(READ_WIDTH, ids.length) }, async () => {
        while (next < ids.length) {
          const id = ids[next++];
          try {
            if (this.source.signature(id) === "") {
              out.push({ id, signature: "", rows: {} });
              continue;
            }
            const p = await this.source.project(id);
            out.push(p ?? { id, signature: "", rows: {} });
            if (p && this.unplaced) for (const what of p.unplaced ?? []) this.unplaced.set(what, (this.unplaced.get(what) ?? 0) + 1);
          } catch (err) {
            this.fail(id, `could not be read (${firstLine(err)})`);
          }
        }
      }),
    );
    return out;
  }

  private fail(id: string, message: string): void {
    const before = this.failed.get(id);
    this.failed.set(id, { at: Date.now(), message });
    // Said once per reason, not on every retry.
    if (before?.message !== message) this.log("error", `record ${id} ${message}; its rows in the tables are as they last were`);
  }

  // ── Following the records ────────────────────────────────────────────────

  /** A record was stored. Its rows are brought up to date in the background. */
  touch(id: string): void {
    if (this.closed) return;
    this.dirty.add(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.draining || !this.built || this.closed || this.dirty.size === 0) return;
    const run = this.drain()
      .catch((err: unknown) => this.log("error", `records tables could not be updated: ${firstLine(err)}`))
      .finally(() => {
        this.draining = null;
        this.schedule();
      });
    this.draining = run;
  }

  private async drain(): Promise<void> {
    const ids = [...this.dirty];
    this.dirty.clear();
    // Most changes to a record (an answer, a note) do not change what it contributes.
    const todo = ids.filter((id) => this.source.signature(id) !== (this.known.get(id) ?? ""));
    for (let at = 0; at < todo.length; at += BATCH) {
      const projections = await this.projectAll(todo.slice(at, at + BATCH));
      await this.enqueue(() => this.apply(projections.filter((p) => p.signature !== (this.known.get(p.id) ?? ""))));
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.catch(() => {}).then(work);
    this.writes = run;
    return run;
  }

  /** Write these together; if that fails, one at a time, so one record's trouble stays its own. */
  private async apply(projections: RecordProjection[]): Promise<void> {
    if (projections.length === 0 || this.closed || !this.writer) return;
    try {
      await this.writeBatch(projections);
    } catch (err) {
      if (projections.length === 1) {
        this.fail(projections[0].id, `could not be written to the tables (${firstLine(err)})`);
        return;
      }
      for (const p of projections) {
        try {
          await this.writeBatch([p]);
        } catch (one) {
          this.fail(p.id, `could not be written to the tables (${firstLine(one)})`);
        }
      }
    }
  }

  /** One transaction: these records' old rows out, their new rows in. All of it or none. */
  private async writeBatch(projections: RecordProjection[]): Promise<void> {
    const conn = this.writer!;
    await conn.run("BEGIN TRANSACTION");
    try {
      // By table, not by record: building writes tens of thousands of records.
      const replaced = projections.filter((p) => this.known.has(p.id)).map((p) => p.id);
      for (let i = 0; i < replaced.length; i += DELETE_IDS) {
        const ids = replaced.slice(i, i + DELETE_IDS);
        const marks = ids.map(() => "?").join(", ");
        for (const t of this.source.tables) await conn.run(`DELETE FROM ${ident(t.name)} WHERE record_id IN (${marks})`, ids);
        await conn.run(`DELETE FROM ${ident(UNFIT_TABLE)} WHERE record_id IN (${marks})`, ids);
      }
      const kept = projections.filter((p) => p.signature !== "");
      const unfit: Unfit[] = [];
      for (const t of this.source.tables) {
        const rows: RecordRow[] = [];
        for (const p of kept) for (const row of p.rows[t.name] ?? []) rows.push(row);
        await this.insert(conn, t, rows, unfit);
      }
      if (unfit.length > 0) {
        const appender = await conn.createAppender(UNFIT_TABLE);
        try {
          for (const u of unfit) {
            appender.appendVarchar(u.record);
            appender.appendVarchar(u.table);
            appender.appendVarchar(u.column);
            if (u.line === null) appender.appendNull();
            else appender.appendBigInt(BigInt(u.line));
            appender.appendVarchar(u.value);
            appender.endRow();
          }
          appender.flushSync();
        } finally {
          appender.closeSync();
        }
      }
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK").catch(() => {});
      throw err;
    }
    for (const p of projections) {
      if (p.signature === "") this.known.delete(p.id);
      else this.known.set(p.id, p.signature);
      this.failed.delete(p.id);
    }
  }

  /**
   * Rows into a table, inside the transaction the connection has open. The
   * appender takes values as they are, with no statement to build and bind:
   * fifty thousand records' rows take a few seconds this way.
   */
  private async insert(conn: DuckDBConnection, table: RecordTable, rows: RecordRow[], unfit: Unfit[]): Promise<void> {
    if (rows.length === 0) return;
    const appender = await conn.createAppender(table.name);
    try {
      for (const row of rows) {
        for (const c of table.columns) {
          const { value, fits } = held(c, row[c.name]);
          if (!fits) {
            // Left empty in its column, and kept where it can be seen and counted.
            const line = typeof row.line_no === "number" && Number.isSafeInteger(row.line_no) ? row.line_no : null;
            unfit.push({ record: String(row.record_id ?? ""), table: table.name, column: c.name, line, value: cut(String(row[c.name]), UNFIT_TEXT) });
            if (this.misses) this.misses.set(`${table.name}.${c.name}`, (this.misses.get(`${table.name}.${c.name}`) ?? 0) + 1);
          }
          if (value === null) appender.appendNull();
          else if (c.type === "number") appender.appendDouble(value as number);
          else if (c.type === "integer") appender.appendBigInt(BigInt(value as number));
          else if (c.type === "boolean") appender.appendBoolean(value as boolean);
          else if (c.type === "timestamp") appender.appendTimestampTZ(new DuckDBTimestampTZValue(BigInt(Date.parse(value as string)) * 1000n));
          else if (c.type === "date") appender.appendDate(new DuckDBDateValue(daysOf(value as string)));
          else appender.appendVarchar(value as string);
        }
        appender.endRow();
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Resolves once the tables hold everything stored so far. */
  private async level(): Promise<void> {
    try {
      const opening = this.open();
      if (!this.built) {
        // With years of records the first build takes a while. A reader waits
        // a reasonable time and is then told how far it has got, instead of
        // holding a connection open for however long it takes.
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([
          opening.then(() => "built" as const),
          new Promise<"building">((resolve) => {
            timer = setTimeout(() => resolve("building"), this.options.buildWaitMs ?? BUILD_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (waited === "building") {
          opening.catch(() => {});
          const { done, total } = this.progress;
          throw new RecordsError(503, `This app's records are still being put into tables${total > 0 ? ` (${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")})` : ""}. Try again in a moment.`);
        }
      } else await opening;
    } catch (err) {
      if (err instanceof RecordsError) throw err;
      throw new RecordsError(503, "This app's records are not available right now. Check the server log.");
    }
    if (this.closed || !this.inst) throw new RecordsError(503, "The server is shutting down.");
    const now = Date.now();
    for (const [id, f] of this.failed) {
      if (now - f.at < (this.options.retryMs ?? RETRY_MS)) continue;
      f.at = now;
      this.dirty.add(id);
    }
    this.schedule();
    // What was stored is what is read. Bounded: under a steady stream of
    // approvals a reader must still get an answer.
    for (let i = 0; i < 4 && this.draining; i++) await this.draining;
  }

  /**
   * One read of the tables, on a connection of its own and in one view of
   * the data: a count and the rows it counted cannot disagree because
   * something was approved between them. A read of a client's own query
   * takes one of a few turns, since such a query can take as long as it
   * likes and the tables must stay answerable beside it.
   */
  private async reader<T>(rel: Relation | null, work: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    await this.level();
    const ms = this.options.readTimeoutMs ?? READ_TIMEOUT_MS;
    const release = rel ? await this.viewTurn(rel) : (): void => {};
    let conn: DuckDBConnection;
    try {
      conn = await this.connect();
    } catch (err) {
      release();
      throw err;
    }
    const reading = conn;
    const task = (async (): Promise<T> => {
      await reading.run("BEGIN TRANSACTION READ ONLY");
      try {
        return await work(reading);
      } catch (err) {
        throw this.unreadable(rel, err);
      }
    })();
    return this.within(
      reading,
      ms,
      task,
      async () => {
        await reading.run("ROLLBACK").catch(() => {});
        try {
          reading.disconnectSync();
        } catch {
          /* already gone */
        }
        release();
      },
      () => new RecordsError(503, `Reading this took longer than ${ms / 1000} seconds and was stopped. If it reads a query of your own, that query needs to do less.`),
    );
  }

  /**
   * The result of a statement, or a plain refusal at its time limit.
   *
   * At the limit the statement is told to stop, and told again until it
   * has. Some work cannot be stopped (one enormous calculation), so the
   * caller is answered a moment after the limit either way; what the
   * statement holds (its connection, its turn) is given back only when it
   * really has ended, so work that cannot be stopped can never pile up
   * beyond the few turns there are.
   */
  private async within<T>(conn: DuckDBConnection, ms: number, task: Promise<T>, tidy: () => Promise<void>, tooLong: () => RecordsError): Promise<T> {
    this.running.add(conn);
    let late = false;
    let nag: NodeJS.Timeout | undefined;
    const stop = (): void => {
      try {
        conn.interrupt();
      } catch {
        /* nothing running */
      }
    };
    const timer = setTimeout(() => {
      late = true;
      stop();
      nag = setInterval(stop, 100);
    }, ms);
    const done = async (): Promise<void> => {
      clearTimeout(timer);
      clearInterval(nag);
      this.running.delete(conn);
      await tidy();
    };
    let moment: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<typeof GAVE_UP>((resolve) => {
      moment = setTimeout(() => resolve(GAVE_UP), ms + QUERY_GRACE_MS);
    });
    let outcome: T | typeof GAVE_UP;
    try {
      outcome = await Promise.race([task, gaveUp]);
    } catch (err) {
      clearTimeout(moment);
      await done();
      if (late) throw tooLong();
      if (this.closed) throw new RecordsError(503, "The server is shutting down.");
      throw err;
    }
    clearTimeout(moment);
    if (outcome === GAVE_UP) {
      const settling = task.then(
        () => {},
        () => {},
      );
      this.stuck.add(settling);
      this.log("error", `a statement could not be stopped at its ${ms / 1000} second limit and is still working; its turn is held until it ends`);
      void settling.then(async () => {
        this.stuck.delete(settling);
        await done();
      });
      throw tooLong();
    }
    await done();
    return outcome;
  }

  /** For an export, whose connection outlives the call: the wait is bounded by telling the statement to stop. */
  private async bounded<T>(conn: DuckDBConnection, work: Promise<T>): Promise<T> {
    const ms = this.options.readTimeoutMs ?? READ_TIMEOUT_MS;
    let late = false;
    let nag: NodeJS.Timeout | undefined;
    const stop = (): void => {
      try {
        conn.interrupt();
      } catch {
        /* nothing running */
      }
    };
    this.running.add(conn);
    const timer = setTimeout(() => {
      late = true;
      stop();
      nag = setInterval(stop, 100);
    }, ms);
    try {
      return await work;
    } catch (err) {
      if (late) throw new RecordsError(503, `Reading this took longer than ${ms / 1000} seconds and was stopped. If it reads a query of your own, that query needs to do less.`);
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(nag);
      this.running.delete(conn);
    }
  }

  /** A connection for one read. Counted while it is being opened: the database is never closed under it. */
  private async connect(): Promise<DuckDBConnection> {
    if (this.closed || !this.inst) throw new RecordsError(503, "The server is shutting down.");
    this.connecting++;
    try {
      const conn = await this.inst.connect();
      if (this.closed) {
        try {
          conn.disconnectSync();
        } catch {
          /* already gone */
        }
        throw new RecordsError(503, "The server is shutting down.");
      }
      return conn;
    } finally {
      this.connecting--;
    }
  }

  /** A turn at reading a client's own query, for the length of one call; nothing for a table. */
  private async viewTurn(rel: Relation): Promise<() => void> {
    return rel.grain === "query" && rel.name !== UNFIT_TABLE ? this.viewSlots.acquire(this.options.readTimeoutMs ?? READ_TIMEOUT_MS) : (): void => {};
  }

  /** Whatever went wrong reading, said plainly: a table does not fail to read, a client's own query can. */
  private unreadable(rel: Relation | null, err: unknown): RecordsError {
    return err instanceof RecordsError ? err : new RecordsError(500, `"${rel?.name ?? "the tables"}" could not be read: ${firstLine(err)}`);
  }

  private named(name: string): Relation {
    const rel = this.relations.get(name);
    if (!rel) throw new RecordsError(404, `No table "${name}"`);
    return rel;
  }

  /**
   * One page of a table or view, as a page's data source asks for it: the
   * page's own filters, the table's column filters and its sort, all applied
   * by the database over every row before the page is cut.
   *
   * A very large page is an export (a download, an alert's snapshot). It is
   * answered from one view of the data and continued with `cursor`, so rows
   * approved or withdrawn while it runs are neither repeated nor skipped.
   */
  async page(name: string, req: FetchRequest): Promise<{ rows: RecordRow[]; total: number; nextCursor?: string | null }> {
    if (req.cursor) return this.continue(req.cursor, req.pageSize);
    await this.level();
    const rel = this.named(name);
    const { where, values } = conditions(rel, req.filters, req.columnFilters, req.selection);
    const limit = Math.max(1, Math.floor(req.pageSize));
    const from = `FROM ${ident(rel.name)} ${where}`;
    const counted = `SELECT count(*) AS n ${from}`;
    const listed = `SELECT ${rel.columns.map(selected).join(", ")} ${from} ${order(rel, req.sort)}`;
    if (limit >= EXPORT_FROM) return this.export(rel, counted, listed, values, limit, !!req.skipTotal);
    return this.reader(rel, async (conn) => {
      const total = req.skipTotal ? 0 : Number((await conn.runAndReadAll(counted, values)).getRowObjects()[0]?.n ?? 0);
      const offset = Math.max(0, (Math.floor(req.page) - 1) * limit);
      const raw = (await conn.runAndReadAll(`${listed} LIMIT ${limit} OFFSET ${offset}`, values)).getRowObjects();
      return { rows: raw.map((row) => served(rel, row)), total };
    });
  }

  private async export(rel: Relation, counted: string, listed: string, values: DuckDBValue[], limit: number, skipTotal: boolean): Promise<{ rows: RecordRow[]; total: number; nextCursor: string | null }> {
    await this.level();
    const turn = await this.viewTurn(rel);
    let conn: DuckDBConnection;
    try {
      conn = await this.connect();
    } catch (err) {
      turn();
      throw err;
    }
    const cursor: OpenCursor = { conn, result: null as unknown as DuckDBResult, rel, names: rel.columns.map((c) => c.name), pending: [], done: false, touched: Date.now(), busy: true };
    try {
      await conn.run("BEGIN TRANSACTION READ ONLY");
      const total = skipTotal ? 0 : Number((await this.bounded(conn, conn.runAndReadAll(counted, values))).getRowObjects()[0]?.n ?? 0);
      cursor.result = await this.bounded(conn, conn.stream(listed, values));
      const rows = await this.bounded(conn, this.take(cursor, limit));
      if (cursor.done) {
        this.release(cursor);
        return { rows, total, nextCursor: null };
      }
      while (this.cursors.size >= MAX_CURSORS) {
        const [oldest] = [...this.cursors].sort((a, b) => a[1].touched - b[1].touched);
        this.release(oldest[1]);
        this.cursors.delete(oldest[0]);
      }
      const token = randomUUID();
      cursor.busy = false;
      this.cursors.set(token, cursor);
      this.sweeper ??= setInterval(() => this.sweep(), 15_000).unref();
      return { rows, total, nextCursor: token };
    } catch (err) {
      this.release(cursor);
      throw this.unreadable(rel, err);
    } finally {
      turn();
    }
  }

  private async continue(token: string, pageSize: number): Promise<{ rows: RecordRow[]; total: number; nextCursor: string | null }> {
    const cursor = this.cursors.get(token);
    if (!cursor || cursor.busy) throw new RecordsError(410, "This export was closed because too long passed between its parts. Start it again.");
    cursor.busy = true;
    let turn: () => void = () => {};
    try {
      turn = await this.viewTurn(cursor.rel);
      const rows = await this.bounded(cursor.conn, this.take(cursor, Math.max(1, Math.floor(pageSize))));
      cursor.touched = Date.now();
      if (cursor.done) {
        this.release(cursor);
        this.cursors.delete(token);
        return { rows, total: 0, nextCursor: null };
      }
      return { rows, total: 0, nextCursor: token };
    } catch (err) {
      this.release(cursor);
      this.cursors.delete(token);
      throw this.unreadable(cursor.rel, err);
    } finally {
      cursor.busy = false;
      turn();
    }
  }

  /** Up to `n` rows from an export, read a piece at a time so nothing else waits on it. */
  private async take(cursor: OpenCursor, n: number): Promise<RecordRow[]> {
    const rows: RecordRow[] = [];
    for (;;) {
      if (cursor.pending.length === 0 && !cursor.done) {
        const chunk = await cursor.result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) cursor.done = true;
        else cursor.pending = chunk.getRowObjects(cursor.names).map((row) => served(cursor.rel, row));
      }
      if (cursor.done || rows.length >= n) break;
      const part = cursor.pending.splice(0, n - rows.length);
      for (const row of part) rows.push(row);
    }
    return rows;
  }

  private release(cursor: OpenCursor): void {
    cursor.done = true;
    try {
      cursor.conn.disconnectSync();
    } catch {
      /* already gone */
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, cursor] of this.cursors) {
      if (cursor.busy || now - cursor.touched < CURSOR_IDLE_MS) continue;
      this.release(cursor);
      this.cursors.delete(token);
    }
    if (this.cursors.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /**
   * How many rows a table or view has under these filters; how many of them
   * are still being corrected; and how many records hold a value that did
   * not fit its column, and so is missing from any total over it. For a
   * table that is counted among the records the rows are of, in the tables
   * it shows. A client's own query can add up anything, so for one of those
   * it is every such record the app has (`unfitAnywhere`).
   */
  async count(name: string, filters?: Record<string, string>, columnFilters?: ColumnFilter[], selection?: Selection): Promise<{ rows: number; correcting: number; unfit: number; unfitAnywhere: boolean }> {
    await this.level();
    const rel = this.named(name);
    const { where, values } = conditions(rel, filters, columnFilters, selection);
    const flagged = rel.columns.some((c) => c.name === "record_correcting" && c.type === "boolean");
    const unfitTable = ident(UNFIT_TABLE);
    const ofRecords = rel.name !== UNFIT_TABLE && !!rel.shows && rel.columns.some((c) => c.name === "record_id");
    const anywhere = rel.name !== UNFIT_TABLE && !ofRecords;
    const unfit = ofRecords
      ? `count(DISTINCT record_id) FILTER (WHERE record_id IN (SELECT record_id FROM ${unfitTable} WHERE table_name IN (${rel.shows!.map((t) => quote(t)).join(", ")})))`
      : anywhere
        ? `(SELECT count(DISTINCT record_id) FROM ${unfitTable})`
        : "0";
    return this.reader(rel, async (conn) => {
      const row = (await conn.runAndReadAll(`SELECT count(*) AS n, ${flagged ? "count(*) FILTER (WHERE record_correcting)" : "0"} AS c, ${unfit} AS u FROM ${ident(rel.name)} ${where}`, values)).getRowObjects()[0];
      return { rows: Number(row?.n ?? 0), correcting: Number(row?.c ?? 0), unfit: Number(row?.u ?? 0), unfitAnywhere: anywhere };
    });
  }

  /**
   * One reading statement of someone else's SQL (the assistant's, the
   * client's own code).
   *
   * The database decides what the text is, not this code: it is split into
   * statements by the database's own parser, exactly one is accepted, it must
   * be of the reading kind, and that one prepared statement is what runs. It
   * runs in a transaction that cannot write and is rolled back, in a database
   * that cannot touch a file. Few run at once, each is stopped after a time
   * limit, and only the rows asked for ever leave the database.
   */
  async query(sql: string, options: { params?: unknown[]; maxRows?: number; timeoutMs?: number; maxText?: number; maxResultText?: number } = {}): Promise<QueryResult> {
    if (typeof sql !== "string" || sql.trim() === "") throw new RecordsError(400, "The query is empty.");
    if (sql.length > MAX_SQL) throw new RecordsError(400, `The query is too long (at most ${MAX_SQL.toLocaleString("en-US")} characters).`);
    const params = options.params ?? [];
    if (!Array.isArray(params) || !params.every((p) => p === null || ["string", "number", "boolean"].includes(typeof p))) {
      throw new RecordsError(400, "Query parameters must be a list of text, numbers, true, false or null.");
    }
    const maxRows = Math.min(5000, Math.max(1, Math.floor(options.maxRows ?? 200)));
    const maxText = options.maxText ?? MAX_TEXT;
    const maxResultText = options.maxResultText ?? MAX_RESULT_TEXT;
    const timeoutMs = options.timeoutMs ?? 15_000;
    await this.level();
    const release = await this.slots.acquire(timeoutMs);
    let conn: DuckDBConnection;
    try {
      conn = await this.connect();
    } catch (err) {
      release();
      throw err;
    }
    const asking = conn;
    // From the moment it has its turn: the limit covers working out what the
    // statement is as well as running it.
    const task = (async (): Promise<QueryResult> => {
      let extracted;
      try {
        extracted = await asking.extractStatements(sql);
      } catch (err) {
        // DuckDB's own first line is the most useful thing for fixing the SQL.
        throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
      }
      if (extracted.count !== 1) throw new RecordsError(400, "Only a single statement is allowed. Remove the others and the ';' between them.");
      // What it reads and what it calls, before anything of it is worked
      // out: even preparing a statement evaluates what a row-making function
      // is handed.
      await this.refuseCalls(asking, sql);
      let prepared;
      try {
        prepared = await extracted.prepare(0);
      } catch (err) {
        throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
      }
      if (prepared.statementType !== StatementType.SELECT) {
        throw new RecordsError(400, "Only reading statements are allowed (SELECT, DESCRIBE, SHOW, SUMMARIZE). Records are changed in the app, never here.");
      }
      const width = prepared.columnCount;
      if (width > MAX_COLUMNS) throw new RecordsError(400, `The result would have ${width} columns; at most ${MAX_COLUMNS} can be returned. Select the ones that are needed.`);
      const kinds = Array.from({ length: width }, (_, i) => prepared.columnTypeId(i));
      const shown = kinds.map((k) => PLAIN_TYPES.has(k));
      const names = distinctNames(Array.from({ length: width }, (_, i) => prepared.columnName(i)));
      // The same statement, read through a frame of our own: long text is
      // cut inside the database, before any of it is turned into a value
      // here, and what is not shown is not fetched at all. Columns are
      // taken by position, so two of the same name are still two.
      let reading = prepared;
      try {
        const inner = sql.trim().replace(/;\s*$/, "");
        const cols = names.map((_, i) => `c${i + 1}`);
        const picked = cols.map((c, i) => (!shown[i] ? `NULL AS ${c}` : kinds[i] === DuckDBTypeId.VARCHAR ? `left(${c}, ${maxText + 1}) AS ${c}` : c));
        const framed = await asking.extractStatements(`SELECT ${picked.join(", ")} FROM (\n${inner}\n) AS q(${cols.join(", ")})`);
        if (framed.count === 1) {
          const candidate = await framed.prepare(0);
          if (candidate.statementType === StatementType.SELECT && candidate.columnCount === width) reading = candidate;
        }
      } catch {
        // A statement that cannot be framed is read as it is, with the same limits applied on this side.
      }
      try {
        if (params.length > 0) reading.bind(params as DuckDBValue[]);
      } catch (err) {
        throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
      }
      await asking.run("BEGIN TRANSACTION READ ONLY");
      try {
        // A piece at a time, and of each piece only the rows that will be
        // returned are turned into values, up to a fixed amount of text in
        // all, with a pause now and then so nothing else waits on a wide
        // result.
        const result = await reading.stream();
        const rows: Record<string, unknown>[] = [];
        let truncated = false;
        let text = 0;
        let cells = 0;
        streaming: for (;;) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          if (rows.length >= maxRows) {
            truncated = true;
            break;
          }
          const vectors = shown.map((yes, i) => (yes ? chunk.getColumnVector(i) : null));
          for (let r = 0; r < chunk.rowCount; r++) {
            if (rows.length >= maxRows) {
              truncated = true;
              break streaming;
            }
            const row: [string, unknown][] = [];
            for (let i = 0; i < width; i++) {
              const raw = vectors[i] ? (vectors[i]!.getItem(r) as DuckDBValue) : OTHER_VALUE;
              text += typeof raw === "string" ? raw.length : 8;
              // Per value, not per row: one row can be as much as any number of rows.
              if (text > maxResultText) {
                truncated = true;
                break streaming;
              }
              row.push([names[i], plain(raw, maxText)]);
            }
            rows.push(Object.fromEntries(row));
            cells += width;
            if (cells >= 5_000) {
              cells = 0;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
        }
        return { columns: names, rows, truncated };
      } catch (err) {
        throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
      }
    })();
    return this.within(
      asking,
      timeoutMs,
      task,
      async () => {
        await asking.run("ROLLBACK").catch(() => {});
        try {
          asking.disconnectSync();
        } catch {
          /* already gone */
        }
        release();
      },
      () => new RecordsError(408, `The query took longer than ${timeoutMs / 1000} seconds and was stopped. Narrow it down or add up in fewer steps.`),
    );
  }

  /**
   * Refuse a statement that calls something it may not. The statement is
   * looked at as the database's own parser sees it, so it makes no
   * difference how a call is spelled, qualified, quoted, or tucked inside a
   * subquery, a lambda or a SUMMARIZE: every call is in the tree, by name.
   *
   * Reading rows is allowed from the tables and from a short list of table
   * functions (TABLE_FUNCTIONS). Calling is allowed for everything that only
   * computes; a function that does more is refused unless it is known to be
   * harmless. What the parser will not describe at all (PRAGMA, PIVOT) is
   * refused too: it cannot be looked at.
   */
  private async refuseCalls(conn: DuckDBConnection, sql: string): Promise<void> {
    let tree: { error?: unknown; statements?: unknown };
    try {
      const text = String((await conn.runAndReadAll("SELECT json_serialize_sql(?::VARCHAR) AS tree", [sql])).getRows()[0][0]);
      if (text.length > MAX_TREE) throw new RecordsError(400, "The query is too large to be examined. Write it more simply.");
      tree = JSON.parse(text) as typeof tree;
    } catch (err) {
      if (err instanceof RecordsError) throw err;
      throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
    }
    if (tree.error || !Array.isArray(tree.statements)) {
      throw new RecordsError(400, "Only SELECT, DESCRIBE, SHOW and SUMMARIZE can be used here. (PRAGMA cannot: DESCRIBE a table to see its columns.)");
    }
    const tables: { catalog: string; schema: string; name: string }[] = [];
    const named = new Set<string>();
    // Walked without recursion: a statement can be nested as deep as it is long.
    const pending: unknown[] = [tree.statements];
    while (pending.length > 0) {
      const node = pending.pop();
      if (Array.isArray(node)) {
        for (const item of node) pending.push(item);
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;
      if (n.type === "TABLE_FUNCTION") {
        const name = String((n.function as Record<string, unknown> | undefined)?.function_name ?? "").toLowerCase();
        if (!TABLE_FUNCTIONS.has(name)) throw new RecordsError(400, `"${name}" cannot be read from here. Rows come from this app's tables, and from ${[...TABLE_FUNCTIONS].slice(0, 3).join(", ")} and the like.`);
      } else if (n.type === "BASE_TABLE") {
        tables.push({ catalog: String(n.catalog_name ?? ""), schema: String(n.schema_name ?? ""), name: String(n.table_name ?? "") });
      } else if (n.type === "SHOW_REF") {
        const what = String(n.table_name ?? "").replace(/"/g, "").toLowerCase();
        if (!["", "tables", "__show_tables_expanded"].includes(what)) throw new RecordsError(400, "SHOW TABLES lists this app's tables, and DESCRIBE shows one's columns. Nothing else can be shown here.");
      } else if (typeof n.function_name === "string") {
        const name = n.function_name.toLowerCase();
        if (this.refused.has(name)) throw new RecordsError(400, `The function "${name}" is not available here.`);
        // The one setting a query has any use for; the rest say things about the server.
        if (name === "current_setting") {
          const given = Array.isArray(n.children) ? (n.children as Record<string, unknown>[]) : [];
          const which = given.length === 1 && given[0]?.class === "CONSTANT" ? String((given[0].value as Record<string, unknown> | undefined)?.value ?? "") : "";
          if (which.toLowerCase() !== "timezone") throw new RecordsError(400, "Only current_setting('TimeZone') is available here.");
        }
      }
      // The names a WITH gives to its own queries: reading from one of those is reading from the statement itself.
      const withs = (n.cte_map as { map?: { key?: unknown }[] } | undefined)?.map;
      if (Array.isArray(withs)) for (const w of withs) if (typeof w?.key === "string") named.add(w.key.toLowerCase());
      for (const value of Object.values(n)) if (value && typeof value === "object") pending.push(value);
    }
    // Rows are read from this app's tables and views and from nothing else:
    // not the database's own catalogue, its settings or its log.
    for (const t of tables) {
      const ours = ["", "memory"].includes(t.catalog.toLowerCase()) && ["", "main"].includes(t.schema.toLowerCase()) && (this.relations.has(t.name.toLowerCase()) || named.has(t.name.toLowerCase()));
      if (!ours) throw new RecordsError(400, `"${[t.catalog, t.schema, t.name].filter(Boolean).join(".")}" is not one of this app's tables. SHOW TABLES lists them.`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const conn of this.running) {
      try {
        conn.interrupt();
      } catch {
        /* nothing running */
      }
    }
    await this.opening?.catch(() => {});
    await this.draining?.catch(() => {});
    await this.writes.catch(() => {});
    // Whatever is still reading is told to stop and given a moment. The
    // database is not pulled from under a statement that is still running
    // (one that cannot be stopped): the process ending takes care of that.
    for (let i = 0; i < 40 && (this.connecting > 0 || this.running.size > 0 || this.stuck.size > 0); i++) {
      for (const conn of this.running) {
        try {
          conn.interrupt();
        } catch {
          /* nothing running */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.connecting > 0 || this.running.size > 0 || this.stuck.size > 0) return;
    this.teardown();
    await rm(this.spill, { recursive: true, force: true }).catch(() => {});
  }
}

/** A few at a time, the rest in a short line; past that, an answer now instead of a long wait. */
class Slots {
  private waiting: (() => void)[] = [];

  constructor(
    private free: number,
    private readonly maxWaiting: number,
  ) {}

  state(): { free: number; waiting: number } {
    return { free: this.free, waiting: this.waiting.length };
  }

  async acquire(maxWaitMs: number): Promise<() => void> {
    if (this.free > 0) this.free--;
    else {
      if (this.waiting.length >= this.maxWaiting) throw new RecordsError(503, "Too many queries are running. Try again in a moment.");
      await new Promise<void>((resolve, reject) => {
        const turn = (): void => {
          clearTimeout(timer);
          resolve();
        };
        // A query ahead that cannot be stopped must not hold the line for ever.
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== turn);
          reject(new RecordsError(503, "The queries ahead of this one are taking too long. Try again in a moment."));
        }, maxWaitMs);
        this.waiting.push(turn);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

function top(counts: Map<string, number> | null, most = 20): [string, number][] {
  return [...(counts ?? [])].sort((a, b) => b[1] - a[1]).slice(0, most);
}

/** How a column of a client's own query is treated, from the type the database gives it. */
function typeOfSql(sqlType: string): RecordColumnType {
  // The whole name, never its beginning: a list of moments is a list.
  const t = sqlType.toUpperCase();
  if (t === "BOOLEAN") return "boolean";
  if (t === "DATE") return "date";
  if (/^TIMESTAMP( WITH TIME ZONE|_S|_MS|_NS)?$/.test(t)) return "timestamp";
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|UTINYINT|USMALLINT|UINTEGER)$/.test(t)) return "integer";
  if (/^(DOUBLE|FLOAT|REAL|UBIGINT|HUGEINT|UHUGEINT|DECIMAL(\(\d+,\s*\d+\))?)$/.test(t)) return "number";
  return "text";
}

/** A column as a page's query selects it, in a form `served` can turn into JSON without guessing. */
function selected(c: RecordColumn): string {
  const col = ident(c.name);
  switch (c.type) {
    case "timestamp":
      return `epoch_ms(CAST(${col} AS ${MOMENT})) AS ${col}`;
    case "date":
    case "text":
      return `CAST(${col} AS VARCHAR) AS ${col}`;
    case "number":
      return `CAST(${col} AS DOUBLE) AS ${col}`;
    default:
      return col;
  }
}

/** A row as a page receives it: moments as ISO text, days as "YYYY-MM-DD", whole numbers as numbers. */
function served(rel: Relation, row: Record<string, unknown>): RecordRow {
  const out: RecordRow = {};
  for (const c of rel.columns) {
    const v = row[c.name];
    if (v === null || v === undefined) out[c.name] = null;
    else if (c.type === "timestamp") out[c.name] = new Date(Number(v)).toISOString();
    else if (typeof v === "bigint") out[c.name] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[c.name] = v;
    else out[c.name] = String(v);
  }
  return out;
}

/** Any value a query can return, as JSON would carry it. A moment is ISO text; long text is cut. */
function plain(v: DuckDBValue, maxText: number): unknown {
  try {
    return plainly(v, maxText);
  } catch {
    // A value that cannot be said as JSON (a moment at infinity) is said as the database writes it.
    return cut(String(v), maxText);
  }
}

/** Column names as keys of a row: each its own, whatever the query called them. */
function distinctNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((given, i) => {
    const base = given.trim() === "" ? `column_${i + 1}` : given;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

function plainly(v: DuckDBValue, maxText: number): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "string") return cut(v, maxText);
  if (v instanceof DuckDBTimestampTZValue) return new Date(Number(v.micros / 1000n)).toISOString();
  if (v instanceof DuckDBDecimalValue) {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : String(v);
  }
  return cut(String(v), maxText);
}

const cut = (text: string, most: number): string => {
  if (text.length <= most) return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
  // Copied out, not sliced: a slice of a long string keeps the whole of it
  // in memory for as long as the slice lives.
  const head = Buffer.from(text.slice(0, most), "utf8").toString("utf8");
  return `${head.includes("\u0000") ? head.replaceAll("\u0000", "") : head}…`;
};

/** A value that did not fit its column: which record, where, and what was written. */
interface Unfit {
  record: string;
  table: string;
  column: string;
  line: number | null;
  value: string;
}

/** Text compared the way a person would: no case, no stray spaces at either end. */
const loose = (expr: string): string => `lower(trim(${expr}))`;

/**
 * The days a piece of text names: one day ("2026-11-05") or a whole month
 * ("2026-11"), as the first day and the day after the last. Null when it
 * names neither.
 */
function span(want: string): { from: string; until: string } | null {
  const day = dayOf(want);
  if (day) return { from: day, until: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
  const m = /^(\d{4})-(\d{2})$/.exec(want);
  const first = m ? dayOf(`${want}-01`) : null;
  if (!m || !first) return null;
  return { from: first, until: new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)).toISOString().slice(0, 10) };
}

/** A day as the column's type sees it: the day itself, or the moment it begins in the database's zone. */
const dayAs = (c: RecordColumn): string => (c.type === "timestamp" ? `CAST(CAST(? AS DATE) AS ${MOMENT})` : "CAST(? AS DATE)");

/**
 * One comparison of a column with what a person typed. What the text cannot
 * mean for this column matches nothing: a filter never quietly widens.
 */
function compare(c: RecordColumn, op: "=" | ">=" | "<=" | ">" | "<", raw: string, values: DuckDBValue[]): string {
  const col = ident(c.name);
  const want = raw.trim();
  switch (c.type) {
    case "number":
    case "integer": {
      const n = numberOf(want);
      if (n === null) return "FALSE";
      values.push(n);
      return `${col} ${op} ?`;
    }
    case "boolean": {
      const b = want.toLowerCase() === "true" ? true : want.toLowerCase() === "false" ? false : null;
      if (b === null || op !== "=") return "FALSE";
      values.push(b);
      return `${col} = ?`;
    }
    case "date":
    case "timestamp": {
      // A day or a month names every moment inside it.
      const days = span(want);
      if (days) {
        const start = `${col} >= ${dayAs(c)}`;
        const end = `${col} < ${dayAs(c)}`;
        if (op === "=") {
          values.push(days.from, days.until);
          return `(${start} AND ${end})`;
        }
        if (op === ">=" || op === "<") {
          values.push(days.from);
          return op === ">=" ? start : end;
        }
        values.push(days.until);
        return op === "<=" ? end : start;
      }
      const ms = c.type === "timestamp" ? Date.parse(want) : NaN;
      if (!Number.isFinite(ms)) return "FALSE";
      values.push(ms);
      return `epoch_ms(CAST(${col} AS ${MOMENT})) ${op} ?`;
    }
    default:
      values.push(want);
      return op === "=" ? `${loose(`CAST(${col} AS VARCHAR)`)} = ${loose("?")}` : `lower(CAST(${col} AS VARCHAR)) ${op} lower(?)`;
  }
}

function columnFilter(rel: Relation, f: ColumnFilter, values: DuckDBValue[]): string {
  const c = rel.columns.find((x) => x.name === f.columnKey);
  // A filter on a column this table does not have matches nothing, except
  // "is empty", which every row satisfies for a column that is not there.
  if (!c) return f.operator === "empty" ? "TRUE" : "FALSE";
  const col = ident(c.name);
  const asText = `CAST(${col} AS VARCHAR)`;
  switch (f.operator) {
    // Only text can be there and say nothing. A number, a day or a moment is
    // empty when it is not there at all (and comparing a moment with '' is
    // neither true nor false to the database, which hid every row).
    case "empty":
      return c.type === "text" ? `(${col} IS NULL OR ${asText} = '')` : `${col} IS NULL`;
    case "not_empty":
      return c.type === "text" ? `(${col} IS NOT NULL AND ${asText} <> '')` : `${col} IS NOT NULL`;
    case "equals":
      return compare(c, "=", String(f.value ?? ""), values);
    case "gt":
      return compare(c, ">", String(f.value ?? ""), values);
    case "lt":
      return compare(c, "<", String(f.value ?? ""), values);
    default:
      values.push(likeText(String(f.value ?? "")));
      return `${asText} ILIKE ? ESCAPE '\\'`;
  }
}

/**
 * The WHERE clause for a page's filters, a table's column filters and what
 * is selected on the page.
 *
 * A page's filters are shared by every section on it, so one whose key is
 * not a column here belongs to some other section and is left alone. A key
 * that is a column must equal it; `<column>_from` and `<column>_to` bound it
 * (what the date-range and month-range filters send); `q` looks for the text
 * in the columns marked for searching. A selection picks the rows of the
 * records selected (or the rows themselves, by their own key).
 */
function conditions(rel: Relation, filters: Record<string, string> | undefined, columnFilters: ColumnFilter[] | undefined, selection?: Selection): { where: string; values: DuckDBValue[] } {
  const values: DuckDBValue[] = [];
  const parts: string[] = [];
  const byName = new Map(rel.columns.map((c) => [c.name, c]));
  for (const [key, raw] of Object.entries(filters ?? {})) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    if (key === "q") {
      const searched = rel.columns.filter((c) => c.searchable ?? !c.system);
      if (searched.length === 0) {
        parts.push("FALSE");
        continue;
      }
      const like = likeText(raw.trim());
      parts.push(`(${searched.map((c) => `CAST(${ident(c.name)} AS VARCHAR) ILIKE ? ESCAPE '\\'`).join(" OR ")})`);
      for (let i = 0; i < searched.length; i++) values.push(like);
      continue;
    }
    const exact = byName.get(key);
    if (exact) {
      parts.push(compare(exact, "=", raw, values));
      continue;
    }
    const range = /^(.+)_(from|to)$/.exec(key);
    const ranged = range ? byName.get(range[1]) : undefined;
    if (range && ranged) parts.push(compare(ranged, range[2] === "from" ? ">=" : "<=", raw, values));
  }
  for (const f of columnFilters ?? []) parts.push(columnFilter(rel, f, values));
  const ids = (selection?.ids ?? []).slice(0, MAX_SELECTED).map(String);
  if (ids.length > 0) {
    const by = [...new Set(["record_id", rel.key].filter((k): k is string => !!k && byName.has(k)))];
    // Rows that are not of any one record (a client's totals) cannot be
    // selected by record; what is selected elsewhere on the page says nothing about them.
    if (by.length > 0) {
      const marks = ids.map(() => "?").join(", ");
      parts.push(`(${by.map((k) => `CAST(${ident(k)} AS VARCHAR) IN (${marks})`).join(" OR ")})`);
      for (let i = 0; i < by.length; i++) for (const id of ids) values.push(id);
    }
  }
  return { where: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "", values };
}

/**
 * Sorted as asked, with what is empty last whichever way, and always ending
 * on the table's own order: rows that tie must come out in the same order on
 * every page, or paging through them would repeat some and skip others.
 */
function order(rel: Relation, sort: FetchRequest["sort"]): string {
  const has = (name: string): boolean => rel.columns.some((c) => c.name === name);
  const ties = rel.order.filter(has).map((name) => `${ident(name)} ASC`);
  const by = (name: string, direction: string): string => {
    const c = rel.columns.find((x) => x.name === name)!;
    return `${c.type === "text" ? `lower(CAST(${ident(name)} AS VARCHAR))` : ident(name)} ${direction === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  };
  const asked = sort && has(sort.key) ? by(sort.key, sort.direction) : rel.defaultSort && has(rel.defaultSort.column) ? by(rel.defaultSort.column, rel.defaultSort.direction) : null;
  const all = [...(asked ? [asked] : []), ...ties];
  return all.length > 0 ? `ORDER BY ${all.join(", ")}` : "";
}
