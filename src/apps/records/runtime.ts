// ---------------------------------------------------------------------------
// One app's records, running: what every kind of app gets once it has said
// what its tables are and what a record contributes (a RecordsSource).
//
//   - the query database, when the app asked for one (`records: true`);
//   - `query`, for the client's own code and the assistant's tool;
//   - `changes` and `record`, for keeping a copy of the records elsewhere.
//
// The last two need no database. They read the records themselves, and are
// there for every app whether or not it keeps tables.
//
// Keeping a copy. A copy is only as good as its way of catching up, so the
// copier is not called when something changes (a call that fails loses a
// record); it asks. It remembers one opaque cursor, hands it back, and gets
// every record that changed since, each once, as it stands now, with its
// rows. When the cursor cannot be continued from (it is from another set of
// records, from before the tables changed shape, or from a future this store
// has not had, as after a restore), the answer says `reset`: empty the copy
// and take everything, which is what it is then given.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordsDatabase, RecordsError, type QueryResult } from "./database.js";
import type { ChangePoint, RecordProjection, RecordRow, RecordsSource } from "./types.js";
import { held } from "./values.js";

export interface RecordsRuntimeOptions {
  appId: string;
  title: string;
  /** The app's own directory. */
  dir: string;
  source: RecordsSource;
  /** Keep the query database. Without it, only `changes` and `record` are offered. */
  database: boolean;
  /** The zone days and months are counted in. */
  timezone: string;
  /** The client's own queries, by resource name. */
  views?: Record<string, { sql: string; label: string }>;
  /** Resolves once the records can be listed. */
  after: Promise<void>;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/** One record as its rows: by table name, values as their columns hold them. */
export type RecordRows = Record<string, RecordRow[]>;

export type RecordChange = { record_id: string; at: string; removed: true } | { record_id: string; at: string; removed: false; rows: RecordRows };

export interface RecordChanges {
  /** Oldest change first. A record appears once, as it stands now. */
  changes: RecordChange[];
  /** Hand this back as `after` next time. */
  cursor: string;
  /** The copy cannot be continued: empty it, then apply these changes, which start from the beginning. */
  reset: boolean;
  /** There are more changes to ask for now. */
  more: boolean;
}

export interface RecordsTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface RecordsRuntime {
  database: RecordsDatabase | null;
  /** A record was stored. */
  touch(id: string): void;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  changes(options?: { after?: string | null; limit?: number }): Promise<RecordChanges>;
  record(id: string): Promise<{ record_id: string; rows: RecordRows } | null>;
  /** When what the tables show last changed: a record, or the shape of the tables themselves. */
  changedAt(): Promise<string>;
  /** The assistant's query tool; null when the app keeps no tables. */
  tool(): RecordsTool | null;
  close(): Promise<void>;
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/**
 * Start an app's records. Resolves once the tables are laid out (empty), or
 * rejects with a plain reason when they cannot be (an unknown time zone, a
 * client's query that does not run): a server with such a mistake should not
 * start. Filling the tables goes on in the background.
 */
export async function openRecords(o: RecordsRuntimeOptions): Promise<RecordsRuntime> {
  const { source } = o;
  const shape = source.tables.map((t) => [t.name, t.columns.map((c) => [c.name, c.type])]);
  /** What a copy was made under: the tables' shape and whatever else decides a record's rows. */
  const schema = fingerprint([source.version, shape]);
  const database = o.database ? new RecordsDatabase(source, { dir: o.dir, timezone: o.timezone, views: o.views, after: o.after, log: o.log }) : null;
  if (database) {
    await database.prepare();
    database.open().catch((err: unknown) => o.log("error", `could not build the records tables: ${firstLine(err)}`));
  }

  // When the shape of what pages are shown last changed. A page is looked at
  // again (its alerts checked) when its data moved; a new column or a client
  // query that was rewritten moves it as surely as an approval does.
  const shown = fingerprint([schema, o.timezone, o.views ?? {}]);
  const since: Promise<string> = o.after
    .then(async () => {
      const path = join(o.dir, "records.json");
      try {
        const kept = JSON.parse(await readFile(path, "utf8")) as { shown?: unknown; since?: unknown };
        if (kept.shown === shown && typeof kept.since === "string") return kept.since;
      } catch {
        /* first time, or unreadable */
      }
      const now = new Date().toISOString();
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ shown, since: now }));
      await rename(tmp, path);
      return now;
    })
    .catch(() => new Date().toISOString());

  const rowsOf = (p: RecordProjection): RecordRows => {
    const out: RecordRows = {};
    for (const t of source.tables) {
      out[t.name] = (p.rows[t.name] ?? []).map((row) => Object.fromEntries(t.columns.map((c) => [c.name, held(c, row[c.name]).value])));
    }
    return out;
  };

  const needDatabase = (): RecordsDatabase => {
    if (!database) throw new Error(`App "${o.appId}" keeps no query database; add \`records: true\` to the app`);
    return database;
  };

  return {
    database,
    touch: (id) => database?.touch(id),
    // The client's own code gets its text whole; the cap on text is for what goes to a model.
    query: async (sql, params) => needDatabase().query(sql, { params, maxRows: 5000, maxText: 1_000_000, maxResultText: 64_000_000 }),

    changes: async (options) => {
      await o.after;
      const identity = source.identity();
      const limit = Math.min(500, Math.max(1, Math.floor(Number(options?.limit) || 100)));
      let from: ChangePoint | null = null;
      let reset = false;
      const after = options?.after;
      if (after !== undefined && after !== null && after !== "") {
        const [id, made, run, high, seq, ...rest] = typeof after === "string" ? after.split(".") : [];
        const point = { seq: Number(seq), id: rest.join(".") };
        // Not this store's, not these tables', or told things this store no
        // longer stands by (see the store's `continues`): start again.
        const sound = id === identity && made === schema && seq !== undefined && seq !== "" && Number.isSafeInteger(point.seq) && point.seq >= 0 && high !== "" && source.continues({ run: run ?? "", high: Number(high) });
        if (!sound) reset = true;
        else from = point;
      }
      // The cursor carries where the records stand once everything in this
      // answer has been read: whoever holds it has been told nothing newer
      // than that, and anything that later turns out to be lost from before
      // it makes the cursor one the store no longer stands by.
      const cursorAt = (point: ChangePoint | null): string => {
        const now = source.mark();
        return `${identity}.${schema}.${now.run}.${now.high}.${point?.seq ?? 0}.${point?.id ?? ""}`;
      };
      const page = source.changes(from, limit);
      const changes: RecordChange[] = [];
      let last = from;
      for (const c of page) {
        if (c.removed) changes.push({ record_id: c.id, at: c.at, removed: true });
        else {
          let p: RecordProjection | null;
          try {
            p = await source.project(c.id);
          } catch (err) {
            // A record that cannot be read right now is not skipped: the
            // cursor stops before it, and it is asked for again next time.
            o.log("error", `record ${c.id} could not be read for the list of changes (${firstLine(err)})`);
            if (changes.length === 0 && !reset) throw new RecordsError(503, `Record ${c.id} cannot be read right now. Check the server log.`);
            return { changes, cursor: cursorAt(last), reset, more: true };
          }
          changes.push(p && p.signature !== "" ? { record_id: c.id, at: c.at, removed: false, rows: rowsOf(p) } : { record_id: c.id, at: c.at, removed: true });
        }
        last = { seq: c.seq, id: c.id };
      }
      return { changes, cursor: cursorAt(last), reset, more: page.length === limit };
    },

    record: async (id) => {
      await o.after;
      if (source.signature(id) === "") return null;
      const p = await source.project(id);
      return p && p.signature !== "" ? { record_id: id, rows: rowsOf(p) } : null;
    },

    changedAt: async () => {
      const [shapeAt] = await Promise.all([since, o.after.catch(() => {})]);
      const recordAt = source.changedAt();
      return recordAt > shapeAt ? recordAt : shapeAt;
    },

    tool: () => {
      if (!database) return null;
      const relations = database.listRelations();
      return {
        name: "query_records",
        description:
          `Run one read-only SQL query (DuckDB) over ${source.about}. For totals, counts, comparisons, anything across many records. ` +
          `Times are moments with a time zone; days and months are counted in ${database.timezone} (current_date, date_trunc and ::date follow it). ` +
          `Tables: ${relations.map((r) => `${r.name} (${r.label})`).join("; ")}. ` +
          "A value that was typed into a number or date column but is not one is NULL there, so it is missing from any total: unfit_values lists every such value; say so when a total may be short. " +
          "Use DESCRIBE <table> to see a table's columns before querying it. At most 200 rows come back: add up, filter or LIMIT in the query.",
        input_schema: {
          type: "object",
          properties: { sql: { type: "string", description: "A single SELECT (or DESCRIBE) statement." } },
          required: ["sql"],
          additionalProperties: false,
        },
        run: async (input) => {
          if (typeof input.sql !== "string" || input.sql.trim() === "") throw new RecordsError(400, "sql is required");
          const result = await database.query(input.sql, { maxRows: 200 });
          return {
            columns: result.columns,
            rows: result.rows,
            row_count: result.rows.length,
            ...(result.truncated ? { truncated: true, note: "Only the first 200 rows are shown. Aggregate, filter or add LIMIT." } : {}),
          };
        },
      };
    },

    close: async () => {
      await database?.close();
    },
  };
}
