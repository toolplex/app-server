// Analytics lookups against a real SQLite database (node:sqlite): schema,
// values that exist / do not, join keys that repeat, and the HTTP routes.
// Run: npx tsx test/analytics-lookups.ts
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { registerAppPages, createAnalytics } from "../src/index.js";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE fact_sales (stock_num TEXT, store_name TEXT, sold INTEGER);
  CREATE TABLE dim_store (store_name TEXT, chain TEXT);
  CREATE TABLE dim_sku (stock_num TEXT, brand TEXT);
  CREATE TABLE dim_variant (stock_id INTEGER, color TEXT);
  CREATE TABLE monthly (year INTEGER, month INTEGER, sale_date TEXT, amt REAL);
  INSERT INTO monthly VALUES (2025,12,'2025-12-31',1),(2026,7,'2026-07-21',2),(2026,3,'2026-03-05',3),(NULL,9,NULL,4);
  CREATE TABLE secrets (k TEXT);
  INSERT INTO dim_store VALUES ('TOWN BAZAAR','Other'),('TOWN BAZAAR','Other'),('MALL ONE','MO'),('LONE','Other'),('LONE','Other');
  INSERT INTO dim_variant VALUES (142,'RED'),(142,'BLUE'),(7,'RED');
  INSERT INTO dim_sku VALUES ('142','Harborline'),('0222','Harborline'),('PM','Vento');
  INSERT INTO fact_sales VALUES ('142','TOWN BAZAAR',30),('0222','TOWN BAZAAR',60),('142','MALL ONE',5),('PM','MALL ONE',7),('PM','LONE',1);
