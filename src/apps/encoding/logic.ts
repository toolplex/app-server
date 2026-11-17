// ---------------------------------------------------------------------------
// Document encoding — what a record means at any moment. No I/O here.
//
// A document carries three layers, kept apart on purpose:
//   reading   what the platform's readers decided (never edited afterwards)
//   resolved  each decision a person made on a value
//   flags     questions the client's own knowledge raised after the read
// The current values, the open questions and the calibration numbers are all
// derived from those, so "what did the machine say" and "what did a person
// change" can always be told apart.
// ---------------------------------------------------------------------------

import type { DocumentEncodingConfig, EncodingDocumentType, EncodingField } from "../types.js";
import type { ReadValue, Reading, Scalar, StoredDocument } from "./store.js";

export interface Question {
  path: string;
  label: string;
  /** ask: a person must decide. confirm: filled in, to be confirmed at a glance. */
  kind: "ask" | "confirm";
  reason: string;
  value: Scalar | null;
  candidates: Scalar[];
  type: EncodingField["type"];
  box?: ReadValue["box"];
}

const TABLE_PATH = /^([^[\].]+)\[(\d+)\]\.([^[\].]+)$/;

export function parsePath(path: string): { table: string; row: number; column: string } | { field: string } {
  const m = TABLE_PATH.exec(path);
  return m ? { table: m[1], row: Number(m[2]), column: m[3] } : { field: path };
}

/** Every value path of a document, in the order the form declares them. */
export function valuePaths(doc: StoredDocument, spec: EncodingDocumentType): { path: string; field: EncodingField; label: string }[] {
  const out: { path: string; field: EncodingField; label: string }[] = [];
  for (const f of spec.fields) out.push({ path: f.key, field: f, label: f.label });
  for (const t of spec.tables ?? []) {
    const rows = doc.tables[t.key] ?? [];
    rows.forEach((_, i) => {
      for (const c of t.columns) {
        out.push({ path: `${t.key}[${i}].${c.key}`, field: c, label: `${t.label}, line ${i + 1}: ${c.label}` });
      }
    });
  }
  return out;
}

export function readValueAt(doc: StoredDocument, path: string): ReadValue | null {
  const p = parsePath(path);
  if (!doc.reading) return null;
  if ("field" in p) return doc.reading.fields[p.field] ?? null;
  return doc.reading.tables[p.table]?.[p.row]?.[p.column] ?? null;
}

export function valueAt(doc: StoredDocument, path: string): Scalar | null {
  const p = parsePath(path);
  if ("field" in p) return doc.values[p.field] ?? null;
  return doc.tables[p.table]?.[p.row]?.[p.column] ?? null;
}

export function setValueAt(doc: StoredDocument, path: string, value: Scalar | null): void {
  const p = parsePath(path);
  if ("field" in p) {
    doc.values[p.field] = value;
    return;
  }
  const rows = (doc.tables[p.table] ??= []);
  while (rows.length <= p.row) rows.push({});
  rows[p.row][p.column] = value;
}

/** Copy the reading's values into the record. Called once, when a read lands. */
export function applyReading(doc: StoredDocument): void {
  doc.values = {};
  doc.tables = {};
  doc.resolved = {};
  doc.flags = {};
  if (!doc.reading) return;
  for (const [k, v] of Object.entries(doc.reading.fields)) doc.values[k] = v.value;
  for (const [t, rows] of Object.entries(doc.reading.tables)) {
    doc.tables[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([c, v]) => [c, v.value])));
  }
}

/** What still waits on a person, in form order. */
export function openQuestions(doc: StoredDocument, spec: EncodingDocumentType | undefined): Question[] {
  if (!spec || !doc.reading) return [];
  const out: Question[] = [];
  for (const { path, field, label } of valuePaths(doc, spec)) {
    const read = readValueAt(doc, path);
    const flag = doc.flags[path];
    const value = valueAt(doc, path);
    if (doc.resolved[path]) {
      // A person's decision settles a value, except that a required one cannot be settled as empty.
      if (field.required && (value === null || value === "")) {
        out.push({ path, label, kind: "ask", reason: "Required, and empty", value: null, candidates: [], type: field.type, box: read?.box });
      }
      continue;
    }
    if (flag) {
      out.push({ path, label, kind: "ask", reason: flag.reason, value, candidates: flag.candidates, type: field.type, box: read?.box });
    } else if (read && (read.status === "ask" || read.status === "confirm")) {
      out.push({
        path,
        label,
        kind: read.status,
        reason: read.reason ?? (read.status === "confirm" ? "Handwritten" : "Needs a decision"),
        value,
        candidates: read.candidates,
        type: field.type,
        box: read.box,
      });
    } else if (field.required && (value === null || value === "")) {
      out.push({ path, label, kind: "ask", reason: "Required, and empty", value: null, candidates: [], type: field.type, box: read?.box });
    }
  }
  return out;
}

