// A download whose data source fails must never take the server down.
// Before the response starts it is an ordinary error; after, the connection
// is broken so the person does not get a short file that looks complete.
//   npx tsx test/download-errors.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";

// A download is fetched in chunks of 100,000 rows; three chunks' worth.
const TOTAL = 250_000;
let failOn = 0;
const server = Fastify();
await server.register(registerAppPages, {
  authToken: "t",
  actions: {},
  files: { enabled: false },
  resources: {
    items: {
      fetch: async (req) => {
        if (req.page === failOn) throw new Error("the database went away");
        const start = (req.page - 1) * req.pageSize;
        const length = Math.max(0, Math.min(req.pageSize, TOTAL - start));
        return { rows: Array.from({ length }, (_, i) => ({ id: start + i + 1 })), total: TOTAL };
      },
    },
  },
  pages: { items: { title: "Items", sections: [{ type: "table", source: "items", rowKey: "id", downloadable: true, columns: [{ key: "id", label: "Id" }] }] } },
});
await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
const port = typeof address === "object" && address ? address.port : 0;
const crashes: unknown[] = [];
process.on("uncaughtException", (e) => crashes.push(e));
process.on("unhandledRejection", (e) => crashes.push(e));

// The client runs in a process of its own, as a real one does: the server
// builds each chunk without yielding, and a client sharing its event loop
// cannot read while it does.
const CLIENT = `
  const http = require("node:http");
  const req = http.get({ host: "127.0.0.1", port: ${port}, path: "/download/items", headers: { authorization: "Bearer t" } }, (res) => {
    let lines = 0, done = false;
    const say = (how) => { if (!done) { done = true; console.log(JSON.stringify({ status: res.statusCode, type: res.headers["content-type"], lines, how })); } };
    res.on("data", (c) => { for (const b of c) if (b === 10) lines++; });
    res.on("end", () => say(res.complete ? "complete" : "cut short"));
    res.on("aborted", () => say("cut short"));
    res.on("error", () => say("cut short"));
  });
  req.on("error", (e) => console.log(JSON.stringify({ how: "no response", error: e.message })));
`;
const download = async (): Promise<{ status?: number; type?: string; lines?: number; how: string }> =>
  JSON.parse((await promisify(execFile)(process.execPath, ["-e", CLIENT], { timeout: 60_000 })).stdout.trim().split("\n")[0]);

try {
  // 1. Nothing wrong: the heading and every row.
  const whole = await download();
  assert.deepEqual({ status: whole.status, lines: whole.lines, how: whole.how }, { status: 200, lines: TOTAL + 1, how: "complete" });

  // 2. Fails on the first chunk: an ordinary error, and no file was started.
  failOn = 1;
  const early = await download();
  assert.equal(early.status, 500);
  assert.ok(!(early.type ?? "").includes("text/csv"), early.type);

  // 3. Fails on a later chunk: the connection is broken, so the download is seen to fail.
  failOn = 3;
  // Either part of the file arrived and then the line dropped, or nothing
  // had left the server yet. What must never arrive is a normal ending.
  const late = await download();
  assert.ok(late.how === "cut short" || late.how === "no response", late.how);
  assert.ok((late.lines ?? 0) < TOTAL + 1);

  // 4. And the server is still there for the next person.
  failOn = 0;
  assert.equal((await download()).how, "complete");
  assert.deepEqual(crashes, []);
  console.log("download-errors: ok");
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await server.close();
}
