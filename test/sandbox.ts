// SQL someone else wrote runs in a process of its own, which the server
// stops and replaces when a query runs too long, takes too much memory or
// breaks it. Tested here at three levels: the processes and what watches
// them; the file tool through them; and an app's records through them. In
// every case the thing to see is that the server (this process) carries on.
//   npx tsx test/sandbox.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { QueryProcessError, QueryProcesses, type QueryProcessesOptions, type RunOptions } from "../src/sandbox/supervisor.js";
import { FileStore, FileStoreError } from "../src/files/store.js";
import { RecordsDatabase, RecordsError } from "../src/apps/records/database.js";
import { openRecords } from "../src/apps/records/runtime.js";
import type { RecordProjection, RecordsSource } from "../src/apps/records/types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, what: string, withinMs = 3_000): Promise<void> => {
  for (let waited = 0; alive(pid); waited += 25) {
    assert.ok(waited < withinMs, what);
    await sleep(25);
  }
};

// Statements made of ordinary functions that no list of forbidden ones stops.
const BREAKS_THE_ENGINE = "select json_structure(repeat('[', 30000) || repeat(']', 30000)) as broken";
const CANNOT_BE_STOPPED = "select levenshtein(repeat('a', 60000), repeat('b', 60000)) as never";
const WANTS_ALL_THE_MEMORY = "select len(range(400000000)) as greedy";

const fileQuery = (dbPath: string, sql: string, limitMs: number): Record<string, unknown> => ({ dbPath, sql, maxRows: 5, maxBytes: 100_000, bounds: { memory_limit: "256MB", threads: "2" }, timezone: null, timeoutMs: limitMs });

if (process.argv[2] === "server-that-dies") {
  // A stand-in for a server: puts a statement that cannot be stopped into a
  // query process, says which process that is, and waits to be stopped dead.
  const pool = new QueryProcesses();
  void pool.run("file.query", fileQuery(process.argv[3], CANNOT_BE_STOPPED, 600_000), { timeoutMs: 600_000, memoryMb: 256, who: "orphan test", sql: CANNOT_BE_STOPPED }).catch(() => {});
  for (let i = 0; pool.status().pids.length === 0; i++) await sleep(20);
  await sleep(500);
  process.send?.({ worker: pool.status().pids[0] });
  await sleep(600_000);
}

const dir = await mkdtemp(join(homedir(), ".tp-sandbox-test-"));
const unhandled: unknown[] = [];
process.on("unhandledRejection", (err) => unhandled.push(err));
process.on("uncaughtException", (err) => unhandled.push(err));
const refused = async (work: () => Promise<unknown>, status: number, what: string): Promise<Error & { statusCode?: number; failure?: string }> => {
  try {
    await work();
  } catch (err) {
    assert.equal((err as { statusCode?: number }).statusCode, status, `${what}: ${(err as Error).message}`);
    return err as Error;
  }
  throw new Error(`${what}: was not refused`);
};

// Stand-ins for the worker, each a program that speaks to the server as the
// real one does and then does one thing a real one might.
const standIn = async (name: string, body: string): Promise<string> => {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, body);
  return path;
};
const OBEDIENT = await standIn(
  "obedient",
  `process.on("message", (m) => {
     const reply = (value) => process.send({ t: "reply", id: m.id, ok: true, value });
     const p = m.payload;
     if (m.op === "say") reply(p);
     else if (m.op === "surroundings") reply({ env: Object.keys(process.env), flags: process.execArgv });
     else if (m.op === "wait") setTimeout(() => reply("waited"), p);
     else if (m.op === "hang") {}
     else if (m.op === "signal") process.kill(process.pid, p);
     else if (m.op === "exit") process.exit(p);
     else if (m.op === "refuse") process.send({ t: "reply", id: m.id, ok: false, error: p });
     else if (m.op === "maybe") { if (p) process.kill(process.pid, p); else reply("ran"); }
     else if (m.op === "shout") { process.send({ t: "log", level: p, message: "hello" }); reply(null); }
   });
   process.on("disconnect", () => process.exit(0));
   process.send({ t: "ready" });`,
);
const SILENT = await standIn("silent", `setInterval(() => {}, 1000);`);
// Ready at once, unless a file beside it says this is a bad moment: then it never is.
const MOODY = await standIn(
  "moody",
  `import { existsSync } from "node:fs";
   process.on("message", (m) => { if (m.op === "say") process.send({ t: "reply", id: m.id, ok: true, value: m.payload }); else if (m.op === "wait") setTimeout(() => process.send({ t: "reply", id: m.id, ok: true, value: "waited" }), m.payload); });
   process.on("disconnect", () => process.exit(0));
   if (!existsSync(new URL("./a-bad-moment", import.meta.url))) process.send({ t: "ready" });
   setInterval(() => {}, 1000);`,
);
const CANNOT_LOAD = await standIn("cannot-load", `process.send({ t: "failed", message: "the database could not be loaded in it: no such library" }, () => process.exit(1));`);
const SOMEONE_ELSES = await standIn("someone-elses", `console.error("  (a program that is not the worker ran, and ended)");`);

