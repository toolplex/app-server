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
 * What each character of the text is, as the database reads it: code ("c"),
 * inside a string ("q"), inside a quoted name ("i"), or inside a comment ("m").
 *
 * Everything below depends on this being right. `select '--'; drop ...` has
 * no comment in it, and a check that thought it did would not see the second
 * statement. So strings are followed the way DuckDB follows them: '' and ""
 * doubling, backslash escapes in E'...' strings, $tag$...$tag$ strings, and
 * block comments that nest.
 */
function classify(sql: string): string {
  const kinds: string[] = new Array<string>(sql.length).fill("c");
  const mark = (from: number, to: number, kind: string): void => {
    for (let k = from; k < to && k < sql.length; k++) kinds[k] = kind;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && i > 0 && (sql[i - 1] === "e" || sql[i - 1] === "E") && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      mark(i, j + 1, ch === '"' ? "i" : "q");
      i = j + 1;
    } else if (ch === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (!tag) {
        i++;
        continue;
      }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      const stop = end < 0 ? sql.length : end + tag[0].length;
      mark(i, stop, "q");
      i = stop;
    } else if (ch === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      mark(i, j, "m");
      i = j;
    } else if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      mark(i, j, "m");
      i = j;
    } else i++;
  }
  return kinds.join("");
}

/** The text with each comment replaced by a space. */
function stripComments(sql: string): string {
  const kinds = classify(sql);
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (kinds[i] !== "m") out += sql[i];
    else if (i === 0 || kinds[i - 1] !== "m") out += " ";
  }
  return out;
}

/**
 * Reject anything but a single read statement: split on `;` where it is
 * code, and require at most one non-empty statement that starts with a
 * reading keyword. This is a first check with a plain message, not the
 * boundary: what it guards runs on databases opened read-only.
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

/** Split on each `;` that is code: not inside a string, a quoted name or a comment. */
function splitStatements(sql: string): string[] {
  const kinds = classify(sql);
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === ";" && kinds[i] === "c") {
      out.push(current);
      current = "";
      continue;
    }
    current += sql[i];
  }
  out.push(current);
  return out;
}