export function coerce(type: EncodingField["type"], raw: unknown): Scalar | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  if (type === "number") {
    const n = Number(s.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : s;
  }
  return s.slice(0, 2000);
}

export function same(a: Scalar | null, b: Scalar | null): boolean {
  if (a === null || b === null) return a === b;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * The arithmetic and range checks, worked out from the values as they stand
 * now. The readers' own checks describe the moment of the read; once a
 * person has changed a value they would be describing something else.
 */
export function currentChecks(
  doc: StoredDocument,
  spec: EncodingDocumentType,
): { type: string; ok: boolean; message: string; values: string[] }[] {
  const num = (v: Scalar | null | undefined): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const out: { type: string; ok: boolean; message: string; values: string[] }[] = [];
  for (const check of spec.checks ?? []) {
    if (check.type === "sum") {
      const total = num(doc.values[check.equals]);
      const parts = (doc.tables[check.table] ?? []).map((r) => num(r[check.column]));
      if (total === null || parts.length === 0 || parts.some((p) => p === null)) continue;
      const sum = (parts as number[]).reduce((x, y) => x + y, 0);
      const ok = Math.abs(sum - total) <= (check.tolerance ?? 0) + 1e-9;
      const label = spec.fields.find((f) => f.key === check.equals)?.label ?? check.equals;
      out.push({
        type: "sum",
        ok,
        message: ok ? `Lines add up to ${label}` : `Lines add up to ${Number(sum.toFixed(6))}, but ${label} says ${total}`,
        values: [check.equals],
      });
    } else if (check.type === "range") {
      const v = num(doc.values[check.field]);
      if (v === null) continue;
      const ok = (check.min === undefined || v >= check.min) && (check.max === undefined || v <= check.max);
      out.push({ type: "range", ok, message: ok ? "Within the expected range" : "Outside the expected range", values: [check.field] });
    }
  }
  return out;
}

/**
 * A reading as it arrived from the platform, made safe to store: anything
 * that is not the expected shape is refused here, once, instead of breaking
 * every screen that later lists the document.
 */
export function checkedReading(raw: unknown): Reading {
  const bad = (): never => {
    throw new Error("The reader returned something that could not be understood");
  };
  if (!raw || typeof raw !== "object") bad();
  const r = raw as Record<string, unknown>;
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const value = (v: unknown): ReadValue => {
    if (!isObject(v)) return bad();
    const scalar = (x: unknown): Scalar | null => (typeof x === "string" || (typeof x === "number" && Number.isFinite(x)) ? x : null);
    const status = v.status === "accepted" || v.status === "confirm" || v.status === "ask" || v.status === "blank" ? v.status : "ask";
    const box = isObject(v.box) && ["page", "x", "y", "w", "h"].every((k) => typeof (v.box as Record<string, unknown>)[k] === "number") ? (v.box as ReadValue["box"]) : undefined;
    return {
      value: scalar(v.value),
      status,
      ...(typeof v.reason === "string" ? { reason: v.reason.slice(0, 500) } : {}),
      candidates: Array.isArray(v.candidates) ? v.candidates.map(scalar).filter((c): c is Scalar => c !== null).slice(0, 12) : [],
      written: v.written === "printed" || v.written === "hand" ? v.written : "unknown",
      ...(box ? { box } : {}),
    };
  };
  const fields = isObject(r.fields) ? Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, value(v)])) : bad();
  const tables: Reading["tables"] = {};
  for (const [k, rows] of Object.entries(isObject(r.tables) ? r.tables : {})) {
    if (!Array.isArray(rows)) bad();
    tables[k] = (rows as unknown[]).map((row) => (isObject(row) ? Object.fromEntries(Object.entries(row).map(([c, v]) => [c, value(v)])) : bad()));
  }
  const counts = { accepted: 0, confirm: 0, ask: 0, blank: 0 };
  for (const v of Object.values(fields)) counts[v.status]++;
  for (const rows of Object.values(tables)) for (const row of rows) for (const v of Object.values(row)) counts[v.status]++;
  return {
    document_type: typeof r.document_type === "string" ? r.document_type : null,
    document_type_agreed: r.document_type_agreed === true,
    fields,
    tables,
    checks: Array.isArray(r.checks)
      ? r.checks.filter(isObject).map((c) => ({
          type: String(c.type ?? ""),
          ok: c.ok === true,
          message: String(c.message ?? "").slice(0, 500),
          values: Array.isArray(c.values) ? c.values.filter((x): x is string => typeof x === "string") : [],
        }))
      : [],
    counts,
    readers: Array.isArray(r.readers) ? (r.readers.filter(isObject) as unknown as Reading["readers"]) : [],
  };
}

