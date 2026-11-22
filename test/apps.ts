// Apps catalogue: definitions are served without their server-side functions,
// pending counts are live, and a bad reference fails at startup.
//   npx tsx test/apps.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";
import type { DocumentEncodingApp } from "../src/index.js";

const auth = { authorization: "Bearer t" };
// Each app keeps a store on disk. In a folder of its own, removed at the end:
// without one the stores were left in the home directory after every run.
const dir = await mkdtemp(join(tmpdir(), "tp-apps-test-"));
const base = { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false, dir } };

const encoding: DocumentEncodingApp = {
  kind: "document-encoding",
  title: "Document Encoding",
  description: "Scans and photos of delivery documents, read into records.",
  pending: ({ abilities }) => (abilities.includes("approve") ? 7 : 2),
  config: {
  intake: [{ via: "files" }, { via: "camera", location: true }],
  group_by: "reference",
  documents: {
    "delivery-receipt": {
      title: "Delivery receipt",
      recognise: "A printed form headed DELIVERY RECEIPT with a DR number top right.",
      fields: [
        { key: "reference", label: "DR number", type: "code", required: true },
        { key: "customer", label: "Customer", type: "name", candidates: "customers" },
        { key: "total_packs", label: "Total packs", type: "number" },
      ],
      tables: [
        {
          key: "lines",
          label: "Items",
          columns: [
            { key: "sku", label: "Item", type: "name", candidates: "skus" },
            { key: "packs", label: "Packs", type: "number" },
          ],
        },
      ],
      checks: [
        { type: "sum", table: "lines", column: "packs", equals: "total_packs" },
        { type: "same-in-group", field: "total_packs" },
      ],
    },
  },
  lists: { customers: () => ["North Market"], skus: async () => ["Pork Buns 250g"] },
  onApproved: () => {},
  },
};

// 1. Catalogue, single app, pending, capability flag.
{
  const server = Fastify();
  await server.register(registerAppPages, { ...base, apps: { "document-encoding": encoding } });

  const list = (await server.inject({ url: "/apps", headers: auth })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "document-encoding");
  assert.equal(list[0].kind, "document-encoding");
  assert.deepEqual(list[0].abilities, ["capture", "review", "approve"]);
  assert.match(list[0].config_version, /^[0-9a-f]{16}$/);
  assert.ok(!("pending" in list[0]));
  for (const key of ["lists", "expected", "onApproved"]) assert.ok(!(key in list[0].config), key);
  assert.equal(list[0].config.documents["delivery-receipt"].fields.length, 3);

  // Two apps of one kind: separate ids, and a changed configuration is a new version.
  const second = Fastify();
  await second.register(registerAppPages, {
    ...base,
    apps: {
      receiving: encoding,
      invoices: { ...encoding, title: "Invoices", config: { ...encoding.config, review: { question_cap: 5 } } },
    },
  });
  const two = (await second.inject({ url: "/apps", headers: auth })).json();
  assert.deepEqual(two.map((a: { id: string }) => a.id).sort(), ["invoices", "receiving"]);
  assert.equal(two.find((a: { id: string }) => a.id === "receiving").config_version, list[0].config_version);
  assert.notEqual(two[0].config_version, two[1].config_version);
  await second.close();

  assert.equal((await server.inject({ url: "/apps/document-encoding", headers: auth })).statusCode, 200);
  assert.equal((await server.inject({ url: "/apps/nope", headers: auth })).statusCode, 404);
  assert.deepEqual((await server.inject({ url: "/apps/pending", headers: auth })).json(), { "document-encoding": 7 });
  // Abilities come from ToolPlex; unknown ones are dropped, and a named list of apps limits the count.
  const reviewer = { ...auth, "x-toolplex-app-abilities": "review,delete-everything" };
  assert.deepEqual((await server.inject({ url: "/apps/pending", headers: reviewer })).json(), { "document-encoding": 2 });
  assert.deepEqual((await server.inject({ url: "/apps/pending?apps=other", headers: auth })).json(), {});
  assert.equal((await server.inject({ url: "/apps" })).statusCode, 401);
  assert.equal((await server.inject({ url: "/capabilities", headers: auth })).json().capabilities.apps, true);
  await server.close();
}

// 2. No apps: an empty catalogue, and the capability says so.
{
  const server = Fastify();
  await server.register(registerAppPages, base);
  assert.deepEqual((await server.inject({ url: "/apps", headers: auth })).json(), []);
  assert.equal((await server.inject({ url: "/capabilities", headers: auth })).json().capabilities.apps, false);
  await server.close();
}

