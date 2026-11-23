// The query database of an app's records, on its own: against a stand-in for
// a kind's records, so what is tested is the engine and nothing of any one
// kind. Records that cannot be read, changes arriving in any order and at
// any moment, queries someone else wrote (the ones that try to write, the
// ones that never finish, many at once), exports while records change, and
// stopping at an awkward time. Also the store's change stamps.
//   npx tsx test/records-database.ts
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RecordsDatabase, RecordsError } from "../src/apps/records/database.js";
import { RESERVED_WORDS, UNFIT_TABLE, type RecordProjection, type RecordsSource } from "../src/apps/records/types.js";
import { dayOf, held, numberOf } from "../src/apps/records/values.js";
import { EncodingStore, type StoredDocument } from "../src/apps/encoding/store.js";

const dir = await mkdtemp(join(homedir(), ".tp-records-database-test-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const unhandled: unknown[] = [];
process.on("unhandledRejection", (err) => unhandled.push(err));

interface Thing {
  n: number | string;
  label: string;
  lines: number;
  rev: number;
  broken?: boolean;
  gone?: boolean;
}
const things = new Map<string, Thing>();
let slow = 0;
let refuse = 0;
const source: RecordsSource = {
  tables: [
    {
      name: "things",
      label: "Things",
      grain: "record",
      key: "record_id",
      defaultSort: { column: "n", direction: "desc" },
      columns: [
        { name: "record_id", type: "text", label: "Record", system: true },
        { name: "n", type: "number", label: "N" },
        { name: "label", type: "text", label: "Label" },
        { name: "seen_at", type: "timestamp", label: "Seen", system: true },
        { name: "due", type: "date", label: "Due" },
      ],
    },
    {
      name: "thing_lines",
      label: "Lines",
      grain: "line",
      key: "line_id",
      parent: "things",
      order: ["record_id", "line_no"],
      columns: [
        { name: "line_id", type: "text", label: "Line", system: true },
        { name: "record_id", type: "text", label: "Record", system: true },
        { name: "line_no", type: "integer", label: "No", system: true },
        { name: "amount", type: "number", label: "Amount" },
      ],
    },
  ],
  version: "1",
  about: "things, for a test",
  noun: { one: "thing", many: "things" },
  identity: () => "test",
  expected: () => {
    if (refuse > 0) {
      refuse--;
      throw new Error("the records cannot be listed yet");
    }
    return [...things].filter(([, t]) => !t.gone).map(([id, t]) => ({ id, signature: String(t.rev) }));
  },
  signature: (id) => {
    const t = things.get(id);
    return t && !t.gone ? String(t.rev) : "";
  },
  project: async (id): Promise<RecordProjection | null> => {
    if (slow > 0) await sleep(slow);
    const t = things.get(id);
    if (!t) return null;
    if (t.broken) throw new Error("the disk says no");
    if (t.gone) return { id, signature: "", rows: {} };
    return {
      id,
      signature: String(t.rev),
      rows: {
        things: [{ record_id: id, n: t.n, label: t.label, seen_at: "2026-11-21T16:30:00.000Z", due: "2026-12-01" }],
        thing_lines: Array.from({ length: t.lines }, (_, i) => ({ line_id: `${id}:${i + 1}`, record_id: id, line_no: i + 1, amount: i + 1 })),
      },
    };
  },
  changedAt: () => new Date().toISOString(),
  changes: () => [],
  mark: () => ({ run: "only", high: 0 }),
  continues: () => true,
};

const said: { level: string; message: string }[] = [];
const make = (extra: Partial<ConstructorParameters<typeof RecordsDatabase>[1]> = {}): RecordsDatabase =>
  new RecordsDatabase(source, { dir, timezone: "Asia/Singapore", log: (level, message) => void said.push({ level, message }), retryMs: 150, reopenMs: 150, ...extra });
const page = (db: RecordsDatabase, name: string, extra: Record<string, unknown> = {}) => db.page(name, { page: 1, pageSize: 50, ...extra });
const refusedWith = async (work: () => Promise<unknown>, status: number, what: string): Promise<RecordsError> => {
  try {
    await work();
  } catch (err) {
    assert.ok(err instanceof RecordsError, `${what}: ${String(err)}`);
    assert.equal(err.statusCode, status, `${what}: ${err.message}`);
    return err;
  }
  throw new Error(`${what}: was not refused`);
};

let db = make();
try {
  // ── What a column can hold ───────────────────────────────────────────────
  assert.deepEqual(["12", "1,234.50", " -7 ", ".5", "1.234,50", "12 pcs", " ", ",", "1e5", "12.", "1,23"].map(numberOf), [12, 1234.5, -7, 0.5, null, null, null, null, null, null, null]);
  assert.deepEqual(["2026-11-05", "2026-02-30", "11/05/2026", "2026-11-05T10:00:00Z", " 2026-01-01 "].map(dayOf), ["2026-11-05", null, null, null, "2026-01-01"]);
  assert.deepEqual(held({ type: "number" }, [1, 2] as never), { value: null, fits: false });
  assert.deepEqual(held({ type: "text" }, "  kept  "), { value: "kept", fits: true });
  assert.deepEqual(held({ type: "integer" }, 2 ** 60), { value: null, fits: false });
  assert.deepEqual(held({ type: "timestamp" }, "not a time"), { value: null, fits: false });

  // ── Building, with records that cannot be read ───────────────────────────
  for (let i = 0; i < 30_000; i++) things.set(`t${String(i).padStart(5, "0")}`, { n: i, label: `Thing ${i % 100}`, lines: 1, rev: 1, broken: i === 10 || i === 20_000 || i === 29_999 });
  // Asked for from the first moment, by many at once: one build, every answer whole.
  const early = await Promise.all(Array.from({ length: 24 }, () => page(db, "things", { pageSize: 1 })));
  assert.deepEqual([...new Set(early.map((r) => r.total))], [29_997], "one bad record never stops the rest");
  assert.equal(said.filter((l) => l.level === "error" && /^record t\d+ could not be read \(the disk says no\)/.test(l.message)).length, 3);
  assert.ok(said.some((l) => l.level === "error" && l.message.startsWith("3 records could not be put in the tables")));
  assert.equal(said.filter((l) => l.message.startsWith("records tables built: 29997 records")).length, 1, "built once");
  // Put right, it is found again without a restart, the next time the tables are read after a while.
  things.get("t00010")!.broken = false;
  await sleep(200);
  assert.equal((await page(db, "things", { filters: { record_id: "t00010" } })).total, 1);
  assert.equal((await page(db, "things")).total, 29_998);
  const errorsSoFar = said.filter((l) => l.level === "error").length;
  await sleep(200);
  await page(db, "things");
  await sleep(200);
  await page(db, "things");
  assert.equal(said.filter((l) => l.level === "error").length, errorsSoFar, "a record still unreadable is not said again on every retry");

  // ── Following the records ────────────────────────────────────────────────
  // A change is on the page the moment it was made, with no waiting for it.
  const first = things.get("t00001")!;
  Object.assign(first, { n: 1_000_001, rev: 2, lines: 3 });
  db.touch("t00001");
  assert.deepEqual((await page(db, "things")).rows[0], { record_id: "t00001", n: 1_000_001, label: "Thing 1", seen_at: "2026-11-21T16:30:00.000Z", due: "2026-12-01" });
  assert.deepEqual((await page(db, "thing_lines_with_record", { filters: { record_id: "t00001" } })).rows.map((r) => [r.line_no, r.amount, r.n]), [[1, 1, 1_000_001], [2, 2, 1_000_001], [3, 3, 1_000_001]]);
  // Changed twice before it was written once: what is there at the end is what counts.
  Object.assign(first, { n: 5, rev: 3 });
  db.touch("t00001");
  Object.assign(first, { n: 6, rev: 4, lines: 1 });
  db.touch("t00001");
  assert.deepEqual([(await page(db, "things", { filters: { record_id: "t00001" } })).rows[0].n, (await page(db, "thing_lines", { filters: { record_id: "t00001" } })).total], [6, 1]);
  // Stored without anything about it changing: nothing is written.
  db.touch("t00001");
  // Many at once, of which some go away.
  for (let i = 100; i < 700; i++) {
    const t = things.get(`t${String(i).padStart(5, "0")}`)!;
    if (i % 3 === 0) t.gone = true;
    else Object.assign(t, { n: -i, rev: 2 });
    db.touch(`t${String(i).padStart(5, "0")}`);
  }
  assert.equal((await page(db, "things")).total, 29_998 - 200);
  assert.equal((await page(db, "thing_lines")).total, 29_998 - 200);
  assert.equal((await db.count("things", { n_to: "-100" })).rows, 400);
  // Changes that keep coming while people read: every reader gets an answer, and at the end the tables are right.
  let churn = true;
  const churning = (async () => {
    for (let i = 0; churn; i++) {
      const t = things.get("t00002")!;
      Object.assign(t, { n: 2_000_000 + i, rev: t.rev + 1 });
      db.touch("t00002");
      await sleep(1);
    }
  })();
  for (let i = 0; i < 40; i++) assert.equal((await page(db, "things", { pageSize: 1 })).rows.length, 1);
  churn = false;
  await churning;
  assert.equal((await page(db, "things")).rows[0].n, things.get("t00002")!.n);

  // ── Days are the organization's ──────────────────────────────────────────
  // 16:30 UTC on the 21st is half past midnight on the 22nd in Singapore.
  assert.equal((await page(db, "things", { filters: { seen_at: "2026-11-22" }, pageSize: 1 })).total, 29_798);
  assert.equal((await page(db, "things", { filters: { seen_at: "2026-11-21" }, pageSize: 1 })).total, 0);
  assert.equal((await page(db, "things", { filters: { seen_at_from: "2026-11", seen_at_to: "2026-11" }, pageSize: 1 })).total, 29_798);
  assert.equal((await page(db, "things", { filters: { due: "2026-12" }, pageSize: 1 })).total, 29_798);
  assert.equal((await page(db, "things", { columnFilters: [{ columnKey: "seen_at", operator: "gt", value: "2026-11-21" }], pageSize: 1 })).total, 29_798);
  assert.equal((await page(db, "things", { columnFilters: [{ columnKey: "seen_at", operator: "lt", value: "2026-11-22" }], pageSize: 1 })).total, 0);
  // "Is empty" and "is not empty" split every row between them, whatever the column holds.
  for (const columnKey of ["seen_at", "due", "n", "label", "record_id"]) {
    const empty = (await page(db, "things", { columnFilters: [{ columnKey, operator: "empty", value: "" }], pageSize: 1 })).total;
    const filled = (await page(db, "things", { columnFilters: [{ columnKey, operator: "not_empty", value: "" }], pageSize: 1 })).total;
    assert.deepEqual([empty, filled], [0, 29_798], columnKey);
  }

  // ── Someone else's SQL ───────────────────────────────────────────────────
  const counts = async (): Promise<unknown> => (await db.query("select (select count(*) from things) as t, (select count(*) from thing_lines) as l, (select sum(n) from things) as s")).rows[0];
  const untouched = await counts();
  for (const sql of [
    "delete from things",
    "select 1; delete from things",
    "select '--'; commit; delete from things; begin transaction",
    "select '/*'; commit; update things set n = 0; begin transaction; select '*/'",
    "select E'\\''; commit; delete from things; --'",
    "select $$--$$; commit; delete from things",
    "select $x$;$x$; rollback; drop table things",
    "with gone as (select 1) insert into things (record_id) select 'made-up'",
    "explain analyze delete from things",
    "create view mine as select 1",
    "set memory_limit = '8GB'",
    "set timezone = 'UTC'",
    "checkpoint",
    "attach ':memory:' as other",
    "copy things to 'out.csv'",
    "export database 'out'",
    "load icu",
    "",
    "   ",
    "select",
  ]) {
    await refusedWith(() => db.query(sql), 400, sql);
  }
  for (const sql of ["select * from read_csv('/etc/passwd')", "select * from read_text('/etc/hosts')", "select * from glob('/*')", "select * from 'things.parquet'"]) await refusedWith(() => db.query(sql), 400, sql);
  assert.deepEqual(await counts(), untouched);
  await refusedWith(() => db.query("select 1", { params: [{}] as never }), 400, "a parameter that is not a plain value");
  await refusedWith(() => db.query(`select ${"1 + ".repeat(8000)}1`), 400, "a very long query");
  // Values that vary are handed over, not pasted in.
  assert.deepEqual((await db.query("select label, n from things where record_id = $1 and n < $2", { params: ["t00003", 10] })).rows, [{ label: "Thing 3", n: 3 }]);
  assert.deepEqual((await db.query("select count(*) as n from things where label = $1", { params: ["x'; delete from things; --"] })).rows, [{ n: 0 }]);
  // What comes back: moments as ISO text, days and whole numbers as they are, and no more rows than asked for.
  assert.deepEqual((await db.query("select seen_at, due, 12::bigint as whole, 1.5::decimal(10,2) as money, n > 0 as positive, null as nothing from things where record_id = 't00003'")).rows, [
    { seen_at: "2026-11-21T16:30:00.000Z", due: "2026-12-01", whole: 12, money: 1.5, positive: true, nothing: null },
  ]);
  assert.deepEqual((await db.query("select current_setting('TimeZone') as zone, (timestamptz '2026-11-21 16:30:00+00')::date::varchar as day")).rows, [{ zone: "Asia/Singapore", day: "2026-11-22" }]);
  const capped = await db.query("select record_id from things", { maxRows: 7 });
  assert.deepEqual([capped.rows.length, capped.truncated], [7, true]);
  // A result far larger than anything could hold is cut off where it is asked to be, quickly.
  let started = Date.now();
  const huge = await db.query("select a.range as x, repeat('x', 100) as y from range(100000) a, range(100000) b", { maxRows: 100 });
  assert.deepEqual([huge.rows.length, huge.truncated], [100, true]);
  assert.ok(Date.now() - started < 3000, `a huge result took ${Date.now() - started} ms`);
  assert.equal(((await db.query("select repeat('x', 50000) as long")).rows[0].long as string).length, 2001, "long text is cut");
  // Long values in a long result. Only rows that will be returned are turned
  // into values, and only so much text in all: this result is hundreds of
  // rows of two million characters each, and a handful of them is all this
  // process ever holds.
  started = Date.now();
  const heapBefore = process.memoryUsage().heapUsed;
  const wide = await db.query("select repeat('a', 400000) as a, repeat('b', 400000) as b, repeat('c', 400000) as c, repeat('d', 400000) as d, repeat('e', 400000) as e, range as i from range(600)", { maxRows: 200 });
  // Long text is cut inside the database, so every row asked for comes back, each value at its limit.
  assert.deepEqual([wide.rows.length, wide.truncated, (wide.rows[0].a as string).length, (wide.rows[199].e as string).length], [200, true, 2001, 2001]);
  // One row can be as much as any number of rows: forty values of five million characters each.
  const oneRow = await db.query(`select ${Array.from({ length: 40 }, (_, i) => `s as s${i}`).join(", ")} from (select repeat('x', 5000000) as s)`);
  assert.deepEqual([oneRow.rows.length, Object.keys(oneRow.rows[0]).length, (oneRow.rows[0].s39 as string).length], [1, 40, 2001]);
  // And a result has only so many columns.
  await refusedWith(() => db.query(`select ${Array.from({ length: 400 }, (_, i) => `${i} as c${i}`).join(", ")}`), 400, "four hundred columns");
  // Two columns of one name are still two; a name that means something to JavaScript is only a name.
  const twins = await db.query('select a.label, b.label, 7 as "__proto__", 1 as x, 2 as "X" from things a join things b using (record_id) where a.record_id = \'t00003\'');
  assert.deepEqual(twins.columns, ["label", "label_2", "__proto__", "x", "X_2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(twins.rows)), [{ label: "Thing 3", label_2: "Thing 3", ["__proto__"]: 7, x: 1, X_2: 2 }]);
  // A moment the calendar cannot say is said as the database writes it, and the rest of the row with it.
  assert.deepEqual((await db.query("select 'infinity'::timestamptz as never, 1 as one")).rows, [{ never: "infinity", one: 1 }]);
  // A statement that cannot be read through a frame is read as it is.
  assert.deepEqual((await db.query("select 5 as five; -- and nothing more")).rows, [{ five: 5 }]);
  assert.ok(Date.now() - started < 5000, `long values took ${Date.now() - started} ms`);
  (globalThis as { gc?: () => void }).gc?.();
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 100 * 1024 * 1024, "long values were kept alive after being cut");
  // A list, a structure or binary data is not built at all, whatever its
  // size; cast to text in the query, it is text like any other.
  const other = "(a list, a structure or binary data; cast it to text in the query to see it)";
  assert.deepEqual((await db.query("select [1, 2, 3] as a_list, {'k': 1} as a_struct, 'abc'::blob as binary, '1011'::bit as bits, 5 as n, cast([1, 2] as varchar) as as_text")).rows, [
    { a_list: other, a_struct: other, binary: other, bits: other, n: 5, as_text: "[1, 2]" },
  ]);
  assert.equal((await db.query("select range(300000) as big from range(200)", { maxRows: 200 })).rows.length, 200);
  started = Date.now();
  let longest = 0;
  let lastTick = Date.now();
  const ticking = setInterval(() => {
    longest = Math.max(longest, Date.now() - lastTick - 10);
    lastTick = Date.now();
  }, 10);
  const binary = await db.query("select repeat('x', 2000000)::blob as a, repeat('y', 2000000)::blob as b, repeat('1', 100000)::bit as c from range(200)", { maxRows: 200 });
  clearInterval(ticking);
  assert.deepEqual([binary.rows.length, binary.rows[0].a, binary.rows[0].c], [200, other, other]);
  assert.ok(longest < 500, `binary data in a result held the server up for ${longest} ms`);
  // What a query calls is read from the database's own account of the
  // statement, so the spelling makes no difference. Functions that wait,
  // that switch something on for the whole database, that write a log, or
  // that run SQL handed to them as text are refused wherever they appear.
  for (const sql of [
    "select system.main.sleep_ms(1500)",
    "select system.sleep_ms(1500)",
    'select "system"."main"."sleep_ms"(1500)',
    "select SYSTEM.MAIN.SLEEP_MS(1500)",
    "select list_transform([1500], x -> system.main.sleep_ms(x))",
    "summarize select system.main.sleep_ms(1500)",
    "describe select * from enable_logging()",
    "with w as (select system.main.sleep_ms(1500) as x) select * from w",
    "select (select system.main.sleep_ms(1500))",
    "select * from things where n = (select max(system.main.sleep_ms(1500)) from things)",
    "select * from query('select system.main.sleep_ms(1500)')",
    "select * from query_table('things')",
    "select * from json_execute_serialized_sql(json_serialize_sql('select 1'))",
    "select * from enable_peg_parser()",
    "select * from disable_peg_parser()",
    "select * from enable_logging()",
    "select * from enable_profiling()",
    "select * from checkpoint()",
    "select * from force_checkpoint()",
    "select * from duckdb_logs()",
    "select * from duckdb_settings()",
    "select * from truncate_duckdb_logs()",
    "select * from things, enable_peg_parser()",
    "select * from things where record_id in (select 'x' from checkpoint())",
    "select write_log('hello')",
    "pragma table_info('things')",
    "pivot things on label using sum(n)",
    // Refused before anything of it is worked out: preparing a statement evaluates what a row-making function is handed.
    "select * from range(system.main.sleep_ms(1500))",
    "select * from generate_series(1, system.main.sleep_ms(1500))",
    "select json_serialize_plan('select * from range(system.main.sleep_ms(1500))')",
    "select json_deserialize_sql(json_serialize_sql('select 1'))",
    "select count(*) from range(1 order by system.main.sleep_ms(1500))",
    // Rows come from this app's tables and nowhere else: not the database's catalogue, its settings or its log.
    "select * from pg_settings",
    "select name, setting from pg_catalog.pg_settings",
    "select * from duckdb_logs",
    "select * from information_schema.tables",
    "select * from pg_catalog.pg_tables",
    "select * from things, pg_settings",
    "select (select count(*) from duckdb_logs) from things",
    "with pg_settings_copy as (select * from pg_settings) select * from pg_settings_copy",
    "describe pg_settings",
    "summarize select * from pg_settings",
    "select * from system.main.things",
    "show databases",
    "select current_setting('temp_directory')",
    "select current_setting('temp' || '_directory')",
    "select current_setting('secret_directory')",
  ]) {
    started = Date.now();
    const refusal = await refusedWith(() => db.query(sql), 400, sql);
    assert.ok(Date.now() - started < 1000, `${sql} was run before it was refused (${refusal.message})`);
  }
  // What only computes or makes rows is as free as ever.
  for (const sql of [
    "select count(*) as n from range(10)",
    "select * from generate_series(1, 3)",
    "select unnest([1, 2, 3]) as x",
    "select * from unnest([1, 2]) as t(x)",
    "select table_name from duckdb_tables()",
    "select column_name from duckdb_columns() where table_name = 'things'",
    "select * from pragma_table_info('things')",
    "describe things",
    "show tables",
    "summarize things",
    "table things",
    "from things select count(*)",
    "values (1), (2)",
    "select random() < 2 as r, length(cast(uuid() as varchar)) as u, upper(label) as l, list_transform([1, 2], x -> x + 1)[1] as two from things limit 1",
    "select label, count(*) filter (where n > 5) as big, sum(n) over (partition by label) as s from things group by label, n limit 3",
    "with by_label as (select label, sum(n) as total from things group by label), ranked as (select *, rank() over (order by total desc) as place from by_label) select * from ranked where place <= 3",
    "with recursive up(i) as (select 1 union all select i + 1 from up where i < 5) select max(i) as top from up",
    "select t.label, l.amount from things t join thing_lines l using (record_id) limit 2",
    "select * from main.things limit 1",
    "select * from thing_lines_with_record limit 1",
    "select count(*) as n from unfit_values",
    "describe thing_lines_with_record",
    "show all tables",
    "select current_setting('TimeZone') as zone, strftime(now(), '%Y') as year",
  ]) {
    assert.ok((await db.query(sql)).rows.length >= 1, sql);
  }
  // And the search box on a page still works: nothing above switched anything.
  assert.ok((await page(db, "things", { filters: { q: "Thing 7" }, pageSize: 1 })).total > 0);
  assert.deepEqual(await counts(), untouched);
  // Functions that only wait are not there to be called, however the call is
  // written or hidden; a name that merely contains the word is a name.
  for (const sql of [
    "select pg_sleep(40)",
    "select sleep_ms(40000)",
    'select "pg_sleep"(40)',
    "select main.pg_sleep(40)",
    "select PG_SLEEP ( 40 )",
    "summarize select pg_sleep(40)",
    "select * from query('select pg_sleep(40)')",
    "select * from query('select ' || 'pg_' || 'sleep(40)')",
    "select * from json_execute_serialized_sql(json_serialize_sql('select pg_sleep(40)'))",
    "select 1 as a$b$, pg_sleep(40) as c$b$",
    "with w as (select sleep_ms(40000) as x) select * from w",
  ]) {
    started = Date.now();
    const refusal = await refusedWith(() => db.query(sql), 400, sql);
    // Refused at once, not after waiting; called plainly, it says why.
    assert.ok(Date.now() - started < 1000, `${sql} waited`);
    assert.match(refusal.message, /not available here|cannot be read from here/, sql);
  }
  await refusedWith(() => db.query("select system.main.pg_sleep(40)"), 400, "the built-in by its full name");
  assert.deepEqual((await db.query("select 'sleep well' as word, 8 as sleep_hours, 'pg_sleep(1)' as other")).rows, [{ word: "sleep well", sleep_hours: 8, other: "pg_sleep(1)" }]);
  // A query run from inside a query is still only a reading one.
  for (const sql of ["select * from query('delete from things')", "select * from query('select 1; delete from things')", "select * from query('create table mine as select 1')", "select * from query('set threads = 8')"]) await refusedWith(() => db.query(sql), 400, sql);
  assert.deepEqual(await counts(), untouched);
  // Work that cannot be stopped once begun: the caller is still answered at
  // the limit, the other turn stays usable, and its own turn comes back when
  // it ends.
  started = Date.now();
  const unstoppable = db.query("select levenshtein(repeat('a', 45000), repeat('b', 45000)) as d", { timeoutMs: 300 }).then(() => "ok", (err: RecordsError) => err.statusCode);
  await sleep(50);
  assert.deepEqual((await db.query("select 1 as one")).rows, [{ one: 1 }], "the other turn answers while one is stuck");
  assert.equal(await unstoppable, 408);
  assert.ok(Date.now() - started < 3000, `the caller of an unstoppable query waited ${Date.now() - started} ms`);
  assert.deepEqual([db.status().stuck, db.status().queryTurns.free], [1, 1], "its turn is held while it works on");
  for (let i = 0; db.status().queryTurns.free < 2; i++) {
    await sleep(100);
    assert.ok(i < 600, "the turn of an unstoppable query never came back");
  }
  assert.deepEqual([db.status().queryTurns, db.status().stuck], [{ free: 2, waiting: 0 }, 0]);
  // One that would never finish is stopped at its limit, and nothing waits behind it afterwards.
  const endless = "select sum((a.range * b.range) % 7) from range(3000000) a, range(3000000) b";
  started = Date.now();
  await refusedWith(() => db.query(endless, { timeoutMs: 300 }), 408, "an endless query");
  assert.ok(Date.now() - started < 3000, `stopping took ${Date.now() - started} ms`);
  // Many of them at once: each is stopped, and the tables stay answerable throughout.
  started = Date.now();
  let answered = 0;
  const heavy = Array.from({ length: 12 }, () => db.query(endless, { timeoutMs: 400 }).then(() => "ok", (err: RecordsError) => err.statusCode));
  const meanwhile = (async () => {
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await page(db, "things", { pageSize: 5 });
      assert.ok(Date.now() - t0 < 1500, `a page waited ${Date.now() - t0} ms behind heavy queries`);
      answered++;
      await sleep(50);
    }
  })();
  const outcomes = await Promise.all(heavy);
  await meanwhile;
  // Stopped at its limit, or told the ones ahead were taking too long: never left running, never left waiting.
  assert.ok(outcomes.includes(408) && outcomes.every((o) => o === 408 || o === 503), JSON.stringify(outcomes));
  assert.equal(answered, 10);
  assert.ok(Date.now() - started < 12_000, `twelve endless queries took ${Date.now() - started} ms to be stopped`);
  // Past what may wait, an answer now instead of a long wait.
  const flood = await Promise.all(Array.from({ length: 40 }, () => db.query(endless, { timeoutMs: 200 }).then(() => "ok", (err: RecordsError) => err.statusCode)));
  assert.ok(flood.includes(503) && flood.includes(408) && !flood.includes("ok"), JSON.stringify(flood));
  for (let i = 0; db.status().queryTurns.free < 2 || db.status().stuck > 0; i++) {
    await sleep(50);
    assert.ok(i < 200, "the turns never came back after the flood");
  }
  assert.deepEqual(await counts(), untouched);

  // ── An export while records change ───────────────────────────────────────
  // A page this large is an export: read from one view of the data and
  // continued with a cursor, so nothing is repeated or skipped.
  const total = (await page(db, "thing_lines", { pageSize: 1 })).total;
  const firstPart = await db.page("thing_lines_with_record", { page: 1, pageSize: 10_000, sort: { key: "amount", direction: "asc" } });
  assert.equal(firstPart.total, total);
  assert.equal(firstPart.rows.length, 10_000);
  assert.equal(typeof firstPart.nextCursor, "string");
  const taken = new Set(firstPart.rows.map((r) => r.line_id));
  // Meanwhile records come and go.
  for (let i = 1000; i < 1100; i++) {
    things.get(`t${String(i).padStart(5, "0")}`)!.gone = true;
    db.touch(`t${String(i).padStart(5, "0")}`);
  }
  things.set("t90000", { n: 9, label: "Late", lines: 2, rev: 1 });
  db.touch("t90000");
  assert.equal((await page(db, "thing_lines", { pageSize: 1 })).total, total - 100 + 2, "the tables themselves have moved on");
  let cursor = firstPart.nextCursor;
  let parts = 1;
  while (cursor) {
    const next = await db.page("thing_lines_with_record", { page: 1, pageSize: 10_000, cursor, skipTotal: true });
    for (const r of next.rows) {
      assert.ok(!taken.has(r.line_id), `repeated ${String(r.line_id)}`);
      taken.add(r.line_id);
    }
    cursor = next.nextCursor ?? null;
    parts++;
  }
  assert.deepEqual([taken.size, parts], [total, 3], "every row that was there when the export began, once");
  await refusedWith(() => db.page("thing_lines", { page: 1, pageSize: 10_000, cursor: "no-such-export" }), 410, "an export that is not open");
  // A small export finishes in one part and says so.
  assert.equal((await db.page("things", { page: 1, pageSize: 100_000 })).nextCursor, null);

  // ── The words the query language keeps for itself ────────────────────────
  // Every keyword the engine has, tried as a bare column name and as a bare
  // table name the way a person or the assistant would write it. The list in
  // src/apps/records/types.ts must be exactly the ones that do not work.
  {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const works = async (sql: string): Promise<boolean> => conn.run(sql).then(() => true, () => false);
    const unusable: string[] = [];
    for (const row of (await conn.runAndReadAll("select keyword_name from duckdb_keywords() order by 1")).getRowObjects()) {
      const w = String(row.keyword_name);
      await conn.run("drop table if exists probe_t");
      const asColumn = (await works(`create table probe_t (${w} integer, other integer)`)) && (await works(`select t.${w}, sum(other) from probe_t t where ${w} > 1 group by ${w} order by ${w}`));
      await conn.run("drop table if exists probe_t");
      const asTable = (await works(`create table ${w} (a integer)`)) && (await works(`select x.a from ${w} x join ${w} y using (a)`));
      await conn.run(`drop table if exists "${w}"`);
      if (!asColumn || !asTable) unusable.push(w);
    }
    assert.deepEqual([...RESERVED_WORDS].sort(), unusable.sort(), "RESERVED_WORDS in src/apps/records/types.ts must be the words the engine will not take as a bare name");
    conn.disconnectSync();
  }

  // ── What did not fit its column is never silent ──────────────────────────
  Object.assign(things.get("t00003")!, { n: "12 pcs", rev: 9 });
  Object.assign(things.get("t00004")!, { n: "about forty", rev: 9 });
  db.touch("t00003");
  db.touch("t00004");
  assert.deepEqual((await page(db, UNFIT_TABLE)).rows, [
    { record_id: "t00003", table_name: "things", column_name: "n", line_no: null, value: "12 pcs" },
    { record_id: "t00004", table_name: "things", column_name: "n", line_no: null, value: "about forty" },
  ]);
  const counted = await db.count("things", { label: "Thing 3" });
  assert.deepEqual([counted.rows > 100, counted.correcting, counted.unfit], [true, 0, 1]);
  assert.equal((await db.count("things", { label: "Thing 5" })).unfit, 0);
  assert.equal((await db.count("thing_lines_with_record", { record_id: "t00004" })).unfit, 1);
  // Put right, it leaves the list.
  Object.assign(things.get("t00003")!, { n: 12, rev: 10 });
  db.touch("t00003");
  assert.deepEqual((await page(db, UNFIT_TABLE)).rows.map((r) => r.record_id), ["t00004"]);
  Object.assign(things.get("t00004")!, { n: 40, rev: 10 });
  db.touch("t00004");
  assert.equal((await page(db, UNFIT_TABLE)).total, 0);

  // ── A client's own query as a view ───────────────────────────────────────
  await db.close();
  db = make({ views: { by_label: { sql: "select label, count(*) as things, sum(n) as total, max(seen_at) as latest from things group by label", label: "Things by label" } } });
  const view = await page(db, "by_label", { sort: { key: "things", direction: "desc" }, pageSize: 3 });
  assert.equal(view.total, 101);
  assert.deepEqual(Object.keys(view.rows[0]), ["label", "things", "total", "latest"]);
  assert.deepEqual(db.relation("by_label")!.columns.map((c) => c.type), ["text", "integer", "number", "timestamp"]);
  assert.equal((await page(db, "by_label", { filters: { label: "thing 7" } })).total, 1);
  assert.equal((await page(db, "by_label", { filters: { q: "Late" } })).total, 1);
  // What is selected elsewhere on the page says nothing about rows that are not of one record.
  assert.equal((await page(db, "by_label", { selection: { type: "rows", ids: ["t00003"] } })).total, 101);
  assert.equal((await page(db, "things", { selection: { type: "rows", ids: ["t00003"] } })).total, 1);
  await db.close();
  // One query may read another, whichever was declared first; and whatever
  // types a query's columns come out as, they sort and filter like a table's.
  db = make({
    readTimeoutMs: 400,
    views: {
      top: { sql: "select * from odd where whole > 1", label: "Declared before what it reads" },
      odd: {
        sql: "select uuid() as an_id, [1, 2] as a_list, interval 1 day as a_while, timestamp_s '2026-11-21 16:30:00' as second, time '10:30:00' as a_time, 3::utinyint as whole, 99999999999999999999::hugeint as huge, 1.50::decimal(9,2) as money, label from things",
        label: "Columns of every sort",
      },
      slow: { sql: "select sum((a.range * b.range) % 7) as n from range(3000000) a, range(3000000) b", label: "Never finishes" },
      commented: { sql: "select label, count(*) as n from things group by label -- one row per label", label: "Ends in a comment" },
      lists: { sql: "select label, list(seen_at) as moments, list(n::decimal(10,2)) as amounts from things group by label", label: "Lists of things" },
    },
  });
  await db.prepare();
  assert.deepEqual(db.relation("odd")!.columns.map((c) => c.type), ["text", "text", "text", "timestamp", "text", "integer", "number", "number", "text"]);
  for (const key of ["an_id", "a_list", "a_while", "second", "a_time", "whole", "huge", "money"]) {
    for (const direction of ["asc", "desc"] as const) assert.equal((await page(db, "odd", { sort: { key, direction }, pageSize: 2 })).rows.length, 2, `sorting by ${key}`);
    assert.ok((await page(db, "odd", { filters: { [key]: "x" }, pageSize: 1 })).total >= 0, `filtering by ${key}`);
    assert.ok((await page(db, "odd", { filters: { [`${key}_from`]: "2026-11-01" }, pageSize: 1 })).total >= 0, `a range on ${key}`);
  }
  const oddRow = (await page(db, "odd", { pageSize: 1 })).rows[0];
  assert.deepEqual([oddRow.a_list, oddRow.a_while, oddRow.a_time, oddRow.whole, oddRow.huge, oddRow.money], ["[1, 2]", "1 day", "10:30:00", 3, 1e20, 1.5]);
  assert.equal((await page(db, "top", { pageSize: 1 })).total, (await page(db, "odd", { pageSize: 1 })).total);
  assert.equal((await page(db, "commented", { pageSize: 1 })).total, 101);
  // A list of moments is a list, not a moment: it is text, and reads as text.
  assert.deepEqual(db.relation("lists")!.columns.map((c) => c.type), ["text", "text", "text"]);
  assert.match(String((await page(db, "lists", { pageSize: 1, sort: { key: "moments", direction: "asc" } })).rows[0].moments), /^\['2026-11-22 00:30/);
  // A total of the client's own can add up anything, so it is told of every value the app's tables left out.
  assert.deepEqual(await db.count("commented"), { rows: 101, correcting: 0, unfit: 0, unfitAnywhere: true });
  // A page over a query that would never finish is stopped, and says why.
  started = Date.now();
  const tooSlow = await refusedWith(() => page(db, "slow"), 503, "a page over an endless query");
  assert.match(tooSlow.message, /took longer than 0\.4 seconds and was stopped/);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await page(db, "things", { pageSize: 1 })).rows.length, 1, "and the tables still answer");
  // Many people open that page at once: two are read at a time, the rest
  // wait their turn or are told to come back, and the tables beside it
  // answer all the while.
  const crowd = Array.from({ length: 10 }, () => page(db, "slow").then(() => "ok", (err: RecordsError) => err.statusCode));
  await sleep(100);
  assert.equal(db.status().viewTurns.free, 0);
  let slowest = 0;
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    await page(db, "things", { pageSize: 5 });
    slowest = Math.max(slowest, Date.now() - t0);
    await sleep(40);
  }
  assert.ok(slowest < 300, `a table waited ${slowest} ms behind slow queries of the client's own`);
  assert.deepEqual([...new Set(await Promise.all(crowd))], [503]);
  for (let i = 0; db.status().viewTurns.free < 1; i++) {
    await sleep(50);
    assert.ok(i < 200, "the turn for the client's own queries never came back");
  }
  // An export of one takes the same turn, and fails as plainly as a page does.
  const exports = Array.from({ length: 6 }, () => db.page("slow", { page: 1, pageSize: 20_000 }).then(() => "ok", (err: RecordsError) => err.statusCode));
  await sleep(100);
  assert.equal(db.status().viewTurns.free, 0);
  const t1 = Date.now();
  await page(db, "things", { pageSize: 5 });
  assert.ok(Date.now() - t1 < 300, `a table waited ${Date.now() - t1} ms behind exports of the client's own queries`);
  assert.deepEqual([...new Set(await Promise.all(exports))], [503]);
  for (let i = 0; db.status().viewTurns.free < 1; i++) {
    await sleep(50);
    assert.ok(i < 200, "the turn never came back after the exports");
  }
  const failing = make({ views: { fails: { sql: "select cast(label as integer) as x from things", label: "Fails when read" } } });
  for (const pageSize of [50, 20_000]) {
    const failure = await refusedWith(() => failing.page("fails", { page: 1, pageSize }), 500, `a query that fails when read (${pageSize} rows asked for)`);
    assert.match(failure.message, /^"fails" could not be read: /);
  }
  await failing.close();
  // The whole of a client's own query can be exported in parts, like a table.
  const firstOf = await db.page("odd", { page: 1, pageSize: 10_000 });
  let got = firstOf.rows.length;
  for (let next = firstOf.nextCursor; next; ) {
    const part = await db.page("odd", { page: 1, pageSize: 10_000, cursor: next, skipTotal: true });
    got += part.rows.length;
    next = part.nextCursor ?? null;
  }
  assert.equal(got, firstOf.total);
  for (const bad of [{ sql: "select 1; select 2" }, { sql: "delete from things" }, { sql: "select nope from things" }, { sql: "select 1 as a, 2 as a" }, { sql: 'select 1 as a, 2 as "A"' }, { sql: "select 1 as \" \"" }]) {
    const broken = make({ views: { v: { ...bad, label: "x" } } });
    await assert.rejects(() => broken.prepare(), /the query of "v" cannot be used/);
    await broken.close();
  }
  await assert.rejects(() => make({ timezone: "Mars/Olympus" }).prepare(), /is not a time zone this server knows/);

  // ── A start that fails is tried again ────────────────────────────────────
  await db.close();
  refuse = 1;
  db = make();
  await refusedWith(() => page(db, "things"), 503, "while the records cannot be listed");
  await refusedWith(() => page(db, "things"), 503, "asked again straight away");
  await sleep(200);
  assert.ok((await page(db, "things")).total > 0, "and tried again a little later");

  // ── A long build says how far it has got ─────────────────────────────────
  await db.close();
  slow = 2;
  db = make({ buildWaitMs: 60 });
  const waiting = await refusedWith(() => page(db, "things"), 503, "while the tables are being built");
  assert.match(waiting.message, /still being put into tables \([\d,]+ of [\d,]+\)\. Try again in a moment\./);
  slow = 0;
  for (let i = 0; i < 400; i++) {
    const got = await page(db, "things", { pageSize: 1 }).then((r) => r.total, () => -1);
    if (got > 0) break;
    await sleep(50);
    assert.ok(i < 399, "the build never finished");
  }

  // ── Stopping at an awkward time ──────────────────────────────────────────
  await db.close();
  await refusedWith(() => page(db, "things"), 503, "after it was closed");
  db.touch("t00003");
  slow = 5;
  db = make();
  const opening = db.open().then(() => "opened", () => "failed");
  const reading = page(db, "things").then(() => "answered", (err: RecordsError) => err.statusCode);
  await sleep(100);
  started = Date.now();
  await db.close();
  assert.ok(Date.now() - started < 3000, `closing during a build took ${Date.now() - started} ms`);
  assert.equal(await opening, "opened");
  assert.equal(await reading, 503);
  slow = 0;
  // Stopped while many reads are only just beginning: none is left holding a
  // connection to a database that has gone, and nothing falls over.
  for (let round = 0; round < 30; round++) {
    const quick = make();
    await quick.prepare();
    const reads = Array.from({ length: 12 }, () => page(quick, "things", { pageSize: 1 }).then(() => "ok", (err: RecordsError) => err.statusCode));
    if (round % 3 === 1) await sleep(round);
    await quick.close();
    assert.ok((await Promise.all(reads)).every((r) => r === "ok" || r === 503));
  }
  // A query still running when the server stops is stopped with it.
  db = make();
  await page(db, "things", { pageSize: 1 });
  const running = db.query(endless, { timeoutMs: 60_000 }).then(() => "ok", (err: RecordsError) => err.statusCode);
  await sleep(200);
  started = Date.now();
  await db.close();
  assert.ok([503, 400].includes((await running) as number));
  assert.ok(Date.now() - started < 3000, `closing with a query running took ${Date.now() - started} ms`);

  // ── The store's change stamps ────────────────────────────────────────────
  const storeDir = join(dir, "store");
  const doc = (id: string, counts: string | null, padding = ""): StoredDocument =>
    ({ id, appId: "x", status: "review", createdAt: "2026-01-01T00:00:00.000Z", createdBy: null, batch: null, name: id, originals: [], pages: [], configVersion: "1", documentType: null, group: null, reading: null, values: { counts: counts as never, padding }, tables: {}, resolved: {}, flags: {}, versions: [], history: [] }) as StoredDocument;
  const store = new EncodingStore(storeDir, "x", { counted: (d) => (d.values.counts as string | null) ?? null });
  await store.init();
  assert.equal(store.identity().length, 36);
  assert.deepEqual(store.changes(null, 10), []);
  // Stamped only when what it counts for changes.
  const one = doc("one", null);
  await store.save(one);
  assert.equal(store.changes(null, 10).length, 0, "a record that has never counted is not a change");
  one.values.counts = "v1";
  await store.save(one);
  const stamp1 = store.changes(null, 10);
  assert.deepEqual(stamp1.map((x) => [x.id, x.removed]), [["one", false]]);
  one.values.padding = "an answer, a note: nothing that counts";
  await store.save(one);
  assert.deepEqual(store.changes(null, 10), stamp1, "storing it again without changing what counts leaves its stamp alone");
  one.values.counts = null;
  await store.save(one);
  const stamp2 = store.changes(null, 10);
  assert.deepEqual([stamp2.map((x) => [x.id, x.removed]), stamp2[0].seq > stamp1[0].seq], [[["one", true]], true]);
  assert.deepEqual(store.changes(stamp2[0], 10), []);
  // A change is never handed out while an earlier one is still being written:
  // whoever follows the list remembers the last number, so a lower number
  // must never turn up later.
  const big = doc("big", "v1", "x".repeat(30_000_000));
  const small = doc("small", "v1");
  const writingBig = store.save(big);
  await store.save(small);
  const during = store.changes(stamp2[0], 10).map((x) => x.id);
  await writingBig;
  const afterwards = store.changes(stamp2[0], 10).map((x) => x.id);
  assert.deepEqual(afterwards, ["big", "small"]);
  assert.ok(during.length === 0 || during[0] === "big", `handed out ${JSON.stringify(during)} while "big" was still being written`);
  // A record that could not be stored is not stamped, and the list goes on.
  await chmod(join(storeDir, "docs"), 0o555);
  small.values.counts = "v2";
  await assert.rejects(() => store.save(small));
  await chmod(join(storeDir, "docs"), 0o755);
  assert.deepEqual(store.changes(stamp2[0], 10).map((x) => x.id), ["big", "small"]);
  await store.save(small);
  assert.deepEqual(store.changes(stamp2[0], 10).map((x) => x.id), ["big", "small"], "still once each");
  // A record handed over without the stamp it carries keeps it.
  const bare = doc("small", "v2");
  assert.equal(bare.counted, undefined);
  await store.save(bare);
  assert.deepEqual(store.changes(stamp2[0], 10).map((x) => x.id), ["big", "small"]);
  assert.equal(JSON.parse(await readFile(join(storeDir, "docs", "small.json"), "utf8")).counted.seq, store.changes(stamp2[0], 10)[1].seq);
  // What a write that was cut short left behind is cleared away at the next start.
  await writeFile(join(storeDir, "docs", "small.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"), "{ half a rec");
  // Stamps and the store's id are kept with the records: another start finds the same.
  const again = new EncodingStore(storeDir, "x", { counted: (d) => (d.values.counts as string | null) ?? null });
  await again.init();
  assert.equal(again.identity(), store.identity());
  assert.deepEqual(again.changes(null, 10), store.changes(null, 10));
  assert.ok(again.changedAt() >= store.changes(null, 10).at(-1)!.at);
  assert.ok(!(await readFile(join(storeDir, "docs", "small.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"), "utf8").then(() => true, () => false)));

  // Records stamped in the same instant (records from before stamps were
  // kept get theirs from when they were approved) are still handed out one
  // after another, however small the pages.
  const tiesDir = join(dir, "ties");
  await mkdir(join(tiesDir, "docs"), { recursive: true });
  const same = "2026-03-01T08:00:00.000Z";
  for (const id of ["f", "b", "d", "a", "e", "c"]) {
    const legacy = doc(id, "v1");
    legacy.versions = [{ version: 1, at: same, by: "x", documentType: "t", group: null, configVersion: "1", values: {}, tables: {} }];
    await writeFile(join(tiesDir, "docs", `${id}.json`), JSON.stringify(legacy));
  }
  const ties = new EncodingStore(tiesDir, "x", { counted: (d) => (d.versions.length > 0 || d.id === "g" ? "v1" : null) });
  await ties.init();
  const walked: string[] = [];
  for (let at: { seq: number; id: string } | null = null; ; ) {
    const part = ties.changes(at, 2);
    if (part.length === 0) break;
    walked.push(...part.map((x) => x.id));
    at = part.at(-1)!;
  }
  assert.deepEqual(walked, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(new Set(ties.changes(null, 10).map((x) => x.seq)).size, 1, "all six carry the same number");

  // ── Whether a copy can carry on ──────────────────────────────────────────
  // A copy hands back where the store stood when it last asked (the store's
  // mark). The store carries on from there only if that is somewhere it has
  // really been: a run it remembers, no further than that run got.
  const counts6 = (d: StoredDocument): string | null => (d.versions.length > 0 || d.values.counts ? String(d.values.counts ?? "v1") : null);
  const openAt = async (where: string, heard: string[] = []): Promise<EncodingStore> => {
    const opened = new EncodingStore(where, "x", { counted: counts6, log: (message, level) => void (level === "error" && heard.push(message)) });
    await opened.init();
    return opened;
  };
  const m0 = ties.mark();
  assert.ok(ties.continues(m0));
  assert.ok(!ties.continues({ run: "not-a-run", high: 0 }), "a run this store never had");
  assert.ok(!ties.continues({ run: m0.run, high: m0.high + 1 }), "further than this run has got");
  assert.ok(!ties.continues({ run: m0.run, high: -1 }) && !ties.continues({ run: m0.run, high: NaN }));
  await ties.save(doc("g", "v1"));
  const m1 = ties.mark();
  assert.ok(m1.high > m0.high && ties.continues(m0) && ties.continues(m1));
  // Restarts, as many as you like, change nothing about that.
  let again2 = await openAt(tiesDir);
  again2 = await openAt(tiesDir);
  assert.ok(again2.continues(m0) && again2.continues(m1) && again2.identity() === ties.identity());
  assert.ok(!again2.continues({ run: m1.run, high: m1.high + 1 }), "a run reached no further than where the next began");

  // The records are put back from an older copy. Every way of having been
  // told something since that copy was taken is refused, whatever happens
  // after the restore and however many restarts go by before the copy asks.
  const copyDir = async (from: string, to: string): Promise<void> => {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  };
  const backup = join(dir, "ties-backup");
  await copyDir(tiesDir, backup);
  const beforeBackup = again2.mark();
  // After the backup: a record changes, and a copy asks (within the same run, then in a later one).
  const moved = (await again2.read("a"))!;
  await again2.update("a", (d) => void (d.values.counts = "v2"));
  const toldInSameRun = again2.mark();
  const later = await openAt(tiesDir);
  await later.save(doc("h", "v1"));
  const toldInLaterRun = later.mark();
  assert.ok(moved && later.continues(toldInSameRun) && later.continues(toldInLaterRun));
  // The restore, and then work goes on before any copy asks; and another restart.
  await copyDir(backup, tiesDir);
  let restored = await openAt(tiesDir);
  await restored.update("a", (d) => void (d.values.counts = "v3"));
  await restored.save(doc("i", "v1"));
  for (const round of [1, 2]) {
    assert.ok(!restored.continues(toldInSameRun), `told after the backup, in the run that was going when it was taken (start ${round})`);
    assert.ok(!restored.continues(toldInLaterRun), `told in a run the backup knows nothing of (start ${round})`);
    assert.ok(restored.continues(beforeBackup), `told before the backup was taken: nothing it knows was lost (start ${round})`);
    restored = await openAt(tiesDir);
  }
  assert.equal(restored.identity(), ties.identity(), "a restore needs no new identity to be noticed");
  await rm(backup, { recursive: true, force: true });

  // A record's file that is gone: said loudly, and every copy starts again.
  // Whether or not the index survives to the same start.
  for (const loseIndexToo of [false, true]) {
    const before = await openAt(tiesDir);
    const victim = before.changes(null, 100).find((x) => !x.removed)!.id;
    const kept = await readFile(join(tiesDir, "docs", `${victim}.json`), "utf8");
    await rm(join(tiesDir, "docs", `${victim}.json`));
    if (loseIndexToo) await rm(join(tiesDir, "index.jsonl"));
    const heard: string[] = [];
    const after = await openAt(tiesDir, heard);
    assert.notEqual(after.identity(), before.identity(), loseIndexToo ? "with the index gone too" : "with the index there");
    if (!loseIndexToo) assert.ok(heard.some((m) => m.includes(`record file docs/${victim}.json is gone`)), JSON.stringify(heard));
    assert.ok(heard.some((m) => m.includes("every copy kept of these records starts again")));
    assert.ok(!after.changes(null, 100).some((x) => x.id === victim));
    // Put back by hand, it returns with the stamp it had, which every copy
    // has long gone past: so again every copy starts again, and gets it.
    const quiet = await openAt(tiesDir);
    assert.equal(quiet.identity(), after.identity(), "a start where nothing is amiss keeps the identity");
    await writeFile(join(tiesDir, "docs", `${victim}.json`), kept);
    const returned = await openAt(tiesDir);
    assert.notEqual(returned.identity(), after.identity(), "a record that is back");
    assert.ok(returned.changes(null, 100).some((x) => x.id === victim));
  }
  // The same for a record that could not be read for a while (its file damaged, then put right).
  {
    const before = await openAt(tiesDir);
    const all = before.changes(null, 100);
    const victim = all[0].id;
    const kept = await readFile(join(tiesDir, "docs", `${victim}.json`), "utf8");
    await writeFile(join(tiesDir, "docs", `${victim}.json`), kept.slice(0, 40));
    const damaged = await openAt(tiesDir);
    assert.equal(damaged.identity(), before.identity(), "a record that cannot be read is not a record that is gone: nobody is told it was withdrawn");
    assert.ok(damaged.continues(before.mark()));
    await writeFile(join(tiesDir, "docs", `${victim}.json`), kept);
    const mended = await openAt(tiesDir);
    assert.notEqual(mended.identity(), before.identity(), "back, with a stamp older than what copies have gone past");
    assert.deepEqual(mended.changes(null, 100).map((x) => x.id).sort(), all.map((x) => x.id).sort());
  }
  // What a start clears away is only what a cut-short write of its own left.
  await mkdir(join(tiesDir, "old-copy.tmp"));
  await mkdir(join(tiesDir, "docs", "kept-folder.tmp"));
  await writeFile(join(tiesDir, "my-export.tmp"), "a person's own file");
  await writeFile(join(tiesDir, "docs", "a.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"), "{ half a rec");
  const reopened = await openAt(tiesDir);
  assert.equal(await readFile(join(tiesDir, "my-export.tmp"), "utf8"), "a person's own file");
  assert.ok(!(await readFile(join(tiesDir, "docs", "a.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"), "utf8").then(() => true, () => false)));
  // The configuration records are approved under is kept beside them, once per version.
  await reopened.keepConfig("0123456789abcdef", { forms: 1 });
  await reopened.keepConfig("0123456789abcdef", { forms: 2 });
  await reopened.keepConfig("../escape", { forms: 3 });
  const keptConfig = JSON.parse(await readFile(join(tiesDir, "configs", "0123456789abcdef.json"), "utf8"));
  assert.deepEqual([keptConfig.version, keptConfig.config], ["0123456789abcdef", { forms: 1 }]);

  await sleep(50);
  assert.deepEqual(unhandled, [], "nothing was left unhandled");
  console.log("records-database: ok");
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
  await chmod(join(dir, "store", "docs"), 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
