// Document encoding end to end, with the platform's reader replaced:
// intake → read → questions → answers → approval → versions, plus abilities,
// retried uploads, joining pages, group checks and the calibration counts.
//   npx tsx test/encoding.ts
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";
import type { DocumentEncodingApp, EncodingHandle, EncodingRecord } from "../src/index.js";
import type { ReadDocumentRequest } from "../src/apps/encoding/routes.js";
import type { Reading, ReadValue } from "../src/apps/encoding/store.js";

const dir = await mkdtemp(join(homedir(), ".tp-encoding-test-"));
const auth = { authorization: "Bearer t", "x-toolplex-user-id": "u1", "x-toolplex-user-email": "ana@example.com" };
const as = (abilities: string) => ({ ...auth, "x-toolplex-app-abilities": abilities });

const v = (value: string | number | null, status: ReadValue["status"], extra: Partial<ReadValue> = {}): ReadValue => ({
  value,
  status,
  candidates: status === "ask" && value !== null ? [value] : [],
  written: "printed",
  ...extra,
});

// The stub "reads" by page content: the test controls what each page says.
const seen: ReadDocumentRequest[] = [];
const readDocument = async (req: ReadDocumentRequest): Promise<Reading> => {
  seen.push(req);
  const text = Buffer.from(req.pages[0].data, "base64").toString();
  if (text.includes("unreadable")) throw new Error("The reader failed");
  const total = text.includes("total-365") ? 365 : 350;
  return {
    document_type: req.document_type ?? (text.includes("mystery") ? null : "delivery-receipt"),
    document_type_agreed: true,
    fields: {
      reference: v("100234", "accepted", { box: { page: 1, x: 0.7, y: 0.05, w: 0.2, h: 0.04 } }),
      customer: v("North Markt", "ask", { reason: "Not in your list", candidates: ["North Markt", "North Market"] }),
      total_packs: v(total, "confirm", { reason: "Handwritten", written: "hand", candidates: [total] }),
    },
    tables: { lines: [{ sku: v("Pork Buns 250g", "accepted"), packs: v(total, "accepted") }] },
    checks: [],
    counts: { accepted: 3, confirm: 1, ask: 1, blank: 0 },
    readers: [{ model: "stub-a", ok: true, ms: 1 }, { model: "stub-b", ok: true, ms: 1 }],
  };
};

const approved: EncodingRecord[] = [];
const events: string[] = [];
let handle: EncodingHandle | null = null;
const app: DocumentEncodingApp = {
  kind: "document-encoding",
  title: "Document Encoding",
  config: {
    context: "Acme makes dumplings. Quantities are in packs.",
    intake: [{ via: "files" }],
    group_by: "reference",
    documents: {
      "delivery-receipt": {
        title: "Delivery receipt",
        recognise: "Headed DELIVERY RECEIPT.",
        fields: [
          { key: "reference", label: "DR number", type: "code", required: true },
          { key: "customer", label: "Customer", type: "name", candidates: "customers" },
          { key: "total_packs", label: "Total packs", type: "number" },
        ],
        tables: [{ key: "lines", label: "Items", columns: [{ key: "sku", label: "Item", type: "name" }, { key: "packs", label: "Packs", type: "number" }] }],
        checks: [{ type: "same-in-group", field: "total_packs" }],
      },
    },
    lists: { customers: () => ["North Market"] },
    onApproved: ({ record }) => void approved.push(record),
    onDocument: ({ document, change }) => void events.push(`${change}:${document.status}:${document.open.ask}`),
    onReady: (h) => void (handle = h),
  },
};

const server = Fastify();
await server.register(registerAppPages, {
  authToken: "t",
  pages: {},
  resources: {},
  actions: {},
  files: { enabled: false, dir },
  apps: { receiving: app },
  platform: { readDocument },
});
const base = "/apps/receiving/document-encoding";