`);
const query = async (sql: string, params: unknown[]) => db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[];
const cfg = { dialect: "sqlite" as const, query, deniedTables: ["secrets"], sqlTools: ["execute_sql", "generate_from_sql"] };
const a = createAnalytics(cfg);

const tables = await a.schema();
assert.deepEqual(tables.map((t) => t.name).sort(), ["dim_sku", "dim_store", "dim_variant", "fact_sales", "monthly"]); // the denied table is absent
assert.deepEqual(tables.find((t) => t.name === "dim_sku")!.columns.map((c) => c.name), ["stock_num", "brand"]);

const d = await a.distinct({ table: "DIM_SKU", column: "Brand", values: ["HARBORLINE", "Ventos", ""] }) as any;
assert.deepEqual(d.matches, [{ value: "Harborline", count: 2 }]); // found, in its real spelling
assert.deepEqual(d.missing, [{ value: "Ventos", closest: [{ value: "Vento", count: 1 }] }]);
assert.match(((await a.distinct({ table: "secrets", column: "k", values: ["x"] })) as any).error, /unknown table/);
assert.match(((await a.distinct({ table: "dim_sku", column: "nope\"; DROP", values: ["x"] })) as any).error, /unknown column/);

// TOWN BAZAAR repeats in both tables; LONE repeats only in dim_store; MALL ONE only in fact_sales.
assert.equal(((await a.repeats({ left: { table: "fact_sales", columns: ["store_name"] }, right: { table: "dim_store", columns: ["store_name"] } })) as any).repeated, 1);
// a key that is unique on one side repeats nothing
assert.equal(((await a.repeats({ left: { table: "fact_sales", columns: ["stock_num"] }, right: { table: "dim_sku", columns: ["stock_num"] } })) as any).repeated, 0);
// a text key against a number (the query casts one): compared as text, '142' is 142
const seen: string[] = [];
const mixed = createAnalytics({ ...cfg, query: (sql, params) => { seen.push(sql); return query(sql, params); } });
assert.deepEqual(await mixed.repeats({ left: { table: "fact_sales", columns: ["stock_num"] }, right: { table: "dim_variant", columns: ["stock_id"] } }),
  { left: { table: "fact_sales", columns: ["stock_num"] }, right: { table: "dim_variant", columns: ["stock_id"] }, repeated: 1 });
assert.match(seen[seen.length - 1], /CAST\("stock_num" AS TEXT\) AS c1 FROM "fact_sales".*CAST\("stock_id" AS TEXT\) AS c1 FROM "dim_variant"/s);
await mixed.repeats({ left: { table: "fact_sales", columns: ["store_name"] }, right: { table: "dim_store", columns: ["store_name"] } });
assert.doesNotMatch(seen[seen.length - 1], /CAST/); // same kind of type: compared as they are
assert.match(((await a.repeats({ left: { table: "fact_sales", columns: ["x"] }, right: { table: "dim_sku", columns: ["stock_num"] } })) as any).error, /unknown column/);

// where the data ends: the latest (year, month) is 2026-07, not the greatest month of any year
assert.deepEqual(await a.latest({ table: "monthly", columns: ["year", "month"] }), { table: "monthly", columns: ["year", "month"], latest: ["2026", "7"] });
assert.deepEqual(((await a.latest({ table: "MONTHLY", columns: ["sale_date"] })) as any).latest, ["2026-07-21"]);
assert.equal(((await a.latest({ table: "secrets", columns: ["k"] })) as any).latest, undefined);
assert.match(((await a.latest({ table: "monthly", columns: [] })) as any).error, /1 to 3 columns/);

// values in memory: a column asked about is loaded once, then answered without reading the table,
// with the same matches and closest values as the SQL answer
{
  const reads: string[] = [];
  const mem = createAnalytics({ ...cfg, warmRefreshMinutes: 5, query: (sql, params) => { reads.push(sql); return query(sql, params); } });
  const viaSql = await mem.distinct({ table: "dim_sku", column: "brand", values: ["HARBORLINE", "Ventos"] }) as any;
  await new Promise((r) => setTimeout(r, 20)); // the load runs behind the answer
  reads.length = 0;
  const viaMem = await mem.distinct({ table: "dim_sku", column: "brand", values: ["HARBORLINE", "Ventos"] }) as any;
  assert.deepEqual(viaMem.matches, viaSql.matches);
  assert.deepEqual(viaMem.missing, viaSql.missing);
  assert.ok(!reads.some((q) => /FROM "dim_sku"/.test(q)), "answered from memory");
}
// configured columns are loaded at start; a number column is never kept
{
  const reads: string[] = [];
  const warm = createAnalytics({ ...cfg, warmColumns: [{ table: "DIM_STORE", column: "Chain" }], query: (sql, params) => { reads.push(sql); return query(sql, params); } });
  const stop = warm.startWarming();
  await new Promise((r) => setTimeout(r, 30));
  reads.length = 0;
  assert.deepEqual(((await warm.distinct({ table: "dim_store", column: "chain", values: ["mo"] })) as any).matches, [{ value: "MO", count: 1 }]);
  assert.ok(!reads.some((q) => /FROM "dim_store"/.test(q)), "configured column answered from memory");
  await warm.distinct({ table: "fact_sales", column: "sold", values: ["30"] });
  await new Promise((r) => setTimeout(r, 20));
  reads.length = 0;
  await warm.distinct({ table: "fact_sales", column: "sold", values: ["30"] });
  assert.ok(reads.some((q) => /FROM "fact_sales"/.test(q)), "a number column is asked through SQL");
  stop();
}
// where the complete data ends, when the client says; nothing when it does not or cannot
{
  const done = createAnalytics({ ...cfg, completeThrough: (table) => (table === "monthly" ? { through: "2026-05-31", rule: "a month counts once 60 days have passed since it ended" } : null) });
  assert.deepEqual(await done.latest({ table: "monthly", columns: ["sale_date"] }),
    { table: "monthly", columns: ["sale_date"], latest: ["2026-07-21"], complete_through: "2026-05-31", completeness: "a month counts once 60 days have passed since it ended" });
  assert.equal(((await done.latest({ table: "fact_sales", columns: ["sold"] })) as any).complete_through, undefined);
  const odd = createAnalytics({ ...cfg, completeThrough: () => ({ through: "last May" }) });
  assert.equal(((await odd.latest({ table: "monthly", columns: ["sale_date"] })) as any).complete_through, undefined);
  const throws = createAnalytics({ ...cfg, completeThrough: () => { throw new Error("no"); } });
  assert.deepEqual(((await throws.latest({ table: "monthly", columns: ["sale_date"] })) as any).latest, ["2026-07-21"]);
}

// the latest period value is kept in memory: a configured period is loaded at start, one asked about
// is kept after its first answer, and neither reads the table again while fresh
{
  const reads: string[] = [];
  const lp = createAnalytics({ ...cfg, warmPeriods: [{ table: "MONTHLY", columns: ["sale_date"] }], query: (sql, params) => { reads.push(sql); return query(sql, params); } });
  const stop = lp.startWarming();
  await new Promise((r) => setTimeout(r, 30));
  reads.length = 0;
  assert.deepEqual(((await lp.latest({ table: "monthly", columns: ["sale_date"] })) as any).latest, ["2026-07-21"]);
  assert.ok(!reads.some((q) => /ORDER BY/.test(q)), "configured period answered from memory");
  await lp.latest({ table: "monthly", columns: ["year", "month"] });
  reads.length = 0;
  assert.deepEqual(((await lp.latest({ table: "monthly", columns: ["year", "month"] })) as any).latest, ["2026", "7"]);
  assert.ok(!reads.some((q) => /ORDER BY/.test(q)), "a period asked about once is answered from memory");
  stop();
}
// a value with no rows where it was asked, but present in the column's reference table: said, with no closest values
{
  db.exec(`CREATE TABLE stock_master (stock_num TEXT, active INTEGER); INSERT INTO stock_master VALUES ('142',1),('0222',1),('NEWSKU',1),('PM',1);`);
  const ref = createAnalytics({ ...cfg, valueReferences: [{ column: "stock_num", table: "stock_master" }] });
  const d = await ref.distinct({ table: "fact_sales", column: "stock_num", values: ["142", "NEWSKU", "14"] }) as any;
  assert.deepEqual(d.matches.map((m: any) => m.value), ["142"]);
  assert.deepEqual(d.missing.find((m: any) => m.value === "NEWSKU"), { value: "NEWSKU", closest: [], in_reference: { table: "stock_master", column: "stock_num" } });
  const typo = d.missing.find((m: any) => m.value === "14");
  assert.equal(typo.in_reference, undefined); // not in the reference either: a typo keeps its closest values
  // from memory too, once the reference column is loaded at start
  const reads: string[] = [];
  const warm = createAnalytics({ ...cfg, valueReferences: [{ column: "stock_num", table: "stock_master" }], query: (sql, params) => { reads.push(sql); return query(sql, params); } });
  const stop = warm.startWarming();
  await new Promise((r) => setTimeout(r, 30));
  reads.length = 0;
  assert.deepEqual(((await warm.distinct({ table: "fact_sales", column: "stock_num", values: ["NEWSKU"] })) as any).missing[0].in_reference, { table: "stock_master", column: "stock_num" });
  assert.ok(!reads.some((q) => /FROM "stock_master"/.test(q)), "reference answered from memory");
  // the reference table itself, and a column with no reference, are answered as before
  assert.equal(((await ref.distinct({ table: "stock_master", column: "stock_num", values: ["NOPE"] })) as any).missing[0].in_reference, undefined);
  assert.equal(((await ref.distinct({ table: "dim_sku", column: "brand", values: ["Pumas"] })) as any).missing[0].in_reference, undefined);
  stop();
  db.exec(`DROP TABLE stock_master`);
}

// a view over a denied table shows its rows under another name: it is hidden too, and so is a view over that view
db.exec(`
  CREATE VIEW v_secrets AS SELECT k FROM secrets;
  CREATE VIEW v_again AS SELECT k FROM v_secrets;
  CREATE VIEW v_stores AS SELECT store_name FROM dim_store;
  CREATE TABLE not_secrets (k TEXT);
  CREATE TABLE keyed (id INTEGER PRIMARY KEY, code TEXT, region TEXT, v TEXT);
  CREATE UNIQUE INDEX keyed_code ON keyed (code, region);
  CREATE UNIQUE INDEX keyed_part ON keyed (v) WHERE v IS NOT NULL;
