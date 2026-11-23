// ---------------------------------------------------------------------------
// Processes of their own for SQL someone else wrote.
//
// A database that runs inside the server cannot be made safe from a query
// written to break it: ordinary functions can use all the memory there is,
// run without end, or stop the process outright. No list of forbidden
// functions closes that. So such SQL is not run in the server at all. It is
// run in a child process, one query to a process at a time, and this side
// watches it:
//
//   - a query that has not answered a little after its time limit: its
//     process is killed, which stops anything;
//   - a process that holds more memory than the query may use: the same;
//   - a process that dies under a query: the query is refused, and not run
//     again as it is.
//
// A process keeps nothing between queries. It is handed the path of a
// database file to open read-only and the statement to run, so one that is
// killed costs only the starting of another, and the server goes on
// answering throughout. A few are kept for the whole server (see hostSlots);
// one with nothing to do is let go after a while.
//
// On a host where such a process cannot be started at all, `run` fails with
// `unavailable`, and whoever asked runs the query in the server as before
// and says so in the log: never a tool that is down.
// ---------------------------------------------------------------------------

import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Why a query got no answer from its process.
 *   timeout      it ran past its limit and was stopped (408)
 *   memory       it used more memory than it may and was stopped (400)
 *   broke        its process died under it (400)
 *   stopped      its process was stopped by something else (503)
 *   busy         every process was taken for too long (503)
 *   closed       the server is shutting down (503)
 *   unavailable  no process can be started on this host (503)
 */
export type QueryFailure = "timeout" | "memory" | "broke" | "stopped" | "busy" | "closed" | "unavailable";

export class QueryProcessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly failure: QueryFailure,
  ) {
    super(message);
  }
}

type Log = (level: "info" | "warn" | "error", message: string) => void;

export interface QueryProcessesOptions {
  /** The most processes at once. Default: what the host can afford (see hostSlots). */
  size?: number;
  /** A process is stopped when it holds more memory than this, whatever its query was allowed. Default: worked out per query (see capMb). */
  maxRssMb?: number;
  /** A process with nothing to do is let go after this long. Default 60 s. */
  idleMs?: number;
  log?: Log;
  /** For tests: the program a process runs (default: the worker beside this file), how long it may take to start, and for how long starting must fail before the host is given up on. */
  workerPath?: string;
  startMs?: number;
  giveUpStartingMs?: number;
}

export interface RunOptions {
  /** The statement's own time limit. Its process is stopped a little after it, answered or not. */
  timeoutMs: number;
  /** The memory the query's database was told it may use. Its process may hold about twice that. */
  memoryMb: number;
  /** Whose query it is, for the log: an app, a file. */
  who: string;
  /** The statement: named in the log if it breaks its process, and then not run again as it is. */
  sql: string;
  /** Directories the query may leave things in when it is stopped mid-way. Removed then. */
  scratch?: string[];
  /**
   * Work that may take minutes (a file made from a query). It takes a turn
   * apart from the queries', of which there are fewer, so that however long
   * it takes, questions are still answered.
   */
  long?: boolean;
}

/** After its time limit, how long a query's process is given to say so itself before it is stopped. */
const GRACE_MS = 2_000;
/** How long a process may take to start: load the database and answer with it. */
const START_MS = 10_000;
/** After a process could not be started, how long before one is tried again; doubled each time, up to the longest. */
const RETRY_START_MS = 30_000;
const RETRY_START_MAX_MS = 30 * 60_000;
/** How long a statement that broke its process is refused without being run. */
const BROKEN_MS = 10 * 60_000;
const BROKEN_KEPT = 200;
/** How long a query waits for a process to be free before it is told to come back. */
const WAIT_MS = 15_000;
/** The same for work that may take minutes, whose callers expect to wait. */
const LONG_WAIT_MS = 60_000;
const WAITING = 64;
/** The memory JavaScript itself may take in a process; a query's result is small by the time it is here. */
const HEAP_MB = 512;
/** How often a working process's memory is looked at, and how often once it is growing or large. */
const WATCH_MS = 250;
const WATCH_CLOSELY_MS = 50;
/** A process left holding more than this by its last query is not given another. */
const KEEP_UNDER_MB = 384;
/** On a host that has started processes before, how long starting must go on failing before it is taken to be a host that cannot. */
const GIVE_UP_STARTING_MS = 2 * 60_000;
/** The most lines of log one process may hand on. */
const LOG_LINES = 20;
/** Set in every query process, so that one can never start processes of its own. */
const MARK = "TOOLPLEX_QUERY_PROCESS";
/** A process that ends on one of these ended itself: the query in it is what did that. */
const BROKE_BY = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE", "SIGTRAP", "SIGSYS"]);

