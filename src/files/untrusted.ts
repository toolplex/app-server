// The file tool's three ways of running SQL someone else wrote: a query over
// one file, a query over an album of snapshots, and a query whose result
// becomes a new file. Written to run in the query process (see
// ../sandbox/supervisor.ts), where a statement that breaks the database
// breaks only that process; the same functions run in the server itself when
// that process is turned off.
//
// Nothing here decides who may read what: the server has done that before it
// hands a file's path over. Each database is opened read-only, with no access
// to any other file and its configuration locked, under the caller's bounds.

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { FileColumn, FileQueryResult } from "./types.js";
import { FileStoreError, lineWriter, normalizeRow, sqlString, withTimeout } from "./values.js";
import { STOPPED_SHORT, endedWhole, whyItFailed } from "../whole.js";

/** What every request carries: the database's bounds, the zone days are counted in, and the time one step may take. */
export interface Bounds {
  /** memory_limit, threads, temp_directory, max_temp_directory_size. */
  bounds: Record<string, string>;
  timezone: string | null;
  timeoutMs: number;
}

export interface QueryRequest extends Bounds {
  dbPath: string;
  sql: string;
  maxRows: number;
  maxBytes: number;
}

export interface QueryManyRequest extends Bounds {
  /** Newest first. */
  files: { dbPath: string; takenAt: string; sourceSync: string | null; tables: string[] }[];
  sql: string;
  maxRows: number;
  maxBytes: number;
}

export interface MaterializeRequest extends Bounds {
  dbPath: string;
  sql: string;
  /** Where the result is written, one JSON row per line. */
  stagedPath: string;
  maxIngestRows: number;
}

type Bounded = <R>(p: Promise<R>) => Promise<R>;

/**
 * One connection for the length of `fn`, with the zone set and the
 * configuration locked before `fn` can run anything. `sealed` says the
 * database can be closed to the outside from the start; when it cannot (an
 * album's files must be attached first) `fn` closes it itself.
 *
 * A statement that could not be stopped at its time limit goes on working
 * after its caller has been answered. The database is not closed under it:
 * that waits until it has ended, and the failure handed back carries
 * `settled`, which resolves then, for a caller that must not start more
 * work until it has (see FileStore.untrusted).
 */
async function withConn<T>(dbPath: string, req: Bounds, sealed: boolean, fn: (conn: DuckDBConnection, bounded: Bounded) => Promise<T>): Promise<T> {
  // Bounds first: options are applied in order. The lock is applied by
  // statement, after the zone: a locked configuration takes no zone.
  const inst = await DuckDBInstance.create(dbPath, { ...req.bounds, ...(sealed ? { access_mode: "READ_ONLY", enable_external_access: "false" } : {}) });
  let conn: DuckDBConnection | null = null;
  const begun: { ended: boolean; settled: Promise<void> }[] = [];
  const shut = (): void => {
    try {
      conn?.disconnectSync();
    } catch {
      /* already gone */
    }
    try {
      inst.closeSync();
    } catch {
      /* already gone */
    }
  };
  let failure: FileStoreError | null = null;
  try {
    const c = (conn = await inst.connect());
    if (req.timezone !== null) await c.run(`SET GLOBAL TimeZone = ${sqlString(req.timezone)}`);
    if (sealed) await c.run("SET GLOBAL lock_configuration = true");
    const bounded: Bounded = (p) => {
      const one = { ended: false, settled: Promise.resolve() };
      const end = (): void => {
        one.ended = true;
      };
      // Noted before the time limit is put on it, so `ended` is already true
      // by the time whoever waits on the limit hears of the statement's end.
      one.settled = p.then(end, end);
      begun.push(one);
      return withTimeout(p, req.timeoutMs, () => c.interrupt());
    };
    return await fn(c, bounded);
  } catch (err) {
    // DuckDB's own first line is the most useful thing for fixing the SQL.
    failure = err instanceof FileStoreError ? err : new FileStoreError(400, `Query failed: ${(err instanceof Error ? err.message.split("\n")[0] : String(err)).replace(/^Failed to extract statements:\s*/, "")}`);
    throw failure;
  } finally {
    const working = begun.filter((one) => !one.ended);
    if (working.length === 0) shut();
    else {
      const settled = Promise.all(working.map((one) => one.settled)).then(shut);
      if (failure) Object.assign(failure, { settled });
    }
  }
}

/**
 * Columns, rows and the truncated flag, within the row and byte caps. Read
 * a piece at a time and no further than the caps, so a result of any size
 * costs what is returned of it; and in a transaction, so that rows which
 * stop coming can be told from rows that have ended (see ../whole.ts).
 */
