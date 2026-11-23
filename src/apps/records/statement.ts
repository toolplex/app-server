// ---------------------------------------------------------------------------
// One reading statement of someone else's SQL over an app's tables: what is
// checked before it runs, how it is run, and how its result is cut to size.
//
// Kept apart from the database that holds the tables because it runs in two
// places and must be the same in both: in a process of its own, over a frozen
// copy of the tables (see ./frozen.ts), and in the server's own tables when
// that process is turned off or cannot be started.
// ---------------------------------------------------------------------------

import { DuckDBDecimalValue, DuckDBTimestampTZValue, DuckDBTypeId, StatementType, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { STOPPED_SHORT, endedWhole, whyItFailed } from "../../whole.js";

export class RecordsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** More rows matched than were returned. */
  truncated: boolean;
}

export interface QueryOptions {
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
  /** The most characters one value may have. */
  maxText?: number;
  /** The most characters the whole result may have. */
  maxResultText?: number;
}

/** A query's options, checked and with every limit filled in. Plain data: it crosses to the query process as it is. */
export interface QueryLimits {
  params: (string | number | boolean | null)[];
  maxRows: number;
  maxText: number;
  maxResultText: number;
  timeoutMs: number;
}

/** What a statement may read and call in the database it is run in. */
export interface QueryRules {
  /** Functions it may not call (see refusedFunctions). */
  refused: ReadonlySet<string>;
  /** The database's own tables and views, in lower case (see ownRelations). */
  own: ReadonlySet<string>;
  /** Whether a name, in lower case, is one of the app's tables or views. */
  has: (name: string) => boolean;
  /** The names the database itself goes by, in lower case, and "" for none given. */
  catalogs: readonly string[];
}

const MAX_SQL = 20_000;
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

const MAX_TEXT = 2_000;

/** The database's own first line, which is the most useful thing for fixing the SQL, without the library's preface to it. */
export const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err)).replace(/^Failed to extract statements:\s*/, "");

export const tookTooLong = (timeoutMs: number): RecordsError => new RecordsError(408, `The query took longer than ${timeoutMs / 1000} seconds and was stopped. Narrow it down or add up in fewer steps.`);

/** The query and its options, refused with a plain reason when they are not what a query can be. */
export function queryLimits(sql: unknown, options: QueryOptions = {}): QueryLimits {
  if (typeof sql !== "string" || sql.trim() === "") throw new RecordsError(400, "The query is empty.");
  if (sql.length > MAX_SQL) throw new RecordsError(400, `The query is too long (at most ${MAX_SQL.toLocaleString("en-US")} characters).`);
  const params = options.params ?? [];
  if (!Array.isArray(params) || !params.every((p) => p === null || ["string", "number", "boolean"].includes(typeof p))) {
    throw new RecordsError(400, "Query parameters must be a list of text, numbers, true, false or null.");
  }
  return {
    params: params as QueryLimits["params"],
    maxRows: Math.min(5000, Math.max(1, Math.floor(options.maxRows ?? 200))),
    maxText: options.maxText ?? MAX_TEXT,
    maxResultText: options.maxResultText ?? MAX_RESULT_TEXT,
    timeoutMs: options.timeoutMs ?? 15_000,
  };
}

/**
 * The functions a query may not call in this database, by the database's
 * own account of what each does.
 */
export async function refusedFunctions(conn: DuckDBConnection): Promise<Set<string>> {
  // Every function the database itself says does more than compute is
  // refused to a query, save the few known to do no harm.
  const effects = (await conn.runAndReadAll("SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type = 'scalar' AND has_side_effects")).getRowObjects();
  const refused = new Set<string>([...NEVER_CALLED, ...effects.map((row) => String(row.function_name).toLowerCase()).filter((name) => !HARMLESS_EFFECTS.has(name))]);
  // And every shorthand the database has for one of those (pg_sleep is
  // sleep_ms under another name): a shorthand is refused when what it
  // stands for names a refused function.
  const shorthands = (await conn.runAndReadAll("SELECT DISTINCT function_name, macro_definition FROM duckdb_functions() WHERE function_type IN ('macro', 'table_macro') AND macro_definition IS NOT NULL")).getRowObjects();
  for (const row of shorthands) {
    const stands = String(row.macro_definition).toLowerCase();
    if ([...refused].some((name) => new RegExp(`(^|[^a-z0-9_])${name}\\s*\\(`).test(stands))) refused.add(String(row.function_name).toLowerCase());
  }
  return refused;
}

/**
 * The tables and views that are the database's own and can be read without
 * saying where they are (its catalogue, its settings, its log), in lower
 * case. A query may not read them, and may not give one of their names to a
 * query of its own (see refuseCalls).
 */