const TOTAL_MB = Math.floor(totalmem() / 1024 ** 2);

/**
 * How many queries someone else wrote this host runs at once: one on a small
 * machine, up to four on a large one.
 */
export function hostSlots(): number {
  const cores = Math.max(1, cpus().length);
  return TOTAL_MB < 4096 ? 1 : cores <= 2 ? 2 : Math.min(4, Math.ceil(cores / 2));
}

/**
 * The most memory a query's process may hold. A database told to use N MB
 * can hold well over N for a while (what it sorts and groups is not all
 * counted), and the process around it needs some: twice N and a little. But
 * never so much that every process at its most, together, takes more than
 * about half the machine. `processes` is how many there can be at once.
 */
export function capMb(memoryMb: number, processes: number): number {
  return Math.min(memoryMb * 2 + 256, Math.max(768, Math.floor((TOTAL_MB * 0.6) / Math.max(1, processes))));
}

/**
 * The worker beside this file: compiled when the package is installed,
 * source when run from the repository. Null when this file has been bundled
 * into someone else's: what lies beside that is not ours to run.
 */
function workerBeside(): string | null {
  if (!/^supervisor\.(js|ts)$/.test(basename(fileURLToPath(import.meta.url)))) return null;
  for (const name of ["./worker.js", "./worker.ts"]) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * What Node is started with for a worker. The compiled worker needs nothing
 * of how the server was started, and gets nothing: flags can carry an
 * environment file, code to load first, or the server's own program. From
 * the repository, TypeScript is run by the loader the server was run with.
 */
function nodeFlags(worker: string): string[] {
  const flags = [`--max-old-space-size=${HEAP_MB}`];
  if (!worker.endsWith(".ts")) return flags;
  const loads = ["--import", "--require", "-r", "--loader", "--experimental-loader"];
  const given = process.execArgv;
  for (let i = 0; i < given.length; i++) {
    if (loads.includes(given[i]) && i + 1 < given.length) flags.push(given[i], given[++i]);
    else if (loads.some((l) => given[i].startsWith(`${l}=`))) flags.push(given[i]);
  }
  return flags;
}

/** How much memory a process holds, in MB; null when that cannot be told. */
async function rssMb(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1]);
      return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2_000 }, (err, out) => {
      const kb = Number(String(out).trim());
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb / 1024);
    });
  });
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const said = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const briefly = (sql: string): string => {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

type Reply = { t: "reply"; id: number; ok: true; value: unknown } | { t: "reply"; id: number; ok: false; error?: { statusCode?: unknown; message?: unknown } };
type Message = { t: "ready" } | { t: "failed"; message?: unknown } | Reply | { t: "log"; level?: unknown; message?: unknown };

interface Call {
  id: number;
  /** What the statement is known by, should it break its process. */
  key: string;
  options: RunOptions;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One process and everything known about it. It runs one query at a time,
 * so whatever becomes of the process while a query is in it is that query's
 * answer, and nobody else's.
 */
class QueryProcess {
  private call: Call | null = null;
  private nextId = 1;
  private logged = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Why this side stopped it, when it did. */
  private stoppedFor: QueryFailure | "idle" | null = null;
  /** Where the query in it, or the last one if that did not end cleanly, may have left things. Cleared away when the process ends. */
  private scratch: string[] = [];
  private over = false;
  /** Resolves when the process has ended, however that came about. */
  readonly ended: Promise<void>;
  private settleEnded!: () => void;
  private whenReady!: { resolve: () => void; reject: (err: Error) => void };
  readonly ready: Promise<void>;

  constructor(
    private readonly proc: ChildProcess,
    private readonly owner: { log: Log; gone: (p: QueryProcess) => void; broke: (key: string) => void; unreadable: () => void },
  ) {
    this.ended = new Promise((resolve) => {
      this.settleEnded = resolve;
    });
    this.ready = new Promise((resolve, reject) => {
      this.whenReady = { resolve, reject };
    });
    this.ready.catch(() => {});
    // A process waiting for work does not keep the server alive; a query in
    // one does, through its own time limit.
    proc.unref();
    (proc.channel as { unref?: () => void } | undefined)?.unref?.();
    // Kept for as long as the process: a channel that breaks says so more than once.
    proc.on("error", (err) => this.whenReady.reject(new Error(said(err))));
    proc.on("message", (m: Message) => this.heard(m));
    proc.on("exit", (code, signal) => this.exited(code, signal));
    // A process that is ending closes its channel first, and what ended it is
    // known a moment later. One whose channel has closed and that lives on
    // can never be heard from again, so it is not kept.
    proc.on("disconnect", () => {
      setTimeout(() => {
        if (!this.over) this.stop("stopped");
      }, 1_000).unref();
    });
  }

  get pid(): number | null {
    return this.proc.pid ?? null;
  }

  get usable(): boolean {
    return !this.over && this.call === null && this.proc.connected;
  }

  /** It has ended, or been told to. */
  get finished(): boolean {
    return this.over;
  }

  private heard(m: Message): void {
    if (!m || typeof m !== "object") return;
    if (m.t === "ready") this.whenReady.resolve();
    else if (m.t === "failed") this.whenReady.reject(new Error(typeof m.message === "string" ? m.message : "it could not load what it needs"));
    else if (m.t === "log") {
      // A few lines, and then no more: what it says is not the server's to be flooded with.
      if (++this.logged > LOG_LINES) return;
      const level = m.level === "info" || m.level === "warn" ? m.level : "error";
      this.owner.log(level, `a query process: ${typeof m.message === "string" ? m.message.slice(0, 2_000) : "(no message)"}${this.logged === LOG_LINES ? " (it will not be heard further)" : ""}`);
    } else if (m.t === "reply") {
      const call = this.call;
      if (!call || call.id !== m.id) return;
      this.call = null;
      clearTimeout(call.timer);
      if (m.ok) {
        this.scratch = [];
        call.resolve(m.value);
      } else {
        // What the process says of its own failure is words and a status, nothing more.
        const status = Number(m.error?.statusCode);
        const message = typeof m.error?.message === "string" ? m.error.message : "It failed.";
        call.reject(Object.assign(new Error(message), { statusCode: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500 }));
        // A statement that ran out of time may not have stopped when told
        // to, and would go on working in there under the next query. The
        // process is not used again.
        if (status === 408) this.stop("idle");
        else this.scratch = [];
      }
    }
  }

  private exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.over = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Ended from outside before it was ready (the system short of memory, the
    // server and its children being stopped) says nothing about whether one
    // can be started here.
    const outside = this.stoppedFor === null && signal !== null && !BROKE_BY.has(signal);
    this.whenReady.reject(Object.assign(new Error(`it stopped as it started (${signal ?? `exit ${code}`})`), { outside }));
    const call = this.call;
    this.call = null;
    if (call) {
      clearTimeout(call.timer);
      const how = signal ?? `exit ${code}`;
      if (this.stoppedFor === null) {
        // Not this side's doing. A process that ended itself was ended by
        // the query in it. One ended from outside (the system short of
        // memory, the server and its children being stopped) was not.
        if ((signal && BROKE_BY.has(signal)) || (code !== null && code !== 0)) {
          this.owner.log("error", `a query stopped the process it was run in (${how}) and will not be run again as it is. ${call.options.who}: ${briefly(call.options.sql)}`);
          this.owner.broke(call.key);
          call.reject(new QueryProcessError(400, "This query stopped the process it was run in, so it cannot be run. Write it another way.", "broke"));
        } else {
          this.owner.log("warn", `a query's process was stopped from outside (${how}). ${call.options.who}`);
          call.reject(new QueryProcessError(503, "The process running this query was stopped (the server may be short of memory, or restarting). Try again in a moment.", "stopped"));
        }
      }
    }
    this.owner.gone(this);
    // What a query that did not end cleanly had begun to write is cleared
    // away before the process counts as ended: a server that closes waits
    // for that.
    void Promise.all(this.scratch.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))).then(() => this.settleEnded());
  }

  /** Stop it now. Whoever had a query in it is told why. */
  stop(why: QueryFailure | "idle", detail = ""): void {
    if (this.over && this.stoppedFor !== null) return;
    this.stoppedFor ??= why;
    this.over = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const call = this.call;
    if (call) {
      // Answered now; `exited` clears away what the query left when the process has really gone.
      clearTimeout(call.timer);
      const o = call.options;
      if (why === "timeout") {
        this.owner.log("warn", `a query was stopped ${(GRACE_MS / 1000).toFixed(0)} s past its ${o.timeoutMs / 1000} s limit, with its process. ${o.who}: ${briefly(o.sql)}`);
        call.reject(new QueryProcessError(408, "This took longer than its time limit and was stopped.", "timeout"));
      } else if (why === "memory") {
        this.owner.log("warn", `a query was stopped for the memory it took (${detail}), with its process. ${o.who}: ${briefly(o.sql)}`);
        call.reject(new QueryProcessError(400, "This query used more memory than a query may, and was stopped. Ask for less at once: filter, add up, or take fewer columns.", "memory"));
      } else if (why === "stopped") {
        this.owner.log("warn", `a query's process stopped answering (its channel closed). ${o.who}`);
        call.reject(new QueryProcessError(503, "The process running this query was stopped (the server may be short of memory, or restarting). Try again in a moment.", "stopped"));
      } else call.reject(new QueryProcessError(503, "The server is shutting down.", "closed"));
      // Left in place for `exited`, without its answer: there is scratch to clear.
      this.call = { ...call, resolve: () => {}, reject: () => {} };
    }
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  /** Taken for a query: it is not let go for having nothing to do. */
  wake(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** With nothing to do, it is let go after a while. */
  rest(idleMs: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop("idle"), idleMs);
    this.idleTimer.unref();
  }

  run<T>(op: string, payload: unknown, options: RunOptions, key: string, maxRssMb: number): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.stop("timeout"), options.timeoutMs + GRACE_MS);
      const call: Call = { id, key, options, resolve: resolve as (value: unknown) => void, reject, timer };
      this.call = call;
      this.scratch = options.scratch ?? [];
      const unsent = (err: unknown): void => {
        if (this.call !== call) return;
        this.call = null;
        clearTimeout(timer);
        this.stop("stopped");
        reject(new QueryProcessError(503, `The process that runs queries could not be reached (${said(err)}). Try again in a moment.`, "stopped"));
      };
      try {
        this.proc.send({ t: "call", id, op, payload }, (err) => {
          if (err) unsent(err);
        });
      } catch (err) {
        unsent(err);
        return;
      }
      void this.watch(call, maxRssMb);
    });
  }

  /** While a query is in it, its memory is looked at; more often once it is large or growing fast. */
  private async watch(call: Call, maxRssMb: number): Promise<void> {
    let last = 0;
    let unread = 0;
    while (this.call === call && this.proc.pid) {
      const mb = await rssMb(this.proc.pid);
      if (this.call !== call) return;
      if (mb === null) {
        // A process that has just ended cannot be read either, and that is
        // heard of in a moment. Only one that stays unreadable is a system
        // that does not say.
        if (++unread >= 4) {
          this.owner.unreadable();
          return;
        }
        await pause(WATCH_MS);
        continue;
      }
      unread = 0;
      if (mb > maxRssMb) {
        this.stop("memory", `${Math.round(mb)} MB, more than the ${maxRssMb} MB it may`);
        return;
      }
      const closely = mb > maxRssMb / 2 || mb - last > maxRssMb / 10;
      last = mb;
      await pause(closely ? WATCH_CLOSELY_MS : WATCH_MS);
    }
  }
}

