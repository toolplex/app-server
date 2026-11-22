// A chat attachment brought into a document-encoding app: read from the
// file store as the person who attached it, once, images only.
//   npx tsx test/encoding-chat.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";
import type { DocumentEncodingApp } from "../src/index.js";

const dir = await mkdtemp(join(homedir(), ".tp-encoding-chat-test-"));
const ana = { authorization: "Bearer t", "x-toolplex-user-id": "u1", "x-toolplex-user-email": "ana@example.com", "x-toolplex-org-id": "org1" };
const ben = { ...ana, "x-toolplex-user-id": "u2", "x-toolplex-user-email": "ben@example.com" };
const read: string[] = [];

const app: DocumentEncodingApp = {
  kind: "document-encoding",
  title: "Document Encoding",
  config: {
    intake: [{ via: "files" }],
    documents: { slip: { title: "Slip", recognise: "A slip.", fields: [{ key: "no", label: "Number", type: "code" }] } },
  },
};

const server = Fastify();
await server.register(registerAppPages, {
  authToken: "t", pages: {}, resources: {}, actions: {},
  files: { dir },
  apps: { receiving: app },
  platform: {
    readDocument: async (req) => {
      read.push(Buffer.from(req.pages[0].data, "base64").toString());
      return {
        document_type: "slip", document_type_agreed: true,
        fields: { no: { value: "77", status: "accepted", candidates: [], written: "printed" } },
        tables: {}, checks: [], counts: { accepted: 1, confirm: 0, ask: 0, blank: 0 }, readers: [],
      };
    },
  },
});

const attach = async (filename: string, mimeType: string, body: string, headers = ana) =>
  (await server.inject({ method: "POST", url: "/files/raw", headers, payload: { filename, mimeType, dataBase64: Buffer.from(body).toString("base64") } })).json().manifest.fileId as string;
const tool = (name: string, body: object, headers = ana) =>
  server.inject({ method: "POST", url: `/apps/receiving/document-encoding/agent/${name}`, headers, payload: body });

try {
  const photo = await attach("slip.jpg", "image/jpeg", "photo bytes");
  const pdf = await attach("scan.pdf", "application/pdf", "%PDF-1.4 not really");

  const brought = await tool("add_attachments", { file_ids: [photo, pdf, "0000000000000000"] });
  // Bringing files in changes the app; the assistant's other tools only look.
  assert.equal(brought.headers["x-toolplex-app-changed"], "1");
  assert.equal((await tool("overview", {})).headers["x-toolplex-app-changed"], undefined);
  // The same tool reached by a differently spelled address is the same tool:
  // the router reads %5F as an underscore, and so does the rule.
  const spelled = await server.inject({ method: "POST", url: "/apps/receiving/document-encoding/agent/add%5Fattachments", headers: ana, payload: { file_ids: [photo] } });
  assert.equal(spelled.statusCode, 200);
  assert.equal(spelled.headers["x-toolplex-app-changed"], "1");
  assert.equal((await server.inject({ method: "POST", url: "/apps/receiving/document-encoding/agent/over%76iew", headers: ana, payload: {} })).headers["x-toolplex-app-changed"], undefined);
  const first = brought.json();
  assert.equal(first.brought_in.length, 1);
  assert.equal(first.brought_in[0].name, "slip.jpg");
  assert.equal(first.skipped.length, 2);
  assert.match(first.skipped.find((s: { file_id: string }) => s.file_id === pdf).reason, /Capture/);
  assert.equal(first.cards[0].open.tab, "review");

  // The same attachment a second time is the same document, not a new one.
  const again = (await tool("add_attachments", { file_ids: [photo] })).json();
  assert.equal(again.brought_in[0].id, first.brought_in[0].id);

  // Someone else cannot bring in a file that is not theirs.
  const other = (await tool("add_attachments", { file_ids: [photo] }, ben)).json();
  assert.equal(other.brought_in.length + other.skipped.length, 1);

  for (let i = 0; i < 100 && read.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(read, ["photo bytes"]);
  const list = (await server.inject({ url: "/apps/receiving/document-encoding/documents", headers: ana })).json();
  assert.equal(list.total, 1);
  console.log("encoding-chat: ok");
} finally {
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