`);
const fresh = createAnalytics(cfg);
assert.deepEqual((await fresh.schema()).map((t) => t.name).sort(), ["dim_sku", "dim_store", "dim_variant", "fact_sales", "keyed", "monthly", "not_secrets", "v_stores"]);
assert.match(((await fresh.distinct({ table: "v_again", column: "k", values: ["x"] })) as any).error, /unknown table/);
// the deny list may spell the name with its schema or in another case
assert.ok(!(await createAnalytics({ ...cfg, deniedTables: ["public.Secrets"] }).schema()).some((t) => /secret/.test(t.name) && t.name !== "not_secrets"));
// what a view reads cannot be told: every view is left out
const blind = createAnalytics({ ...cfg, query: (sql, params) => (/type = 'view'/.test(sql) && !/pragma/.test(sql) ? Promise.reject(new Error("no")) : query(sql, params)) });
assert.ok(!(await blind.schema()).some((t) => t.kind === "view"));

// a side with a primary key or a whole unique index on the join columns: zero, and neither table is read
const scans: string[] = [];
const keyed = createAnalytics({ ...cfg, query: (sql, params) => { scans.push(sql); return query(sql, params); } });
await keyed.schema();
scans.length = 0;
assert.deepEqual(await keyed.repeats({ left: { table: "fact_sales", columns: ["sold"] }, right: { table: "keyed", columns: ["id"] } }),
  { left: { table: "fact_sales", columns: ["sold"] }, right: { table: "keyed", columns: ["id"] }, repeated: 0, unique_key: true });
assert.ok(!scans.some((q) => /GROUP BY/.test(q)));
assert.equal(((await keyed.repeats({ left: { table: "keyed", columns: ["region", "code"] }, right: { table: "dim_store", columns: ["chain", "store_name"] } })) as any).unique_key, true);
// part of a key, or a partial index, is not one row per value
for (const columns of [["code"], ["v"]]) {
  scans.length = 0;
  assert.equal(((await keyed.repeats({ left: { table: "keyed", columns }, right: { table: "dim_sku", columns: ["brand"] } })) as any).unique_key, undefined);
  assert.ok(scans.some((q) => /GROUP BY/.test(q)));
}

// Over HTTP, behind the plugin's bearer token; absent when not configured.
const on = Fastify();
await on.register(registerAppPages, { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false }, analytics: cfg });
const h = { authorization: "Bearer t" };
assert.equal((await on.inject({ url: "/analytics/schema" })).statusCode, 401);
assert.deepEqual((await on.inject({ url: "/analytics/info", headers: h })).json(), { analytics_version: 6, dialect: "sqlite", sql_tools: ["execute_sql", "generate_from_sql"] });
assert.equal((await on.inject({ url: "/capabilities", headers: h })).json().capabilities.analytics, true);
const rep = await on.inject({ method: "POST", url: "/analytics/repeats", headers: h, payload: { left: { table: "fact_sales", columns: ["store_name"] }, right: { table: "dim_store", columns: ["store_name"] } } });
assert.equal(rep.json().repeated, 1);
assert.equal((await on.inject({ method: "POST", url: "/analytics/distinct", headers: h, payload: { table: "nope", column: "x" } })).statusCode, 400);
const off = Fastify();
await off.register(registerAppPages, { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false } });
assert.equal((await off.inject({ url: "/analytics/schema", headers: h })).statusCode, 404);
assert.equal((await off.inject({ url: "/capabilities", headers: h })).json().capabilities.analytics, false);
console.log("analytics lookups: ok");

// the database's own message does not leave the server
const broken = Fastify();
await broken.register(registerAppPages, { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false },
  analytics: { ...cfg, query: async () => { throw new Error('connection to server at "10.1.2.3", port 5432 failed: FATAL: password authentication failed for user "svc_reports"'); } } });
const failed = await broken.inject({ method: "GET", url: "/analytics/schema", headers: { authorization: "Bearer t" } });
assert.equal(failed.statusCode, 500);
assert.deepEqual(failed.json(), { error: "the lookup failed" });
const slow = Fastify();
await slow.register(registerAppPages, { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false },
  analytics: { ...cfg, query: async () => { throw new Error("canceling statement due to statement timeout"); } } });
assert.deepEqual((await slow.inject({ method: "GET", url: "/analytics/schema", headers: { authorization: "Bearer t" } })).json(), { error: "the lookup timed out" });
console.log("ok: denied views, unique keys, plain errors");