export async function ownRelations(conn: DuckDBConnection): Promise<Set<string>> {
  const rows = (
    await conn.runAndReadAll(
      "SELECT lower(view_name) AS name FROM duckdb_views() WHERE internal AND schema_name IN ('main', 'pg_catalog') UNION SELECT lower(table_name) FROM duckdb_tables() WHERE internal AND schema_name IN ('main', 'pg_catalog')",
    )
  ).getRowObjects();
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * The statement, checked and run on this connection, and its result within
 * the limits. The caller gives it a time limit and tidies the connection up.
 */
export async function readStatement(conn: DuckDBConnection, sql: string, limits: QueryLimits, rules: QueryRules): Promise<QueryResult> {
  const { params, maxRows, maxText, maxResultText } = limits;
  let extracted;
  try {
    extracted = await conn.extractStatements(sql);
  } catch (err) {
    // DuckDB's own first line is the most useful thing for fixing the SQL.
    throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
  }
  if (extracted.count !== 1) throw new RecordsError(400, "Only a single statement is allowed. Remove the others and the ';' between them.");
  // What it reads and what it calls, before anything of it is worked
  // out: even preparing a statement evaluates what a row-making function
  // is handed.
  await refuseCalls(conn, sql, rules);
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
    const framed = await conn.extractStatements(`SELECT ${picked.join(", ")} FROM (\n${inner}\n) AS q(${cols.join(", ")})`);
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
  await conn.run("BEGIN TRANSACTION READ ONLY");
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
    let ended = false;
    streaming: for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) {
        ended = true;
        break;
      }
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
    // The rows have stopped coming. Whether that was their end is the
    // database's to say (see ../../whole.ts): a statement that failed on a
    // late row gives no answer at all, never a short one that looks whole.
    if (ended && !(await endedWhole(conn))) {
      throw new RecordsError(400, `Query failed: ${(await whyItFailed(conn, sql, params as DuckDBValue[])) ?? STOPPED_SHORT}`);
    }
    return { columns: names, rows, truncated };
  } catch (err) {
    if (err instanceof RecordsError) throw err;
    throw new RecordsError(400, `Query failed: ${firstLine(err)}`);
  }
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
export async function refuseCalls(conn: DuckDBConnection, sql: string, rules: QueryRules): Promise<void> {
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
      if (rules.refused.has(name)) throw new RecordsError(400, `The function "${name}" is not available here.`);
      // The one setting a query has any use for; the rest say things about the server.
      if (name === "current_setting") {
        const given = Array.isArray(n.children) ? (n.children as Record<string, unknown>[]) : [];
        const which = given.length === 1 && given[0]?.class === "CONSTANT" ? String((given[0].value as Record<string, unknown> | undefined)?.value ?? "") : "";
        if (which.toLowerCase() !== "timezone") throw new RecordsError(400, "Only current_setting('TimeZone') is available here.");
      }
    }
    // The names a WITH gives to its own queries: reading from one of those is reading from the statement itself.
    const withs = (n.cte_map as { map?: { key?: unknown }[] } | undefined)?.map;
    if (Array.isArray(withs)) {
      for (const w of withs) {
        if (typeof w?.key !== "string") continue;
        // Not by a name the database has for something of its own: where
        // the WITH does not reach, that name would be the database's again.
        if (rules.own.has(w.key.toLowerCase())) throw new RecordsError(400, `A WITH query cannot be called "${w.key}": the database has something of its own by that name. Call it something else.`);
        named.add(w.key.toLowerCase());
      }
    }
    for (const value of Object.values(n)) if (value && typeof value === "object") pending.push(value);
  }
  // Rows are read from this app's tables and views and from nothing else:
  // not the database's own catalogue, its settings or its log.
  for (const t of tables) {
    // A name the statement gave one of its own queries stands for that query
    // only as it is: said with a schema or a database, it is not that query.
    const itsOwn = t.catalog === "" && t.schema === "" && named.has(t.name.toLowerCase());
    const ours = itsOwn || (rules.catalogs.includes(t.catalog.toLowerCase()) && ["", "main"].includes(t.schema.toLowerCase()) && rules.has(t.name.toLowerCase()));
    if (!ours) throw new RecordsError(400, `"${[t.catalog, t.schema, t.name].filter(Boolean).join(".")}" is not one of this app's tables. SHOW TABLES lists them.`);
  }
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

export const cut = (text: string, most: number): string => {
  if (text.length <= most) return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
  // Copied out, not sliced: a slice of a long string keeps the whole of it
  // in memory for as long as the slice lives.
  const head = Buffer.from(text.slice(0, most), "utf8").toString("utf8");
  return `${head.includes("\u0000") ? head.replaceAll("\u0000", "") : head}…`;
};

