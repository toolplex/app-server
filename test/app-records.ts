// An app's records as tables, through the server: a query database built
// from the records and kept level with them; pages that read it with their
// own sort, filters and paging; what counts while a record is corrected; the
// client's own queries; the list of changes a copy follows; renames; and
// what is refused at startup. The engine on its own is in records-database.ts.
//   npx tsx test/app-records.ts
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { appRecords, registerAppPages } from "../src/index.js";
import type { DocumentEncodingApp, EncodingHandle } from "../src/index.js";
import type { ReadDocumentRequest } from "../src/apps/encoding/routes.js";
import type { Reading, ReadValue } from "../src/apps/encoding/store.js";

// Under the home directory: the file store (used for the snapshot below) refuses the OS temp dir.
const dir = await mkdtemp(join(homedir(), ".tp-app-records-test-"));
const auth = { authorization: "Bearer t", "x-toolplex-user-id": "u1", "x-toolplex-user-email": "ana@example.com" };
// Two zones a whole day apart, so "today" is never the same day in both.
const ZONE = "Pacific/Kiritimati";
const ELSEWHERE = "Pacific/Pago_Pago";
const dayIn = (zone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const v = (value: string | number | null): ReadValue => ({ value, status: "accepted", candidates: [], written: "printed" });
// The stand-in reader reads the page's own text: "receipt|<reference>|<customer>|<packs>|<packs>…"
// or "invoice|<reference>|<amount>|<charge>|<charge>…".
const readDocument = async (req: ReadDocumentRequest): Promise<Reading> => {
  const [kind, reference, third, ...rest] = Buffer.from(req.pages[0].data, "base64").toString().split("|");
  const form = req.document_type ?? (kind === "invoice" ? "invoice" : "delivery-receipt");
  const done = { checks: [], counts: { accepted: 1, confirm: 0, ask: 0, blank: 0 }, readers: [{ model: "a", ok: true, ms: 1 }, { model: "b", ok: true, ms: 1 }], document_type: form, document_type_agreed: true };
  if (form === "invoice") {
    return { ...done, fields: { reference: v(reference), amount: v(Number(third)) }, tables: { charges: rest.map((c, i) => ({ label: v(`Charge ${i + 1}`), charge: v(Number(c)) })) } };
  }
  return {
    ...done,
    // Dated by how many lines it has, so the receipts fall on different days.
    fields: { reference: v(reference), customer: v(third), total_packs: v(rest.reduce((n, p) => n + Number(p), 0)), dated: v(`2026-11-0${rest.length}`) },
    tables: { items: rest.map((p, i) => ({ sku: v(`Item ${i + 1}`), packs: v(Number(p)) })) },
  };
};

let handle: EncodingHandle | null = null;
const app: DocumentEncodingApp = {
  kind: "document-encoding",
  title: "Receiving",
  records: true,
  config: {
    onReady: (h) => void (handle = h),
    intake: [{ via: "files" }],
    group_by: "reference",
    documents: {
      "delivery-receipt": {
        title: "Delivery receipt",
        recognise: "Headed DELIVERY RECEIPT.",
        fields: [
          { key: "reference", label: "DR number", type: "code", required: true },
          { key: "customer", label: "Customer", type: "name" },
          { key: "total_packs", label: "Total packs", type: "number" },
          { key: "dated", label: "Date", type: "date" },
        ],
        tables: [{ key: "items", label: "Items", columns: [{ key: "sku", label: "Item", type: "name" }, { key: "packs", label: "Packs", type: "number" }] }],
      },
      invoice: {
        title: "Invoice",
        recognise: "Headed INVOICE.",
        fields: [
          { key: "reference", label: "Invoice number", type: "code", required: true },
          { key: "amount", label: "Amount", type: "number" },
        ],
        tables: [{ key: "charges", label: "Charges", columns: [{ key: "label", label: "Charge", type: "text" }, { key: "charge", label: "Value", type: "number" }] }],
      },
    },
  },
};

const table = (source: string, rowKey: string, columns: string[], downloadable = false) => ({ type: "table" as const, source, rowKey, downloadable, columns: columns.map((key) => ({ key, label: key })) });
const config = (theApp: DocumentEncodingApp = app) => ({
  authToken: "t",
  timezone: ZONE,
  actions: {},
  files: { enabled: false, dir },
  platform: { readDocument },
  apps: { receiving: theApp },
  resources: {
    receipts: appRecords("receiving", { form: "delivery-receipt" }),
    receipt_lines: appRecords("receiving", { form: "delivery-receipt", lines: "items" }),
    invoice_lines: appRecords("receiving", { form: "invoice", lines: "charges" }),
    everything: appRecords("receiving"),
    // The client's own figure, as a query over the same tables: read like any table.
    by_customer: appRecords("receiving", { sql: "select customer, sum(total_packs) as packs, count(*) as receipts, max(record_first_approved_at) as latest from delivery_receipt group by customer" }),
    // And worked in the client's own code, for anything a query alone cannot do.
    own_figure: {
      fetch: async (req: { filters?: Record<string, string> }) => {
        const { rows } = await handle!.query("select count(*) as receipts from delivery_receipt where lower(customer) = lower($1)", [req.filters?.customer ?? ""]);
        return { rows, total: rows.length };
      },
      context: async () => ({ summary: "The client's own words about its own figure." }),
    },
  },
  pages: {
    receipts: {
      title: "Receipts",
      sections: [
        table("receipts", "record_id", ["reference", "customer", "total_packs", "record_first_approved_at"], true),
        table("receipt_lines", "line_id", ["reference", "sku", "packs"], true),
      ],
    },
    money: { title: "Invoices", sections: [table("invoice_lines", "line_id", ["label", "charge"]), table("everything", "record_id", ["record_form", "record_name"])] },
    figures: { title: "Figures", sections: [table("by_customer", "customer", ["customer", "packs", "receipts"], true), table("own_figure", "receipts", ["receipts"])] },
    // Records beside data copied from somewhere else, which says for itself when it last arrived.
    mixed: { title: "Mixed", context: async () => ({ summary: "Copied nightly.", lastSync: "2020-01-01T00:00:00.000Z" }), sections: [table("everything", "record_id", ["record_form"])] },
  },
});

let server: FastifyInstance;
/** What the server said at warning level or above, since it was last started. */
let said: { level: number; msg: string; [key: string]: unknown }[] = [];
const start = async (theApp?: DocumentEncodingApp, overrides: Record<string, unknown> = {}): Promise<void> => {
  handle = null;
  said = [];
  server = Fastify({ logger: { level: "warn", stream: { write: (line: string) => void said.push(JSON.parse(line)) } } });
  await server.register(registerAppPages, { ...config(theApp), ...overrides } as never);
  await server.ready();
  // The handle is given once the app's store is open, a moment after the server is up.
  for (let i = 0; i < 500 && !handle; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(handle, "the app never became ready");
};
await start();
const appBase = "/apps/receiving/document-encoding";

function multipart(parts: { name: string; filename?: string; type?: string; body: string }[]) {
  const boundary = "----tp" + Math.random().toString(16).slice(2);
  const chunks = parts.map(
    (p) => `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n` + (p.type ? `Content-Type: ${p.type}\r\n` : "") + `\r\n${p.body}\r\n`,
  );
  return { payload: chunks.join("") + `--${boundary}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
let n = 0;
const settle = async (id: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    const d = (await server.inject({ url: `${appBase}/documents/${id}`, headers: auth })).json();
    if (d.status !== "queued" && d.status !== "reading") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never read");
};
const bring = async (page: string): Promise<string> => {
  const m = multipart([
    { name: "meta", body: JSON.stringify({ upload_id: `up-${++n}` }) },
    { name: "page", filename: `scan-${n}.jpg`, type: "image/jpeg", body: page },
  ]);
  const res = await server.inject({ method: "POST", url: `${appBase}/intake`, payload: m.payload, headers: { ...auth, ...m.headers } });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().documents[0].id as string;
  await settle(id);
  return id;
};
const post = (url: string, body: object) => server.inject({ method: "POST", url: appBase + url, payload: body, headers: auth });
const approve = async (id: string): Promise<void> => assert.equal((await post(`/documents/${id}/approve`, {})).statusCode, 200);
type Row = Record<string, string | number | boolean | null>;
type Rows = { rows: Row[]; total: number; totalPages: number };
const data = async (resource: string, query = ""): Promise<Rows> => {
  const res = await server.inject({ url: `/data/${resource}${query}`, headers: auth });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

/**
 * A copy of the records kept the way the handle's `changes` says to keep
 * one. Compared with the tables at several points: whatever happened in
 * between, the two must agree.
 */
const copy = { cursor: null as string | null, records: new Map<string, Record<string, Row[]>>(), resets: 0 };
const follow = async (): Promise<void> => {
  for (;;) {
    const got = await handle!.changes({ after: copy.cursor, limit: 3 });
    if (got.reset) {
      copy.records.clear();
      copy.resets++;
    }
    for (const c of got.changes) {
      if (c.removed) copy.records.delete(c.record_id);
      else copy.records.set(c.record_id, c.rows);
    }
    copy.cursor = got.cursor;
    if (!got.more) return;
  }
};
const byId = (rows: Row[]): Row[] => [...rows].sort((x, y) => String(x.record_id).localeCompare(String(y.record_id)));
const copyAgrees = async (formTable = "delivery_receipt", resource = "receipts"): Promise<void> => {
  await follow();
  const mine = byId([...copy.records.values()].flatMap((r) => r[formTable] ?? []));
  const theirs = byId((await data(resource, "?pageSize=500")).rows);
  assert.deepEqual(mine, theirs, "a copy kept from the list of changes holds what the tables hold");
};

try {
  // 0. A new app, nothing approved: its pages already say when they were last
  //    changed (an alert can be set up on day one), and a copy starts empty.
  const born = (await server.inject({ url: "/pages/freshness?fresh=1", headers: auth })).json();
  assert.match(born.receipts, /^\d{4}-\d{2}-\d{2}T/);
  await copyAgrees();
  assert.equal(copy.records.size, 0);

  // 1. Read but not approved: it does not count, so no table has it.
  const a = await bring("receipt|DR-100|North Market|200|150");
  for (const r of ["receipts", "receipt_lines", "everything"]) assert.equal((await data(r)).total, 0, r);

  // 2. Approved: one row, the form's fields beside the columns every record has, each of its own type.
  await approve(a);
  const one = (await data("receipts")).rows[0];
  assert.deepEqual(
    { ...one, record_first_approved_at: typeof one.record_first_approved_at, record_approved_at: typeof one.record_approved_at, record_captured_at: typeof one.record_captured_at },
    {
      record_id: a, record_name: "scan-1.jpg", record_group: "DR-100", record_version: 1,
      record_first_approved_at: "string", record_approved_at: "string", record_captured_at: "string", record_correcting: false,
      reference: "DR-100", customer: "North Market", total_packs: 350, dated: "2026-11-02",
    },
  );
  assert.match(String(one.record_first_approved_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(String(one.record_first_approved_at)) - Date.now()) < 60_000, "the moment it was approved, whatever zone days are counted in");
  assert.ok(!("approved_by" in one) && !("record_approved_by" in one), "who approved is the app's business, not every page's");
  const firstApproved = one.record_first_approved_at;
  const all = (await data("everything")).rows[0];
  assert.deepEqual([all.record_id, all.record_form, all.record_form_title, "reference" in all], [a, "delivery-receipt", "Delivery receipt", false]);
  await copyAgrees();

  // 3. One row per line, each with its record's columns beside it.
  const lines = await data("receipt_lines");
  assert.deepEqual(lines.rows.map((r) => [r.line_id, r.line_no, r.sku, r.packs, r.reference, r.record_id, r.total_packs]), [
    [`${a}:1`, 1, "Item 1", 200, "DR-100", a, 350],
    [`${a}:2`, 2, "Item 2", 150, "DR-100", a, 350],
  ]);

  // 4. A correction does not take the record out of the numbers. What was
  //    approved goes on counting, marked as being corrected, until the
  //    correction itself is approved.
  await new Promise((r) => setTimeout(r, 15));
  assert.equal((await post(`/documents/${a}/values`, { changes: [{ path: "items[1].packs", value: 160 }, { path: "total_packs", value: 360 }] })).statusCode, 200);
  const during = (await data("receipts")).rows[0];
  assert.deepEqual([during.total_packs, during.record_correcting, during.record_version], [350, true, 1]);
  assert.deepEqual((await data("receipt_lines")).rows.map((r) => r.packs), [200, 150]);
  await copyAgrees();
  assert.equal(copy.records.get(a)!.delivery_receipt[0].record_correcting, true, "a copy is told a correction has been opened");
  await approve(a);
  const after = (await data("receipts")).rows[0];
  assert.deepEqual([after.total_packs, after.record_correcting, after.record_version], [360, false, 2]);
  assert.equal(after.record_first_approved_at, firstApproved, "a correction does not move when the record was first approved");
  assert.ok(String(after.record_approved_at) > String(firstApproved));
  assert.deepEqual((await data("receipt_lines")).rows.map((r) => r.packs), [200, 160]);

  // 5. Sorting, filters and paging are done over every row.
  const b = await bring("receipt|DR-200| east depot |40");
  const c = await bring("receipt|DR-300|North Market|500|10|5");
  const d = await bring("receipt|dr-050|Zenith|7");
  for (const id of [b, c, d]) await approve(id);
  // A quantity someone typed with its unit is not a number, and a date typed
  // the long way is not a date: the columns keep their types.
  assert.equal((await post(`/documents/${d}/values`, { changes: [{ path: "total_packs", value: "12 pcs" }, { path: "dated", value: "Nov 5, 2026" }] })).statusCode, 200);
  await approve(d);
  const typed = (await data("receipts", "?reference=dr-050")).rows[0];
  assert.deepEqual([typed.total_packs, typed.dated], [null, null]);
  assert.deepEqual((await data("receipts", "?sort=total_packs,desc")).rows.map((r) => r.total_packs), [515, 360, 40, null]);
  assert.deepEqual((await data("receipts", "?sort=total_packs,asc")).rows.map((r) => r.total_packs), [40, 360, 515, null]);
  // Text sorts without regard to case.
  assert.deepEqual((await data("receipts", "?sort=reference,asc")).rows.map((r) => r.reference), ["dr-050", "DR-100", "DR-200", "DR-300"]);
  // Unsorted: newest first approval first, and a later correction does not move a record up.
  assert.deepEqual((await data("receipts")).rows.map((r) => r.reference), ["dr-050", "DR-300", "DR-200", "DR-100"]);
  // Lines follow their record, in the order they were written.
  assert.deepEqual((await data("receipt_lines")).rows.map((r) => `${r.reference}:${r.line_no}`), ["dr-050:1", "DR-300:1", "DR-300:2", "DR-300:3", "DR-200:1", "DR-100:1", "DR-100:2"]);
  // Paging through rows that tie returns each exactly once.
  const seen: string[] = [];
  for (let page = 1; page <= 7; page++) seen.push(...(await data("receipt_lines", `?sort=reference,asc&pageSize=1&page=${page}`)).rows.map((r) => String(r.line_id)));
  assert.equal(new Set(seen).size, 7);
  assert.equal((await data("receipt_lines", "?pageSize=3&page=3")).totalPages, 3);
  assert.deepEqual((await data("receipt_lines", "?pageSize=3&page=9")).rows, [], "past the end is empty, not an error");
  // A filter that names a column must equal it, however it is cased or spaced.
  assert.equal((await data("receipts", "?customer=NORTH%20MARKET")).total, 2);
  assert.equal((await data("receipts", "?customer=East%20Depot")).total, 1);
  assert.equal((await data("receipts", "?customer=Nobody")).total, 0);
  // One for some other section of the page, or named like something every object has, is left alone.
  assert.equal((await data("receipts", "?month=2026-01&constructor=x&toString=y")).total, 4);
  // A key sent twice is the last one sent, for a filter and for the sort.
  assert.equal((await data("receipts", "?customer=Nobody&customer=zenith")).total, 1);
  assert.deepEqual((await data("receipts", "?sort=customer,asc&sort=reference,desc")).rows.map((r) => r.reference), ["DR-300", "DR-200", "DR-100", "dr-050"]);
  // A number is a number however it is written; what is not one matches nothing.
  assert.equal((await data("receipts", "?total_packs=360.0")).total, 1);
  assert.equal((await data("receipts", "?total_packs=lots")).total, 0);
  // Search looks in the client's own values and the file name, not in the rest of the bookkeeping.
  assert.equal((await data("receipts", "?q=depot")).total, 1);
  assert.equal((await data("receipts", `?q=${a.slice(0, 8)}`)).total, 0);
  assert.equal((await data("receipts", "?q=scan-2")).total, 1);
  assert.equal((await data("receipts", "?q=100%25")).total, 0, "a percent sign is a percent sign");
  // Moments: a day, a range of days, a range of months, in the zone days are counted in.
  const today = dayIn(ZONE);
  assert.notEqual(today, dayIn(ELSEWHERE));
  assert.equal((await data("receipts", `?record_first_approved_at=${today}`)).total, 4);
  assert.equal((await data("receipts", `?record_first_approved_at=${dayIn(ELSEWHERE)}`)).total, 0, "the day is the organization's, not the server's or UTC's");
  assert.equal((await data("receipts", "?record_first_approved_at=1999-01-01")).total, 0);
  assert.equal((await data("receipts", `?record_first_approved_at_from=1999-01-01&record_first_approved_at_to=${today}`)).total, 4);
  assert.equal((await data("receipts", "?record_first_approved_at_from=1999-01-01&record_first_approved_at_to=1999-12-31")).total, 0);
  assert.equal((await data("receipts", `?record_first_approved_at_from=${today.slice(0, 7)}&record_first_approved_at_to=${today.slice(0, 7)}`)).total, 4);
  // A date field is a date: a day, a range of days, a month, a range of months.
  assert.equal((await data("receipts", "?dated=2026-11-01")).total, 1);
  assert.equal((await data("receipts", "?dated=2026-11")).total, 3);
  assert.equal((await data("receipts", "?dated_from=2026-11-02&dated_to=2026-11-03")).total, 2);
  assert.equal((await data("receipts", "?dated_from=2026-11&dated_to=2026-11")).total, 3);
  assert.equal((await data("receipts", "?dated_from=2026-12")).total, 0);
  assert.deepEqual((await data("receipts", "?sort=dated,asc")).rows.map((r) => r.dated), ["2026-11-01", "2026-11-02", "2026-11-03", null]);
  // What a bound cannot mean matches nothing, and is never an error.
  assert.equal((await data("receipts", "?dated_from=soon")).total, 0);
  assert.equal((await data("receipts", "?record_correcting_from=maybe")).total, 0);
  assert.equal((await data("receipts", "?record_correcting=false")).total, 4);
  assert.equal((await data("receipts", "?total_packs_from=100&total_packs_to=400")).total, 1);
  // The table's own column filters.
  assert.deepEqual((await data("receipts", "?_cf_total_packs__gt=300&sort=reference,asc")).rows.map((r) => r.reference), ["DR-100", "DR-300"]);
  assert.equal((await data("receipts", "?_cf_total_packs__empty=")).total, 1);
  assert.equal((await data("receipts", "?_cf_customer__contains=MARK")).total, 2);
  assert.equal((await data("receipts", "?_cf_dated__gt=2026-11-01")).total, 2);
  assert.deepEqual([(await data("receipts", "?_cf_record_first_approved_at__not_empty=")).total, (await data("receipts", "?_cf_record_first_approved_at__empty=")).total], [4, 0]);
  assert.deepEqual([(await data("receipts", "?_cf_dated__not_empty=")).total, (await data("receipts", "?_cf_dated__empty=")).total], [3, 1]);
  assert.equal((await data("receipts", "?_cf_dated__lt=2026-11-02")).total, 1);
  assert.equal((await data("receipt_lines", "?reference=DR-300")).total, 3);
  // What is selected on the page picks its rows: a record's lines by the record, or a line by itself.
  const selected = (ids: string[]): string => `?selection=${encodeURIComponent(JSON.stringify({ type: "rows", ids }))}`;
  assert.equal((await data("receipt_lines", selected([c]))).total, 3);
  assert.equal((await data("receipt_lines", selected([`${c}:2`, `${a}:1`]))).total, 2);
  assert.equal((await data("receipts", selected([a, b]))).total, 2);
  // A resource named like something every object has is not a resource.
  for (const name of ["constructor", "toString", "__proto__"]) assert.equal((await server.inject({ url: `/data/${name}`, headers: auth })).statusCode, 404, name);
  await copyAgrees();

  // 6. Two line tables on one app, asked for at the same time by several
  //    people: each always gets every one of its own rows.
  const inv = await bring("invoice|INV-1|900|400|500");
  await approve(inv);
  const rounds = await Promise.all(Array.from({ length: 30 }, (_, i) => data(i % 2 ? "invoice_lines" : "receipt_lines")));
  assert.deepEqual([...new Set(rounds.filter((_, i) => i % 2 === 0).map((r) => r.total))], [7]);
  assert.deepEqual([...new Set(rounds.filter((_, i) => i % 2 === 1).map((r) => r.total))], [2]);
  assert.equal((await data("everything")).total, 5);
  // A page asked for the moment an approval returns already shows it, every time.
  const quick: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await bring(`invoice|INV-Q${i}|1|1`);
    await approve(id);
    assert.equal((await data("everything", `?record_id=${id}`)).total, 1, `approval ${i} was not on the page`);
    quick.push(id);
  }
  for (const id of quick) assert.equal((await post(`/documents/${id}/reread`, {})).statusCode, 200);
  for (const id of quick) await settle(id);
  for (const id of quick) assert.equal((await post(`/documents/${id}/discard`, { reason: "only here to be quick" })).statusCode, 200);
  assert.equal((await data("everything")).total, 5);

  // 7. The page says when its records last changed (what alerts are driven
  //    by), and a client is told which of a page's sources are an app's.
  const fresh = (await server.inject({ url: "/pages/freshness?fresh=1", headers: auth })).json();
  assert.match(fresh.receipts, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(fresh.receipts > born.receipts);
  assert.match(fresh.figures, /^\d{4}-\d{2}-\d{2}T/, "a page of the client's own queries says so too");
  await new Promise((r) => setTimeout(r, 15));
  const e = await bring("receipt|DR-400|Zenith|1");
  await approve(e);
  const fresher = (await server.inject({ url: "/pages/freshness?fresh=1", headers: auth })).json();
  assert.ok(fresher.receipts > fresh.receipts, `${fresher.receipts} > ${fresh.receipts}`);
  const pages = (await server.inject({ url: "/pages", headers: auth })).json() as { id: string; record_sources?: Record<string, unknown> }[];
  assert.deepEqual(pages.find((p) => p.id === "receipts")!.record_sources, {
    receipts: { app: "receiving", table: "delivery_receipt", grain: "record", key: "record_id", record: "record_id" },
    receipt_lines: { app: "receiving", table: "delivery_receipt_items_with_record", grain: "line", key: "line_id", record: "record_id" },
  });
  assert.deepEqual(pages.find((p) => p.id === "figures")!.record_sources, { by_customer: { app: "receiving", table: "by_customer", grain: "query", key: null, record: null } });
  assert.match((await server.inject({ url: "/context/receipts?customer=zenith", headers: auth })).json().summary, /^2 approved records: Approved records of the form "Delivery receipt"/);
  // A page with no context handler of its own still says what each of its
  // sources says, with the records' freshness added and never called stale.
  const pageContext = (await server.inject({ url: "/context/page/figures", headers: auth })).json();
  assert.match(pageContext.summary, /3 rows: "by_customer", a query of the client's own/);
  // A total of the client's own may add up a value the tables had to leave out: it says so.
  assert.match(pageContext.summary, /1 of this app's records hold a value that is not a number or a date where one belongs/);
  assert.match(pageContext.summary, /The client's own words about its own figure\./);
  assert.equal(pageContext.lastSync, fresher.figures);
  assert.ok(pageContext.freshness.warningAfterHours > 24 * 365);
  // A page that says for itself how fresh its copied data is keeps saying it:
  // approvals beside it must not hide a copy that has stopped arriving.
  assert.equal(fresher.mixed, "2020-01-01T00:00:00.000Z");
  // The client's own code can ask the same thing, for a resource of its own.
  assert.equal(await handle!.changedAt(), fresher.receipts);
  // A value that is not a number where a number belongs is out of every
  // total. That is never silent: the page's context says so, the assistant
  // is told, and the values are listed.
  assert.match((await server.inject({ url: "/context/receipts", headers: auth })).json().summary, /1 of the records here hold a value that is not a number or a date where one belongs/);
  assert.doesNotMatch((await server.inject({ url: "/context/receipts?customer=north%20market", headers: auth })).json().summary, /not a number/);
  // While a correction waits, the page's context says how many rows are counted with what was last approved.
  assert.equal((await post(`/documents/${b}/values`, { changes: [{ path: "customer", value: "East Depot" }] })).statusCode, 200);
  assert.match((await server.inject({ url: "/context/receipts", headers: auth })).json().summary, /^5 approved records \(1 of them with a correction waiting for approval/);
  await approve(b);

  // 7b. The same tables, asked a question: by a query the client declared
  //     (read like any table), by the client's own code, and by the assistant.
  assert.deepEqual((await data("by_customer", "?sort=packs,desc")).rows.map((r) => [r.customer, r.packs, r.receipts]), [["North Market", 875, 2], ["East Depot", 40, 1], ["Zenith", 1, 2]]);
  assert.equal((await data("by_customer", "?customer=zenith")).total, 1);
  assert.equal((await data("by_customer", "?packs_from=30")).total, 2);
  assert.equal((await data("by_customer", `?latest=${today}`)).total, 3);
  assert.equal((await data("by_customer", "?pageSize=2&page=2")).rows.length, 1);
  assert.deepEqual((await data("own_figure", "?customer=NORTH%20MARKET")).rows, [{ receipts: 2 }]);
  const own = await handle!.query("select reference, record_first_approved_at, dated from delivery_receipt where reference = $1", ["DR-100"]);
  assert.deepEqual([own.columns, own.truncated], [["reference", "record_first_approved_at", "dated"], false]);
  assert.deepEqual(own.rows, [{ reference: "DR-100", record_first_approved_at: firstApproved, dated: "2026-11-02" }], "the same values a page gets, moments as ISO text");
  const many = await handle!.query("select range as i from range(100000000)");
  assert.deepEqual([many.rows.length, many.truncated], [5000, true]);
  const agentTools = (await server.inject({ url: `${appBase}/agent`, headers: auth })).json().tools as { name: string; description: string }[];
  const queryTool = agentTools.find((t) => t.name === "query_records")!;
  assert.ok(queryTool.description.includes("delivery_receipt_items_with_record") && queryTool.description.includes("invoice_charges") && queryTool.description.includes("by_customer") && queryTool.description.includes(ZONE));
  assert.ok(queryTool.description.includes("unfit_values"));
  const ask = async (sql: string) => server.inject({ method: "POST", url: `${appBase}/agent/query_records`, headers: auth, payload: { sql } });
  assert.equal((await ask("select count(*) as sleep_hours from delivery_receipt")).json().rows[0].sleep_hours, 5, "a name is a name");
  assert.equal((await ask("select pg_sleep(30)")).statusCode, 400);
  const total = await ask("select sum(packs) as packs, count(distinct record_id) as receipts from delivery_receipt_items");
  assert.equal(total.statusCode, 200, total.body);
  assert.deepEqual(total.json().rows, [{ packs: 923, receipts: 5 }]);
  assert.equal(total.headers["x-toolplex-app-changed"], undefined, "asking changes nothing");
  const described = (await ask("describe delivery_receipt")).json().rows as { column_name: string; column_type: string }[];
  const typeNamed = (name: string): string | undefined => described.find((r) => r.column_name === name)?.column_type;
  assert.deepEqual([typeNamed("total_packs"), typeNamed("dated"), typeNamed("record_first_approved_at"), typeNamed("record_correcting")], ["DOUBLE", "DATE", "TIMESTAMP WITH TIME ZONE", "BOOLEAN"]);
  assert.deepEqual((await ask("select table_name, column_name, value from unfit_values order by column_name")).json().rows, [
    { table_name: "delivery_receipt", column_name: "dated", value: "Nov 5, 2026" },
    { table_name: "delivery_receipt", column_name: "total_packs", value: "12 pcs" },
  ]);
  // "The last hour", "today" and "this month" mean what they mean to the organization.
  const recent = (await ask(`select count(*) filter (where record_first_approved_at > now() - interval 1 hour) as hour, count(*) filter (where record_first_approved_at::date = current_date) as today, count(*) filter (where record_first_approved_at::date = date '${dayIn(ELSEWHERE)}') as elsewhere, current_setting('TimeZone') as zone from delivery_receipt`)).json().rows[0];
  assert.deepEqual(recent, { hour: 5, today: 5, elsewhere: 0, zone: ZONE });
  // Records joined with their lines, and two forms in one answer.
  assert.equal((await ask("select count(*) as n from delivery_receipt r join delivery_receipt_items i using (record_id) where r.customer = 'North Market'")).json().rows[0].n, 5);
  assert.equal((await ask("select count(*) as n from records where record_form = 'invoice'")).json().rows[0].n, 1);
  const big = await ask("select a.range as x from range(30000) a, range(30000) b");
  assert.deepEqual([big.json().row_count, big.json().truncated], [200, true]);
  // Reading only, whatever is sent: nothing but a single reading statement
  // runs, however a second one is hidden.
  const everything = async (): Promise<unknown> => (await ask("select (select count(*) from delivery_receipt) as r, (select count(*) from delivery_receipt_items) as i, (select sum(total_packs) from delivery_receipt) as p")).json().rows[0];
  const untouched = await everything();
  for (const sql of [
    "drop table delivery_receipt",
    "delete from delivery_receipt",
    "select 1; drop table records",
    "select * from read_csv('/etc/passwd')",
    "copy delivery_receipt to '/tmp/out.csv'",
    "with x as (select 1) insert into delivery_receipt (record_id) select 'made-up'",
    "select '--'; commit; delete from delivery_receipt where reference = 'DR-100'; begin transaction",
    "select '--'; commit; update delivery_receipt set total_packs = 999999; delete from delivery_receipt_items where line_no = 1",
    "select '/*'; commit; update delivery_receipt set total_packs = 999999; begin transaction; select '*/'",
    "select E'\\''; commit; delete from delivery_receipt; --'",
    "select $$--$$; commit; delete from delivery_receipt",
    "select '--'; rollback; delete from delivery_receipt",
    "select '--'; end; delete from delivery_receipt",
    "select 1 -- one\n; delete from delivery_receipt",
    "explain analyze delete from delivery_receipt",
    "set threads = 8",
    "pragma enable_profiling",
    "call pragma_version()",
    "attach ':memory:' as other",
    "install httpfs",
    "create table mine as select 1",
    "begin transaction",
    "commit",
  ]) {
    const res = await ask(sql);
    assert.equal(res.statusCode, 400, `${sql}\n${res.body}`);
  }
  assert.deepEqual(await everything(), untouched);
  assert.equal((await data("receipts")).total, 5);
  // The same from someone who may open the app and do nothing in it: they can look, like everyone who can open it, and no more.
  const looking = await server.inject({ method: "POST", url: `${appBase}/agent/query_records`, headers: { ...auth, "x-toolplex-app-abilities": "" }, payload: { sql: "select '--'; commit; delete from delivery_receipt" } });
  assert.equal(looking.statusCode, 400);
  assert.deepEqual(await everything(), untouched);

  // 8. A download gets every row.
  const csv = (await server.inject({ url: "/download/receipt_lines?sort=reference,asc", headers: auth })).body.trim().split("\n");
  assert.equal(csv.length - 1, 8);
  assert.equal((await server.inject({ url: "/download/by_customer", headers: auth })).body.trim().split("\n").length - 1, 3);

  // 9. Withdrawn means discarded, and discarding what has counted is for the
  //    people who could have approved it. A record sent to be read again
  //    still counts with what was approved; discarded, it leaves every table.
  const reviewer = { ...auth, "x-toolplex-app-abilities": "capture,review" };
  assert.equal((await post(`/documents/${e}/reread`, {})).statusCode, 200);
  await settle(e);
  const reread = (await data("receipts", "?reference=DR-400")).rows[0];
  assert.deepEqual([reread.record_correcting, reread.total_packs], [true, 1]);
  const tried = await server.inject({ method: "POST", url: `${appBase}/documents/${e}/discard`, payload: { reason: "not mine to take out" }, headers: reviewer });
  assert.equal(tried.statusCode, 403, tried.body);
  assert.equal((await data("receipts", "?reference=DR-400")).total, 1, "still counted");
  // Nor can it be folded into another record: joining would throw it away.
  const loose = await bring("receipt|DR-401|Zenith|2");
  const joined = await post("/documents/merge", { ids: [loose, e] });
  assert.equal(joined.statusCode, 409, joined.body);
  assert.match(joined.json().error ?? joined.json().message, /has been approved and cannot be joined/);
  assert.equal((await server.inject({ method: "POST", url: `${appBase}/documents/${loose}/discard`, payload: { reason: "never approved, so a reviewer may" }, headers: reviewer })).statusCode, 200);
  assert.equal((await post(`/documents/${e}/discard`, { reason: "scanned twice" })).statusCode, 200);
  assert.equal((await data("receipts", "?reference=DR-400")).total, 0);
  assert.equal((await data("receipt_lines", "?reference=DR-400")).total, 0);
  assert.equal((await data("everything")).total, 5);

  // 9b. The list of changes, for whoever keeps a copy elsewhere: each record
  //     that changed once, as it stands, oldest change first; continued from
  //     a cursor; and started again when the cursor cannot be continued from.
  await copyAgrees();
  await copyAgrees();
  assert.deepEqual([...copy.records.keys()].sort(), [a, b, c, d, inv].sort(), "the discarded record left the copy; the others are there once each");
  assert.equal(copy.resets, 0);
  const whole = await handle!.changes({ limit: 500 });
  assert.deepEqual([whole.reset, whole.more], [false, false]);
  const changedIds = whole.changes.map((x) => x.record_id);
  assert.equal(new Set(changedIds).size, changedIds.length, "each record once");
  assert.ok(!changedIds.includes(loose), "a record that never counted is never in the list");
  assert.deepEqual(whole.changes.filter((x) => !x.removed).map((x) => x.record_id), [a, c, d, inv, b], "in the order each last changed");
  assert.deepEqual(whole.changes.filter((x) => x.removed).map((x) => x.record_id).sort(), [...quick, e].sort());
  assert.deepEqual([...whole.changes.map((x) => x.at)].sort(), whole.changes.map((x) => x.at));
  const mine = whole.changes.find((x) => x.record_id === a)!;
  assert.ok(!mine.removed);
  assert.deepEqual(Object.keys(mine.rows).sort(), ["delivery_receipt", "delivery_receipt_items", "invoice", "invoice_charges", "records"]);
  assert.deepEqual([mine.rows.delivery_receipt[0].total_packs, mine.rows.delivery_receipt[0].dated, mine.rows.delivery_receipt_items.map((r) => r.packs), mine.rows.records[0].record_form, mine.rows.invoice], [360, "2026-11-02", [200, 160], "delivery-receipt", []]);
  const typedCopy = whole.changes.find((x) => x.record_id === d)!;
  assert.ok(!typedCopy.removed && typedCopy.rows.delivery_receipt[0].total_packs === null && typedCopy.rows.delivery_receipt[0].dated === null, "a copy gets what the tables hold, not what was typed");
  // Asked again with the cursor: nothing, and the same cursor back.
  assert.deepEqual(await handle!.changes({ after: whole.cursor }), { changes: [], cursor: whole.cursor, reset: false, more: false });
  const firstPage = await handle!.changes({ limit: 2 });
  assert.deepEqual([firstPage.changes.length, firstPage.more, firstPage.reset], [2, true, false]);
  // A cursor that cannot be continued from: nonsense, someone else's, made
  // under other tables, from a run this store never had, or from further
  // than a run got.
  const [storeId, shape, run, high, lastSeq, lastId] = whole.cursor.split(".");
  for (const bad of [
    "nonsense",
    `someone-else.${shape}.${run}.${high}.${lastSeq}.${lastId}`,
    `${storeId}.other-tables.${run}.${high}.${lastSeq}.${lastId}`,
    `${storeId}.${shape}.no-such-run.${high}.${lastSeq}.${lastId}`,
    `${storeId}.${shape}.${run}.9007199254740000.${lastSeq}.${lastId}`,
    `${storeId}.${shape}.${run}.${high}.99999999999999999999.${lastId}`,
    `${storeId}.${shape}.${run}.-4.${lastSeq}.${lastId}`,
    `${storeId}.${shape}.${run}`,
  ]) {
    const again = await handle!.changes({ after: bad, limit: 500 });
    assert.deepEqual([again.reset, again.changes.length], [true, whole.changes.length], bad);
  }
  // One record, as the list would give it.
  assert.equal((await handle!.record(a))!.rows.delivery_receipt[0].reference, "DR-100");
  for (const id of [e, loose, "no-such-record"]) assert.equal(await handle!.record(id), null, id);

  // 10. The tables are only ever a copy, built again at every start. Nothing
  //     of them is kept on disk, and they come back the same.
  const before = { receipts: (await data("receipts", "?sort=reference,asc")).rows, lines: (await data("receipt_lines", "?sort=line_id,asc")).rows, figures: (await data("by_customer", "?sort=customer,asc")).rows };
  await server.close();
  const onDisk = await readdir(join(dir, "apps", "receiving"));
  assert.ok(!onDisk.some((f) => /duckdb|changes\.jsonl/.test(f)), onDisk.join(", "));
  await start();
  assert.deepEqual((await data("receipts", "?sort=reference,asc")).rows, before.receipts);
  assert.deepEqual((await data("receipt_lines", "?sort=line_id,asc")).rows, before.lines);
  assert.deepEqual((await data("by_customer", "?sort=customer,asc")).rows, before.figures);
  // What the tables could not hold is said once, when they are built.
  assert.ok(said.some((l) => /^document-encoding: 1 value in delivery_receipt\.total_packs does not fit the column/.test(l.msg)), JSON.stringify(said.map((l) => l.msg)));
  assert.ok(said.some((l) => /1 value in delivery_receipt\.dated does not fit the column/.test(l.msg)));
  // A copy carries on from where it was: its cursor is good across a restart.
  const resumed = await handle!.changes({ after: copy.cursor });
  assert.deepEqual([resumed.changes.length, resumed.reset, resumed.more], [0, false, false]);
  // The freshness of a page does not move because the server restarted.
  assert.equal((await server.inject({ url: "/pages/freshness?fresh=1", headers: auth })).json().receipts, (await server.inject({ url: "/context/page/receipts", headers: auth })).json().lastSync);

  // The configuration records are approved under is kept beside them.
  const keptConfigs = await readdir(join(dir, "apps", "receiving", "configs"));
  assert.equal(keptConfigs.length, 1, keptConfigs.join(", "));
  assert.ok(JSON.parse(await readFile(join(dir, "apps", "receiving", "configs", keptConfigs[0]), "utf8")).config.documents["delivery-receipt"].fields.length === 4);

  // 10a. The records are put back from an older copy (a restore). Whatever a
  //      copy elsewhere took after that older copy was made no longer holds,
  //      and it is told to start again, even when new approvals have been
  //      made since the restore and without anyone doing anything by hand.
  await server.close();
  const backup = `${dir}-backup`;
  await cp(join(dir, "apps"), backup, { recursive: true });
  await start();
  const lostLater = await bring("receipt|DR-900|Lost Later|9");
  await approve(lostLater);
  assert.equal((await post(`/documents/${a}/values`, { changes: [{ path: "customer", value: "Changed After The Backup" }] })).statusCode, 200);
  await approve(a);
  await copyAgrees();
  assert.ok(copy.records.has(lostLater) && copy.records.get(a)!.delivery_receipt[0].customer === "Changed After The Backup");
  await server.close();
  await rm(join(dir, "apps"), { recursive: true, force: true });
  await cp(backup, join(dir, "apps"), { recursive: true });
  await rm(backup, { recursive: true, force: true });
  await start();
  // Work goes on after the restore, before the copy next asks.
  const afterRestore = await bring("receipt|DR-901|After Restore|3");
  await approve(afterRestore);
  const resetsBeforeRestore = copy.resets;
  await copyAgrees();
  assert.equal(copy.resets, resetsBeforeRestore + 1, "a copy from a future the store never had starts again");
  assert.ok(!copy.records.has(lostLater) && copy.records.has(afterRestore) && copy.records.get(a)!.delivery_receipt[0].customer === "North Market");
  assert.equal((await post(`/documents/${afterRestore}/reread`, {})).statusCode, 200);
  await settle(afterRestore);
  assert.equal((await post(`/documents/${afterRestore}/discard`, { reason: "only here for the restore" })).statusCode, 200);
  await copyAgrees();
  assert.equal(copy.resets, resetsBeforeRestore + 1, "and then it carries on as usual");

  // 10b. One record's file is damaged. Every other record is still served,
  //      the damage is said loudly, and a copy elsewhere is not told the
  //      record was withdrawn (nobody withdrew it). Put right, it is back.
  await server.close();
  const fileOf = (id: string): string => join(dir, "apps", "receiving", "docs", `${id}.json`);
  const intact = await readFile(fileOf(b), "utf8");
  await writeFile(fileOf(b), intact.slice(0, 200));
  await start();
  assert.deepEqual((await data("receipts", "?sort=reference,asc")).rows.map((r) => r.reference), ["dr-050", "DR-100", "DR-300"]);
  assert.equal((await data("by_customer")).total, 2);
  assert.ok(said.some((l) => l.level >= 50 && l.msg.includes(`record file docs/${b}.json cannot be read`)), JSON.stringify(said.map((l) => l.msg)));
  const meanwhile = await handle!.changes({ after: copy.cursor });
  assert.deepEqual([meanwhile.changes.length, meanwhile.reset], [0, false]);
  await server.close();
  await writeFile(fileOf(b), intact);
  await start();
  assert.deepEqual((await data("receipts", "?sort=reference,asc")).rows, before.receipts);
  await copyAgrees();

  // 11. Renames, declared: a field, a table, one of its columns and a whole
  //     form. Everything approved under the old names is found under the new.
  await server.close();
  const changed = structuredClone({ ...app, config: { ...app.config, onReady: undefined } }) as DocumentEncodingApp;
  changed.config.onReady = (h) => void (handle = h);
  const receipt = changed.config.documents["delivery-receipt"];
  receipt.fields = [receipt.fields[0], { key: "buyer", label: "Buyer", type: "name", was: ["customer"] }, receipt.fields[2], receipt.fields[3], { key: "driver", label: "Driver", type: "name" }];
  receipt.tables = [{ key: "lines", label: "Lines", was: ["items"], columns: [{ key: "sku", label: "Item", type: "name" }, { key: "qty", label: "Quantity", type: "number", was: ["packs"] }] }];
  changed.config.documents = { "delivery-receipt": receipt, bill: { ...changed.config.documents.invoice, title: "Bill", was: ["invoice"] } };
  const renamedPages = {
    resources: {
      receipts: appRecords("receiving", { form: "delivery-receipt" }),
      receipt_lines: appRecords("receiving", { form: "delivery-receipt", lines: "lines" }),
      bills: appRecords("receiving", { form: "bill" }),
      bill_lines: appRecords("receiving", { form: "bill", lines: "charges" }),
      everything: appRecords("receiving"),
    },
    pages: {
      receipts: {
        title: "Receipts",
        sections: [table("receipts", "record_id", ["reference", "buyer", "driver"]), table("receipt_lines", "line_id", ["sku", "qty"]), table("bills", "record_id", ["amount"]), table("bill_lines", "line_id", ["charge"]), table("everything", "record_id", ["record_form"])],
      },
    },
  };
  await start(changed, renamedPages);
  assert.deepEqual((await data("receipts", "?sort=reference,asc")).rows.map((r) => [r.reference, r.buyer, r.driver, "customer" in r]), [
    ["dr-050", "Zenith", null, false],
    ["DR-100", "North Market", null, false],
    ["DR-200", "East Depot", null, false],
    ["DR-300", "North Market", null, false],
  ]);
  assert.deepEqual((await data("receipt_lines", "?reference=DR-100")).rows.map((r) => [r.sku, r.qty, "packs" in r]), [["Item 1", 200, false], ["Item 2", 160, false]]);
  assert.deepEqual((await data("bills")).rows.map((r) => [r.reference, r.amount]), [["INV-1", 900]]);
  assert.deepEqual((await data("bill_lines")).rows.map((r) => r.charge), [400, 500]);
  assert.deepEqual((await data("everything", "?record_form=bill")).rows.map((r) => r.record_form_title), ["Bill"]);
  assert.ok(!said.some((l) => /no longer has/.test(l.msg)), `a rename that was declared leaves nothing unshown: ${JSON.stringify(said.map((l) => l.msg))}`);
  // The app's own screens follow the renames too.
  const shown = (await server.inject({ url: `${appBase}/documents/${a}`, headers: auth })).json();
  assert.deepEqual([shown.values.buyer, "customer" in shown.values, shown.tables.lines.map((r: Row) => r.qty), "items" in shown.tables], ["North Market", false, [200, 160], false]);
  assert.equal((await server.inject({ url: `${appBase}/documents/${inv}`, headers: auth })).json().document_type, "bill");
  // A copy made before the tables changed shape is told to start again, and then agrees again.
  const resetsBefore = copy.resets;
  await copyAgrees();
  assert.equal(copy.resets, resetsBefore + 1);
  assert.ok("buyer" in copy.records.get(a)!.delivery_receipt[0] && copy.records.get(inv)!.bill.length === 1);

  // 11b. Renames nobody declared: the old values are still in the records,
  //      but nothing shows them, so the server says so when it starts, for a
  //      field, for a column of a table, and for a whole form.
  await server.close();
  const undeclared = structuredClone({ ...app, config: { ...app.config, onReady: undefined } }) as DocumentEncodingApp;
  undeclared.config.onReady = (h) => void (handle = h);
  undeclared.config.documents["delivery-receipt"].fields[2] = { key: "packs_total", label: "Total packs", type: "number" };
  undeclared.config.documents["delivery-receipt"].tables![0].columns[1] = { key: "quantity", label: "Quantity", type: "number" };
  undeclared.config.documents = { "delivery-receipt": undeclared.config.documents["delivery-receipt"], bill: undeclared.config.documents.invoice };
  await start(undeclared, {
    resources: { receipts: appRecords("receiving", { form: "delivery-receipt" }), receipt_lines: appRecords("receiving", { form: "delivery-receipt", lines: "items" }), everything: appRecords("receiving") },
    pages: { receipts: { title: "Receipts", sections: [table("receipts", "record_id", ["packs_total"]), table("receipt_lines", "line_id", ["sku", "quantity"]), table("everything", "record_id", ["record_form"])] } },
  });
  assert.deepEqual((await data("receipts")).rows.map((r) => r.packs_total), [null, null, null, null]);
  assert.deepEqual([...new Set((await data("receipt_lines")).rows.map((r) => r.quantity))], [null]);
  assert.equal((await data("everything", "?record_form=invoice")).total, 1, "a record of a form that is gone is still a record");
  for (let i = 0; i < 300 && !said.some((l) => l.key === "total_packs"); i++) await new Promise((r) => setTimeout(r, 10));
  const warning = said.find((l) => l.key === "total_packs");
  assert.deepEqual([warning?.form, warning?.records], ["delivery-receipt", 4]);
  assert.match(String(warning?.msg), /add was: \["total_packs"\]/);
  assert.ok(said.some((l) => /4 records hold a value under "items\.packs" \(form "delivery-receipt"\), which the app's configuration no longer has/.test(l.msg)), JSON.stringify(said.map((l) => l.msg)));
  assert.ok(said.some((l) => /1 record holds the form "invoice", which the app's configuration no longer has/.test(l.msg)));

  // 11c. What an alert works from: a photograph of the page's data, queried
  //      with SQL. The columns have the types the tables have, whatever rows
  //      happen to be there: a number column adds up although one record's
  //      quantity was written with its unit, and an empty page is still typed.
  await server.close();
  await start(undefined, { files: { dir } });
  type Photo = { manifest: { fileId: string; tables: { name: string; columns: { name: string; type: string }[] }[] }; rowCounts: Record<string, number>; lastSync: string; takenAt: string };
  const photograph = async (on: FastifyInstance, pageId: string): Promise<Photo> => {
    const res = await on.inject({ method: "POST", url: "/snapshots", headers: auth, payload: { pageId } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const typeIn = (photo: Photo, tableName: string, columnName: string): string | undefined => photo.manifest.tables.find((t) => t.name === tableName)?.columns.find((x) => x.name === columnName)?.type;
  const askPhoto = async (on: FastifyInstance, photo: Photo, sql: string): Promise<Row[]> => {
    const res = await on.inject({ method: "POST", url: "/snapshots/query", headers: auth, payload: { files: [{ fileId: photo.manifest.fileId, takenAt: photo.takenAt, sourceSync: photo.lastSync }], sql } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().rows;
  };
  const taken = await photograph(server, "receipts");
  assert.deepEqual([taken.rowCounts.receipts, taken.rowCounts.receipt_lines], [4, 7]);
  assert.match(String(taken.lastSync), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    [typeIn(taken, "receipts", "total_packs"), typeIn(taken, "receipts", "record_first_approved_at"), typeIn(taken, "receipts", "reference"), typeIn(taken, "receipt_lines", "packs"), typeIn(taken, "receipt_lines", "line_id")],
    ["DOUBLE", "TIMESTAMP WITH TIME ZONE", "VARCHAR", "DOUBLE", "VARCHAR"],
  );
  assert.deepEqual(await askPhoto(server, taken, "select sum(total_packs) as packs, count(*) as n from receipts"), [{ packs: 915, n: 4 }]);
  // The moments in the photograph are the moments on the page, and its days
  // are the organization's days, wherever the machine happens to be.
  const onPage = (await data("receipts", "?sort=reference,asc")).rows.map((r) => Date.parse(String(r.record_first_approved_at)));
  const inPhoto = await askPhoto(server, taken, "select epoch_ms(record_first_approved_at) as ms, strftime(record_first_approved_at, '%Y-%m-%d') as day, current_setting('TimeZone') as zone from receipts order by lower(reference)");
  assert.deepEqual(inPhoto.map((r) => Number(r.ms)), onPage);
  assert.deepEqual([...new Set(inPhoto.map((r) => `${r.zone} ${r.day}`))], [`${ZONE} ${dayIn(ZONE)}`]);
  assert.deepEqual(await askPhoto(server, taken, "select count(*) as n from receipts where record_first_approved_at > now() - interval 1 hour and record_first_approved_at::date = current_date"), [{ n: 4 }]);
  const figures = await photograph(server, "figures");
  assert.deepEqual([typeIn(figures, "by_customer", "packs"), typeIn(figures, "by_customer", "receipts"), typeIn(figures, "by_customer", "customer")], ["DOUBLE", "BIGINT", "VARCHAR"]);
  await server.close();
  // An app nothing has been approved in yet: the photograph is empty, and typed all the same.
  const emptyDir = await mkdtemp(join(homedir(), ".tp-app-records-empty-"));
  try {
    const fresh2 = Fastify();
    await fresh2.register(registerAppPages, { ...config({ ...app, config: { ...app.config, onReady: undefined } }), files: { dir: emptyDir } } as never);
    await fresh2.ready();
    const nothing = await photograph(fresh2, "receipts");
    assert.deepEqual([nothing.rowCounts.receipts, typeIn(nothing, "receipts", "total_packs"), typeIn(nothing, "receipts", "record_first_approved_at")], [0, "DOUBLE", "TIMESTAMP WITH TIME ZONE"]);
    assert.deepEqual(await askPhoto(fresh2, nothing, "select coalesce(sum(total_packs), 0) as packs, count(*) as n from receipts where total_packs > 100"), [{ packs: 0, n: 0 }]);
    await fresh2.close();
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }

  // 12. What cannot work is refused at startup, every problem named.
  const refused = async (make: () => Record<string, unknown>, parts: string[]): Promise<void> => {
    const broken = Fastify();
    await assert.rejects(
      async () => {
        await broken.register(registerAppPages, make() as never);
        await broken.ready();
      },
      (err: Error) => {
        for (const part of parts) assert.ok(err.message.includes(part), `missing: ${part}\n${err.message}`);
        return true;
      },
    );
    await broken.close().catch(() => {});
  };
  const quiet = (): DocumentEncodingApp => structuredClone({ ...app, config: { ...app.config, onReady: undefined } }) as DocumentEncodingApp;
  const base = config(quiet());
  await refused(
    () => ({
      ...base,
      resources: {
        r1: appRecords("warehouse", { form: "delivery-receipt" }),
        r2: appRecords("receiving", { form: "nope" }),
        r3: appRecords("receiving", { form: "delivery-receipt", lines: "pallets" }),
        r4: appRecords("receiving", { lines: "items" }),
        r5: appRecords("receiving", { form: "constructor" }),
        r6: appRecords("receiving", { form: "invoice" }),
        r7: { ...appRecords("receiving", { form: "invoice" }), context: async () => ({ summary: "mine" }) },
        r8: appRecords("receiving", { form: "delivery-receipt" }),
        r9: appRecords("receiving", { sql: "  " }),
        "Bad-Name": appRecords("receiving", { sql: "select 1 as x" }),
        select: appRecords("receiving", { sql: "select 1 as x" }),
        hidden: appRecords("receiving", { sql: "select 1 as x" }),
        r10: appRecords("receiving", { sql: "select 1 as x", form: "invoice" } as never),
      },
      pages: {
        p: {
          title: "P",
          sections: [
            table("r1", "record_id", []), table("r2", "record_id", []), table("r3", "line_id", []), table("r4", "line_id", []), table("r5", "record_id", []),
            table("r7", "record_id", []), table("r8", "id", ["reference", "customer_name"]), table("r9", "x", []), table("Bad-Name", "x", []), table("select", "x", []), table("r10", "x", []),
          ],
        },
      },
    }),
    [
      'Resource "r1": reads app "warehouse", which this server does not declare',
      'Resource "r2": the app has no form "nope"',
      'Resource "r3": form "delivery-receipt" has no table "pallets"',
      'Resource "r4": lines "items" needs the form they belong to',
      'Resource "r5": the app has no form "constructor"',
      'Resource "r6": is not shown on any page',
      'Resource "r7": an appRecords resource cannot carry its own context',
      'Page "p", table on "r8": rowKey must be "record_id"',
      'Page "p", table on "r8": column "customer_name" is not a column of this table',
      'Resource "r9": "sql" must be one SELECT statement',
      'Resource "Bad-Name": a resource that is a query over an app\'s records is kept as a view of the same name',
      'Resource "select": a resource that is a query over an app\'s records is kept as a view of the same name',
      'Resource "hidden": is not shown on any page',
      'Resource "r10": a query takes "sql" and "label" only (found form)',
    ],
  );
  // A query of the client's own that does not run, or is not one reading statement, or asks a page for what it does not return.
  const withQuery = (name: string, sql: string, columns: string[] = []) => () => ({ ...base, resources: { [name]: appRecords("receiving", { sql }) }, pages: { p: { title: "P", sections: [table(name, columns[0] ?? "x", columns)] } } });
  await refused(withQuery("broken", "select nope from delivery_receipt"), ['app "receiving": the query of "broken" cannot be used:', "nope"]);
  await refused(withQuery("two", "select 1 as x; select 2 as x"), ['the query of "two" cannot be used: it must be a single SELECT statement']);
  await refused(withQuery("writes", "delete from delivery_receipt"), ['the query of "writes" cannot be used: it must be a SELECT statement']);
  await refused(withQuery("reads_files", "select * from read_csv('/etc/passwd')"), ['the query of "reads_files" cannot be used:']);
  await refused(withQuery("records", "select 1 as x"), ['"records" is already the name of one of the app\'s tables']);
  await refused(withQuery("sums", "select 1 as x", ["y"]), ['Page "p", table on "sums": rowKey "y" is not a column the query returns (x)', 'Page "p", table on "sums": column "y" is not a column the query returns (x)']);
  await refused(() => ({ ...base, timezone: "Mars/Olympus" }), ['timezone: "Mars/Olympus" is not a time zone']);
  await refused(() => ({ ...base, timezone: "+08:00" }), ['timezone: "+08:00" is not a time zone']);
  // Tables are counted by day, so a server that keeps them says whose days.
  await refused(() => ({ ...base, timezone: undefined }), ['timezone: app "receiving" keeps tables of its records (records: true), which are counted by day']);
  // An app that keeps no query database offers the assistant no query tool,
  // and still hands its changes to a copy: that needs only the records.
  let plainHandle: EncodingHandle | null = null;
  const plain = Fastify();
  await plain.register(registerAppPages, { ...base, resources: {}, pages: {}, apps: { receiving: { ...app, records: undefined, config: { ...app.config, onReady: (h: EncodingHandle) => void (plainHandle = h) } } } } as never);
  assert.ok(!(await plain.inject({ url: `${appBase}/agent`, headers: auth })).json().tools.some((t: { name: string }) => t.name === "query_records"));
  assert.equal((await plain.inject({ method: "POST", url: `${appBase}/agent/query_records`, headers: auth, payload: { sql: "select 1" } })).statusCode, 404);
  for (let i = 0; i < 500 && !plainHandle; i++) await new Promise((r) => setTimeout(r, 5));
  const withoutTables = await plainHandle!.changes({ limit: 500 });
  assert.deepEqual(withoutTables.changes.filter((x) => !x.removed).map((x) => x.record_id), [a, c, d, inv, b]);
  await assert.rejects(() => plainHandle!.query("select 1"), /keeps no query database/);
  await plain.close();
  // An app that keeps no query database has nothing for a page to read.
  await refused(() => ({ ...base, apps: { receiving: { ...quiet(), records: undefined } } }), ['Resource "receipts": app "receiving" keeps no query database; add `records: true`']);
  // Names that could not be tables or columns are refused for every app, whether or not it keeps tables today.
  const keys = quiet();
  keys.records = false;
  keys.config.documents["delivery-receipt"].fields.push(
    { key: "record_total", label: "x", type: "number" },
    { key: "Total Packs", label: "x", type: "number" },
    { key: "q", label: "x", type: "text" },
    { key: "page", label: "x", type: "number" },
    { key: "order", label: "x", type: "code" },
    { key: "valid", label: "x", type: "date" },
    { key: "valid_from", label: "x", type: "date" },
  );
  keys.config.documents["delivery-receipt"].tables![0].columns.push({ key: "customer", label: "x", type: "name" });
  keys.config.documents["delivery_receipt"] = { title: "Same name", recognise: "x", fields: [{ key: "reference", label: "r", type: "code" }] };
  keys.config.documents["group"] = { title: "A reserved word", recognise: "x", fields: [{ key: "reference", label: "r", type: "code" }] };
  await refused(() => ({ ...base, resources: {}, pages: {}, apps: { receiving: keys } }), [
    'field "record_total": key "record_total" starts with "record_"',
    'key "Total Packs" must be lower case letters, digits and underscores',
    'key "q" is something a page sends with every request',
    'key "page" is something a page sends with every request',
    'key "order" is a word the query language keeps for itself',
    'keys "valid" and "valid_from" cannot both exist',
    'column "items.customer" has the same key as a field of the form',
    'form "delivery_receipt" and form "delivery-receipt" would both be the table "delivery_receipt"',
    'form "group" would be the table "group", a word the query language keeps for itself',
  ]);
  const words = quiet();
  words.records = false;
  words.config.documents["delivery-receipt"].fields.push({ key: "left", label: "x", type: "number" }, { key: "by", label: "x", type: "name" });
  words.config.documents["unfit-values"] = { title: "Taken", recognise: "x", fields: [{ key: "reference", label: "r", type: "code" }] };
  await refused(() => ({ ...base, timezone: undefined, resources: {}, pages: {}, apps: { receiving: words } }), [
    'key "left" is a word the query language keeps for itself',
    'key "by" is a word the query language keeps for itself',
    'form "unfit-values" and the table of values that did not fit their column would both be the table "unfit_values"',
  ]);
  // What something used to be called: a list of old names, none in use now, none claimed twice.
  const was = quiet();
  was.records = false;
  const wasForm = was.config.documents["delivery-receipt"];
  wasForm.fields[1] = { ...wasForm.fields[1], was: ["customer"] };
  wasForm.fields[2] = { ...wasForm.fields[2], was: ["reference"] };
  wasForm.fields.push({ key: "one", label: "x", type: "text", was: ["former"] }, { key: "two", label: "x", type: "text", was: ["former"] }, { key: "three", label: "x", type: "text", was: "former_three" as never });
  wasForm.tables![0] = { ...wasForm.tables![0], was: ["items"], columns: [{ ...wasForm.tables![0].columns[0], was: ["packs"] }, wasForm.tables![0].columns[1]] };
  was.config.documents.invoice = { ...was.config.documents.invoice, was: ["delivery-receipt"] };
  await refused(() => ({ ...base, resources: {}, pages: {}, apps: { receiving: was } }), [
    'field "customer" says it was called "customer", which is what it is called now',
    'field "total_packs" says it was called "reference", but there is a field "reference" now',
    'fields "one" and "two" both say they were called "former"',
    '"was" of field "three" must be a list of the keys it used to have',
    'table "items" says it was called "items", which is what it is called now',
    'column "sku" says it was called "packs", but there is a column "packs" now',
    'form "invoice" says it was called "delivery-receipt", but there is a form "delivery-receipt" now',
  ]);

  console.log("app-records: ok");
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await server.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
