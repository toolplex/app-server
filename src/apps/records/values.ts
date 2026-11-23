// What a column can hold, decided in one place.
//
// The same rule answers three questions: what is written to the query
// database, what a copy elsewhere is handed, and what a filter's value means.
// A number column never holds text and a date column never holds a guess:
// what does not fit the column is left empty, and counted, so it can be said.

import type { RecordColumn, RecordValue } from "./types.js";

/** Digits, with thousands separators only where they belong: "1,234.50", "-12", ".5". */
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;
const WHOLE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The number a piece of text is, or null when it is not one. */
export function numberOf(text: string): number | null {
  const s = text.trim();
  if (s === "" || !/\d/.test(s) || !NUMBER.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A calendar day written year-month-day that exists, as that same text; else null. */
export function dayOf(text: string): string | null {
  const m = DAY.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? m[0] : null;
}

/** Days since 1970-01-01 of a day `dayOf` accepted. */
export const daysOf = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/**
 * A value as its column holds it: a number, true or false, a moment as ISO
 * text, a day as "YYYY-MM-DD", or trimmed text. `fits` is false when there
 * was something there that the column cannot hold (which is then null).
 */
export function held(column: Pick<RecordColumn, "type">, value: RecordValue | undefined): { value: RecordValue; fits: boolean } {
  if (value === null || value === undefined) return { value: null, fits: true };
  if (typeof value === "string" && value.trim() === "") return { value: null, fits: true };
  switch (column.type) {
    case "number": {
      const n = typeof value === "number" ? (Number.isFinite(value) ? value : null) : typeof value === "string" ? numberOf(value) : null;
      return { value: n, fits: n !== null };
    }
    case "integer": {
      const n = typeof value === "number" ? (Number.isFinite(value) ? Math.trunc(value) : null) : typeof value === "string" && WHOLE.test(value.trim()) ? Number(value.trim().replace(/,/g, "")) : null;
      return { value: n !== null && Number.isSafeInteger(n) ? n : null, fits: n !== null && Number.isSafeInteger(n) };
    }
    case "boolean": {
      const b = value === true || value === "true" ? true : value === false || value === "false" ? false : null;
      return { value: b, fits: b !== null };
    }
    case "timestamp": {
      const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
      // Outside what a date can express is not a moment anyone approved anything.
      return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? { value: new Date(ms).toISOString(), fits: true } : { value: null, fits: false };
    }
    case "date": {
      const day = typeof value === "string" ? dayOf(value) : null;
      return { value: day, fits: day !== null };
    }
    default: {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return { value: null, fits: false };
      // Space around a value is never part of it, whoever or whatever typed it.
      const text = String(value).trim();
      return { value: text === "" ? null : text, fits: true };
    }
  }
}
