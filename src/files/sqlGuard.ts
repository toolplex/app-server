// ---------------------------------------------------------------------------
// SQL guard — a light read-only allowlist for agent-issued queries.
//
// This is defense-in-depth, NOT the primary control. The real sandbox is the
// query-time DuckDB instance (read-only access mode + external access disabled
// + locked configuration — see store.ts), which makes writes, ATTACH, COPY,
// arbitrary file reads, and SET impossible regardless of what the SQL says.
//
// This guard's job is to (a) fail fast with a clear, agent-readable message
// before touching DuckDB, and (b) reject multi-statement payloads so a query
// can't smuggle a second statement past the reader.
// ---------------------------------------------------------------------------

export interface SqlGuardResult {
  ok: boolean;
  /** Present when ok=false — a short, agent-readable reason. */
  error?: string;
}

const ALLOWED_LEADING = [
  "SELECT",
  "WITH",
  "DESCRIBE",
  "SUMMARIZE",
  "EXPLAIN",
  "SHOW",
  "TABLE", // DuckDB: `TABLE foo` ≡ `SELECT * FROM foo`
  "PIVOT",
  "FROM", // DuckDB FROM-first syntax: `FROM foo SELECT ...`
  "VALUES",
];

/**
 * Strip SQL comments (line `--…` and block `/* … *​/`) so they can't hide a
 * second statement or a disallowed leading keyword.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * Reject anything but a single read statement. Multi-statement detection is
 * intentionally simple: split on `;` outside of single/double-quoted strings
 * and require at most one non-empty statement.
 */
export function validateReadOnlySql(raw: string): SqlGuardResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "Query is empty." };
  }

  const sql = stripComments(raw).trim();
  if (sql.length === 0) {
    return { ok: false, error: "Query is empty (only comments)." };
  }

  // Split into statements, respecting quoted strings, to count them.
  const statements = splitStatements(sql).filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    return {
      ok: false,
      error:
        "Only a single SQL statement is allowed. Remove the extra statement(s) and the ';' separator.",
    };
  }

  const firstWord = sql.replace(/^[("\s]+/, "").split(/[\s(]/, 1)[0]?.toUpperCase() ?? "";
  if (!ALLOWED_LEADING.includes(firstWord)) {
    return {
      ok: false,
      error: `Only read-only queries are allowed (must start with one of: ${ALLOWED_LEADING.join(
        ", ",
      )}). This file is read-only — you cannot modify it.`,
    };
  }

  return { ok: true };
}

/**
 * Split on `;` that are not inside single- or double-quoted string literals.
 * DuckDB uses '' / "" doubling for escapes, which this handles naturally
 * (a doubled quote just toggles in and back out).
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ";" && !inSingle && !inDouble) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}
