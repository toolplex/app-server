// A server stopped dead in the middle of writing records, again and again.
// After every stop the records are opened afresh and three things must hold:
// no two records carry the same change stamp, the index says what the record
// files say, and a copy kept by following the list of changes in small pages
// holds exactly the records that count. (One process at a time: this is what
// a crash does, not what two servers on one directory would do.)
//   npx tsx test/records-crash.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncodingStore, type StoredDocument } from "../src/apps/encoding/store.js";

const counted = (doc: StoredDocument): string | null => {
  const last = doc.versions?.at(-1);
  if (!last || doc.status === "discarded") return null;
  return `${last.version}:${doc.status !== "approved" ? 1 : 0}:${last.documentType}`;
};

if (process.argv[2] === "worker") {
  // Brings records in, approves, corrects and reopens them, without end.
  const store = new EncodingStore(process.argv[3], "app", { counted });
  await store.init();
  const approve = (doc: StoredDocument): void => {
    doc.versions.push({ version: doc.versions.length + 1, at: new Date().toISOString(), by: "x", documentType: "form", group: null, configVersion: "1", values: {}, tables: {} });
    doc.status = "approved";
  };
  process.send?.("writing");
  for (let round = 1; ; round++) {
    // Now and then a record that counts from the moment it is first stored:
    // stopped just then, the next start meets a record its index never heard of.
    if (round % 3 === 0) {
      const fresh = { id: `n${process.pid}-${round}`, appId: "app", status: "review", createdAt: new Date().toISOString(), createdBy: null, batch: null, name: "new", originals: [], pages: [], configVersion: "1", documentType: "form", group: null, reading: null, values: {}, tables: {}, resolved: {}, flags: {}, versions: [], history: [] } as StoredDocument;
      approve(fresh);
      void store.save(fresh).catch(() => {});
    }
    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const id = `d${String(i).padStart(3, "0")}`;
        if (!store.has(id)) {
          const doc = { id, appId: "app", status: "review", createdAt: new Date().toISOString(), createdBy: null, batch: null, name: id, originals: [], pages: [], configVersion: "1", documentType: "form", group: null, reading: null, values: {}, tables: {}, resolved: {}, flags: {}, versions: [], history: [] } as StoredDocument;
          approve(doc);
          await store.save(doc);
          return;
        }
        await store.update(id, (doc) => {
          const what = (i + round) % 4;
          if (what === 0) doc.status = doc.status === "approved" ? "review" : "approved";
          else if (what === 1) approve(doc);
          else if (what === 2) doc.status = "discarded";
          else if (doc.status === "approved") doc.status = "review";
          else approve(doc);
        });
      }),
    );
  }
}

const dir = await mkdtemp(join(homedir(), ".tp-records-crash-test-"));
try {
  const ROUNDS = 24;
  let stoppedWhileWriting = 0;
  let cursor: { seq: number; id: string } | null = null;
  let mark: { run: string; high: number } | null = null;
  let identity: string | null = null;
  const copy = new Map<string, string>();
  for (let round = 1; round <= ROUNDS; round++) {
    const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "worker", dir], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("exit", (code) => reject(new Error(`the worker stopped by itself (${code})`)));
    });
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 400));
    const gone = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.kill("SIGKILL");
    await gone;
    // Now and then the index is lost as well.
    const indexLost = round % 4 === 0;
    if (indexLost) await rm(join(dir, "index.jsonl"), { force: true });

    // What the record files themselves say, read without the store.
    const names = await readdir(join(dir, "docs"));
    if (names.some((f) => f.endsWith(".tmp"))) stoppedWhileWriting++;
    const onDisk = new Map<string, { seq: number | null; sig: string | null }>();
    for (const f of names.filter((n) => n.endsWith(".json"))) {
      const doc = JSON.parse(await readFile(join(dir, "docs", f), "utf8")) as StoredDocument;
      onDisk.set(doc.id, { seq: doc.counted?.seq ?? null, sig: counted(doc) });
    }
    const stamps = [...onDisk.values()].map((d) => d.seq).filter((s): s is number => s !== null);
    assert.equal(new Set(stamps).size, stamps.length, `round ${round}: two records carry the same stamp`);

    const store = new EncodingStore(dir, "app", { counted });
    await store.init();
    assert.ok(!(await readdir(join(dir, "docs"))).some((f) => f.endsWith(".tmp")), "half-written files are cleared away at start");
    for (const e of store.entries()) {
      assert.deepEqual({ seq: e.seq, sig: e.sig }, onDisk.get(e.id), `round ${round}: the index and the file of ${e.id} disagree`);
    }
    assert.equal(store.entries().length, onDisk.size);

    // A copy that has been following since the first round carries on from
    // where it was, in small pages.
    if (indexLost) {
      // With no index from the last run the store cannot vouch for what was
      // handed out, so it says so: a new identity, and the copy starts again.
      assert.notEqual(store.identity(), identity, `round ${round}: the index was lost and the store carried on as if it had not been`);
      cursor = null;
      copy.clear();
    } else {
      if (mark) assert.ok(store.continues(mark), `round ${round}: a copy that asked before the stop can no longer carry on`);
      assert.equal(identity ?? store.identity(), store.identity(), `round ${round}: the store took a new identity after a plain stop`);
    }
    identity = store.identity();
    for (;;) {
      const page = store.changes(cursor, 3);
      for (const c of page) {
        assert.ok(!cursor || c.seq > cursor.seq || (c.seq === cursor.seq && c.id > cursor.id), `round ${round}: the list went backwards`);
        if (c.removed) copy.delete(c.id);
        else copy.set(c.id, counted((await store.read(c.id))!)!);
        cursor = { seq: c.seq, id: c.id };
      }
      if (page.length < 3) break;
    }
    mark = store.mark();
    const live = new Map(store.entries().filter((e) => e.sig !== null).map((e) => [e.id, e.sig!]));
    assert.deepEqual([...copy].sort(), [...live].sort(), `round ${round}: the copy does not hold what counts`);
  }
  assert.ok(stoppedWhileWriting > 0, "none of the stops landed in the middle of a write; the test proved nothing");
  console.log(`records-crash: ok (${ROUNDS} stops, ${stoppedWhileWriting} of them mid-write)`);
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
