// ---------------------------------------------------------------------------
// A query over a frozen copy of an app's tables, in a process of its own.
//
// SQL someone else wrote (the assistant's) is not run in the server (see
// ../../sandbox/supervisor.ts). The server writes its tables to a file that
// nothing will change (RecordsDatabase.freeze) and hands this process the
// path. Here the file is opened read-only, closed to every other file, and
// the one statement is checked and run exactly as it would be in the server
// (./statement.ts). Nothing is kept afterwards: the next query opens the
// file it is given.
//
// Should the statement break this process, run without end, or take all the
// memory it can, the server stops the process and starts another. Its own
// tables, and the pages read from them, are never part of it.
// ---------------------------------------------------------------------------

import { DuckDBInstance } from "@duckdb/node-api";
import { RecordsError, firstLine, ownRelations, readStatement, refusedFunctions, tookTooLong, type QueryLimits, type QueryResult } from "./statement.js";

export interface FrozenQuery {
  /** The frozen copy to read. */
  path: string;
  /** The app's tables and views, by name. */
  relations: string[];
  sql: string;
  limits: QueryLimits;
  /** The zone days and months are counted in. */
  timezone: string;
  /** memory_limit, threads, temp_directory, max_temp_directory_size. */
  bounds: Record<string, string>;
}

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * Said when the copy cannot be opened. The server knows it by these words:
 * it forgets that copy and makes another (see ./runtime.ts). What follows
 * them is for its log and goes no further.
 */
export const COPY_UNREADABLE = "This app's records could not be opened for a query. Try again in a moment.";

export async function query(req: FrozenQuery): Promise<QueryResult> {
  // Bounds first: options are applied in order, and a database closed to
  // files takes no directory to spill to.
  let inst: DuckDBInstance;
  try {
    inst = await DuckDBInstance.create(req.path, { ...req.bounds, access_mode: "READ_ONLY", enable_external_access: "false" });
  } catch (err) {
    throw new RecordsError(503, `${COPY_UNREADABLE} ${firstLine(err)}`);
  }
  try {
    const conn = await inst.connect();
    // At the limit the statement is told to stop, and told again until it
    // has. One that cannot be stopped is the server's to deal with: it stops
    // this process a moment later.
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
    }, req.limits.timeoutMs);
    try {
      await conn.run(`SET GLOBAL TimeZone = ${quote(req.timezone)}`);
      // The lock last: nothing after it is accepted, and nothing a query says can undo it.
      await conn.run("SET GLOBAL lock_configuration = true");
      const refused = await refusedFunctions(conn);
      const own = await ownRelations(conn);
      const names = new Set(req.relations);
      return await readStatement(conn, req.sql, req.limits, { refused, own, has: (name) => names.has(name), catalogs: ["", "memory"] });
    } catch (err) {
      if (late) throw tookTooLong(req.limits.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(nag);
      await conn.run("ROLLBACK").catch(() => {});
      try {
        conn.disconnectSync();
      } catch {
        /* already gone */
      }
    }
  } finally {
    try {
      inst.closeSync();
    } catch {
      /* already gone */
    }
  }
}

/** By the name the query process is asked for it. */
export const handlers = {
  "records.query": query,
};