async function capped(conn: DuckDBConnection, bounded: Bounded, sql: string, maxRows: number, maxBytes: number): Promise<FileQueryResult> {
  await conn.run("BEGIN TRANSACTION READ ONLY");
  const result = await bounded(conn.stream(sql));
  const types = result.columnTypes();
  const columns: FileColumn[] = result.columnNames().map((name, i) => ({ name, type: String(types[i]) }));
  const keys = result.deduplicatedColumnNames();
  const rows: Record<string, unknown>[] = [];
  // As JSON: the brackets, then each row and the comma after it.
  let bytes = 2;
  let truncated = false;
  reading: for (;;) {
    const chunk = await bounded(result.fetchChunk());
    if (!chunk || chunk.rowCount === 0) {
      if (!(await bounded(endedWhole(conn)))) throw new FileStoreError(400, `Query failed: ${(await bounded(whyItFailed(conn, sql))) ?? STOPPED_SHORT}`);
      break;
    }
    const vectors = keys.map((_, i) => chunk.getColumnVector(i));
    for (let r = 0; r < chunk.rowCount; r++) {
      if (rows.length >= maxRows) {
        truncated = true;
        break reading;
      }
      // One row at a time: a piece can hold more text than the whole answer may.
      const raw: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) raw[keys[i]] = vectors[i].getItem(r);
      const row = normalizeRow(raw);
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (bytes + size > maxBytes) {
        truncated = true;
        break reading;
      }
      bytes += size;
      rows.push(row);
    }
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

export async function query(req: QueryRequest): Promise<FileQueryResult> {
  return withConn(req.dbPath, req, true, (conn, bounded) => capped(conn, bounded, req.sql, req.maxRows, req.maxBytes));
}

/**
 * One statement across an album: the newest snapshot's tables at the top
 * level, and `history.<table>` for every snapshot that has the table, each
 * row tagged with when it was taken.
 */
export async function queryMany(req: QueryManyRequest): Promise<FileQueryResult> {
  return withConn(":memory:", req, false, async (conn, bounded) => {
    // ATTACH is a file operation, so the database is open to files while the
    // album's are attached, then closed to them and locked before any SQL the
    // caller wrote can run.
    for (const [i, f] of req.files.entries()) await conn.run(`ATTACH ${sqlString(f.dbPath)} AS s${i} (READ_ONLY)`);
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
    for (const t of req.files[0].tables) await conn.run(`CREATE VIEW "${t}" AS SELECT * FROM s0."${t}"`);
    await conn.run("CREATE SCHEMA history");
    const allTables = new Set(req.files.flatMap((f) => f.tables));
    for (const t of allTables) {
      if (t === "__meta") continue;
      const parts = req.files
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.tables.includes(t))
        .map(({ f, i }) => `SELECT ${sqlString(f.takenAt)}::TIMESTAMPTZ AS taken_at, ${f.sourceSync === null ? "NULL::VARCHAR" : sqlString(f.sourceSync)} AS source_sync, * FROM s${i}."${t}"`);
      await conn.run(`CREATE VIEW history."${t}" AS ${parts.join(" UNION ALL BY NAME ")}`);
    }
    return capped(conn, bounded, req.sql, req.maxRows, req.maxBytes);
  });
}

/** A query's whole result written to a file, a piece at a time: it never passes through the caller. */
export async function materialize(req: MaterializeRequest): Promise<{ rowCount: number; columns: string[] }> {
  return withConn(req.dbPath, req, true, async (conn, bounded) => {
    // In a transaction, so that rows which stop coming can be told from rows
    // that have ended (see ../whole.ts): a statement that fails on a late
    // row must not leave a file that is short and looks whole.
    await conn.run("BEGIN TRANSACTION READ ONLY");
    const result = await bounded(conn.stream(req.sql));
    const columns = result.columnNames();
    let rowCount = 0;
    const out = lineWriter(req.stagedPath);
    try {
      for (;;) {
        const chunk = await bounded(result.fetchChunk());
        if (!chunk || chunk.rowCount === 0) {
          if (!(await bounded(endedWhole(conn)))) throw new FileStoreError(400, `Query failed: ${(await bounded(whyItFailed(conn, req.sql))) ?? STOPPED_SHORT}`);
          break;
        }
        rowCount += chunk.rowCount;
        if (rowCount > req.maxIngestRows) throw new FileStoreError(413, `Result has too many rows. Maximum is ${req.maxIngestRows.toLocaleString()}.`);
        await out.write(
          chunk
            .getRowObjects(columns)
            .map((r) => JSON.stringify(normalizeRow(r)))
            .join("\n") + "\n",
        );
      }
      await out.end();
    } catch (err) {
      out.destroy();
      throw err;
    }
    return { rowCount, columns };
  });
}

/** By the names the query process is asked for them. */
export const handlers = {
  "file.query": query,
  "file.queryMany": queryMany,
  "file.materialize": materialize,
};