/** The value of the grouping field, as text. */
export function groupOf(doc: StoredDocument, config: DocumentEncodingConfig): string | null {
  if (!config.group_by) return null;
  const v = doc.values[config.group_by];
  return v === null || v === undefined || v === "" ? null : String(v).trim();
}

/**
 * Questions that only the client's side can raise: a value that differs from
 * what the client expected, or from the same value on another document in
 * the group. Either one only ever ASKS; the value read stays as read.
 */
export function raiseFlags(
  doc: StoredDocument,
  spec: EncodingDocumentType,
  expected: Record<string, Scalar> | null,
  groupMates: { name: string; values: Record<string, Scalar | null> }[],
): void {
  for (const [key, want] of Object.entries(expected ?? {})) {
    if (!spec.fields.some((f) => f.key === key) || doc.resolved[key]) continue;
    const have = doc.values[key] ?? null;
    if (!same(have, want)) {
      doc.flags[key] = {
        reason: "Differs from what your records expect",
        candidates: have === null ? [want] : [have, want],
      };
    }
  }
  for (const check of spec.checks ?? []) {
    if (check.type !== "same-in-group" || doc.resolved[check.field] || doc.flags[check.field]) continue;
    const have = doc.values[check.field] ?? null;
    if (have === null) continue;
    for (const mate of groupMates) {
      const theirs = mate.values[check.field] ?? null;
      if (theirs !== null && !same(have, theirs)) {
        doc.flags[check.field] = {
          reason: `Differs from "${mate.name}" in the same group`,
          candidates: [have, theirs],
        };
        break;
      }
    }
  }
}

export interface Calibration {
  documents: number;
  /** Values the readers accepted without a question. */
  accepted: number;
  /** Of those, how many a person later changed: the number that matters most. */
  acceptedThenChanged: number;
  confirmed: number;
  confirmedChanged: number;
  asked: number;
  /** Asked values answered by picking one of the offered choices. */
  askedAnsweredByChoice: number;
  askedTyped: number;
}

const CAL_KEYS = [
  "documents",
  "accepted",
  "acceptedThenChanged",
  "confirmed",
  "confirmedChanged",
  "asked",
  "askedAnsweredByChoice",
  "askedTyped",
] as const satisfies readonly (keyof Calibration)[];

/**
 * One document's share of the calibration counts, in CAL_KEYS order, or null
 * when it does not count (not approved, or never read). Kept in the index so
 * the totals never need a record opened.
 */
export function calibrationOf(doc: StoredDocument): number[] | null {
  if (doc.status !== "approved" || !doc.reading) return null;
  const c: Calibration = {
    documents: 1,
    accepted: 0,
    acceptedThenChanged: 0,
    confirmed: 0,
    confirmedChanged: 0,
    asked: 0,
    askedAnsweredByChoice: 0,
    askedTyped: 0,
  };
  const each = (path: string, read: ReadValue) => {
    const r = doc.resolved[path];
    const changed = !!r && !same(r.from, r.to);
    if (read.status === "accepted") {
      c.accepted++;
      if (changed) c.acceptedThenChanged++;
    } else if (read.status === "confirm") {
      c.confirmed++;
      if (changed) c.confirmedChanged++;
    } else if (read.status === "ask") {
      c.asked++;
      if (r?.how === "choice") c.askedAnsweredByChoice++;
      else if (r?.how === "typed") c.askedTyped++;
    }
  };
  for (const [k, v] of Object.entries(doc.reading.fields ?? {})) each(k, v);
  for (const [t, rows] of Object.entries(doc.reading.tables ?? {})) {
    rows.forEach((row, i) => {
      for (const [col, v] of Object.entries(row)) each(`${t}[${i}].${col}`, v);
    });
  }
  return CAL_KEYS.map((k) => c[k]);
}

/** How the readers are doing, counted over documents a person has approved. */
export function calibration(shares: (number[] | null)[]): Calibration {
  const total = CAL_KEYS.map(() => 0);
  for (const share of shares) if (share) share.forEach((n, i) => (total[i] += n || 0));
  return Object.fromEntries(CAL_KEYS.map((k, i) => [k, total[i]])) as unknown as Calibration;
}
