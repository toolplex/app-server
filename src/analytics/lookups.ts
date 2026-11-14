// Analytics lookups — the facts about a client's data that the ToolPlex
// analytics engine (cloud-agent/src/analytics) asks for when it checks the
// agent's SQL. The engine reads the query and decides what to ask; this
// answers, next to the data, in the client's own dialect.
//
//   GET  /analytics/info      dialect and which of the client's tools run SQL
//   GET  /analytics/schema    tables and views with their columns and types
//   POST /analytics/distinct  { table, column, values } → which values exist, and the closest real ones
//   POST /analytics/repeats   { left, right } → how many join-key values repeat in both tables
//   POST /analytics/latest    { table, columns } → the latest row by a date, or by a year and a month
//
// Every route is read-only. Identifiers are only ever taken from the live
// schema, never from the request, and values are bound as parameters, so a
// request cannot inject SQL. A server that does not configure `analytics`
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
  /** Tables the agent may not see: left out of the schema and refused in lookups. */
  deniedTables?: string[];
  /**
   * The names of this client's tools whose argument is SQL the agent wrote
   * (e.g. ["execute_sql", "generate_from_sql"]), in any of its tool packages.
   * The engine checks calls to these and nothing else.
   */
  sqlTools?: string[];
}

export interface AnalyticsColumn { name: string; type: string }
export interface AnalyticsTable { name: string; kind: "table" | "view"; columns: AnalyticsColumn[]; estimated_rows?: number }
/** One side of a join: a table and the column(s) it is joined on. */
export interface JoinSide { table?: string; columns?: unknown[] }

export const ANALYTICS_VERSION = 4;
const SCHEMA_TTL_MS = 10 * 60_000;
const MAX_VALUES = 20;
const MAX_CLOSEST_LOOKUPS = 8;
const MAX_JOIN_COLUMNS = 6;
const MAX_LATEST_COLUMNS = 3;

export function createAnalytics(deps: AnalyticsConfig) {
  let cached: { at: number; tables: AnalyticsTable[] } | null = null;
  const denied = new Set((deps.deniedTables ?? []).map((t) => t.toLowerCase()));
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
      if (denied.has(name.toLowerCase())) continue;
      let t = byName.get(name);
      if (!t) {
        t = { name, kind: r.kind === "view" ? "view" : "table", columns: [] };
        if (r.est != null && r.kind !== "view") t.estimated_rows = Number(r.est);
        byName.set(name, t);
      }
      t.columns.push({ name: String(r.c), type: String(r.ty ?? "") });
    }
    const tables = [...byName.values()];
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

  /**
   * For each requested value: does it occur (case-insensitive, as the
   * clients' own filters compare), how often, and if not, the closest real
   * values.
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
    // A text key joined to a number (the query casts one of them) is compared as text on both sides:
    // '7' matches 7. A value written two ways ('007') is not matched, so the count can only be low.
    const asText = l.types.map((t, i) => !!t && !!r.types[i] && t !== r.types[i]);
    const grouped = (s: { table: string; columns: string[] }) =>
      `SELECT ${s.columns.map((c, i) => `${asText[i] ? `CAST(${quoteIdent(c)} AS TEXT)` : quoteIdent(c)} AS c${i + 1}`).join(", ")} FROM ${quoteIdent(s.table)} GROUP BY ${s.columns.map((_, i) => i + 1).join(", ")} HAVING COUNT(*) > 1`;
    const on = l.columns.map((_, i) => `a.c${i + 1} = b.c${i + 1}`).join(" AND ");
    const rows = await deps.query(`SELECT COUNT(*) AS n FROM (${grouped(l)}) a JOIN (${grouped(r)}) b ON ${on}`, []);
    const out = (s: { table: string; columns: string[] }) => ({ table: s.table, columns: s.columns });
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
    return { table, columns: resolved, latest: rows[0] ? resolved.map((_, i) => String(rows[0][`c${i + 1}`])) : null };
  }

  return { schema, distinct, repeats, latest, resolve };
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
  const guard = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, run: () => Promise<T>) => {
    try {
      const out = await run();
      if (out && typeof out === "object" && "error" in (out as object)) return reply.code(400).send(out);
      return out;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
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
