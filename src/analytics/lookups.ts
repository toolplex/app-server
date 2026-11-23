// Analytics lookups — the facts about a client's data that the ToolPlex
// analytics engine (cloud-agent/src/analytics) asks for when it checks the
// agent's SQL. The engine reads the query and decides what to ask; this
// answers, next to the data, in the client's own dialect.
//
//   GET  /analytics/info      dialect and which of the client's tools run SQL
//   GET  /analytics/schema    tables and views with their columns and types
//   POST /analytics/distinct  { table, column, values } → which values exist, and the closest real ones
//   POST /analytics/repeats   { left, right } → how many join-key values repeat in both tables
//   POST /analytics/latest    { table, columns } → the latest row by a date, or by a year and a month,
//                             and where the complete data ends when the client says (completeThrough)
//
// Every route is read-only. Identifiers are only ever taken from the live
// schema, never from the request, and values are bound as parameters, so a
// request cannot inject SQL. A lookup that fails answers "the lookup failed"
// (or "timed out"): the database's own message stays in this server's log.
// A server that does not configure `analytics`
// has none of these routes and the engine records its checks as not run.
import type { FastifyInstance } from "fastify";

export type AnalyticsDialect = "sqlite" | "postgres";

export interface AnalyticsConfig {
  dialect: AnalyticsDialect;
  /**
   * Run ONE read-only statement with positional parameters and return its
   * rows. Must enforce the server's own timeout and read-only guarantees.
   * Placeholders are written `?` (sqlite) or `$1, $2…` (postgres).
   */
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  /**
   * Tables the agent may not see: left out of the schema and refused in lookups, together with every
   * view that reads one of them. A bare name (`payroll`) denies that table in every schema; a name
   * with its schema (`hr.payroll`) denies that one (`public.payroll` and `payroll` are the same table).
   */
  deniedTables?: string[];
  /**
   * The names of this client's tools whose argument is SQL the agent wrote
   * (e.g. ["execute_sql", "generate_from_sql"]), in any of its tool packages.
   * The engine checks calls to these and nothing else.
   */
  sqlTools?: string[];
  /**
   * Text columns the engine's value check asks about most (a store's chain, a brand, a stock number).
   * Their values are read into memory when the server starts and kept fresh, so the first question of
   * the day is answered without scanning a large table. Any other text column joins them the first
   * time it is asked about.
   */
  warmColumns?: Array<{ table: string; column: string }>;
  /** How often a column's values in memory are re-read, in minutes (default 60). An older list is not used. */
  warmRefreshMinutes?: number;
  /**
   * How far a table's data is complete, when the client knows. Data often keeps arriving after a period
   * ends (sales keyed days or weeks late), so the latest row is not where the complete data ends.
   * Called by the `latest` lookup with the table and the period column(s) asked about. Return the last
   * date (YYYY-MM-DD) through which the data is complete and, in a few words, the rule behind it — or
   * null when not known.
   */
  completeThrough?: (table: string, columns: string[]) => Promise<CompleteThrough | null> | CompleteThrough | null;
}

export interface CompleteThrough { through: string; rule?: string }

export interface AnalyticsColumn { name: string; type: string }
export interface AnalyticsTable { name: string; kind: "table" | "view"; columns: AnalyticsColumn[]; estimated_rows?: number }
/** One side of a join: a table and the column(s) it is joined on. */
export interface JoinSide { table?: string; columns?: unknown[] }

export const ANALYTICS_VERSION = 6;
const SCHEMA_TTL_MS = 10 * 60_000;
const MAX_VALUES = 20;
const MAX_CLOSEST_LOOKUPS = 8;
const MAX_JOIN_COLUMNS = 6;
const MAX_LATEST_COLUMNS = 3;
/** A column with more distinct values than this is not kept in memory; it is asked through SQL every time. */
const MAX_WARM_VALUES = 50_000;
/** Columns kept in memory beyond the configured ones, learned from the questions asked. */
const MAX_LEARNED_COLUMNS = 200;

interface ValueList { at: number; byUpper: Map<string, { value: string; count: number }[]> }