// 3. Bad references fail at startup, all named at once.
{
  const broken: DocumentEncodingApp = {
    ...encoding,
    config: {
      ...encoding.config,
      group_by: "shipment",
      lists: {},
      documents: {
        dr: {
          ...encoding.config.documents["delivery-receipt"],
          checks: [{ type: "sum", table: "lines", column: "weight", equals: "total_packs" }],
        },
      },
    },
  };
  const server = Fastify();
  await assert.rejects(
    async () => {
      await server.register(registerAppPages, { ...base, apps: { enc: broken } });
      await server.ready();
    },
    (err: Error) => {
      for (const part of ['list "customers"', 'list "skus"', '"lines.weight"', 'group_by "shipment"']) {
        assert.ok(err.message.includes(part), `missing: ${part}\n${err.message}`);
      }
      return true;
    },
  );
}

// 4. Sections: the client's own words, served by place, outside the version,
//    known to the assistant, and checked at startup.
{
  const withText: DocumentEncodingApp = {
    ...encoding,
    sections: {
      capture: [{ type: "text", title: "Before you scan", text: "- One slip per sheet\n- The whole sheet must show\n\nAsk your supervisor about anything else." }],
      review: [{ type: "text", text: "Type what the paper says, **even if it looks wrong**." }],
      records: [],
    },
  };
  const server = Fastify();
  await server.register(registerAppPages, { ...base, apps: { plain: encoding, guided: withText } });
  const list = (await server.inject({ url: "/apps", headers: auth })).json() as { id: string; sections?: Record<string, unknown[]>; config_version: string; config: Record<string, unknown> }[];
  const plain = list.find((a) => a.id === "plain")!;
  const guided = list.find((a) => a.id === "guided")!;
  assert.ok(!("sections" in plain));
  assert.deepEqual(Object.keys(guided.sections!).sort(), ["capture", "review"], "an empty place is not served");
  assert.deepEqual(guided.sections!.capture[0], { type: "text", title: "Before you scan", text: withText.sections!.capture![0].text });
  assert.deepEqual(guided.sections!.review[0], { type: "text", text: "Type what the paper says, **even if it looks wrong**." });
  // Wording is not configuration: the same version with and without it.
  assert.equal(guided.config_version, plain.config_version);
  assert.ok(!("sections" in guided.config));

  // The assistant is told what the app tells people, on one line.
  const agent = (await server.inject({ url: "/apps/guided/document-encoding/agent", headers: auth })).json() as { about: string };
  assert.match(agent.about, /\[capture: Before you scan\] One slip per sheet; The whole sheet must show; Ask your supervisor about anything else\./);
  // Bold is for the screen; the assistant gets the sentence.
  assert.match(agent.about, /\[review\] Type what the paper says, even if it looks wrong\./);
  assert.ok(!agent.about.includes("**"));
  assert.ok(!agent.about.includes("\n"));
  // Someone who cannot capture never sees the Capture tab, so neither does their assistant.
  const reviewer = { ...auth, "x-toolplex-app-abilities": "review" };
  const forReviewer = (await server.inject({ url: "/apps/guided/document-encoding/agent", headers: reviewer })).json() as { about: string };
  assert.ok(!forReviewer.about.includes("One slip per sheet"));
  assert.match(forReviewer.about, /\[review\]/);
  const none = (await server.inject({ url: "/apps/plain/document-encoding/agent", headers: auth })).json() as { about: string };
  assert.ok(!none.about.includes("instructions"));
  await server.close();

  // A long set of instructions is cut, not sent whole into every conversation.
  const { toldInApp } = await import("../src/apps/encoding/agent.js");
  const long = toldInApp({ review: [{ type: "text", text: "word ".repeat(1000) }] }, () => true);
  assert.ok(long.length < 1800 && long.endsWith("…"), String(long.length));

  const bad = {
    ...encoding,
    sections: {
      lobby: [{ type: "text", text: "Hello" }],
      capture: [{ type: "image", src: "x.png" }, { type: "text", text: "   " }, { type: "text", text: "a".repeat(2001) }, { type: "text", title: "t".repeat(81), text: "ok" }],
      review: Array.from({ length: 7 }, () => ({ type: "text", text: "ok" })),
      records: "Keep everything",
    },
  } as unknown as DocumentEncodingApp;
  const broken = Fastify();
  await assert.rejects(
    async () => {
      await broken.register(registerAppPages, { ...base, apps: { enc: bad } });
      await broken.ready();
    },
    (err: Error) => {
      for (const part of [
        'sections "lobby": not a place in a document-encoding app (capture, review, records)',
        'sections "capture", section 1: type must be "text"',
        'sections "capture", section 2: text is empty',
        'sections "capture", section 3: text is 2001 characters; keep it to 2,000',
        'sections "capture", section 4: title must be text of at most 80 characters',
        'sections "review": has 7 sections; keep it to 6',
        'sections "records": must be a list of sections',
      ]) {
        assert.ok(err.message.includes(part), `missing: ${part}\n${err.message}`);
      }
      return true;
    },
  );
}

await rm(dir, { recursive: true, force: true });
console.log("apps: ok");