/** A few turns, a short line for one, and past that an answer now. */
class Turns {
  private waiting: { turn: () => void; refuse: (err: Error) => void }[] = [];

  constructor(private free: number) {}

  get inLine(): number {
    return this.waiting.length;
  }

  acquire(maxWaitMs: number): Promise<() => void> {
    const once = (): (() => void) => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = this.waiting.shift();
        if (next) next.turn();
        else this.free++;
      };
    };
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(once());
    }
    if (this.waiting.length >= WAITING) return Promise.reject(new QueryProcessError(503, "Too many queries are running. Try again in a moment.", "busy"));
    return new Promise((resolve, reject) => {
      const mine = {
        turn: (): void => {
          clearTimeout(timer);
          resolve(once());
        },
        refuse: (err: Error): void => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== mine);
        reject(new QueryProcessError(503, "The queries ahead of this one are taking too long. Try again in a moment.", "busy"));
      }, maxWaitMs);
      this.waiting.push(mine);
    });
  }

  refuseAll(err: Error): void {
    for (const w of this.waiting) w.refuse(err);
    this.waiting = [];
  }
}

export class QueryProcesses {
  private readonly size: number;
  private readonly idleMs: number;
  private readonly log: Log;
  private readonly all = new Set<QueryProcess>();
  private idle: QueryProcess[] = [];
  /** Turns for queries, as many as the host affords; and half as many again, apart, for work that may take minutes. */
  private readonly turns: Turns;
  private readonly longSize: number;
  private readonly longTurns: Turns;
  private closed = false;
  private starts = 0;
  /** Statements that broke a process, and until when each is refused. */
  private broken = new Map<string, number>();
  /** Set when no process can be started on this host: why, until when none is tried, and how long the next wait will be. */
  private down: { error: QueryProcessError; until: number; next: number } | null = null;
  /**
   * Whether one has ever started here; and since when starting has been
   * failing with no query answered by any process in between.
   */
  private started = false;
  private failingSince: number | null = null;
  private saidUnreadable = false;
  private readonly giveUpStartingMs: number;