function multipart(parts: { name: string; filename?: string; type?: string; body: string }[]) {
  const boundary = "----tp" + Math.random().toString(16).slice(2);
  const chunks = parts.map(
    (p) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n` +
      (p.type ? `Content-Type: ${p.type}\r\n` : "") +
      `\r\n${p.body}\r\n`,
  );
  return { payload: chunks.join("") + `--${boundary}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const upload = (pages: string[], meta: object, headers = auth, original?: string) => {
  const m = multipart([
    { name: "meta", body: JSON.stringify(meta) },
    ...(original ? [{ name: "original", filename: "scan.pdf", type: "application/pdf", body: original }] : []),
    ...pages.map((body, i) => ({ name: "page", filename: `p${i + 1}.jpg`, type: "image/jpeg", body })),
  ]);
  return server.inject({ method: "POST", url: `${base}/intake`, payload: m.payload, headers: { ...headers, ...m.headers } });
};
const get = async (url: string, headers = auth) => (await server.inject({ url: base + url, headers })).json();
const post = (url: string, body: object, headers: Record<string, string> = auth) =>
  server.inject({ method: "POST", url: base + url, payload: body, headers });
const settle = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const d = await get(`/documents/${id}`);
    if (d.status !== "queued" && d.status !== "reading") return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("document never finished reading");
};

try {
  // 1. Abilities: capture is needed to bring documents in.
  assert.equal((await upload(["page one"], { upload_id: "x0" }, as("review"))).statusCode, 403);

  // 2. A two-page PDF: one original stored once, one document per page.
  const first = await upload(["page one", "page two total-365"], { upload_id: "up-1", batch: "b1" }, auth, "%PDF original bytes");
  assert.equal(first.statusCode, 200);
  const docs = first.json().documents;
  assert.equal(docs.length, 2);
  assert.equal(docs[0].name, "scan.pdf, sheet 1");
  // A retried upload returns the same documents and creates nothing.
  const again = (await upload(["page one", "page two total-365"], { upload_id: "up-1" }, auth, "%PDF original bytes")).json();
  assert.equal(again.repeated, true);
  assert.deepEqual(again.documents.map((d: { id: string }) => d.id), docs.map((d: { id: string }) => d.id));
  assert.equal((await readdir(join(dir, "apps", "receiving", "originals"))).filter((f) => !f.endsWith(".json")).length, 1);

  // 3. Read: values land, the reader was not told the answer's list contents beyond lists, questions are derived.
  await settle(docs[0].id);
  await settle(docs[1].id);
  // The group check runs just after a read lands; wait for it to reach the first sheet.
  let a = await settle(docs[0].id);
  for (let i = 0; i < 200 && !a.questions.some((q: { reason: string }) => /same group/.test(q.reason)); i++) {
    await new Promise((r) => setTimeout(r, 10));
    a = await settle(docs[0].id);
  }
  assert.equal(a.status, "review");
  assert.equal(a.document_type, "delivery-receipt");
  assert.equal(a.group, "100234");
  assert.deepEqual(seen[0].lists, { customers: ["North Market"] });
  assert.deepEqual(a.questions.map((q: { path: string; kind: string }) => [q.path, q.kind]), [["customer", "ask"], ["total_packs", "ask"]]);
  // The group check does not depend on which sheet was read first: both carry the question.
  assert.match(a.questions[1].reason, /same group/);
  assert.equal(a.questions[0].candidates[1], "North Market");
  assert.equal(a.keying, false);

  // 4. The second page disagrees on a value that must match within the group.
  const b = await settle(docs[1].id);
  const flagged = b.questions.find((q: { path: string }) => q.path === "total_packs");
  assert.match(flagged.reason, /same group/);
  assert.deepEqual(flagged.candidates, [365, 350]);

  // 5. Approval is refused while questions are open, and needs the ability.
  assert.equal((await post(`/documents/${a.id}/approve`, {})).statusCode, 409);
  assert.equal((await post(`/documents/${a.id}/values`, { changes: [{ path: "customer", value: "North Market" }] }, as("capture"))).statusCode, 403);
  assert.equal((await post(`/documents/${a.id}/values`, { changes: [{ path: "nope", value: 1 }] })).statusCode, 400);
  assert.equal(
    (await post(`/documents/${a.id}/values`, { changes: [{ path: "customer", value: "North Market" }, { path: "total_packs", value: 350, how: "confirmed" }] })).statusCode,
    200,
  );
  const answered = await get(`/documents/${a.id}`);
  assert.equal(answered.questions.length, 0);
  assert.equal(answered.resolved.customer.how, "choice");
  assert.equal(answered.resolved.customer.from, "North Markt");
  assert.equal(answered.resolved.total_packs.how, "confirmed");
  assert.equal((await post(`/documents/${a.id}/approve`, {}, as("capture,review"))).statusCode, 403);
  assert.equal((await post(`/documents/${a.id}/approve`, {})).statusCode, 200);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].values.customer, "North Market");
  assert.equal(approved[0].version, 1);
  assert.match(approved[0].configVersion, /^[0-9a-f]{16}$/);
  assert.equal(approved[0].originals.length, 1);

  // 6. Correcting an approved record reopens it; re-approval is version 2, and version 1 is kept.
  await post(`/documents/${a.id}/values`, { changes: [{ path: "lines[0].packs", value: "349" }] });
  assert.equal((await get(`/documents/${a.id}`)).status, "review");
  assert.equal((await post(`/documents/${a.id}/approve`, {})).statusCode, 200);
  const twice = await get(`/documents/${a.id}`);
  assert.equal(twice.versions.length, 2);
  assert.equal(twice.versions[0].tables.lines[0].packs, 350);
  assert.equal(twice.versions[1].tables.lines[0].packs, 349);

  // 7. Calibration counts the accepted value a person changed.
  const sum = await get("/summary");
  assert.equal(sum.calibration.documents, 1);
  assert.equal(sum.calibration.acceptedThenChanged, 1);
  assert.equal(sum.calibration.askedAnsweredByChoice, 1);
  assert.equal(sum.calibration.confirmed, 1);
  assert.equal(sum.calibration.confirmedChanged, 0);

  // 8. A page the readers could not place: a person names the form and it is read again as that form.
  const odd = (await upload(["mystery page"], { upload_id: "up-2" })).json().documents[0];
  const unplaced = await settle(odd.id);
  assert.equal(unplaced.document_type, null);
  assert.equal((await post(`/documents/${odd.id}/reread`, { document_type: "delivery-receipt" })).statusCode, 200);
  assert.equal((await settle(odd.id)).document_type, "delivery-receipt");
  assert.equal(seen.at(-1)!.document_type, "delivery-receipt");

  // 9. A failed read is visible and counts as waiting; joining pages re-reads them as one document.
  const bad = (await upload(["unreadable"], { upload_id: "up-3" })).json().documents[0];
  assert.equal((await settle(bad.id)).status, "failed");
  assert.equal((await post("/documents/merge", { ids: [b.id, odd.id] })).statusCode, 200);
  const joined = await settle(b.id);
  assert.equal(joined.pages, 2);
  assert.equal(seen.at(-1)!.pages.length, 2);
  assert.equal((await get(`/documents/${odd.id}`)).status, "discarded");

  // 10. Lists, pages, originals, pending, discard.
  const list = await get("/documents?status=review,failed");
  assert.deepEqual(list.documents.map((d: { id: string }) => d.id).sort(), [b.id, bad.id].sort());
  const page = await server.inject({ url: `${base}/documents/${a.id}/pages/0`, headers: auth });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, "page one");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  const orig = await server.inject({ url: `${base}/originals/${twice.originals[0].sha256}`, headers: auth });
  assert.equal(orig.body, "%PDF original bytes");
  assert.equal((await server.inject({ url: `${base}/originals/${"0".repeat(64)}`, headers: auth })).statusCode, 404);
  assert.deepEqual((await server.inject({ url: "/apps/pending", headers: auth })).json(), { receiving: 2 });
  assert.deepEqual((await server.inject({ url: "/apps/pending", headers: as("capture") })).json(), { receiving: 0 });
  assert.equal((await post(`/documents/${bad.id}/discard`, {})).statusCode, 400);
  assert.equal((await post(`/documents/${bad.id}/discard`, { reason: "Blank page" })).statusCode, 200);
  assert.equal((await post(`/documents/${a.id}/discard`, { reason: "x" })).statusCode, 409);

  // 11. The client's own code follows every change and can list what the app holds.
  assert.ok(events.includes("read:review:2"), events.join(" "));
  assert.ok(events.includes("values:review:0"));
  assert.ok(events.includes("approved:approved:0"));
  assert.ok(events.includes("failed:failed:0"));
  assert.ok(events.some((e) => e.startsWith("discarded:")));
  const snap = (await handle!.document(a.id))!;
  assert.equal(snap.status, "approved");
  assert.equal(snap.approvedBy, "ana@example.com");
  assert.ok(snap.sheets[0].path.endsWith(`${a.id}-0`));
  let held = 0;
  for await (const _ of handle!.documents()) held++;
  assert.equal(held, 4);
  await assert.rejects(() => handle!.approve(b.id, { id: "u1", email: "ana@example.com" }), /still need a decision/);

  // 12. The chat agent: tools are listed per ability, look things up, and never write.
  const agent = (await get("/agent")) as { about: string; tools: { name: string }[] };
  assert.deepEqual(agent.tools.map((t) => t.name), ["overview", "find_documents", "get_document", "show_document", "compare_group", "add_attachments"]);
  const shown = (await post("/agent/show_document", { id: a.id, sheet: 9 })).json();
  assert.equal(shown.cards[0].image.path, `documents/${a.id}/pages/0`);
  assert.equal((await server.inject({ url: `${base}/${shown.cards[0].image.path}`, headers: auth })).body, "page one");
  assert.ok(!(await get("/agent", as("review"))).tools.some((t: { name: string }) => t.name === "add_attachments"));
  const overview = (await post("/agent/overview", {})).json();
  assert.equal(overview.counts.approved, 1);
  assert.equal(overview.waiting_total, 1);
  assert.equal(overview.cards[0].open.tab, "review");
  assert.equal(overview.accuracy_on_approved_documents.of_those_later_corrected_by_a_person, 1);
  const found = (await post("/agent/find_documents", { text: "north market" })).json();
  assert.equal(found.total, 1);
  assert.equal(found.documents[0].settled, true);
  assert.deepEqual(found.cards[0].open, { tab: "records", document_id: a.id });
  const one = (await post("/agent/get_document", { id: b.id })).json();
  assert.equal(one.settled, false);
  assert.ok(one.waiting_on_a_person.length > 0);
  assert.ok(!JSON.stringify(one.waiting_on_a_person).includes("candidates"));
  const cmp = (await post("/agent/compare_group", { group: "100234" })).json();
  assert.equal(cmp.documents.length, 2);
  assert.ok(cmp.values_that_differ.some((d: { field: string }) => d.field === "total_packs"));
  assert.equal((await post("/agent/approve", {})).statusCode, 404);
  assert.equal((await post("/agent/add_attachments", { file_ids: ["x"] }, as("review"))).statusCode, 403);
  // This server runs without a file store, so there is nothing to bring in from chat.
  assert.equal((await post("/agent/add_attachments", { file_ids: ["x"] })).statusCode, 409);

  // 13. Approved names teach the lists, after three approvals, and the readers
  //     are given the client's background.
  assert.equal(seen[0].context, "Acme makes dumplings. Quantities are in packs.");
  const before13 = seen.length;
  const taught: string[] = [];
  for (const n of [1, 2, 3]) {
    const d = (await upload([`learn ${n}`], { upload_id: `learn-${n}` })).json().documents[0];
    await settle(d.id);
    await post(`/documents/${d.id}/values`, { changes: [{ path: "customer", value: "East Depot" }, { path: "total_packs", value: 350, how: "confirmed" }] });
    assert.equal((await post(`/documents/${d.id}/approve`, {})).statusCode, 200);
    taught.push(d.id);
    // After one or two approvals the name is not yet known; after three it is.
    const next = (await upload([`after ${n}`], { upload_id: `after-${n}` })).json().documents[0];
    await settle(next.id);
    assert.equal(seen.at(-1)!.lists.customers.includes("East Depot"), n === 3, `after ${n} approvals`);
    await post(`/documents/${next.id}/discard`, { reason: "test" });
  }
  // A name field with no list of its own gets one from approvals too.
  assert.ok(seen.length > before13);
  const skuList = "~delivery-receipt.lines.sku";
  assert.ok(seen.at(-1)!.lists[skuList]?.includes("Pork Buns 250g"));
  assert.equal(seen.at(-1)!.documents["delivery-receipt"].tables![0].columns[0].candidates, skuList);

  // A record corrected after approval takes its old name back out of the list.
  await post(`/documents/${taught[2]}/values`, { changes: [{ path: "customer", value: "North Market" }] });
  assert.equal((await post(`/documents/${taught[2]}/approve`, {})).statusCode, 200);
  const unlearned = (await upload(["after correction"], { upload_id: "after-fix" })).json().documents[0];
  await settle(unlearned.id);
  assert.equal(seen.at(-1)!.lists.customers.includes("East Depot"), false);
  await post(`/documents/${unlearned.id}/discard`, { reason: "test" });

  // A batch of changes with one bad value changes nothing at all.
  const whole = await get(`/documents/${taught[0]}`);
  assert.equal((await post(`/documents/${taught[0]}/values`, { changes: [{ path: "customer", value: "Someone Else" }, { path: "nope", value: 1 }] })).statusCode, 400);
  const still = await get(`/documents/${taught[0]}`);
  assert.equal(still.status, "approved");
  assert.equal(still.values.customer, whole.values.customer);
  assert.equal(still.history.length, whole.history.length);
  // Reading an approved record again undoes an approval, so it needs that right.
  assert.equal((await post(`/documents/${taught[0]}/reread`, {}, as("capture,review"))).statusCode, 403);
  // A required value cannot be settled as empty.
  assert.equal((await post(`/documents/${taught[0]}/values`, { changes: [{ path: "reference", value: "" }] })).statusCode, 200);
  const emptied = await post(`/documents/${taught[0]}/approve`, {});
  assert.equal(emptied.statusCode, 409);
  assert.match(emptied.json().error ?? emptied.json().message, /still need/);

  // What the readers are told stays on the server: the catalogue a client
  // receives has the forms and fields, not the background, notes or hints.
  const listed = (await server.inject({ url: "/apps/receiving", headers: auth })).json();
  const servedText = JSON.stringify(listed.config);
  assert.ok(!servedText.includes("Acme makes dumplings"));
  assert.ok(!servedText.includes("Headed DELIVERY RECEIPT"));
  assert.ok(!("recognise" in listed.config.documents["delivery-receipt"]));
  assert.equal(listed.config.documents["delivery-receipt"].fields[0].label, "DR number");
  // A record's version and the catalogue's are the same thing, and both
  // cover the private parts.
  assert.equal((await get(`/documents/${a.id}`)).current_config_version, listed.config_version);

  // A long scan arrives in one upload, and the same upload sent twice at once makes its documents once.
  const long = Array.from({ length: 60 }, (_, i) => `long sheet ${i}`);
  const [l1, l2] = await Promise.all([upload(long, { upload_id: "long-1" }, auth, "%PDF long"), upload(long, { upload_id: "long-1" }, auth, "%PDF long")]);
  assert.equal(l1.statusCode, 200);
  assert.equal(l2.statusCode, 200);
  assert.equal(l1.json().documents.length, 60);
  assert.deepEqual(l1.json().documents.map((d: { id: string }) => d.id).sort(), l2.json().documents.map((d: { id: string }) => d.id).sort());
  assert.equal((await readdir(join(dir, "apps", "receiving", "uploads"))).filter((f) => f.endsWith(".part")).length, 0);
  assert.equal((await upload(["x"], { upload_id: "not ok!" })).statusCode, 400);
  for (const d of l1.json().documents) await settle(d.id);

  // 14. Records survive a restart.
  await server.close();
  const restarted = Fastify();
  await restarted.register(registerAppPages, {
    authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false, dir }, apps: { receiving: app }, platform: { readDocument },
  });
  const back = (await restarted.inject({ url: `${base}/documents/${a.id}`, headers: auth })).json();
  assert.equal(back.status, "approved");
  assert.equal(back.versions.length, 2);
  await restarted.close();

  console.log("encoding: ok");
} catch (err) { console.error("TEST FAILED", err); process.exitCode = 1; await new Promise((r) => setTimeout(r, 1500)); } finally {
  await rm(dir, { recursive: true, force: true });
}
