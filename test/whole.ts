// A result read a piece at a time does not say when it stops short: a
// statement that fails on a late row hands over the rows it had made and
// then nothing, exactly as one that has finished does. Every place that
// reads that way must refuse such a result, never pass it on short.
//   npx tsx test/whole.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { endedWhole, whyItFailed } from "../src/whole.js";
import { FileStore } from "../src/files/store.js";
import { QueryProcesses } from "../src/sandbox/supervisor.js";
import { openRecords } from "../src/apps/records/runtime.js";
import type { RecordProjection, RecordsSource } from "../src/apps/records/types.js";

const dir = await mkdtemp(join(homedir(), ".tp-whole-test-"));
const refused = async (work: () => Promise<unknown>, status: number, what: string): Promise<Error> => {
  try {
    const got = await work();
    throw new Error(`${what}: was answered, with ${JSON.stringify(got).slice(0, 200)}`);
  } catch (err) {
    assert.equal((err as { statusCode?: number }).statusCode, status, `${what}: ${(err as Error).message}`);
    return err as Error;
  }
};

try {
  // ── What the database does, which everything else rests on ───────────────
  // If a later version of it behaves otherwise, this is where it shows.
  const inst = await DuckDBInstance.create(":memory:", { threads: "2" });
  const setup = await inst.connect();
  await setup.run("create table t as select range as a, case when range = 900000 then 'x' else '1' end as s from range(1000000)");
  const read = async (sql: string, between?: (conn: Awaited<ReturnType<typeof inst.connect>>, rows: number) => boolean | void): Promise<{ rows: number; whole: boolean; why: string | null }> => {
    const conn = await inst.connect();
    await conn.run("BEGIN TRANSACTION READ ONLY");
    const result = await conn.stream(sql);
    let rows = 0;
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      rows += chunk.rowCount;
      if (between?.(conn, rows)) break;
    }
    const whole = await endedWhole(conn);
    const why = whole ? null : await whyItFailed(conn, sql);
    conn.disconnectSync();
    return { rows, whole, why };
  };
  assert.deepEqual(await read("select a, s from t"), { rows: 1_000_000, whole: true, why: null });
  const cast = await read("select a, s::integer as n from t");
  assert.ok(cast.rows > 0 && cast.rows < 1_000_000 && !cast.whole && /Conversion Error: Could not convert string 'x' to INT32/.test(cast.why ?? ""), JSON.stringify(cast));
  const raised = await read("select a, case when a = 900000 then error('boom') else s end as s from t");
  assert.ok(raised.rows > 0 && !raised.whole && /boom/.test(raised.why ?? ""), JSON.stringify(raised));
  const hidden = await read("select a from (select a, s::integer as n from t) where n >= 0 -- and it ends in a comment");
  assert.ok(hidden.rows > 0 && !hidden.whole && /Conversion Error/.test(hidden.why ?? ""), JSON.stringify(hidden));
  let told = false;
  const interrupted = await read("select range, repeat('x', 50) from range(50000000)", (conn, rows) => {
    if (rows >= 200_000 && !told) {
      told = true;
      conn.interrupt();
    }
  });
  assert.ok(interrupted.rows < 50_000_000 && !interrupted.whole, JSON.stringify(interrupted));
  // Simply not read to its end is no failure: the rows taken are good ones.
  assert.deepEqual(await read("select a, s::integer as n from t", () => true), { rows: 2048, whole: true, why: null });
  setup.disconnectSync();
  inst.closeSync();

  // ── An app's records ─────────────────────────────────────────────────────
  // 3,000 records, so a table is more than one piece; the 2,501st makes a statement fail.
  const things = new Map(Array.from({ length: 3000 }, (_, i) => [`t${String(i).padStart(4, "0")}`, i]));
  const source: RecordsSource = {
    tables: [{ name: "things", label: "Things", grain: "record", key: "record_id", columns: [{ name: "record_id", type: "text", label: "Record", system: true }, { name: "n", type: "number", label: "N" }] }],
    version: "1",
    about: "things",
    noun: { one: "thing", many: "things" },
    identity: () => "test",
    expected: () => [...things.keys()].map((id) => ({ id, signature: "1" })),
    signature: (id) => (things.has(id) ? "1" : ""),
    project: async (id): Promise<RecordProjection | null> => ({ id, signature: "1", rows: { things: [{ record_id: id, n: things.get(id)! }] } }),
    changedAt: () => new Date().toISOString(),
    changes: () => [],
    mark: () => ({ run: "r", high: 0 }),
    continues: () => true,
  };
  const FRAGILE = "select record_id, case when n = 2500 then error('row 2500 is bad') else n end as v from things";
  // Few rows, so the cap on rows is not what ends it: five come, then the failure.
  const SHORT = `select v from (${FRAGILE}) where v < 5 or v > 2990`;
  const views = { fragile: { sql: FRAGILE, label: "Fails on one row" }, sound: { sql: "select record_id, n * 2 as v from things", label: "Does not" } };
  const processes = new QueryProcesses({ size: 2 });
  for (const [where, pool] of [["in a process of its own", processes], ["in the server", null]] as const) {
    const appDir = join(dir, pool ? "apart" : "inside");
    await mkdir(appDir);
    const logged: string[] = [];
    const app = await openRecords({ appId: "things", title: "Things", dir: appDir, source, database: true, timezone: "UTC", views, after: Promise.resolve(), processes: pool, log: (level, message) => void logged.push(`${level}: ${message}`) });
    const tool = app.tool()!;
    // The assistant's query: refused with the database's own reason, never five rows of fourteen.
    const no = await refused(() => tool.run({ sql: SHORT }), 400, `a query that fails on a late row, ${where}`);
    assert.match(no.message, /^Query failed: Invalid Input Error: row 2500 is bad/, where);
    assert.deepEqual((await tool.run({ sql: "select count(*) as n from sound where v < 5 or v > 5980" })).rows, [{ n: 12 }], where);
    // A name the statement gives one of its own queries excuses reading
    // that query, and nothing the database has of its own by that name.
    for (const sql of [
      "with duckdb_databases as (select 1 as x) select database_name, path from main.duckdb_databases",
      "with duckdb_databases as (select 1 as x) select * from duckdb_databases",
      "select * from (with sqlite_master as (select 1 as x) select * from sqlite_master) a, sqlite_master b",
      "with mine as (select 1 as x) select * from main.mine",
      "with mine as (select 1 as x) select * from memory.main.mine",
      "select * from duckdb_databases",
      "select * from main.duckdb_views",
    ]) await refused(() => tool.run({ sql }), 400, `${sql}, ${where}`);
    assert.deepEqual((await tool.run({ sql: "with mine as (select 1 as x) select x from mine" })).rows, [{ x: 1 }], where);
    assert.deepEqual((await tool.run({ sql: "with things as (select 7 as n) select n from things" })).rows, [{ n: 7 }], where);
    assert.deepEqual((await tool.run({ sql: "with a as (select n from main.things where n < 3), b as (select count(*) as c from a) select c from b" })).rows, [{ c: 3 }], where);
    // Stopped by the cap on rows before the bad one: the rows given are good ones, and it says there are more.
    const first = await tool.run({ sql: `select v from (${FRAGILE}) order by record_id` }).catch((err: Error) => err);
    assert.ok(first instanceof Error || ((first.rows as unknown[]).length === 200 && first.truncated === true), where);
    if (!pool) {
      // The client's own code, the same.
      const mine = await refused(() => app.query(SHORT), 400, "the client's own query that fails on a late row");
      assert.match(mine.message, /row 2500 is bad/);
      assert.equal((await app.query("select v from sound where v < $1", [10])).rows.length, 5);
      // All of a client's query that fails on some row, for a download or
      // an alert's snapshot: refused, never the rows before the bad one. (A
      // page of it sorts and counts every row, so that is refused too.)
      const pages = app.database!;
      const all = await refused(() => pages.page("fragile", { page: 1, pageSize: 10_000, sort: [] } as never), 500, "an export that fails on a late row");
      assert.match(all.message, /"fragile" could not be read( to its end)?: Invalid Input Error: row 2500 is bad/);
      const whole = await pages.page("sound", { page: 1, pageSize: 10_000 });
      assert.equal(whole.rows.length, 3000);
      assert.equal(pages.status().viewTurns.free, 1, "a refused export kept its turn");
    }
    await app.close();
  }
  await processes.close();

  // An export is read in parts, each part asked for with what the last one
  // handed back. However many are being read at once, and whatever becomes
  // of the server meanwhile, one either gives every row or is refused:
  // never fewer rows that end as if they were all.
  {
    const many = new Map(Array.from({ length: 25_000 }, (_, i) => [`m${String(i).padStart(5, "0")}`, i]));
    const big: RecordsSource = {
      ...source,
      expected: () => [...many.keys()].map((id) => ({ id, signature: "1" })),
      signature: (id) => (many.has(id) ? "1" : ""),
      project: async (id): Promise<RecordProjection | null> => ({ id, signature: "1", rows: { things: [{ record_id: id, n: many.get(id)! }] } }),
    };
    const { RecordsDatabase } = await import("../src/apps/records/database.js");
    const exportDir = join(dir, "exports");
    await mkdir(exportDir);
    const db = new RecordsDatabase(big, { dir: exportDir, timezone: "UTC" });
    await db.open();
    const readAll = async (pause: number): Promise<number | string> => {
      let rows = 0;
      let cursor: string | undefined;
      try {
        for (;;) {
          const part = await db.page("things", { page: 1, pageSize: 10_000, ...(cursor ? { cursor } : {}) } as never);
          rows += part.rows.length;
          if (!part.nextCursor) return rows;
          cursor = part.nextCursor;
          await new Promise((r) => setTimeout(r, pause));
        }
      } catch (err) {
        return `refused ${(err as { statusCode?: number }).statusCode}`;
      }
    };
    for (let round = 0; round < 3; round++) {
      const ends = await Promise.all(Array.from({ length: 14 }, (_, i) => readAll(i % 3 === 0 ? 0 : 20)));
      assert.deepEqual(ends.filter((e) => typeof e === "number" && e !== 25_000), [], `an export ended short: ${JSON.stringify(ends)}`);
      assert.ok(ends.filter((e) => e === 25_000).length >= 8, JSON.stringify(ends));
      assert.ok(ends.every((e) => e === 25_000 || e === "refused 503" || e === "refused 410"), JSON.stringify(ends));
    }
    // Closed while exports are being read: the same.
    const reading = Array.from({ length: 6 }, () => readAll(5));
    await new Promise((r) => setTimeout(r, 12));
    await db.close();
    const ends = await Promise.all(reading);
    assert.deepEqual(ends.filter((e) => typeof e === "number" && e !== 25_000), [], `an export ended short when the server closed: ${JSON.stringify(ends)}`);
  }

  // ── The file tool ────────────────────────────────────────────────────────
  const requester = { orgId: "org-test" };
  const rowsOfFile = Array.from({ length: 6000 }, (_, i) => ({ a: i, s: i === 5000 ? "x" : "1" }));
  for (const isolate of [true, false]) {
    const where = isolate ? "in a process of its own" : "in the server";
    const store = new FileStore({ enabled: true, dir: join(dir, isolate ? "files-apart" : "files-inside"), minFreeBytes: 0 }, { isolate });
    await store.init();
    const file = await store.materialize("data", rowsOfFile, requester);
    const before = (await readdir(store.config.dir)).length;
    // A file made from a query: all of the rows, or no file.
    const made = await refused(() => store.materializeFromQuery(file.fileId, "select a, s::integer as n from data", "made", requester), 400, `a query-to-file that fails on a late row, ${where}`);
    assert.match(made.message, /^Query failed: Conversion Error: Could not convert string 'x' to INT32/, where);
    assert.equal((await readdir(store.config.dir)).length, before, `${where}: something was kept of a query-to-file that failed`);
    const good = await store.materializeFromQuery(file.fileId, "select a, s from data where a <> 5000", "good", requester);
    assert.deepEqual((await store.query(good.fileId, "select count(*) as n from good", requester)).rows, [{ n: 5999 }], where);
    // A query: refused, never the rows before the bad one as if they were all.
    const asked = await refused(() => store.query(file.fileId, "select a, s::integer as n from data where a < 5 or a >= 5000", requester), 400, `a file query that fails on a late row, ${where}`);
    assert.match(asked.message, /Conversion Error/, where);
    // Within its caps a result is what it always was.
    const capped = await store.query(file.fileId, "select a from data order by a", requester);
    assert.deepEqual([capped.rows.length, capped.truncated, capped.rows[999]], [1000, true, { a: 999 }], where);
    const small = await store.query(file.fileId, "select a, a as a from data where a < 3 order by 1", requester);
    assert.deepEqual([small.rows.length, small.truncated, small.columns.map((c) => c.name)], [3, false, ["a", "a"]], where);
    // Rows heavy with text: answered with as many as fit, at the cost of
    // those and not of all there are.
    const started = Date.now();
    const heavy = await store.query(file.fileId, "select a, repeat('x', 200000) || a as s from data", requester);
    assert.ok(heavy.truncated && heavy.rows.length >= 1 && heavy.rows.length <= 3 && JSON.stringify(heavy.rows).length <= 512 * 1024, `${where}: ${heavy.rows.length} rows`);
    assert.ok(Date.now() - started < 3_000, `${where}: ${Date.now() - started} ms`);
    await store.close();
  }

  console.log("whole: ok");
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
