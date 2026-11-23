// What the file store and the process that runs queries for it both need:
// the store's own error, and how a value from the database is turned into
// something JSON can carry. Kept apart from the store so that process loads
// this and nothing of the rest (spreadsheets, documents, uploads).

import { createWriteStream } from "node:fs";

// ---------------------------------------------------------------------------
// Errors — carry an HTTP status so the route can map them directly.
// ---------------------------------------------------------------------------

export class FileStoreError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "FileStoreError";
    this.statusCode = statusCode;
  }
}

/** Append-only UTF-8 text file with awaited writes, so memory stays at one chunk. */
export function lineWriter(path: string): {
  write: (text: string) => Promise<void>;
  end: () => Promise<void>;
  /** Release the descriptor after a failure; `end` already closed it on success. */
  destroy: () => void;
} {
  const out = createWriteStream(path, { encoding: "utf8" });
  return {
    write: (text) => new Promise((done, fail) => out.write(text, (err) => (err ? fail(err) : done()))),
    end: () => new Promise((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done()))),
    destroy: () => out.destroy(),
  };
}

/** Drop rows from the end until the serialized payload fits the byte cap. */
export function fitBytes<T>(rows: T[], maxBytes: number): { rows: T[]; truncated: boolean } {
  let out = rows;
  while (out.length > 0 && byteLen(out) > maxBytes) out = out.slice(0, Math.max(1, Math.floor(out.length * 0.8)) - 1);
  return { rows: out, truncated: out.length < rows.length };
}

/** Strip NUL bytes — they corrupt manifests and are rejected by some LLM APIs. */
export function stripNulls(s: string): string {
  const NUL = String.fromCharCode(0);
  return s.indexOf(NUL) === -1 ? s : s.split(NUL).join("");
}

/** Single-quote a string for inline SQL (paths). Doubles embedded quotes. */
export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function byteLen(rows: unknown): number {
  return Buffer.byteLength(JSON.stringify(rows ?? []), "utf8");
}

export function normalizeRow(
  row: Record<string, unknown>,
  maxStringLen?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = normalizeValue(v, maxStringLen);
  }
  return out;
}

/**
 * DuckDB's neo client returns native JS values for primitives but typed
 * wrapper objects for temporal/decimal/nested types (e.g. DATE → {days},
 * DECIMAL → {width,scale,value}). Their `toString()` yields the canonical
 * SQL rendering ("2026-01-02", "3.14"), so we stringify wrappers and fall
 * back to a BigInt-safe JSON for anything without a useful toString.
 */
export function normalizeValue(v: unknown, maxStringLen?: number): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : (v as bigint).toString();
  }
  if (t === "number" || t === "boolean") return v;
  if (t === "string") return capStr(stripNulls(v as string), maxStringLen);
  if (v instanceof Date) return v.toISOString();
  if (t === "object") {
    const s = safeToString(v);
    if (s !== null) return capStr(stripNulls(s), maxStringLen);
    try {
      return JSON.parse(
        JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)),
      );
    } catch {
      return String(v);
    }
  }
  return v;
}

export function safeToString(v: unknown): string | null {
  try {
    const s = (v as { toString(): string }).toString();
    return s === "[object Object]" ? null : s;
  } catch {
    return null;
  }
}

export function capStr(s: string, maxLen?: number): string {
  if (!maxLen || s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

/**
 * Race a promise against a timeout. On timeout, run `onTimeout` (interrupts
 * the DuckDB connection, which is what actually stops a running query) and
 * reject with a 408.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
      reject(new FileStoreError(408, `Query exceeded the ${ms / 1000}s time limit.`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