  constructor(private readonly options: QueryProcessesOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? hostSlots()));
    this.turns = new Turns(this.size);
    this.longSize = Math.max(1, Math.ceil(this.size / 2));
    this.longTurns = new Turns(this.longSize);
    this.idleMs = options.idleMs ?? 60_000;
    this.giveUpStartingMs = options.giveUpStartingMs ?? GIVE_UP_STARTING_MS;
    this.log = options.log ?? (() => {});
  }

  /** How things stand, for whoever watches over the server and for tests. */
  status(): { size: number; processes: number; idle: number; pids: number[]; waiting: number; starts: number; available: boolean } {
    return {
      size: this.size,
      processes: this.all.size,
      idle: this.idle.length,
      pids: [...this.all].map((p) => p.pid ?? 0),
      waiting: this.turns.inLine + this.longTurns.inLine,
      starts: this.starts,
      available: this.down === null,
    };
  }

  /**
   * Start one process now, so that the first query does not wait for it and
   * a host that cannot start one is known, and said, when the server starts.
   */
  warm(): void {
    if (this.closed || this.all.size > 0) return;
    this.turns.acquire(1).then(
      (release) =>
        this.start()
          .then(
            (p) => this.keep(p),
            (err: unknown) => {
              if (!this.closed && err instanceof QueryProcessError && err.failure === "unavailable") this.log("error", `queries will run inside the server: ${said(err)}`);
            },
          )
          .finally(release),
      () => {},
    );
  }

  /**
   * Run one thing in a process of its own and wait for its answer. What the
   * process answers with (rows, or a refusal with its status) comes back as
   * it is; when the process itself is what failed, the error is a
   * QueryProcessError that says how.
   */
  async run<T>(op: string, payload: unknown, options: RunOptions): Promise<T> {
    if (this.closed) throw new QueryProcessError(503, "The server is shutting down.", "closed");
    // By what it was run over as well as what it says: a statement that
    // breaks on one file's contents is not refused to everyone else's.
    const key = createHash("sha256").update(`${op}\0${options.who}\0${options.sql}`).digest("hex");
    const until = this.broken.get(key);
    if (until !== undefined) {
      if (Date.now() < until) throw new QueryProcessError(400, "This query stopped the process it was run in a little while ago, and is not run again as it is. Write it another way.", "broke");
      this.broken.delete(key);
    }
    const release = await (options.long ? this.longTurns.acquire(Math.min(LONG_WAIT_MS, options.timeoutMs)) : this.turns.acquire(Math.min(WAIT_MS, options.timeoutMs)));
    try {
      const p = await this.take();
      try {
        const answer = await p.run<T>(op, payload, options, key, this.options.maxRssMb ?? capMb(options.memoryMb, this.size + this.longSize));
        this.failingSince = null;
        return answer;
      } catch (err) {
        // Answered with a refusal of the statement: a process that works, all the same.
        if (!(err instanceof QueryProcessError)) this.failingSince = null;
        throw err;
      } finally {
        this.keep(p);
      }
    } finally {
      release();
    }
  }

  /** A process to run a query in: one that is waiting for work, or a new one. */
  private async take(): Promise<QueryProcess> {
    if (this.closed) throw new QueryProcessError(503, "The server is shutting down.", "closed");
    for (;;) {
      const p = this.idle.pop();
      if (!p) break;
      if (!p.usable) continue;
      p.wake();
      // A process keeps the memory its last query took, and would be judged
      // for it under the next. One that is left holding much is let go.
      const mb = p.pid ? await rssMb(p.pid) : null;
      if (!p.usable) continue;
      if (mb !== null && mb > KEEP_UNDER_MB) {
        p.stop("idle");
        continue;
      }
      return p;
    }
    if (this.closed) throw new QueryProcessError(503, "The server is shutting down.", "closed");
    // Only when a new one is needed does it matter that none can be started.
    if (this.down && Date.now() < this.down.until) throw this.down.error;
    return this.start();
  }

  private keep(p: QueryProcess): void {
    if (!p.usable) {
      if (!p.finished) p.stop("idle");
      return;
    }
    if (this.closed) p.stop("closed");
    else {
      this.idle.push(p);
      p.rest(this.idleMs);
    }
  }

  /**
   * Start a process, and decide what a failure to means. A host that has
   * never started one cannot, as far as anyone knows: that is `unavailable`,
   * and whoever asked runs its query in the server and says so. A host that
   * has started one before can: a start that fails there is a bad moment,
   * and the query is refused rather than let into the server. Only when
   * starting has failed for minutes on end, with no process answering
   * anything in all that time, is the host taken to have changed.
   */
  private async start(): Promise<QueryProcess> {
    try {
      const p = await this.launch();
      this.down = null;
      this.started = true;
      this.failingSince = null;
      return p;
    } catch (err) {
      if (!(err instanceof QueryProcessError) || err.failure !== "unavailable") throw err;
      const now = Date.now();
      const first = this.failingSince === null;
      this.failingSince ??= now;
      if (this.started && !(err as { definite?: boolean }).definite && now - this.failingSince < this.giveUpStartingMs) {
        if (first) this.log("warn", `${err.message}; queries that need one are refused until one starts, not run in the server`);
        throw new QueryProcessError(503, "A process to run this query in could not be started just now. Try again in a moment.", "busy");
      }
      const wait = this.down?.next ?? RETRY_START_MS;
      this.down = { error: err, until: now + wait, next: Math.min(RETRY_START_MAX_MS, wait * 2) };
      throw err;
    }
  }

  private async launch(): Promise<QueryProcess> {
    const cannot = (why: string, definite = false): QueryProcessError => Object.assign(new QueryProcessError(503, `a process to run queries in cannot be started (${why})`, "unavailable"), { definite });
    if (process.env[MARK]) throw cannot("this is a query process itself, and starts none of its own", true);
    const worker = this.options.workerPath ?? workerBeside();
    if (!worker) throw cannot("its program is not beside the server's own (the package was bundled into another file)", true);
    let proc: ChildProcess;
    try {
      proc = fork(worker, [], {
        execArgv: nodeFlags(worker),
        // Nothing of the server's own surroundings: no tokens, no keys.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ, NODE_ENV: process.env.NODE_ENV, [MARK]: "1" } as NodeJS.ProcessEnv,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "json",
      });
    } catch (err) {
      throw cannot(said(err));
    }
    this.starts++;
    const p = new QueryProcess(proc, {
      log: this.log,
      gone: (gone) => {
        this.all.delete(gone);
        this.idle = this.idle.filter((i) => i !== gone);
      },
      broke: (key) => {
        // The oldest is forgotten first: this is a brake on asking the same thing over and over, not a record.
        if (this.broken.size >= BROKEN_KEPT) this.broken.delete(this.broken.keys().next().value as string);
        this.broken.set(key, Date.now() + BROKEN_MS);
      },
      unreadable: () => {
        if (!this.saidUnreadable) this.log("warn", "how much memory a query's process holds cannot be read on this system; the only limit on it is the one its database keeps to");
        this.saidUnreadable = true;
      },
    });
    this.all.add(p);
    let tooSlow: NodeJS.Timeout | undefined;
    const startMs = this.options.startMs ?? START_MS;
    try {
      // It says it is ready once it has loaded the database and run a statement with it.
      await Promise.race([
        p.ready,
        new Promise<never>((_, reject) => {
          tooSlow = setTimeout(() => reject(new Error(`it was not ready after ${startMs / 1000} s`)), startMs);
        }),
      ]);
    } catch (err) {
      p.stop("unavailable");
      // One that never came to be says nothing more, not even that it has ended.
      this.all.delete(p);
      if (this.closed) throw new QueryProcessError(503, "The server is shutting down.", "closed");
      if ((err as { outside?: boolean }).outside) throw new QueryProcessError(503, "The process for this query was stopped as it started (the server may be short of memory, or restarting). Try again in a moment.", "stopped");
      throw cannot(said(err));
    } finally {
      clearTimeout(tooSlow);
    }
    if (this.closed) {
      p.stop("closed");
      throw new QueryProcessError(503, "The server is shutting down.", "closed");
    }
    // If the machine runs out of memory, let it be this process the system stops, not the server.
    if (process.platform === "linux" && proc.pid) void writeFile(`/proc/${proc.pid}/oom_score_adj`, "900").catch(() => {});
    return p;
  }

  async close(): Promise<void> {
    this.closed = true;
    const closing = new QueryProcessError(503, "The server is shutting down.", "closed");
    this.turns.refuseAll(closing);
    this.longTurns.refuseAll(closing);
    const all = [...this.all];
    for (const p of all) p.stop("closed");
    // Waited for, so that closing the server means its processes are gone.
    // The wait itself must hold the server open: the processes do not.
    let giveUp: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(all.map((p) => p.ended)),
      new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, 2_000);
      }),
    ]);
    clearTimeout(giveUp);
  }
}