export function createAnalytics(deps: AnalyticsConfig) {
  let cached: { at: number; tables: AnalyticsTable[] } | null = null;
  const refreshMs = Math.max(5, Number(deps.warmRefreshMinutes) || 60) * 60_000;
  /** table\0column -> its values in memory */
  const lists = new Map<string, ValueList>();
  /** Columns with too many values to keep. */
  const tooMany = new Set<string>();
  /** Columns to keep fresh: the configured ones and those asked about. */
  const kept = new Map<string, { table: string; column: string }>();
  const loading = new Set<string>();
  /** One load at a time: a refresh must not stack scans on the client's database. */
  let loadQueue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  const denied = new Set((deps.deniedTables ?? []).map((t) => t.toLowerCase().replace(/"/g, "").replace(/^public\./, "")));
  /** Is a listed table (`name`, or `schema.name` outside public) on the deny list, however the list spells it? */
  const isDenied = (name: string) => { const n = name.toLowerCase(); return denied.has(n) || denied.has(n.slice(n.lastIndexOf(".") + 1)); };

  /**
   * Views that read a denied table, directly or through another view: a view over a denied table shows
   * its rows under another name. If what a view reads cannot be told, every view is left out.
   */
  async function viewsOverDenied(all: Map<string, AnalyticsTable>): Promise<Set<string>> {
    const hidden = new Set<string>();
    const views = [...all.values()].filter((t) => t.kind === "view").map((t) => t.name);
    if (!denied.size || !views.length) return hidden;
    try {
      /** view -> what it reads */
      const reads = new Map<string, string[]>();
      if (deps.dialect === "postgres") {
        const rows = await deps.query(
          `SELECT DISTINCT
                  CASE WHEN vn.nspname = 'public' THEN v.relname ELSE vn.nspname || '.' || v.relname END AS v,
                  CASE WHEN sn.nspname = 'public' THEN s.relname ELSE sn.nspname || '.' || s.relname END AS s
             FROM pg_depend d
             JOIN pg_rewrite r ON r.oid = d.objid
             JOIN pg_class v ON v.oid = r.ev_class
             JOIN pg_namespace vn ON vn.oid = v.relnamespace
             JOIN pg_class s ON s.oid = d.refobjid
             JOIN pg_namespace sn ON sn.oid = s.relnamespace
            WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND v.oid <> s.oid`,
          [],
        );
        for (const r of rows) reads.set(String(r.v), [...(reads.get(String(r.v)) ?? []), String(r.s)]);
      } else {
        // SQLite keeps a view as its text: any denied table or hidden view named in it counts.
        const rows = await deps.query(`SELECT name AS v, sql FROM sqlite_master WHERE type = 'view'`, []);
        const names = [...all.keys()];
        for (const r of rows) {
          const text = String(r.sql ?? "").toLowerCase();
          reads.set(String(r.v), names.filter((n) => n !== String(r.v) && new RegExp(`(^|[^a-z0-9_])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`).test(text)));
        }
      }
      for (let grew = true; grew; ) {
        grew = false;
        for (const v of views) {
          if (hidden.has(v)) continue;
          if ((reads.get(v) ?? []).some((s) => isDenied(s) || hidden.has(s))) { hidden.add(v); grew = true; }
        }
      }
    } catch {
      for (const v of views) hidden.add(v);
    }
    return hidden;
  }
  const ph = (i: number) => (deps.dialect === "postgres" ? `$${i}` : "?");
  const quoteIdent = (name: string) => name.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");

  async function schema(): Promise<AnalyticsTable[]> {
    if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.tables;
    const rows =
      deps.dialect === "sqlite"
        ? await deps.query(
            `SELECT m.name AS t, m.type AS kind, p.name AS c, p.type AS ty
               FROM sqlite_master m JOIN pragma_table_info(m.name) p
              WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
              ORDER BY m.name, p.cid`,
            [],
          )
        : await deps.query(
            `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS t,
                    CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
                    a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty,
                    GREATEST(c.reltuples, 0)::bigint AS est
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              WHERE c.relkind IN ('r','p','v','m','f')
                AND n.nspname NOT IN ('pg_catalog','information_schema')
                AND n.nspname NOT LIKE 'pg_toast%'
              ORDER BY 1, a.attnum`,
            [],
          );
    const byName = new Map<string, AnalyticsTable>();
    for (const r of rows) {
      const name = String(r.t);
      let t = byName.get(name);
      if (!t) {
        t = { name, kind: r.kind === "view" ? "view" : "table", columns: [] };
        if (r.est != null && r.kind !== "view") t.estimated_rows = Number(r.est);
        byName.set(name, t);
      }
      t.columns.push({ name: String(r.c), type: String(r.ty ?? "") });
    }
    const hidden = await viewsOverDenied(byName);
    const tables = [...byName.values()].filter((t) => !isDenied(t.name) && !hidden.has(t.name));
    cached = { at: Date.now(), tables };
    return tables;
  }

  /** Resolve a table and column by case-insensitive name against the live schema. */
  async function resolve(table: string, column: string) {
    const tables = await schema();
    const t = tables.find((x) => x.name.toLowerCase() === String(table).toLowerCase());
    if (!t) return { error: `unknown table '${table}'` } as const;
    const c = t.columns.find((x) => x.name.toLowerCase() === String(column).toLowerCase());
    if (!c) return { error: `unknown column '${column}' on '${t.name}'` } as const;
    return { table: t.name, column: c.name, type: c.type } as const;
  }

  const listKey = (table: string, column: string) => `${table}\u0000${column}`;

  /** Read a column's values and counts into memory, behind any load already running. */
  function loadList(table: string, column: string): Promise<void> {
    const key = listKey(table, column);
    if (loading.has(key) || tooMany.has(key)) return loadQueue;
    loading.add(key);
    loadQueue = loadQueue.then(async () => {
      try {
        const c = quoteIdent(column);
        const rows = await deps.query(
          `SELECT CAST(${c} AS TEXT) AS v, COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${c} IS NOT NULL GROUP BY 1 LIMIT ${MAX_WARM_VALUES + 1}`,
          [],
        );
        if (rows.length > MAX_WARM_VALUES) { tooMany.add(key); lists.delete(key); kept.delete(key); return; }
        const byUpper = new Map<string, { value: string; count: number }[]>();
        for (const row of rows) {
          const value = String(row.v);
          const u = value.toUpperCase();
          byUpper.set(u, [...(byUpper.get(u) ?? []), { value, count: Number(row.n) }]);
        }
        lists.set(key, { at: Date.now(), byUpper });
      } catch {
        // stays unknown: the next question is asked through SQL, and the next refresh tries again
      } finally {
        loading.delete(key);
      }
    });
    return loadQueue;
  }

  /** Keep a column fresh from now on (a configured one, or one just asked about). */
  function keep(table: string, column: string, learned: boolean) {
    const key = listKey(table, column);
    if (tooMany.has(key) || kept.has(key)) return;
    if (learned && kept.size >= MAX_LEARNED_COLUMNS + (deps.warmColumns?.length ?? 0)) return;
    kept.set(key, { table, column });
    void loadList(table, column);
  }

  /**
   * Load the configured columns now and re-read every kept column on the refresh interval.
   * Called once by the routes; the returned function stops it.
   */
  function startWarming(): () => void {
    void (async () => {
      for (const w of deps.warmColumns ?? []) {
        const r = await resolve(w.table, w.column).catch(() => null);
        if (r && !("error" in r)) keep(r.table, r.column, false);
      }
    })();
    if (!timer) {
      timer = setInterval(() => { for (const k of kept.values()) void loadList(k.table, k.column); }, refreshMs);
      timer.unref?.();
    }
    return () => { if (timer) clearInterval(timer); timer = null; };
  }

  /** The distinct answer from a column's values in memory: the same matches and closest values as the SQL below. */
  function distinctFromMemory(list: ValueList, table: string, column: string, values: string[], limit: number) {
    const matches: { value: string; count: number }[] = [];
    const missing: { value: string; closest: { value: string; count: number }[] }[] = [];
    for (const v of values) {
      const hit = list.byUpper.get(v.toUpperCase());
      if (hit) { matches.push(...hit); continue; }
      const token = longestToken(v);
      const patterns = token ? [token, token.slice(0, 4)].filter((p, i, a) => p.length >= 3 && a.indexOf(p) === i) : [];
      let closest: { value: string; count: number }[] = [];
      for (const pat of patterns) {
        if (closest.length) break;
        const p = pat.toUpperCase();
        closest = [...list.byUpper.entries()].filter(([u]) => u.includes(p)).flatMap(([, e]) => e)
          .sort((a, b) => b.count - a.count).slice(0, limit);
      }
      missing.push({ value: v, closest });
    }
    // matches in one spelling each, as GROUP BY returns them
    const seen = new Set<string>();
    return { table, column, matches: matches.filter((m) => (seen.has(m.value) ? false : (seen.add(m.value), true))), missing };
  }

  /**
   * For each requested value: does it occur (case-insensitive, as the
   * clients' own filters compare), how often, and if not, the closest real
   * values. A text column's values are answered from memory when a fresh
   * list is held; otherwise from the table, and the column is loaded for
   * the next question.
   */
  async function distinct(body: { table?: string; column?: string; values?: unknown[]; limit?: number }) {
    if (!body?.table || !body?.column) return { error: "table and column are required" };
    const r = await resolve(body.table, body.column);
    if ("error" in r) return { error: r.error };
    const from = quoteIdent(r.table);
    const col = `CAST(${quoteIdent(r.column)} AS TEXT)`;
    const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 25);

    const values = (Array.isArray(body.values) ? body.values : [])
      .filter((v) => v !== null && v !== undefined && String(v).length > 0)
      .slice(0, MAX_VALUES)
      .map((v) => String(v));

    const key = listKey(r.table, r.column);
    const list = lists.get(key);
    if (list && Date.now() - list.at < refreshMs) return distinctFromMemory(list, r.table, r.column, values, limit);
    if (typeFamily(r.type) === "text") keep(r.table, r.column, true);

    const matches: { value: string; count: number }[] = [];
    if (values.length) {
      const list = values.map((_, i) => `UPPER(${ph(i + 1)})`).join(", ");
      const rows = await deps.query(
        `SELECT ${col} AS v, COUNT(*) AS n FROM ${from} WHERE UPPER(${col}) IN (${list}) GROUP BY 1`,
        values,
      );
      for (const row of rows) matches.push({ value: String(row.v), count: Number(row.n) });
    }
    const found = new Set(matches.map((m) => m.value.toUpperCase()));
    const missing: { value: string; closest: { value: string; count: number }[] }[] = [];
    let lookups = 0;
    for (const v of values) {
      if (found.has(v.toUpperCase())) continue;
      const token = longestToken(v);
      let closest: { value: string; count: number }[] = [];
      // Whole token first ("TIKTOK" → "TIKTOK SHOP"), then its first four
      // letters for misspellings and abbreviations ("Dasmarinas" → "DASMA").
      const patterns = token ? [token, token.slice(0, 4)].filter((p, i, a) => p.length >= 3 && a.indexOf(p) === i) : [];
      for (const pat of patterns) {
        if (closest.length || lookups >= MAX_CLOSEST_LOOKUPS) break;
        lookups++;
        const rows = await deps.query(
          `SELECT ${col} AS v, COUNT(*) AS n FROM ${from} WHERE UPPER(${col}) LIKE ${ph(1)} GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`,
          [`%${pat.toUpperCase()}%`],
        );
        closest = rows.map((row) => ({ value: String(row.v), count: Number(row.n) }));
      }
      missing.push({ value: v, closest });
    }

    return { table: r.table, column: r.column, matches, missing };
  }

  /**
   * Do these columns of a table hold a primary key or a whole (not partial, not expression) unique index?
   * Then the table has one row per value of them. False when it cannot be told (a view, an error).
   */
  async function uniqueOn(table: string, columns: string[]): Promise<boolean> {
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const within = (cols: Array<string | null>) => cols.length > 0 && cols.every((c) => c !== null && columns.includes(c));
    try {
      if (deps.dialect === "postgres") {
        const rows = await deps.query(
          `SELECT 1 AS u FROM pg_index i
            WHERE i.indrelid = to_regclass(${lit(quoteIdent(table))}) AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM generate_series(0, i.indnkeyatts - 1) g
                 WHERE i.indkey[g] = 0
                    OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                                    WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[g] AND a.attname IN (${columns.map(lit).join(", ")})))
            LIMIT 1`,
          [],
        );
        return rows.length > 0;
      }
      const pk = await deps.query(`SELECT name FROM pragma_table_info(${lit(table)}) WHERE pk > 0`, []);
      if (within(pk.map((r) => String(r.name)))) return true;
      const idx = await deps.query(
        `SELECT il.name AS idx, ii.name AS col FROM pragma_index_list(${lit(table)}) il JOIN pragma_index_info(il.name) ii WHERE il."unique" = 1 AND il.partial = 0`,
        [],
      );
      const byIndex = new Map<string, Array<string | null>>();
      for (const r of idx) byIndex.set(String(r.idx), [...(byIndex.get(String(r.idx)) ?? []), r.col == null ? null : String(r.col)]);
      return [...byIndex.values()].some(within);
    } catch {
      return false;
    }
  }

  /**
   * How many values of the join key appear more than once in BOTH tables.
   * Rows carrying such a value are repeated by a join on that key, so a SUM
   * over the join counts them more than once. Zero means the join repeats
   * nothing. One aggregate; the same SQL on Postgres and SQLite.
   */
  async function repeats(body: { left?: JoinSide; right?: JoinSide }) {
    const sides: { table: string; columns: string[]; types: string[] }[] = [];
    for (const side of [body?.left, body?.right]) {
      const cols = Array.isArray(side?.columns) ? side!.columns.map(String) : [];
      if (!side?.table || !cols.length || cols.length > MAX_JOIN_COLUMNS) return { error: "left and right each need a table and 1 to 6 columns" };
      const resolved: string[] = [];
      const types: string[] = [];
      let table = "";
      for (const c of cols) {
        const r = await resolve(side.table, c);
        if ("error" in r) return { error: r.error };
        table = r.table;
        resolved.push(r.column);
        types.push(typeFamily(r.type));
      }
      sides.push({ table, columns: resolved, types });
    }
    const [l, r] = sides;
    if (l.columns.length !== r.columns.length) return { error: "left and right need the same number of columns" };
    const out = (s: { table: string; columns: string[] }) => ({ table: s.table, columns: s.columns });
    // A side whose join columns hold a primary key or a unique index has one row per key: nothing can
    // repeat in both, and neither table has to be read to know it.
    if ((await uniqueOn(l.table, l.columns)) || (await uniqueOn(r.table, r.columns))) return { left: out(l), right: out(r), repeated: 0, unique_key: true };
    // A text key joined to a number (the query casts one of them) is compared as text on both sides:
    // '7' matches 7. A value written two ways ('007') is not matched, so the count can only be low.
    const asText = l.types.map((t, i) => !!t && !!r.types[i] && t !== r.types[i]);
    const grouped = (s: { table: string; columns: string[] }) =>
      `SELECT ${s.columns.map((c, i) => `${asText[i] ? `CAST(${quoteIdent(c)} AS TEXT)` : quoteIdent(c)} AS c${i + 1}`).join(", ")} FROM ${quoteIdent(s.table)} GROUP BY ${s.columns.map((_, i) => i + 1).join(", ")} HAVING COUNT(*) > 1`;
    const on = l.columns.map((_, i) => `a.c${i + 1} = b.c${i + 1}`).join(" AND ");
    const rows = await deps.query(`SELECT COUNT(*) AS n FROM (${grouped(l)}) a JOIN (${grouped(r)}) b ON ${on}`, []);
    return { left: out(l), right: out(r), repeated: Number(rows[0]?.n ?? 0) };
  }

  /**
   * Where a table's data ends: the greatest value of a date column, or of an
   * ordered pair such as (year, month). Data often lags the calendar, and a
   * query whose period runs past this point is totalling a period that is
   * missing or only partly there. Values come back as text.
   */
  async function latest(body: { table?: string; columns?: unknown[] }) {
    const cols = Array.isArray(body?.columns) ? body!.columns.map(String) : [];
    if (!body?.table || !cols.length || cols.length > MAX_LATEST_COLUMNS) return { error: "a table and 1 to 3 columns are required" };
    const resolved: string[] = [];
    let table = "";
    for (const c of cols) {
      const r = await resolve(body.table, c);
      if ("error" in r) return { error: r.error };
      table = r.table;
      resolved.push(r.column);
    }
    const rows = await deps.query(
      `SELECT ${resolved.map((c, i) => `CAST(${quoteIdent(c)} AS TEXT) AS c${i + 1}`).join(", ")} FROM ${quoteIdent(table)}` +
        ` WHERE ${resolved.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(" AND ")}` +
        ` ORDER BY ${resolved.map((c) => `${quoteIdent(c)} DESC`).join(", ")} LIMIT 1`,
      [],
    );
    const out = { table, columns: resolved, latest: rows[0] ? resolved.map((_, i) => String(rows[0][`c${i + 1}`])) : null };
    // Where the complete data ends, when the client knows: said beside the latest row, never instead of it.
    let complete: CompleteThrough | null = null;
    try { complete = deps.completeThrough ? await deps.completeThrough(table, resolved) : null; } catch { complete = null; }
    if (complete && /^\d{4}-\d{2}-\d{2}$/.test(String(complete.through))) {
      return { ...out, complete_through: String(complete.through), ...(complete.rule ? { completeness: String(complete.rule) } : {}) };
    }
    return out;
  }

  return { schema, distinct, repeats, latest, resolve, startWarming };
}

/** Types that compare with each other without a cast: numbers, text, dates. "" when the type is not known. */
export function typeFamily(type: string | undefined): string {
  const t = (type ?? "").toLowerCase().trim();
  if (!t) return "";
  if (/int|numeric|decimal|real|double|float|serial|money/.test(t)) return "number";
  if (/char|text|string|clob/.test(t)) return "text";
  if (/date|time/.test(t)) return "time";
  return t.replace(/\(.*$/, "");
}

/** The longest run of letters/digits (≥3 chars) — what a closest-value search keys on. */
function longestToken(v: string): string | null {
  const parts = v.split(/[^A-Za-z0-9]+/).filter((p) => p.length >= 3);
  if (!parts.length) return v.trim().length >= 3 ? v.trim() : null;
  return parts.sort((a, b) => b.length - a.length)[0];
}

/** Routes under /analytics, inside the plugin's auth scope. */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsConfig): void {
  const analytics = createAnalytics(deps);
  const stopWarming = analytics.startWarming();
  app.addHook("onClose", async () => stopWarming());
  const guard = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, run: () => Promise<T>) => {
    try {
      const out = await run();
      if (out && typeof out === "object" && "error" in (out as object)) return reply.code(400).send(out);
      return out;
    } catch (e) {
      // The database's own message can name a host, a user or a file: it stays in this server's log.
      const message = String((e as Error)?.message ?? e);
      app.log.warn({ err: message }, "analytics lookup failed");
      return reply.code(500).send({ error: /time ?out|timed out|cancel|interrupt/i.test(message) ? "the lookup timed out" : "the lookup failed" });
    }
  };
  app.get("/analytics/info", async () => ({ analytics_version: ANALYTICS_VERSION, dialect: deps.dialect, sql_tools: deps.sqlTools ?? [] }));
  app.get("/analytics/schema", async (_req, reply) =>
    guard(reply, async () => ({ analytics_version: ANALYTICS_VERSION, dialect: deps.dialect, tables: await analytics.schema() })));
  app.post<{ Body: { table?: string; column?: string; values?: unknown[]; limit?: number } }>("/analytics/distinct", async (req, reply) =>
    guard(reply, () => analytics.distinct(req.body ?? {})));
  app.post<{ Body: { left?: JoinSide; right?: JoinSide } }>("/analytics/repeats", async (req, reply) =>
    guard(reply, () => analytics.repeats(req.body ?? {})));
  app.post<{ Body: { table?: string; columns?: unknown[] } }>("/analytics/latest", async (req, reply) =>
    guard(reply, () => analytics.latest(req.body ?? {})));
}
