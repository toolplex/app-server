// The program a query process runs (see ./supervisor.ts).
//
// It is started by the server and does only what it is asked over the
// channel between them: open the database file it is pointed at, read-only,
// and run one statement. It keeps nothing between one query and the next,
// is given no environment to speak of, and when the server goes away, so
// does it.

type Handler = (payload: never) => Promise<unknown>;

const send = (message: object, then?: () => void): void => {
  try {
    if (process.connected && process.send) {
      process.send(message, () => then?.());
      return;
    }
  } catch {
    /* the server has gone */
  }
  then?.();
};

/**
 * Stop now, whatever is still working. An ordinary exit waits for the
 * database's threads, and a statement that cannot be stopped would keep this
 * process alive after its server has gone.
 */
const die = (): void => {
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
};

const log = (level: "info" | "warn" | "error", message: string, then?: () => void): void => send({ t: "log", level, message }, then);
const said = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));

// Each kind of work is loaded when first asked for.
const families: Record<string, () => Promise<Record<string, Handler>>> = {
  file: () => import("../files/untrusted.js").then((m) => m.handlers as unknown as Record<string, Handler>),
  records: () => import("../apps/records/frozen.js").then((m) => m.handlers as unknown as Record<string, Handler>),
};
const loaded = new Map<string, Promise<Record<string, Handler>>>();

const run = async (op: string, payload: unknown): Promise<unknown> => {
  const family = op.split(".")[0];
  if (!Object.hasOwn(families, family)) throw Object.assign(new Error(`This process does not do "${op}".`), { statusCode: 400 });
  if (!loaded.has(family)) loaded.set(family, families[family]());
  const handlers = await loaded.get(family)!;
  if (!Object.hasOwn(handlers, op)) throw Object.assign(new Error(`This process does not do "${op}".`), { statusCode: 400 });
  return handlers[op](payload as never);
};

process.on("message", (m: { t?: string; id?: number; op?: string; payload?: unknown }) => {
  if (!m || typeof m !== "object" || m.t !== "call" || typeof m.id !== "number" || typeof m.op !== "string") return;
  const id = m.id;
  run(m.op, m.payload).then(
    (value) => send({ t: "reply", id, ok: true, value: value ?? null }),
    (err: unknown) => send({ t: "reply", id, ok: false, error: { statusCode: (err as { statusCode?: number })?.statusCode ?? 500, message: err instanceof Error ? err.message : String(err) } }),
  );
});

// The server has gone (stopped, or stopped dead): nothing is left to answer to.
process.on("disconnect", die);
// A mistake in here must not leave a process that answers nothing.
process.on("uncaughtException", (err) => log("error", `stopped on an error: ${said(err)}`, die));
process.on("unhandledRejection", (err) => log("error", `a failure nobody was waiting for: ${said(err)}`));

// Ready means able to work: the database loads here and answers. A host
// where it does not (a library it needs is out of this process's reach) is
// told so now, not by every query failing later.
void (async () => {
  if (!process.send) return;
  try {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const inst = await DuckDBInstance.create(":memory:");
    const conn = await inst.connect();
    await conn.run("SELECT 1");
    conn.disconnectSync();
    inst.closeSync();
    send({ t: "ready" });
  } catch (err) {
    send({ t: "failed", message: `the database could not be loaded in it: ${said(err)}` }, () => process.exit(1));
  }
})();
