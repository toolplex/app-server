// ---------------------------------------------------------------------------
// Knowing that a result was read to its end.
//
// A result read a piece at a time does not say when it stops short. A
// statement that fails on a late row (a value that will not convert, a
// calculation that runs out of memory) or is told to stop hands over the
// rows it had made and then an empty piece, exactly as one that has
// finished does. Taken at its word, a query's answer, an export or a file
// made from a query would be short and look whole.
//
// The database does know. Inside a transaction, a statement that failed
// leaves the transaction unusable, and the next statement in it is refused;
// after one that finished, or one that was simply not read to its end, the
// next statement runs. So: read inside a transaction the caller began, and
// when the rows end, ask.
// ---------------------------------------------------------------------------

import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";

/**
 * Whether the statement whose rows were just read to their end really ended
 * there. Only means something inside a transaction that was begun before the
 * statement was started (BEGIN TRANSACTION); outside one it always says yes.
 */
export async function endedWhole(conn: DuckDBConnection): Promise<boolean> {
  try {
    await conn.run("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a statement that stopped short fails, in the database's own words:
 * it is run again to its end with its rows thrown away, which is the one way
 * the database says. Null when that tells nothing (run again, it did not
 * fail, or it cannot be run this way). The connection is left in a new
 * reading transaction, for the caller to end as it would have the first.
 */
export async function whyItFailed(conn: DuckDBConnection, sql: string, params: DuckDBValue[] = []): Promise<string | null> {
  try {
    await conn.run("ROLLBACK");
    await conn.run("BEGIN TRANSACTION READ ONLY");
    // On lines of its own: the statement may end in a comment.
    const again = await conn.prepare(`EXPLAIN ANALYZE\n${sql.trim().replace(/;\s*$/, "")}\n`);
    try {
      if (params.length > 0) again.bind(params);
      await again.run();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message.split("\n")[0] : String(err);
    }
  } catch {
    return null;
  }
}

/** What is said of a statement that stopped short when the database gives no reason of its own. */
export const STOPPED_SHORT = "it failed part-way through its rows, so none of them are given";
