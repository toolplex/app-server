// Apps catalogue: definitions are served without their server-side functions,
// pending counts are live, and a bad reference fails at startup.
//   npx tsx test/apps.ts
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";
import type { DocumentEncodingApp } from "../src/index.js";

const auth = { authorization: "Bearer t" };
const base = { authToken: "t", pages: {}, resources: {}, actions: {}, files: { enabled: false } };

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

console.log("apps: ok");