try {
  // ── The processes and what watches them ──────────────────────────────────
  const said: string[] = [];
  const log = (level: string, message: string): void => void said.push(`${level}: ${message}`);
  const about = (sql: string, more: Partial<RunOptions> = {}): RunOptions => ({ timeoutMs: 5_000, memoryMb: 256, who: "a test", sql, ...more });
  const pool = new QueryProcesses({ workerPath: OBEDIENT, size: 2, log });
  assert.equal(pool.status().processes, 0, "nothing is started until it is needed");
  assert.equal(await pool.run("say", "hello", about("1")), "hello");
  const [first] = pool.status().pids;
  assert.ok(first && first !== process.pid && alive(first));
  assert.equal(await pool.run("say", "again", about("2")), "again");
  assert.deepEqual(pool.status().pids, [first], "one process serves query after query");

  // It is given nothing of the server's surroundings: not its environment,
  // and not what the server itself was started with (flags can name a file
  // of secrets, or the server's own program).
  process.env.A_SECRET_OF_THE_SERVER = "not for a query";
  const around = await pool.run<{ env: string[]; flags: string[] }>("surroundings", null, about("3"));
  assert.ok(!around.env.includes("A_SECRET_OF_THE_SERVER") && around.env.every((n) => ["PATH", "HOME", "TZ", "NODE_ENV", "TOOLPLEX_QUERY_PROCESS"].includes(n) || n.startsWith("__")), around.env.join(", "));
  assert.deepEqual(around.flags, ["--max-old-space-size=512"], `the server here was started with ${JSON.stringify(process.execArgv)}`);

  // A failure the process reports is the statement's own; the process stays.
  // What it says is taken as words and a status, and nothing else.
  const own = await refused(() => pool.run("refuse", { statusCode: 400, message: "no such column" }, about("4")), 400, "a statement that is wrong");
  assert.ok(!(own instanceof QueryProcessError) && own.message === "no such column");
  await refused(() => pool.run("refuse", { statusCode: "200; DROP", message: { not: "text" } }, about("5")), 500, "a failure said badly");
  await pool.run("shout", "constructor", about("6"));
  assert.ok(said.includes("error: a query process: hello"), said.join("\n"));
  assert.deepEqual(pool.status().pids, [first]);

  // A process that ends itself under a query was ended by that query. The
  // query is refused, its process replaced, and the same query is not run
  // again: asking it over and over starts nothing.
  for (const [how, op, payload] of [["by a fault", "signal", "SIGSEGV"], ["by an abort", "signal", "SIGABRT"], ["by an error", "exit", 3]] as const) {
    const startsBefore = pool.status().starts;
    const broke = await refused(() => pool.run(op, payload, about(`breaks ${how}`)), 400, `a process ended ${how}`);
    assert.ok(broke instanceof QueryProcessError && broke.failure === "broke", broke.message);
    for (let i = 0; i < 5; i++) await refused(() => pool.run(op, payload, about(`breaks ${how}`)), 400, "the same statement again");
    assert.ok(pool.status().starts - startsBefore <= 1, "the statement was run again");
    assert.equal(await pool.run("say", "next", about("7")), "next");
  }
  assert.ok(said.some((l) => l.startsWith("error: a query stopped the process it was run in (SIGSEGV)") && l.includes("a test: breaks by a fault")), said.join("\n"));
  // One that is stopped from outside (the system short of memory, the server
  // and its children being stopped) is nobody's query's doing: come back.
  for (const signal of ["SIGTERM", "SIGKILL", "SIGINT"]) {
    const outside = await refused(() => pool.run("signal", signal, about(`stopped by ${signal}`)), 503, `a process stopped by ${signal}`);
    assert.ok(outside instanceof QueryProcessError && outside.failure === "stopped");
  }
  assert.equal(await pool.run("signal", "SIGUSR2", about("stopped by SIGTERM")).catch((err: QueryProcessError) => err.failure), "stopped", "and its statement is run again when asked again");
  assert.ok(!said.some((l) => l.includes("stopped by SIGTERM") && l.startsWith("error")), "nothing is blamed on a query for that");

  // One that does not answer is stopped a little after its time limit, and
  // what it had begun to write is cleared away.
  const scratch = join(dir, "scratch-of-a-query");
  await mkdir(scratch);
  await writeFile(join(scratch, "half-written"), "x");
  let started = Date.now();
  const late = await refused(() => pool.run("hang", null, about("hangs", { timeoutMs: 300, scratch: [scratch] })), 408, "a statement that does not answer");
  assert.ok(late instanceof QueryProcessError && late.failure === "timeout");
  assert.ok(Date.now() - started < 3_500, `stopping it took ${Date.now() - started} ms`);
  await sleep(200);
  assert.ok(!existsSync(scratch), "what a stopped query left behind is still there");
  assert.equal(await pool.run("say", "after", about("8")), "after");
  // One that says itself that it ran out of time may not have stopped when
  // told to: its process is ended, and what it left is cleared away too.
  await mkdir(scratch);
  const [saidSo] = pool.status().pids;
  await refused(() => pool.run("refuse", { statusCode: 408, message: "too long" }, about("says it ran out of time", { scratch: [scratch] })), 408, "a statement that says it ran out of time");
  await gone(saidSo, "a process whose statement ran out of time was kept", 1_000);
  await sleep(100);
  assert.ok(!existsSync(scratch), "what a query that ran out of time left behind is still there");
  // A query that ends cleanly clears up after itself, and nothing of its is touched.
  await mkdir(scratch);
  assert.equal(await pool.run("say", "clean", about("8b", { scratch: [scratch] })), "clean");
  await refused(() => pool.run("signal", "SIGKILL", about("8c")), 503, "the next query's process is stopped");
  await sleep(100);
  assert.ok(existsSync(scratch), "an earlier query's directory was removed for a later query's failure");
  await rm(scratch, { recursive: true });

  // Each query has a process to itself, so one that is stopped takes nothing
  // else with it; and there are only so many at once.
  const slow = pool.run("hang", null, about("hangs again", { timeoutMs: 400 })).then(() => "ok", (err: QueryProcessError) => `${err.statusCode} ${err.failure}`);
  const bystander = pool.run("wait", 1_000, about("9")).then((v) => v, (err: QueryProcessError) => `${err.statusCode} ${err.failure}`);
  assert.deepEqual(await Promise.all([slow, bystander]), ["408 timeout", "waited"]);
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => pool.run("wait", 20, about(`many ${i}`))));
  assert.deepEqual([...new Set(many)], ["waited"]);
  assert.ok(pool.status().processes <= 2 && pool.status().waiting === 0, JSON.stringify(pool.status()));
  // With every process taken for too long, a query is told to come back.
  const taken = [pool.run("wait", 1_500, about("10")), pool.run("wait", 1_500, about("11"))];
  const turnedAway = await refused(() => pool.run("say", "x", about("12", { timeoutMs: 300 })), 503, "a query with no process free");
  assert.ok(turnedAway instanceof QueryProcessError && turnedAway.failure === "busy");
  await Promise.all(taken);

  // A process killed between queries is simply not used again; nothing is
  // heard of it, however many queries find it gone at once.
  for (const pid of pool.status().pids) process.kill(pid, "SIGKILL");
  const afterKill = await Promise.all(Array.from({ length: 4 }, (_, i) => pool.run("say", i, about(`after kill ${i}`)).then((v) => v, (err: QueryProcessError) => err.failure)));
  assert.ok(afterKill.every((v) => typeof v === "number" || v === "stopped"), JSON.stringify(afterKill));
  assert.deepEqual(await Promise.all([0, 1, 2].map((i) => pool.run("say", i, about(`later ${i}`)))), [0, 1, 2]);

  // Closed with a query in flight: the caller is told, the processes are gone.
  const pids = pool.status().pids;
  const inFlight = pool.run("hang", null, about("in flight", { timeoutMs: 60_000 })).then(() => "ok", (err: QueryProcessError) => `${err.statusCode} ${err.failure}`);
  await sleep(100);
  await pool.close();
  assert.equal(await inFlight, "503 closed");
  assert.ok(pids.every((pid) => !alive(pid)));
  await refused(() => pool.run("say", "x", about("13")), 503, "after it was closed");

  // A process with nothing to do is let go, and another started when needed.
  const brief = new QueryProcesses({ workerPath: OBEDIENT, idleMs: 300 });
  await brief.run("say", "x", about("1"));
  const [idlePid] = brief.status().pids;
  await sleep(700);
  assert.ok(!alive(idlePid) && brief.status().processes === 0);
  assert.equal(await brief.run("say", "again", about("2")), "again");
  await brief.close();

  // A host where no such process can be started. Whatever the reason, it is
  // told apart from a query that failed (`unavailable`), found out once and
  // not again for every query, and nothing is left running.
  const cannot: [string, QueryProcessesOptions, RegExp][] = [
    ["a program that never says it is ready", { workerPath: SILENT, startMs: 400 }, /not ready after 0.4 s/],
    ["a database that does not load in it", { workerPath: CANNOT_LOAD }, /no such library/],
    ["someone else's program where the worker should be", { workerPath: SOMEONE_ELSES }, /stopped as it started \(exit 0\)/],
    ["no program at all", { workerPath: join(dir, "no-such-worker.js") }, /stopped as it started \(exit 1\)/],
    ["a system that will not start one", { workerPath: "not\0a path" }, /cannot be started/],
  ];
  for (const [what, options, why] of cannot) {
    const none = new QueryProcesses(options);
    const err = await refused(() => none.run("say", "x", about("1")), 503, what);
    assert.ok(err instanceof QueryProcessError && err.failure === "unavailable" && why.test(err.message), `${what}: ${err.message}`);
    const startsOnce = none.status().starts;
    started = Date.now();
    for (let i = 0; i < 3; i++) await refused(() => none.run("say", "x", about(`${i}`)), 503, what);
    assert.ok(none.status().starts === startsOnce && Date.now() - started < 200 && !none.status().available, `${what}: asked again for every query`);
    await sleep(100);
    assert.equal(none.status().processes, 0, `${what}: something was left running`);
    await none.close();
  }
  // A host that has started one can start one. A start that fails there is
  // a bad moment: a process that is waiting for work is used all the same,
  // and a query that needs a new one is refused. It is not let into the
  // server, and the host is not written off.
  const moody = new QueryProcesses({ workerPath: MOODY, startMs: 300, size: 2, log });
  assert.equal(await moody.run("say", 1, about("1")), 1);
  await writeFile(join(dir, "a-bad-moment"), "");
  assert.equal(await moody.run("say", 2, about("2")), 2, "the process that was waiting was not used");
  const pair = await Promise.all([moody.run("wait", 600, about("3")), moody.run("say", 4, about("4")).then((v) => v, (err: QueryProcessError) => `${err.statusCode} ${err.failure}`)]);
  assert.deepEqual(pair, ["waited", "503 busy"]);
  assert.ok(moody.status().available, "one start that failed wrote the host off");
  assert.equal(await moody.run("say", 5, about("5")), 5);
  await rm(join(dir, "a-bad-moment"));
  assert.deepEqual(await Promise.all([moody.run("wait", 200, about("6")), moody.run("say", 7, about("7"))]), ["waited", 7], "and when the moment has passed, one starts");
  assert.ok(said.filter((l) => l.includes("refused until one starts, not run in the server")).length === 1, said.join("\n"));
  await moody.close();
  // Two bad moments a long while apart are two bad moments, when queries
  // were answered between them. Only starting that fails for a long while
  // with nothing answered in all that time is a host that has changed, and
  // then it is said and the queries run in the server.
  const patient = new QueryProcesses({ workerPath: MOODY, startMs: 200, size: 2, giveUpStartingMs: 500, log });
  assert.equal(await patient.run("say", 1, about("1")), 1);
  await writeFile(join(dir, "a-bad-moment"), "");
  const needsAnother = (): Promise<unknown[]> => Promise.all([patient.run("wait", 400, about("w")), patient.run("say", "x", about("x")).then((v) => v, (err: QueryProcessError) => `${err.statusCode} ${err.failure}`)]);
  assert.deepEqual(await needsAnother(), ["waited", "503 busy"]);
  for (const until = Date.now() + 800; Date.now() < until; await sleep(50)) assert.equal(await patient.run("say", "still", about("s")), "still");
  assert.deepEqual(await needsAnother(), ["waited", "503 busy"], "a second bad moment, long after the first, let a query into the server");
  assert.ok(patient.status().available);
  for (const pid of patient.status().pids) process.kill(pid, "SIGKILL");
  await sleep(100);
  const firstOfMany = await refused(() => patient.run("say", "y", about("y")), 503, "a start that fails with no process left");
  assert.ok(firstOfMany instanceof QueryProcessError && firstOfMany.failure === "busy");
  await sleep(600);
  const givenUp = await refused(() => patient.run("say", "z", about("z")), 503, "starting that has failed for a long while");
  assert.ok(givenUp instanceof QueryProcessError && givenUp.failure === "unavailable" && !patient.status().available, givenUp.message);
  await rm(join(dir, "a-bad-moment"));
  await patient.close();
  // Nothing is started once closing has begun, whoever asked in the same breath.
  const closing = new QueryProcesses({ workerPath: OBEDIENT, size: 2 });
  const asked = [closing.run("say", 1, about("1")), closing.run("say", 2, about("2"))].map((r) => r.then((v) => v, (err: QueryProcessError) => err.failure));
  await closing.close();
  assert.ok((await Promise.all(asked)).every((v) => v === "closed" || typeof v === "number"));
  await sleep(150);
  assert.equal(closing.status().processes, 0, "a process was started after the pool was closed");

  // What broke a process is refused where it broke it, and run where it did not:
  // the same words over someone else's file are someone else's query.
  const shared = new QueryProcesses({ workerPath: OBEDIENT, size: 2 });
  await refused(() => shared.run("maybe", "SIGSEGV", about("select shape from data", { who: "file A" })), 400, "a statement that breaks on one file");
  const startsThen = shared.status().starts;
  await refused(() => shared.run("maybe", null, about("select shape from data", { who: "file A" })), 400, "the same statement over the same file");
  assert.equal(shared.status().starts, startsThen, "it was run again");
  assert.equal(await shared.run("maybe", null, about("select shape from data", { who: "file B" })), "ran");
  await shared.close();

  // Work that may take minutes has a turn apart, one at a time: it never
  // takes the turns questions are answered in, however few there are.
  const narrow = new QueryProcesses({ workerPath: OBEDIENT, size: 1 });
  const long = narrow.run("wait", 1_200, about("a file from a query", { long: true }));
  await sleep(100);
  started = Date.now();
  assert.equal(await narrow.run("say", "a question", about("q")), "a question");
  assert.ok(Date.now() - started < 600, `a question waited ${Date.now() - started} ms behind long work`);
  const second = await refused(() => narrow.run("wait", 10, about("another file from a query", { long: true, timeoutMs: 300 })), 503, "a second piece of long work meanwhile");
  assert.ok(second instanceof QueryProcessError && second.failure === "busy");
  assert.equal(await long, "waited");
  await narrow.close();

  // A query process never starts processes of its own, whatever it is made to run.
  process.env.TOOLPLEX_QUERY_PROCESS = "1";
  const nested = new QueryProcesses({ workerPath: OBEDIENT });
  const no = await refused(() => nested.run("say", "x", about("1")), 503, "a query process starting its own");
  assert.ok(no instanceof QueryProcessError && no.failure === "unavailable" && nested.status().starts === 0);
  delete process.env.TOOLPLEX_QUERY_PROCESS;

  // ── The real worker ──────────────────────────────────────────────────────
  const db = join(dir, "t.duckdb");
  {
    const inst = await DuckDBInstance.create(db);
    const conn = await inst.connect();
    await conn.run("create table t as select range as a, 'v' || range as s from range(1000)");
    conn.disconnectSync();
    inst.closeSync();
  }
  const real = new QueryProcesses({ maxRssMb: 1200, size: 2, log });
  const ask = (sql: string, limitMs = 5_000): Promise<{ rows: Record<string, unknown>[] }> => real.run("file.query", fileQuery(db, sql, limitMs), about(sql, { timeoutMs: limitMs }));
  assert.deepEqual((await ask("select count(*) as n from t")).rows, [{ n: 1000 }]);
  const [worker] = real.status().pids;
  await refused(() => ask("select nope from t"), 400, "a statement that is wrong");
  await refused(() => real.run("file.nothing", {}, about("x")), 400, "something the worker does not do");
  await refused(() => real.run("constructor.x", {}, about("x")), 400, "something the worker does not do");
  assert.deepEqual(real.status().pids, [worker]);
  // A statement that brings the database down brings down that process, and only that.
  started = Date.now();
  const broke = await refused(() => ask(BREAKS_THE_ENGINE), 400, "a statement that breaks the engine");
  assert.ok(broke instanceof QueryProcessError && broke.failure === "broke" && Date.now() - started < 5_000);
  assert.deepEqual((await ask("select count(*) as n from t")).rows, [{ n: 1000 }], "the next query is answered by a new process");
  assert.ok(!alive(worker));
  // One that cannot be stopped is stopped all the same: it is answered at
  // its limit, and its process, where it would have gone on working, is ended.
  started = Date.now();
  const stuck = real.status().pids;
  await refused(() => ask(CANNOT_BE_STOPPED, 400), 408, "a statement that cannot be stopped");
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
  for (const pid of stuck) await gone(pid, "a process whose statement ran out of time was kept", 1_000);
  // So no number of them, one after another, leaves the next query waiting.
  for (let i = 0; i < 5; i++) await refused(() => ask(`${CANNOT_BE_STOPPED} -- ${i}`, 200), 408, "one more that cannot be stopped");
  started = Date.now();
  assert.deepEqual((await ask("select count(*) as n from t")).rows, [{ n: 1000 }]);
  assert.ok(Date.now() - started < 1_000, `an ordinary query after them waited ${Date.now() - started} ms`);
  // One that says nothing at all at its limit has its process stopped a little after.
  const silent = new QueryProcesses({ workerPath: OBEDIENT });
  started = Date.now();
  const never = await refused(() => silent.run("hang", null, about("silent", { timeoutMs: 300 })), 408, "a process that says nothing");
  assert.ok(never instanceof QueryProcessError && never.failure === "timeout" && Date.now() - started < 3_500, `${Date.now() - started} ms`);
  await silent.close();
  // One that takes all the memory there is: stopped when its process holds more than it may.
  started = Date.now();
  const greedy = await refused(() => ask(WANTS_ALL_THE_MEMORY, 20_000), 400, "a statement that wants all the memory");
  assert.ok(Date.now() - started < 10_000 && (!(greedy instanceof QueryProcessError) || greedy.failure === "memory"), greedy.message);
  assert.deepEqual((await ask("select count(*) as n from t")).rows, [{ n: 1000 }]);
  await real.close();

  // When the server is stopped dead, a query process does not outlive it,
  // even one with a statement in it that cannot be stopped.
  const server = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "server-that-dies", db], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const workerPid = await new Promise<number>((resolve, reject) => {
    server.once("message", (m: { worker: number }) => resolve(m.worker));
    server.once("exit", () => reject(new Error("the stand-in server stopped by itself")));
  });
  assert.ok(alive(workerPid));
  server.kill("SIGKILL");
  await gone(workerPid, "the query process outlived its server", 2_000);

  // ── The file tool ────────────────────────────────────────────────────────
  const requester = { orgId: "org-test" };
  const heardByStore: string[] = [];
  const store = new FileStore({ enabled: true, dir: join(dir, "files"), minFreeBytes: 0 }, { maxQueryProcessMb: 1200, log: (level, message) => void heardByStore.push(`${level}: ${message}`) });
  await store.init();
  const file = await store.materialize("data", Array.from({ length: 50 }, (_, i) => ({ store: `Store ${i}`, sold: i * 10 })), requester);
  assert.deepEqual((await store.query(file.fileId, "select count(*) as n, sum(sold) as total from data", requester)).rows, [{ n: 50, total: 12250 }]);
  for (const [sql, status] of [[BREAKS_THE_ENGINE, 400], [WANTS_ALL_THE_MEMORY, 400]] as const) {
    const err = await refused(() => store.query(file.fileId, sql, requester), status, sql);
    assert.ok(err instanceof FileStoreError, "the store's own kind of error, so its routes answer as they always have");
    assert.deepEqual((await store.query(file.fileId, "select count(*) as n from data", requester)).rows, [{ n: 50 }], "and the next query is answered");
  }
  assert.ok(heardByStore.some((l) => l.includes(`file ${file.fileId}: select json_structure`)), `the log names whose query broke a process and what it was:\n${heardByStore.join("\n")}`);
  // The same across an album of snapshots, and for a query whose result becomes a file.
  const album = [{ fileId: file.fileId, takenAt: new Date().toISOString(), sourceSync: null }];
  assert.deepEqual((await store.queryMany(album, "select count(*) as n from data", requester)).rows, [{ n: 50 }]);
  await refused(() => store.queryMany(album, BREAKS_THE_ENGINE, requester), 400, "an album query that breaks the engine");
  assert.deepEqual((await store.queryMany(album, "select count(*) as n from history.data", requester)).rows, [{ n: 50 }]);
  const made = await store.materializeFromQuery(file.fileId, "select store, sold * 2 as doubled from data where sold >= 400", "big", requester);
  assert.deepEqual((await store.query(made.fileId, "select count(*) as n, max(doubled) as most from big", requester)).rows, [{ n: 10, most: 980 }]);
  await refused(() => store.materializeFromQuery(file.fileId, BREAKS_THE_ENGINE, "never", requester), 400, "a query-to-file that breaks the engine");
  assert.ok(!(await readdir(join(dir, "files"))).some((f) => f.endsWith(".staged.json")), "what a failed query-to-file had begun to write is cleared away");
  // Several at once, of which some break things: the others are answered.
  const breaker = (i: number): string => `select json_structure(repeat('[', ${30000 + i}) || repeat(']', ${30000 + i})) as broken`;
  const mixed = await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.query(file.fileId, i % 4 === 0 ? breaker(i) : "select sum(sold) as total from data", requester).then((r) => r.rows[0].total, (err: FileStoreError) => err.statusCode)),
  );
  assert.deepEqual(mixed.filter((_, i) => i % 4 !== 0), Array(9).fill(12250));
  assert.deepEqual(mixed.filter((_, i) => i % 4 === 0), [400, 400, 400]);
  await store.close();
  await refused(() => store.query(file.fileId, "select 1", requester), 503, "a query after the store was closed");
  // Turned off, the same queries run in the server itself, as they did before.
  const inside = new FileStore({ enabled: true, dir: join(dir, "files") }, { isolate: false });
  await inside.init();
  assert.deepEqual((await inside.query(file.fileId, "select count(*) as n from data", requester)).rows, [{ n: 50 }]);
  await refused(() => inside.query(file.fileId, "select nope from data", requester), 400, "a wrong statement, run in the server");
  // In the server a statement that cannot be stopped goes on working after
  // it has been answered. The database is not closed under it, and it keeps
  // one of two turns until it has ended: however many are sent, the server's
  // own reading of its disk never waits on them.
  const impatient = new FileStore({ enabled: true, dir: join(dir, "files"), queryTimeoutMs: 300 }, { isolate: false });
  await impatient.init();
  const FOR_A_WHILE = "select levenshtein(repeat('a', 25000), repeat('b', 25000)) as slow";
  started = Date.now();
  const sent = Array.from({ length: 6 }, (_, i) => impatient.query(file.fileId, `${FOR_A_WHILE} -- ${i}`, requester).then(() => 200, (err: FileStoreError) => err.statusCode));
  await sleep(600);
  const reading = Date.now();
  for (let i = 0; i < 20; i++) await readdir(join(dir, "files"));
  assert.ok(Date.now() - reading < 500, `the server's own reading waited ${Date.now() - reading} ms behind statements that could not be stopped`);
  assert.deepEqual(await Promise.all(sent), Array(6).fill(408));
  assert.deepEqual((await impatient.query(file.fileId, "select count(*) as n from data", requester)).rows, [{ n: 50 }], "and when they have ended, the next is answered");

  // On a host where no such process can be started, the tool is not down:
  // its queries run in the server, as they did before, and it is said once.
  for (const queryWorkerPath of [join(dir, "no-such-worker.js"), CANNOT_LOAD, SOMEONE_ELSES, "not\0a path"]) {
    const heard: string[] = [];
    const stranded = new FileStore({ enabled: true, dir: join(dir, "files") }, { queryWorkerPath, log: (level, message) => void heard.push(`${level}: ${message}`) });
    await stranded.init();
    for (let i = 0; i < 3; i++) assert.deepEqual((await stranded.query(file.fileId, "select count(*) as n from data", requester)).rows, [{ n: 50 }]);
    assert.equal(heard.filter((l) => l.startsWith("error: queries over files are running inside the server")).length, 1, heard.join("\n"));
    await stranded.close();
  }

  // ── An app's records ─────────────────────────────────────────────────────
  const things = new Map<string, { n: number; rev: number; gone?: boolean }>();
  for (let i = 0; i < 3000; i++) things.set(`t${String(i).padStart(4, "0")}`, { n: i, rev: 1 });
  const source: RecordsSource = {
    tables: [{ name: "things", label: "Things", grain: "record", key: "record_id", columns: [{ name: "record_id", type: "text", label: "Record", system: true }, { name: "n", type: "number", label: "N" }] }],
    version: "1",
    about: "things",
    noun: { one: "thing", many: "things" },
    identity: () => "test",
    expected: () => [...things].filter(([, t]) => !t.gone).map(([id, t]) => ({ id, signature: String(t.rev) })),
    signature: (id) => (things.get(id) && !things.get(id)!.gone ? String(things.get(id)!.rev) : ""),
    project: async (id): Promise<RecordProjection | null> => {
      const t = things.get(id);
      return !t ? null : t.gone ? { id, signature: "", rows: {} } : { id, signature: String(t.rev), rows: { things: [{ record_id: id, n: t.n }] } };
    },
    changedAt: () => new Date().toISOString(),
    changes: () => [],
    mark: () => ({ run: "r", high: 0 }),
    continues: () => true,
  };
  const recordsDir = join(dir, "records");
  await mkdir(recordsDir);
  const heardByApp: string[] = [];
  const processes = new QueryProcesses({ maxRssMb: 1200, size: 2 });
  const views = { big: { sql: "select * from things where n >= 2990", label: "The big ones" } };
  const app = await openRecords({ appId: "things", title: "Things", dir: recordsDir, source, database: true, timezone: "Asia/Singapore", views, after: Promise.resolve(), processes, log: (level, message) => void heardByApp.push(`${level}: ${message}`) });
  const pages = app.database!;
  const tool = app.tool()!;
  const rows = async (sql: string): Promise<Record<string, unknown>[]> => (await tool.run({ sql })).rows as Record<string, unknown>[];
  const count = async (): Promise<number> => Number((await rows("select count(*) as n from things"))[0].n);
  const copies = async (): Promise<string[]> => {
    const all: string[] = [];
    for (const held of await readdir(join(recordsDir, ".records-frozen"))) all.push(...(await readdir(join(recordsDir, ".records-frozen", held))));
    return all;
  };
  // The assistant's query is answered by another process, from a frozen copy of the tables.
  assert.equal(await count(), 3000);
  assert.ok(processes.status().starts === 1 && processes.status().pids[0] !== process.pid);
  assert.equal(pages.status().queryTurns.free, 2, "nothing of it ran in the server's own tables");
  assert.deepEqual(await rows("select count(*) as n from big"), [{ n: 10 }], "a query of the client's own is there too");
  assert.deepEqual(await rows("select count(*) as n from memory.main.things"), [{ n: 3000 }], "and the tables go by the names they have in the server");
  assert.deepEqual(await rows("select current_setting('TimeZone') as zone"), [{ zone: "Asia/Singapore" }]);
  // One copy serves every query until something changes.
  await Promise.all(Array.from({ length: 8 }, () => count()));
  assert.deepEqual(await copies(), ["1"]);
  // Everything the rules for a query refuse is refused there as here.
  for (const sql of ["delete from things", "select 1; drop table things", "select * from enable_peg_parser()", "select system.main.sleep_ms(2000)", "select pg_sleep(1)", "select * from pg_settings", "select * from read_text('/etc/hosts')", "attach ':memory:' as x", "select getenv('HOME')"]) {
    const no = await refused(() => rows(sql), 400, sql);
    assert.ok(no instanceof RecordsError, sql);
  }
  await refused(() => tool.run({ sql: "" }), 400, "no query at all");
  // The client's own code reads the server's own tables, as its pages do.
  const startsSoFar = processes.status().starts;
  assert.deepEqual((await app.query("select n from things where record_id = $1", ["t0042"])).rows, [{ n: 42 }]);
  assert.equal(processes.status().starts, startsSoFar);
  // A record changes: a query asked straight after sees it, from a new copy,
  // and the copy it replaced is removed.
  Object.assign(things.get("t0001")!, { n: 1_000_000, rev: 2 });
  app.touch("t0001");
  assert.deepEqual(await rows("select max(n) as most from things"), [{ most: 1_000_000 }]);
  things.get("t0002")!.gone = true;
  app.touch("t0002");
  assert.equal(await count(), 2999);
  await sleep(100);
  assert.deepEqual(await copies(), ["3"]);
  // The copy removed from under the server (or damaged): the query that
  // finds it so is answered from a new one, and it is said in the log.
  {
    const frozen = join(recordsDir, ".records-frozen");
    const [held] = await readdir(frozen);
    for (const n of await readdir(join(frozen, held))) await rm(join(frozen, held, n), { recursive: true });
    assert.equal(await count(), 2999);
    assert.ok(heardByApp.some((l) => l.startsWith("error: a frozen copy of the tables could not be opened by a query's process; another is made")), heardByApp.join("\n"));
    heardByApp.length = 0;
    // Another database opened over the same directory in this process leaves these copies alone.
    const beside = new RecordsDatabase(source, { dir: recordsDir, timezone: "UTC", freeze: true });
    await beside.prepare();
    assert.equal(await count(), 2999);
    assert.equal((await copies()).length, 1);
    await beside.close();
    assert.equal(await count(), 2999);
  }
  // The three that nothing inside a database can stop. Each is answered
  // plainly, the server's own pages never notice, nothing is rebuilt, and
  // the next query is answered at once.
  for (const [sql, status] of [[BREAKS_THE_ENGINE, 400], [WANTS_ALL_THE_MEMORY, 400], [CANNOT_BE_STOPPED, 408]] as const) {
    let slowest = 0;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const t0 = Date.now();
        assert.equal((await pages.page("things", { page: 1, pageSize: 5 })).total, 2999);
        slowest = Math.max(slowest, Date.now() - t0);
        await sleep(20);
      }
    })();
    started = Date.now();
    const err = await refused(() => (sql === CANNOT_BE_STOPPED ? pages.freeze().then((copy) => processes.run("records.query", { path: copy.path, relations: copy.relations, sql, limits: { params: [], maxRows: 5, maxText: 100, maxResultText: 1000, timeoutMs: 500 }, timezone: "UTC", bounds: {} }, about(sql, { timeoutMs: 500 })).finally(copy.done)) : rows(sql)), status, sql);
    assert.ok(Date.now() - started < 12_000, `${sql} was answered after ${Date.now() - started} ms`);
    if (sql !== CANNOT_BE_STOPPED) assert.ok(err instanceof RecordsError, "the app's own kind of error");
    watching = false;
    await watcher;
    assert.ok(slowest < 400, `the server's own pages waited ${slowest} ms while a query misbehaved`);
    started = Date.now();
    assert.equal(await count(), 2999);
    assert.ok(Date.now() - started < 1_500, `the next query waited ${Date.now() - started} ms`);
    assert.equal(pages.status().records, 2999, "the server's tables were never touched");
  }
  assert.ok(processes.status().processes <= 2);
  // A change made while a query's process was being replaced is in the next answer.
  await refused(() => rows(`${BREAKS_THE_ENGINE} `), 400, "one more break");
  Object.assign(things.get("t0003")!, { n: 7_000_000, rev: 2 });
  app.touch("t0003");
  assert.deepEqual(await rows("select max(n) as most from things"), [{ most: 7_000_000 }]);
  // Many at once, while records change under them: every answer is of one
  // state of the tables, never of half a change.
  let rev = 3;
  const changing = (async () => {
    for (let i = 0; i < 20; i++) {
      for (const id of ["t0010", "t0011"]) Object.assign(things.get(id)!, { n: 9_000_000 + rev, rev });
      rev++;
      app.touch("t0010");
      app.touch("t0011");
      await sleep(15);
    }
  })();
  const seen = await Promise.all(Array.from({ length: 24 }, async (_, i) => (await sleep(i * 12), rows("select count(distinct n) as kinds, count(*) as n from things where record_id in ('t0010', 't0011')"))));
  await changing;
  assert.ok(seen.every(([r]) => Number(r.n) === 2 && Number(r.kinds) <= 2), JSON.stringify(seen));
  await sleep(200);
  assert.equal((await copies()).length, 1, "copies that were replaced are still on disk");
  // On a host where no such process can be started, the tool is not down:
  // the query runs in the server's own tables, and it is said once.
  const strandedDir = join(dir, "records-stranded");
  await mkdir(strandedDir);
  const heard: string[] = [];
  const nowhere = new QueryProcesses({ workerPath: CANNOT_LOAD });
  const stranded = await openRecords({ appId: "things", title: "Things", dir: strandedDir, source, database: true, timezone: "UTC", after: Promise.resolve(), processes: nowhere, log: (level, message) => void heard.push(`${level}: ${message}`) });
  for (let i = 0; i < 3; i++) assert.deepEqual((await stranded.tool()!.run({ sql: "select count(*) as n from things" })).rows, [{ n: 2999 }]);
  assert.equal(heard.filter((l) => l.startsWith("error: queries over this app's records are running inside the server")).length, 1, heard.join("\n"));
  await refused(() => stranded.tool()!.run({ sql: "delete from things" }), 400, "a statement that writes, run in the server");
  await stranded.close();
  await nowhere.close();
  // Turned off: the same, with nothing said, and no copies kept.
  const plainDir = join(dir, "records-plain");
  await mkdir(plainDir);
  const plain = await openRecords({ appId: "things", title: "Things", dir: plainDir, source, database: true, timezone: "UTC", after: Promise.resolve(), processes: null, log: () => {} });
  assert.deepEqual((await plain.tool()!.run({ sql: "select count(*) as n from things" })).rows, [{ n: 2999 }]);
  assert.ok(!existsSync(join(plainDir, ".records-frozen")));
  await plain.close();

  const last = processes.status().pids;
  await app.close();
  await processes.close();
  assert.ok(last.every((pid) => !alive(pid)));
  assert.deepEqual(await readdir(join(recordsDir, ".records-frozen")), [], "frozen copies outlived the app");
  assert.ok(!heardByApp.some((l) => l.startsWith("error")), heardByApp.join("\n"));

  await sleep(100);
  assert.deepEqual(unhandled, [], "nothing was left unhandled");
  console.log("sandbox: ok");
} catch (err) {
  console.error("TEST FAILED", err);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
