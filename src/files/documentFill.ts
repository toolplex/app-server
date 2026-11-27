// ---------------------------------------------------------------------------
// Writing into a workbook somebody already has.
//
// A value written into an existing sheet has to land against the row and the
// column it belongs to, and nothing here can see what the author meant. So
// nothing here goes by position when the sheet can say where a value goes:
//
//   fill_by_key     each sheet row is found by its own key (an item code, a
//                   store name), read from the sheet itself, and each value
//                   is written under the header it was mapped to. Row order,
//                   column order, blank rows and title rows do not matter.
//   append_rows     each value is written under the header of the same name.
//   populate_sheet  by position, and therefore only into an area that has
//                   nothing beside it to be misaligned with.
//
// Every op checks all of its cells before it writes any, and says what it
// did. What cannot be done safely is refused with the reason and a way
// forward; a workbook that is half right is worse than none. What is merely
// not there to fill (a heading in the key column, a row with no data) is
// left alone and counted, so the caller can say so.
//
// Pure and synchronous: rows arrive already fetched (see documents.ts).
// ---------------------------------------------------------------------------

import ExcelJS from "exceljs";

/** A request that cannot be carried out as asked. The message is for the caller. */
export class DocOpError extends Error {}

export interface KeyPair {
  /** Header text of the key column in the sheet. */
  sheet: string;
  /** Column name of the key in the data. */
  data: string;
}

export interface FillByKeyArgs {
  sheet: string;
  key: KeyPair | KeyPair[];
  /** Sheet header → data column. */
  set: Record<string, string>;
  /**
   * A sheet row whose key has no data row: left as it is (default), or its
   * EMPTY target cells set to 0. Nothing such a row already holds is ever
   * written over, a formula or a figure, whatever `overwrite` says: a label
   * or a total written in the key column is a row without data too.
   */
  unmatched?: "leave" | "zero";
  /** Write over cells that already hold a value or a formula, in rows the data has. Default false. */
  overwrite?: boolean;
  /**
   * Sheet rows that carry the same key: refused (default), since the same
   * code under two stores is two different rows that one key cannot tell
   * apart; or "fill_each", when it is one thing listed twice.
   */
  sharedKeys?: "refuse" | "fill_each";
  /**
   * The sheet row that holds the headers, for a sheet with more than one
   * table: the one the op is about is named by where its headers are.
   * Without it, the first row that holds all the named headers is the one.
   */
  headerRow?: number;
  /**
   * The last sheet row of the table. With it nothing is guessed about where
   * the table ends: every row from the headers down to this one is read.
   */
  lastRow?: number;
  rows: Record<string, unknown>[];
}

export interface OpReport {
  op: string;
  sheet?: string;
  /** Cells written, e.g. "I2:J375", or one address. */
  range?: string;
  rowsWritten?: number;
  cellsWritten?: number;
  /** fill_by_key */
  headerRow?: number;
  keyColumns?: Record<string, string>;
  targetColumns?: Record<string, string>;
  sheetRowsWithKey?: number;
  matched?: number;
  /** Matched only after ignoring leading zeros, letter case or number-versus-text. */
  matchedLoosely?: number;
  looselyMatchedKeys?: Array<{ sheet: string; data: string }>;
  sheetRowsWithoutData?: number;
  sheetKeysWithoutData?: string[];
  /** What was done with rows that had no data: nothing, or their empty cells set to 0. */
  unmatched?: "leave" | "zero";
  unmatchedCellsSet?: number;
  /** Formulas in rows with no data, which are never written over. */
  formulasKept?: number;
  /** Cells in rows with no data that kept the value they already held; how many rows; and the keys of those rows (the first few hundred). */
  unmatchedValuesKept?: number;
  rowsThatKeptTheirValues?: number;
  keysThatKeptTheirValues?: string[];
  dataRowsNotInSheet?: number;
  dataKeysNotInSheet?: string[];
  sheetRowsSharingAKey?: number;
  /** Rows passed over because their key cell could not be read as a key (a merged heading, a formula with no result, …). */
  rowsWithUnreadableKey?: number;
  unreadableKeys?: string[];
  /** Rows passed over because only part of a several-column key was there. */
  rowsWithPartialKey?: number;
  /** The sheet rows that were read as the table: from the first below the headers to the last. */
  firstRow?: number;
  lastRow?: number;
  /** Another table begins here (its header row), and nothing from this row down was touched. */
  stoppedAtRow?: number;
  stoppedBecause?: string;
  /** Keys of the data that are found below that row, in the other table. */
  dataKeysBelowStop?: number;
  /** Keys of the data that are found below the "lastRow" the caller gave. */
  dataKeysBelowLastRow?: number;
  /** Rows inside the table that only repeat its headers (a header printed on every page), passed over. */
  headerRowsPassed?: number;
  /** Rows inside the rows the caller said are one table that read like column headings, and were taken as rows of it. */
  rowsThatReadLikeHeadings?: number[];
  /** Columns whose values were written as the column already holds its values, not as the data gave them: header → "dates", "numbers", "digits kept as text". */
  writtenAs?: Record<string, string>;
  /** Columns that were given dates as text and wrote them as text, the column giving no sign of holding real dates. */
  datesAsText?: string[];
  /** append_rows: what on the sheet is set to a range that does not take in the rows added (a filter, a print area). */
  doesNotCover?: string[];
  emptyValuesLeft?: number;
  /** The first rows as they now read: key, then each target. */
  firstRows?: Array<Record<string, unknown>>;
}

/** Addresses this op wrote, with what each must now hold; used to check the saved file. */
export type Written = Map<string, ExcelJS.CellValue>;

const SEP = "\u0001";
const SAMPLE = 10;
/** Keys of rows that kept an earlier figure: the caller has to be able to act on every one of them. */
const KEPT_SAMPLE = 300;

// --- Cell addresses ----------------------------------------------------------

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * One cell, as "I2" or "$I$2". Anything else (a range, a sheet prefix, a typo,
 * nothing) is refused: it used to be read as A1, and the write went over the
 * sheet's headers and keys.
 */
export function parseSingleCell(ref: unknown, what: string): { col: number; row: number } {
  const m = typeof ref === "string" ? /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref.trim()) : null;
  if (!m) {
    throw new DocOpError(`${what} must be one cell such as "B2" (got ${ref === undefined ? "nothing" : JSON.stringify(ref)}). A range or a sheet name is not accepted here; name the sheet in "sheet".`);
  }
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) };
}

const addr = (col: number, row: number): string => `${numToCol(col)}${row}`;

// --- Reading a sheet as it is ------------------------------------------------

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const headerKey = (s: string): string => squash(s).toLowerCase();

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function isFormula(cell: ExcelJS.Cell): boolean {
  const v = cell.value as unknown;
  return typeof v === "object" && v !== null && ("formula" in v || "sharedFormula" in v);
}

function cellText(cell: ExcelJS.Cell): string {
  try {
    return squash(String(cell.text ?? "")); // a link over a number gives the number, not text
  } catch {
    return "";
  }
}

/**
 * The last row that holds a value or a formula. Not the sheet's own row
 * count: rows that are only formatted (borders drawn down to row 500) count
 * there, and rows appended after them would land far below the data.
 */
export function lastValueRow(ws: ExcelJS.Worksheet): number {
  for (let r = ws.rowCount; r >= 1; r--) {
    let any = false;
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      if (!isEmptyValue(cell.value)) any = true;
    });
    if (any) return r;
  }
  return 0;
}

/**
 * A column named by its letter, "column:I", instead of by its header: the
 * way to say which is meant when a sheet uses one header text for several
 * columns (a "Qty" under every month).
 */
const COLUMN_REF = /^column:\s*\$?([A-Za-z]{1,3})$/i;
function columnLetter(name: string): number | null {
  const m = COLUMN_REF.exec(name.trim());
  return m ? colToNum(m[1]) : null;
}

/**
 * The row that holds every one of the named headers, each exactly once.
 * Title rows above it do not qualify; a sheet that names a header twice is
 * refused, since "the SOLD column" would then be a guess, and the refusal
 * says how to name the one that is meant.
 */
export function findHeaderRow(ws: ExcelJS.Worksheet, all: string[], at?: number): { row: number; cols: Map<string, number> } {
  const names = all.filter((n) => columnLetter(n) === null);
  const withLetters = (row: number, cols: Map<string, number>) => {
    for (const n of all) {
      const c = columnLetter(n);
      if (c !== null) cols.set(n, c);
    }
    return { row, cols };
  };
  const quoted = (list: string[]) => list.map((n) => `"${n}"`).join(", ");
  const read = (r: number) => {
    const seen = new Map<string, number[]>();
    const texts: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const t = cellText(cell);
      if (!t) return;
      texts.push(t);
      const k = headerKey(t);
      seen.set(k, [...(seen.get(k) ?? []), c]);
    });
    return { seen, texts };
  };
  const twiceIn = (r: number, seen: Map<string, number[]>) => {
    const twice = names.filter((n) => (seen.get(headerKey(n)) ?? []).length > 1);
    if (twice.length === 0) return;
    const where = twice.map((t) => `"${t}" heads columns ${seen.get(headerKey(t))!.map(numToCol).join(" and ")}`).join("; ");
    throw new DocOpError(`Sheet "${ws.name}" row ${r} uses one header for more than one column: ${where}. Name the column that is meant by its letter instead, as "column:${numToCol(seen.get(headerKey(twice[0]))![0])}". Nothing was written.`);
  };
  const list = (texts: string[]) => texts.slice(0, 40).map((t) => `"${t}"`).join(", ");
  const missing = (texts: string[]) => names.filter((n) => !texts.map(headerKey).includes(headerKey(n)));

  // The caller has said which row.
  if (at !== undefined) {
    if (!Number.isInteger(at) || at < 1) throw new DocOpError(`"headerRow" is the number of the sheet row that holds the headers (got ${JSON.stringify(at)}). Nothing was written.`);
    const { seen, texts } = read(at);
    const lacks = missing(texts);
    if (lacks.length > 0) {
      throw new DocOpError(`Row ${at} of sheet "${ws.name}" does not hold ${quoted(lacks)}. It holds: ${texts.length > 0 ? list(texts) : "nothing"}. Give the row the headers are on, or leave "headerRow" out to have it found. Nothing was written.`);
    }
    twiceIn(at, seen);
    return withLetters(at, new Map(names.map((n) => [n, seen.get(headerKey(n))![0]])));
  }
  if (names.length === 0) {
    throw new DocOpError(`Sheet "${ws.name}": with every column named by its letter, the header row cannot be found. Name at least one column by its header (the key column is the natural one), or say which row holds the headers with "headerRow". Nothing was written.`);
  }
  const wanted = names.map(headerKey);
  let best: { row: number; found: number; texts: string[] } | null = null;
  let widest: { row: number; texts: string[] } | null = null;
  // The whole sheet: a second table can begin anywhere below the first.
  const last = lastValueRow(ws);
  for (let r = 1; r <= last; r++) {
    const { seen, texts } = read(r);
    const found = wanted.filter((w) => seen.has(w)).length;
    if (found === wanted.length) {
      twiceIn(r, seen);
      // A row well above with some of these headers and not the rest: the
      // table meant may be that one, its headers written a little differently.
      if (best && r - best.row > 3) {
        throw new DocOpError(
          `Sheet "${ws.name}" has these headers on row ${r}, and some of them on row ${best.row} above it, which lacks ${quoted(missing(best.texts))} (it holds: ${list(best.texts)}). Which table is meant cannot be told. ` +
            `For the table whose headers are on row ${r}, add "headerRow": ${r}; for the one under row ${best.row}, name its headers as they are written there. Nothing was written.`,
        );
      }
      return withLetters(r, new Map(names.map((n) => [n, seen.get(headerKey(n))![0]])));
    }
    if (found > 0 && (!best || found > best.found)) best = { row: r, found, texts };
    // What the sheet's header row probably is, for the message, is judged near the top.
    if (r > 200) continue;
    if (!widest || texts.length > widest.texts.length) widest = { row: r, texts };
  }
  if (best) {
    throw new DocOpError(
      `Sheet "${ws.name}" has no row with all of these headers: ${quoted(names)}. Row ${best.row} comes closest but lacks ${quoted(missing(best.texts))}; its headers are: ${list(best.texts)}. Use the headers as they are written there; if the sheet's headings run over two rows (a month above "Qty" and "Amount"), name the key column by its header and each other column by its letter, as "column:D". Nothing was written.`,
    );
  }
  throw new DocOpError(
    `Sheet "${ws.name}" has none of these headers: ${quoted(names)}.` +
      (widest && widest.texts.length > 0 ? ` Its header row looks like row ${widest.row}: ${list(widest.texts)}. Use the headers as they are written there.` : " The sheet looks empty.") +
      " Nothing was written.",
  );
}

/** The last row of the merged cell a header sits in (its own row when it is not merged). */
function mergedBottom(ws: ExcelJS.Worksheet, row: number, col: number): number {
  const top = masterOf(ws.getRow(row).getCell(col));
  let r = row;
  while (r < ws.rowCount) {
    const below = ws.getRow(r + 1).getCell(col);
    if (!(below.isMerged && below.master.address === top.address)) break;
    r++;
  }
  return r;
}

// --- Keys --------------------------------------------------------------------

/** A value that cannot serve as a key, with the reason. */
class NotAKey extends Error {}

function dateKey(d: Date): string {
  if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds()) throw new NotAKey("a date with a time of day");
  return d.toISOString().slice(0, 10);
}

function numberKey(n: number): string {
  if (!Number.isInteger(n)) throw new NotAKey(`a number that is not whole (${n})`);
  if (!Number.isSafeInteger(n)) throw new NotAKey(`a number too long to be exact (${n}); a key like that must be stored as text`);
  return String(n);
}

function scalarKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return squash(v) === "" ? null : squash(v);
  if (typeof v === "number") return numberKey(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return dateKey(v);
  throw new NotAKey("something that is not a plain value");
}

/** A sheet cell as a key: what the cell holds, not how it happens to be laid out. null when empty. Throws NotAKey. */
function sheetKey(cell: ExcelJS.Cell): string | null {
  if (cell.isMerged) throw new NotAKey("part of a merged cell");
  const v = cell.value as unknown;
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as { result?: unknown; richText?: Array<{ text?: string }>; text?: unknown; error?: unknown; formula?: unknown; sharedFormula?: unknown };
    if ("formula" in o || "sharedFormula" in o) {
      if (o.result === undefined || o.result === null) throw new NotAKey("a formula with no stored result");
      if (typeof o.result === "object" && !(o.result instanceof Date)) throw new NotAKey("a formula that shows an error");
      return scalarKey(o.result);
    }
    if (o.error !== undefined) throw new NotAKey("an error");
    if (Array.isArray(o.richText)) return scalarKey(o.richText.map((p) => p.text ?? "").join(""));
    if (o.text !== undefined) return scalarKey(String(o.text));
    return scalarKey(cellText(cell));
  }
  return scalarKey(v);
}

/**
 * The same key with the differences a person would not call differences
 * removed: letter case, and a number written as text or with leading zeros.
 */
function looseKey(k: string): string {
  return k
    .split(SEP)
    .map((p) => {
      const t = p.toLowerCase();
      if (/^[+-]?\d+$/.test(t)) return t.replace(/^([+-]?)0+(?=\d)/, "$1");
      if (/^[+-]?\d+\.\d+$/.test(t)) return t.replace(/^([+-]?)0+(?=\d)/, "$1").replace(/\.?0+$/, "");
      if (/^\d{4}-\d{2}-\d{2}t00:00:00(\.0+)?z?$/.test(t)) return t.slice(0, 10);
      return t;
    })
    .join(SEP);
}

const shown = (k: string): string => k.split(SEP).join(" + ");

// --- Values ------------------------------------------------------------------

/** Coerce an arbitrary value to a valid exceljs cell value. A number that is not finite has no cell value. */
export function toCellValue(v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (v instanceof Date) return v;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  return String(v);
}

/**
 * Why a cell may not be written, or null. A merged cell shows one value over
 * several rows; a formula is the sheet's own arithmetic; a value already
 * there is somebody's data.
 */
function blocked(cell: ExcelJS.Cell, overwrite: boolean): string | null {
  if (cell.isMerged) return "merged";
  if (overwrite) return null;
  if (isFormula(cell)) return "a formula";
  if (!isEmptyValue(cell.value)) return "already filled";
  return null;
}

const FIRST_OF_FILLED_DOWN = "the first cell of a filled-down formula";

function refuseBlocked(problems: Array<{ address: string; why: string }>, what: string, filled?: string): void {
  if (problems.length === 0) return;
  const by = new Map<string, string[]>();
  for (const p of problems) by.set(p.why, [...(by.get(p.why) ?? []), p.address]);
  const parts = [...by.entries()].map(([why, a]) => `${a.length} ${why} (${a.slice(0, 5).join(", ")}${a.length > 5 ? ", …" : ""})`);
  const advice: string[] = [];
  if (by.has("merged")) advice.push("Merged cells cannot be filled row by row: build a new workbook that lists each key with its figures instead.");
  if (by.has("a formula")) advice.push('The formulas are the sheet\'s own calculations (totals, computed columns) and are almost never meant to be replaced: check that the right column is being filled. Only if the user asked for those formulas to be replaced, pass "overwrite": true.');
  if (by.has("already filled")) advice.push(filled ?? 'If the existing figures of these rows are to be replaced (a refresh), pass "overwrite": true.');
  if (by.has(FIRST_OF_FILLED_DOWN)) advice.push("That cell holds a formula which the cells below or beside it take theirs from, written in a way that cannot be carried over to them safely here (it names another sheet, a name, text in quotes or a whole column). Leave that column to the sheet's own formulas, or write every cell that shares the formula.");
  throw new DocOpError(`${what} would write over cells that are not free: ${parts.join("; ")}. Nothing was written. ${advice.join(" ")}`);
}

/** A column that is numbers in some rows and text in others adds up wrong in Excel without saying so. */
function refuseMixedTypes(rows: Record<string, unknown>[], columns: string[]): void {
  for (const c of columns) {
    let numbers = 0;
    let texts = 0;
    let example = "";
    for (const r of rows) {
      const v = r[c];
      if (typeof v === "number" || typeof v === "bigint") numbers++;
      else if (typeof v === "string" && v.trim() !== "") {
        texts++;
        example = example || v;
      }
    }
    if (numbers > 0 && texts > 0) {
      throw new DocOpError(`Data column "${c}" is a number in ${numbers} rows and text in ${texts} (for example ${JSON.stringify(example)}). Excel would leave the text out of any total. Make the column one type in the query. Nothing was written.`);
    }
  }
}

function requireColumns(rows: Record<string, unknown>[], columns: string[], what: string): void {
  if (rows.length === 0) throw new DocOpError(`${what}: the data has no rows. Nothing was written.`);
  const have = new Set(Object.keys(rows[0]));
  const missing = columns.filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new DocOpError(`${what}: the data has no column ${missing.map((m) => `"${m}"`).join(", ")}. Its columns are: ${[...have].map((h) => `"${h}"`).join(", ")}. Nothing was written.`);
  }
}

// --- fill_by_key -------------------------------------------------------------

/** What people write in a cell that has no figure yet. Not a heading. */
const PLACEHOLDER = /^(n\/?a|n\.a\.?|nil|none|null|tbd|tba|tbc|x|[-–—.?]+)$/i;

const isText = (v: unknown): boolean => typeof v === "string" || (typeof v === "object" && v !== null && "richText" in v);

/** The columns a table takes up on the sheet. */
type Span = { c1: number; c2: number };

/**
 * The columns a row is read across: from the first column the op names to
 * the last. Not the whole sheet row, where a list, a legend or another
 * table standing beside this one would make an empty row look filled; and
 * not further along the header row either, since such a list may stand
 * directly against the table with headings of its own.
 */
function headerSpan(cols: number[]): Span {
  return { c1: Math.min(...cols), c2: Math.max(...cols) };
}

/**
 * The same, taken as far as the header row's headings run unbroken: every
 * column that may belong to the table. Used where reading too much is the
 * safe mistake (is there a formula in the table's last row?), never to judge
 * whether a row is empty.
 */
function headerRun(ws: ExcelJS.Worksheet, headerRow: number, cols: number[]): Span {
  const row = ws.getRow(headerRow);
  const filled = (c: number) => c >= 1 && !isEmptyValue(row.getCell(c).value);
  let { c1, c2 } = headerSpan(cols);
  while (filled(c1 - 1)) c1--;
  while (filled(c2 + 1)) c2++;
  return { c1, c2 };
}

function eachCellIn(row: ExcelJS.Row, span: Span, f: (cell: ExcelJS.Cell) => void): void {
  row.eachCell({ includeEmpty: false }, (cell, c) => {
    if (c >= span.c1 && c <= span.c2) f(cell);
  });
}

/**
 * A row of headings, as far as a row can show it: under the columns that are
 * to receive figures, a word or a date ("RETURNED", "Q1", a month) and never a
 * figure, a formula or a placeholder such as "N/A"; and nothing else across
 * the table but words, dates and years. A cell that only shows a label merged
 * across the row (a section banner) says nothing either way.
 */
function looksLikeHeadings(row: ExcelJS.Row, figureCols: number[], span: Span): boolean {
  let headings = 0;
  for (const c of figureCols) {
    const cell = row.getCell(c);
    if (cell.isMerged && cell.master.address !== cell.address) continue;
    const v = cell.value as unknown;
    if (v instanceof Date) {
      headings++;
      continue;
    }
    if (!isText(v)) return false;
    const t = cellText(cell);
    if (PLACEHOLDER.test(t) || !/\p{L}/u.test(t)) return false;
    headings++;
  }
  if (headings === 0) return false;
  let words = 0;
  let other = false;
  eachCellIn(row, span, (cell) => {
    const v = cell.value as unknown;
    if (isEmptyValue(v)) return;
    if (isText(v) || v instanceof Date) words++;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2100) return;
    else other = true;
  });
  return !other && words >= 2;
}

/** A row with nothing in it across the table. */
function isBlankRow(row: ExcelJS.Row, span: Span): boolean {
  let any = false;
  eachCellIn(row, span, (cell) => {
    if (!isEmptyValue(cell.value)) any = true;
  });
  return !any;
}

/** The last row that holds anything across the table. */
function lastRowIn(ws: ExcelJS.Worksheet, span: Span): number {
  for (let r = lastValueRow(ws); r >= 1; r--) if (!isBlankRow(ws.getRow(r), span)) return r;
  return 0;
}

/** A row as a person would read it across the table, for a message: its first few cells. */
function rowAsRead(row: ExcelJS.Row, span: Span): string {
  const cells: string[] = [];
  eachCellIn(row, span, (cell) => void (cells.length < 8 && cellText(cell) && cells.push(`${cell.address} "${cellText(cell)}"`)));
  return cells.join(", ");
}

// --- Writing like the column ---------------------------------------------------
//
// Data arrives as it was fetched, and a date is always fetched as text.
// Written as it came, it would sit as text under a column of dates, and
// nothing that reads that column by date (a total for a month, the latest
// date) would count it. So the sheet's own cells say how a column's values
// are to be written.
//
// The decision is made once for a whole column, never value by value: a
// column that came out part numbers and part text would add up wrong without
// looking wrong. Where the data cannot all be written as the column holds
// its values, the op is refused with the column named.

/** "2026-11-04", or with a time of day and no zone: the day (and time) as written. */
function dateFromText(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?)?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60 && se < 60 ? date : null;
}

/** A number written out plainly: no leading zeros, no separators, no more digits than a number holds exactly. */
const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/** Does a number format show a date or a time? (The test the workbook library itself applies when it reads a cell.) */
function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt) return false;
  return /[ymdhMsb]+/.test(fmt.replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, ""));
}

interface ColumnFit {
  /** The value as this column is to hold it. */
  write: (v: ExcelJS.CellValue) => ExcelJS.CellValue;
  /** How the values were changed, if they were: "dates", "numbers", "digits kept as text". */
  as?: string;
  /** The column holds dates: the format its dates are shown in. */
  dateFormat?: string;
  holdsDates: boolean;
  /** The data's dates were left as text, the column giving no sign of holding real dates. */
  datesLeftAsText: boolean;
}

/**
 * How the values of one data column are to be written into one sheet
 * column. `evidence` are the sheet rows whose cells show what the column
 * holds; `into` are the cells about to be written; `values` what the data
 * gives for them.
 */
function fitColumn(what: string, header: string, ws: ExcelJS.Worksheet, col: number, evidence: number[], into: ExcelJS.Cell[], values: ExcelJS.CellValue[]): ColumnFit {
  let dates = 0;
  let numbers = 0;
  let digits = 0;
  let words = 0;
  let aDate: ExcelJS.Cell | undefined;
  for (const r of evidence) {
    const cell = ws.getRow(r).getCell(col);
    if (cell.isMerged || isFormula(cell)) continue;
    const v = cell.value as unknown;
    if (isEmptyValue(v)) continue;
    if (v instanceof Date) {
      dates++;
      aDate = aDate ?? cell;
    } else if (typeof v === "number") numbers++;
    else if (typeof v === "string" && PLACEHOLDER.test(v.trim())) continue;
    else if (typeof v === "string" && /^\d+$/.test(v.trim())) digits++;
    else words++;
  }
  const total = dates + numbers + digits + words;
  const given = values.filter((v) => v !== null && !(typeof v === "string" && v.trim() === ""));
  const texts = given.filter((v): v is string => typeof v === "string");
  const same: ColumnFit = { write: (v) => v, holdsDates: false, datesLeftAsText: false };
  if (given.length === 0) return { ...same, holdsDates: dates > 0 && dates >= 0.8 * total };
  const allDates = given.every((v) => v instanceof Date || (typeof v === "string" && dateFromText(v) !== null));

  // A column of dates (a stray word or figure in it changes nothing).
  if (dates > 0 && dates >= 0.8 * total) {
    const bad = given.find((v) => !(v instanceof Date) && !(typeof v === "string" && dateFromText(v) !== null));
    if (bad !== undefined) {
      throw new DocOpError(`${what}: the column "${header}" holds dates in the sheet (${aDate!.address}), and the data gives ${JSON.stringify(bad)} for it, which is not a date. Written as it is, it would not count as a date in anything that reads the column. Give dates as YYYY-MM-DD. Nothing was written.`);
    }
    return { write: (v) => (typeof v === "string" && v.trim() !== "" ? dateFromText(v) : v), as: texts.length > 0 ? "dates" : undefined, dateFormat: isDateFormat(aDate!.numFmt) ? aDate!.numFmt : undefined, holdsDates: true, datesLeftAsText: false };
  }
  // Dates for a column with nothing in it yet: the cells' own format says whether they are meant as dates.
  if (allDates && texts.length > 0) {
    const formatted = into.filter((c) => isDateFormat(c.numFmt)).length;
    if (total === 0 && into.length > 0 && formatted === into.length) return { write: (v) => (typeof v === "string" && v.trim() !== "" ? dateFromText(v) : v), as: "dates", holdsDates: true, datesLeftAsText: false };
    return { ...same, datesLeftAsText: true };
  }
  // A column of numbers: text that is a number is written as one; any other text is not for this column.
  if (numbers > 0 && numbers >= 0.8 * total && texts.length > 0) {
    const bad = texts.find((v) => !PLAIN_NUMBER.test(v.trim()) && !PLACEHOLDER.test(v.trim()));
    if (bad !== undefined) {
      throw new DocOpError(`${what}: the column "${header}" holds numbers in the sheet, and the data gives ${JSON.stringify(bad)} for it, which is text and not a plain number. Written as it is, it would be left out of every total. Give plain numbers (no separators, signs or leading zeros; a code that needs its zeros does not belong under a column of numbers). Nothing was written.`);
    }
    return { write: (v) => (typeof v === "string" && PLAIN_NUMBER.test(v.trim()) ? Number(v) : v), as: texts.some((v) => PLAIN_NUMBER.test(v.trim())) ? "numbers" : undefined, holdsDates: false, datesLeftAsText: false };
  }
  // A column of digits kept as text (a branch "103", a code "0222"), more
  // than one cell of it and nothing else: whole numbers are written as text
  // too, so that a lookup on the code still finds them. A figure with a
  // fraction or a minus sign is no code, and then nothing is changed.
  if (digits >= 2 && digits === total && texts.length === 0 && given.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) {
    return { write: (v) => (typeof v === "number" ? String(v) : v), as: "digits kept as text", holdsDates: false, datesLeftAsText: false };
  }
  return same;
}

/** A date is only a date in a cell whose format shows one: otherwise it is saved, and read back, as a bare number. */
function writeDate(cell: ExcelJS.Cell, value: Date, format: string | undefined): void {
  // The style is set on this cell alone: cells loaded from one file share their style object.
  if (!isDateFormat(cell.numFmt)) cell.style = { ...cell.style, numFmt: format ?? "yyyy-mm-dd" };
  cell.value = value;
}

export function fillByKey(ws: ExcelJS.Worksheet, a: FillByKeyArgs): { report: OpReport; written: Written; released: string[] } {
  const keys = Array.isArray(a.key) ? a.key : [a.key];
  const targets = Object.entries(a.set ?? {});
  if (keys.length === 0 || keys.some((k) => typeof k?.sheet !== "string" || typeof k?.data !== "string" || !k.sheet.trim() || !k.data.trim())) {
    throw new DocOpError('fill_by_key needs "key": { "sheet": <header in the sheet>, "data": <column in the data> }, both as text. Nothing was written.');
  }
  if (targets.length === 0 || targets.some(([h, d]) => !h.trim() || typeof d !== "string" || !d.trim())) {
    throw new DocOpError('fill_by_key needs "set": { <header in the sheet>: <column in the data>, … }, each a column name as text. Nothing was written.');
  }
  const unmatched = a.unmatched ?? "leave";
  if (!["leave", "zero"].includes(unmatched)) throw new DocOpError('"unmatched" is "leave" or "zero". Nothing was written.');
  const sharedKeys = a.sharedKeys ?? "refuse";
  if (!["refuse", "fill_each"].includes(sharedKeys)) throw new DocOpError('"sharedKeys" is "refuse" or "fill_each". Nothing was written.');
  const overwrite = a.overwrite === true;

  const keyHeaders = keys.map((k) => k.sheet);
  const targetHeaders = targets.map(([h]) => h);
  const clash = targetHeaders.filter((h) => keyHeaders.map(headerKey).includes(headerKey(h)));
  if (clash.length > 0) throw new DocOpError(`"${clash[0]}" is named both as the key and as a column to fill.`);
  requireColumns(a.rows, [...keys.map((k) => k.data), ...targets.map(([, d]) => d)], "fill_by_key");
  refuseMixedTypes(a.rows, targets.map(([, d]) => d));

  const header = findHeaderRow(ws, [...keyHeaders, ...targetHeaders], a.headerRow);
  const keyCols = keyHeaders.map((h) => header.cols.get(h)!);
  const targetCols = targetHeaders.map((h) => header.cols.get(h)!);
  // Two names for one column (a header and its letter, or a letter that is
  // the key column) would have one value written over the other, or the keys
  // themselves written over.
  const namedBy = new Map<number, string>();
  [...keyHeaders, ...targetHeaders].forEach((h, i) => {
    const c = [...keyCols, ...targetCols][i];
    const other = namedBy.get(c);
    if (other !== undefined) {
      const isKey = keyHeaders.includes(other);
      throw new DocOpError(`"${other}" and "${h}" are the same column of sheet "${ws.name}" (${numToCol(c)})${isKey ? ", and it holds the keys" : ""}. Name each column once. Nothing was written.`);
    }
    namedBy.set(c, h);
  });

  // The data, by key. Two data rows with one key would make the value a coin toss.
  const data = new Map<string, Record<string, unknown>>();
  const repeated = new Set<string>();
  for (let i = 0; i < a.rows.length; i++) {
    let parts: Array<string | null>;
    try {
      parts = keys.map((k) => scalarKey(a.rows[i][k.data]));
    } catch (e) {
      if (!(e instanceof NotAKey)) throw e;
      throw new DocOpError(`Data row ${i + 1} has a key that is ${e.message}, which cannot be matched. Make the key column text or whole numbers in the query. Nothing was written.`);
    }
    if (parts.some((p) => p === null)) continue;
    const id = parts.join(SEP);
    if (data.has(id)) repeated.add(id);
    else data.set(id, a.rows[i]);
  }
  if (repeated.size > 0) {
    throw new DocOpError(`The data has more than one row for ${repeated.size} key${repeated.size === 1 ? "" : "s"} (${[...repeated].slice(0, 5).map((k) => `"${shown(k)}"`).join(", ")}${repeated.size > 5 ? ", …" : ""}). Which row's figures belong in the sheet cannot be told: make the query return one row per key. Nothing was written.`);
  }
  if (data.size === 0) throw new DocOpError("No data row has a key. Nothing was written.");

  // The sheet's rows, by their own keys. A row whose key cell cannot be read
  // as a key (a merged section heading, a formula with no result) is passed
  // over and counted, not a reason to refuse every other row.
  const sheetRows: Array<{ row: number; id: string }> = [];
  const unreadable: string[] = [];
  let partial = 0;
  let headerRowsPassed = 0;
  let stoppedAtRow: number | undefined;
  let stoppedBecause: string | undefined;
  let stoppedOnALikeness = false;
  const sheetEnd = lastValueRow(ws);
  // A header merged over two rows (the key above a row of "Qty", "Amount")
  // ends where its merged cell ends: the rows of the table begin below that.
  const first = Math.max(...[...keyCols, ...targetCols].map((c) => mergedBottom(ws, header.row, c))) + 1;
  if (a.lastRow !== undefined && (!Number.isInteger(a.lastRow) || a.lastRow < first)) {
    throw new DocOpError(`"lastRow" is the number of the last sheet row of the table (got ${JSON.stringify(a.lastRow)}; the headers are on row ${header.row}). Nothing was written.`);
  }
  const end = Math.min(sheetEnd, a.lastRow ?? sheetEnd);
  const dataLoose = new Set([...data.keys()].map(looseKey));
  const knows = (k: string) => data.has(k) || dataLoose.has(looseKey(k));
  // The headings as the sheet has them on the header row, whether a column was named by them or by its letter.
  const keyHeadings = keyCols.map((c) => headerKey(cellText(ws.getRow(header.row).getCell(c))));
  const ownHeadings = targetCols.map((c) => headerKey(cellText(ws.getRow(header.row).getCell(c))));
  // The columns that are to receive figures: a column of numbers in the data,
  // or any column when rows without data are to be given 0.
  const figureCols = targetCols.filter((_, t) => unmatched === "zero" || a.rows.some((r) => typeof r[targets[t][1]] === "number" || typeof r[targets[t][1]] === "bigint"));
  const span = headerSpan([...keyCols, ...targetCols]);
  // The row said to hold the headers must not be a row of the table itself.
  if (a.headerRow !== undefined) {
    const own = keyCols.map((c) => cellText(ws.getRow(header.row).getCell(c))).join(SEP);
    if (keyCols.every((c) => cellText(ws.getRow(header.row).getCell(c)) !== "") && knows(own)) {
      throw new DocOpError(`Row ${header.row} of sheet "${ws.name}" holds a key the data has ("${shown(own)}"): it is a row of the table, not the row of its headers. Give "headerRow" as the row the headers are on. Nothing was written.`);
    }
  }
  const targetsAgain = (row: ExcelJS.Row) => ownHeadings.some((h) => h !== "") && targetCols.every((c, t) => ownHeadings[t] === "" || headerKey(cellText(row.getCell(c))) === ownHeadings[t]);
  // Where a table ends cannot be read off a sheet with certainty. Three
  // things are taken as signs of it; none is acted on silently when the
  // data's own keys lie beyond (see below the loop):
  //   the key heading again                       another table, for certain
  //   a row that looks like headings              probably one
  //   an empty row, then a row the data has no    a gap, then something that
  //   key for                                     is not plainly this table
  // A caller that says where the table ends ("lastRow") is taken at its word,
  // except where a row inside is plainly another table's header.
  const keyHeadingAgain = (row: ExcelJS.Row) => keyHeadings.some((h) => h !== "") && keyCols.every((c, i) => headerKey(cellText(row.getCell(c))) === keyHeadings[i]);
  // From a row that may or may not end the table: is there anything from
  // there down, before the key heading comes again, that the answer would
  // change? Keys of the data (rows that would be filled, or must not be);
  // or, when rows without data are to get 0, any row with a key at all.
  let nothingAheadThrough = 0;
  const whatTheAnswerChanges = (from: number): string | null => {
    if (from <= nothingAheadThrough) return null;
    const keys = new Set<string>();
    let keyed = 0;
    let r = from;
    for (; r <= sheetEnd; r++) {
      const row = ws.getRow(r);
      if (r > from && keyHeadingAgain(row)) break;
      let parts: Array<string | null>;
      try {
        parts = keyCols.map((c) => sheetKey(row.getCell(c)));
      } catch {
        continue;
      }
      if (parts.some((p) => p === null)) continue;
      keyed++;
      if (knows(parts.join(SEP))) keys.add(shown(parts.join(SEP)));
    }
    if (keys.size > 0) return `${keys.size} of the data's keys are found from there down (for example ${[...keys].slice(0, 3).map((k) => `"${k}"`).join(", ")})`;
    if (unmatched === "zero" && keyed > 0) return `${keyed} row${keyed === 1 ? "" : "s"} with a key lie from there down, which would or would not be given 0`;
    nothingAheadThrough = r - 1;
    return null;
  };
  // Guessing either way gives a workbook that is wrong without looking wrong,
  // so nothing is written and the caller, who can look at the sheet, says
  // where the table ends.
  // Every row from there down that may begin something else, with its
  // number: the caller cannot see row numbers or empty rows any other way.
  const doubtfulFrom = (from: number): string[] => {
    const out: string[] = [];
    let blank = false;
    for (let r = from; r <= sheetEnd && out.length < 8; r++) {
      const row = ws.getRow(r);
      if (isBlankRow(row, span)) {
        blank = true;
        continue;
      }
      const gap = blank;
      blank = false;
      if (r > from && keyHeadingAgain(row)) {
        out.push(`row ${r} (${rowAsRead(row, span)}), the key heading again`);
        continue;
      }
      let known = false;
      try {
        const parts = keyCols.map((c) => sheetKey(row.getCell(c)));
        known = parts.every((p) => p !== null) && knows(parts.join(SEP));
      } catch {
        known = false;
      }
      if (known) continue;
      const headings = targetsAgain(row) || looksLikeHeadings(row, figureCols, span);
      if (r === from || headings || gap) out.push(`row ${r} (${rowAsRead(row, span) || "no text"}), which ${headings ? "reads like column headings" : "follows an empty row and has no key the data has"}`);
    }
    return out;
  };
  const ask = (r: number, why: string, what: string) =>
    new DocOpError(
      `Where the table under row ${header.row} of sheet "${ws.name}" ends cannot be told from the sheet. Row ${r} (${rowAsRead(ws.getRow(r), span) || "no text"}) has ${why}, and ${what}. Nothing was written. ` +
        `From there down, each of these rows may begin something else, or be only a label or an item the data has no row for: ${doubtfulFrom(r).join("; ")}. ` +
        `Send the same op with "lastRow": the row just above the first of them that does begin something else. That is ` +
        `${r - 1} if another table, a note or a footer begins at row ${r} (that table is filled with an op of its own, by "headerRow"); ` +
        `or the number of this table's real last row, if row ${r} is only a label or an item the data has no row for and the table goes on. ` +
        `The sheet's last row with anything in it is ${sheetEnd}: that is the answer only if every row down to it belongs to this one table.`,
    );
  const headingsInside: number[] = [];
  let afterBlank = false;
  for (let r = first; r <= end; r++) {
    const row = ws.getRow(r);
    if (isBlankRow(row, span)) {
      afterBlank = true;
      continue;
    }
    const gap = afterBlank;
    afterBlank = false;
    if (keyHeadingAgain(row)) {
      const whole = targetsAgain(row);
      if (a.lastRow !== undefined) {
        // The whole header printed again inside the table (one per page) is passed over.
        if (whole) {
          headerRowsPassed++;
          continue;
        }
        throw new DocOpError(
          `Row ${r} of sheet "${ws.name}" holds the key heading again over other column headings (${rowAsRead(row, span)}): another table begins there, inside the rows said to be one table ("lastRow": ${a.lastRow}). ` +
            `Nothing was written. Give "lastRow": ${r - 1} for the table under row ${header.row}, and fill the table that begins at row ${r} with an op of its own ("headerRow": ${r}, its own headers).`,
        );
      }
      stoppedAtRow = r;
      stoppedBecause = whole ? "the same headers again" : "the key heading again, over other column headings";
      break;
    }
    let parts: Array<string | null> | null = null;
    let notAKey = "";
    try {
      parts = keyCols.map((c) => sheetKey(row.getCell(c)));
    } catch (e) {
      if (!(e instanceof NotAKey)) throw e;
      notAKey = e.message;
    }
    const whole = parts !== null && parts.every((p) => p !== null);
    const known = whole && knows(parts!.join(SEP));
    if (!known) {
      const ownAgain = targetsAgain(row);
      // Before the table's first row, headings with nothing in the key column
      // are the second line of this table's own headings (a month above
      // "Qty" and "Amount"); with a word in the key column they are not.
      const keyCellFilled = keyCols.some((c) => !isEmptyValue(row.getCell(c).value));
      const headings = (ownAgain || looksLikeHeadings(row, figureCols, span)) && (sheetRows.length > 0 || keyCellFilled);
      if (a.lastRow !== undefined) {
        // Taken at the caller's word as a row of the table; said in the report, so that it can be looked at again.
        if (headings && !ownAgain) headingsInside.push(r);
        if (ownAgain && keyCellFilled) {
          throw new DocOpError(
            `Row ${r} of sheet "${ws.name}" holds this table's column headings again under another key heading (${rowAsRead(row, span)}): another table begins there, inside the rows said to be one table ("lastRow": ${a.lastRow}). ` +
              `Nothing was written. Give "lastRow": ${r - 1} for the table under row ${header.row}, and fill the table that begins at row ${r} with an op of its own ("headerRow": ${r}, its own headers).`,
          );
        }
      } else if (headings || gap) {
        const why = headings ? (ownAgain ? "this table's column headings again, under another key heading" : "what reads like column headings") : "an empty row above it, and no key the data has";
        const what = whatTheAnswerChanges(r);
        if (what) throw ask(r, why, what);
        // Nothing beyond it that the answer would change. After a gap the
        // reading goes on (rows the data has nothing for are left as they
        // are, whichever table they belong to); at what reads like another
        // table's headings it ends, and says so.
        if (headings) {
          stoppedAtRow = r;
          stoppedBecause = why;
          stoppedOnALikeness = true;
          break;
        }
      }
    }
    if (parts === null) {
      unreadable.push(`row ${r} (${notAKey})`);
      continue;
    }
    if (parts.every((p) => p === null)) continue; // a totals row with no key, a note
    if (!whole) {
      partial++;
      continue;
    }
    sheetRows.push({ row: r, id: parts.join(SEP) });
  }
  // Keys of the data beyond where the reading ended: they are in the sheet, not among the rows read.
  const lastRead = stoppedAtRow !== undefined ? stoppedAtRow - 1 : end;
  const below = new Set<string>();
  for (let r = stoppedAtRow ?? end + 1; r <= sheetEnd; r++) {
    let parts: Array<string | null>;
    try {
      parts = keyCols.map((c) => sheetKey(ws.getRow(r).getCell(c)));
    } catch {
      continue;
    }
    if (parts.some((p) => p === null)) continue;
    if (knows(parts.join(SEP))) below.add(shown(parts.join(SEP)));
  }
  if (sheetRows.length === 0) {
    const formulas = unreadable.some((u) => /formula with no stored result/.test(u));
    throw new DocOpError(
      `Sheet "${ws.name}" has no rows with a readable key under ${keyHeaders.map((h) => `"${h}"`).join(" + ")} in rows ${first}–${lastRead}${unreadable.length > 0 ? ` (${unreadable.slice(0, 3).join("; ")})` : ""}. Nothing was written.` +
        (formulas
          ? " The keys in this workbook are formulas, and a workbook this tool has already written does not store their results (they are worked out when it is opened in Excel). Fill the file the user originally gave instead of an earlier filled copy, or use another column that holds plain values as the key."
          : stoppedAtRow !== undefined
            ? stoppedOnALikeness
              ? ` Row ${stoppedAtRow} has ${stoppedBecause}, and the rows were read no further; if the table's rows are below it, say where the table ends with "lastRow".`
              : ` Row ${stoppedAtRow} has ${stoppedBecause}, so the table under row ${header.row} has no rows; if the table meant begins at row ${stoppedAtRow}, pass "headerRow": ${stoppedAtRow} with the headers as they are written there.`
            : ' Use a column that holds a plain value in each row as the key; if the table is somewhere else on the sheet, say which row holds its headers with "headerRow".'),
    );
  }

  const sheetIds = new Map<string, number[]>();
  for (const s of sheetRows) sheetIds.set(s.id, [...(sheetIds.get(s.id) ?? []), s.row]);
  // A key on several rows is in doubt only when the data has figures for it: which row are they for?
  const shared = [...sheetIds.entries()].filter(([id, rows]) => rows.length > 1 && knows(id));
  if (shared.length > 0 && sharedKeys !== "fill_each") {
    throw new DocOpError(
      `${shared.length} key${shared.length === 1 ? " appears" : "s appear"} on more than one row of sheet "${ws.name}" (${shared.slice(0, 4).map(([k, rows]) => `"${shown(k)}" on rows ${rows.slice(0, 4).join(", ")}`).join("; ")}${shared.length > 4 ? "; …" : ""}). ` +
        `If those rows belong to different groups (the same item under two stores, two sections), the key needs the column that tells them apart: give "key" as a list of two columns. ` +
        `If they are two tables one below the other, fill each on its own: "headerRow" is the row its headers are on and "lastRow" its last row. ` +
        `Only if it is one thing listed twice and each row should get the same figures, pass "sharedKeys": "fill_each". Nothing was written.`,
    );
  }

  // Exact first. What is left may match once leading zeros, case and
  // number-versus-text are ignored, but only where that is one-to-one on both
  // sides; otherwise two different items would be taken for one.
  const match = new Map<number, Record<string, unknown>>();
  const usedData = new Set<string>();
  for (const s of sheetRows) {
    const d = data.get(s.id);
    if (d) {
      match.set(s.row, d);
      usedData.add(s.id);
    }
  }
  const loosely: Array<{ sheet: string; data: string }> = [];
  if (match.size < sheetRows.length) {
    const looseData = new Map<string, Set<string>>();
    for (const id of data.keys()) looseData.set(looseKey(id), new Set([...(looseData.get(looseKey(id)) ?? []), id]));
    const looseSheet = new Map<string, Set<string>>();
    for (const s of sheetRows) looseSheet.set(looseKey(s.id), new Set([...(looseSheet.get(looseKey(s.id)) ?? []), s.id]));
    for (const s of sheetRows) {
      if (match.has(s.row)) continue;
      const lk = looseKey(s.id);
      const candidates = looseData.get(lk);
      if (!candidates || candidates.size !== 1 || looseSheet.get(lk)!.size !== 1) continue;
      const id = [...candidates][0];
      match.set(s.row, data.get(id)!);
      usedData.add(id);
      loosely.push({ sheet: shown(s.id), data: shown(id) });
    }
  }
  if (match.size === 0) {
    throw new DocOpError(
      `No row of sheet "${ws.name}" in rows ${first}–${lastRead} has a key found in the data. Sheet keys look like ${sheetRows.slice(0, 5).map((s) => `"${shown(s.id)}"`).join(", ")}; data keys look like ${[...data.keys()].slice(0, 5).map((k) => `"${shown(k)}"`).join(", ")}.` +
        (stoppedAtRow === undefined
          ? ""
          : stoppedOnALikeness
            ? ` The rows were read down to row ${lastRead} only: row ${stoppedAtRow} has ${stoppedBecause}. If the table goes on below it, say where it ends with "lastRow".`
            : ` The rows were read down to row ${lastRead} only: row ${stoppedAtRow} has ${stoppedBecause}${below.size > 0 ? `, and ${below.size} of the data's keys are found below it` : ""}. To fill the table that begins there, pass "headerRow": ${stoppedAtRow} with the headers as they are written on that row.`) +
        " Nothing was written.",
    );
  }

  // Everything is checked before anything is written.
  const plan: Array<{ cell: ExcelJS.Cell; value: ExcelJS.CellValue; dateFormat?: string }> = [];
  const problems: Array<{ address: string; why: string }> = [];
  let emptyValuesLeft = 0;
  let unmatchedCellsSet = 0;
  let formulasKept = 0;
  let unmatchedValuesKept = 0;
  const keptKeys = new Set<string>();
  const keptRows = new Set<number>();
  const staleIfLeft: Array<{ address: string; key: string; column: string }> = [];
  // What each column to fill already holds, read from the table's own rows.
  const tableRows = sheetRows.map((s) => s.row);
  const fits = targets.map(([h, d], t) =>
    fitColumn(
      "fill_by_key",
      h,
      ws,
      targetCols[t],
      tableRows,
      [...match.keys()].map((r) => ws.getRow(r).getCell(targetCols[t])),
      [...match.values()].map((row) => toCellValue(row[d])),
    ),
  );
  for (const s of sheetRows) {
    const d = match.get(s.row);
    const row = ws.getRow(s.row);
    for (let t = 0; t < targets.length; t++) {
      const cell = row.getCell(targetCols[t]);
      if (d) {
        const value = fits[t].write(toCellValue(d[targets[t][1]]));
        if (value === null) {
          // In a refresh, no value in the data against a figure in the sheet
          // would leave last period's figure standing as if it were this one's.
          if (overwrite && !isFormula(cell) && !cell.isMerged && !isEmptyValue(cell.value)) staleIfLeft.push({ address: cell.address, key: shown(s.id), column: targetHeaders[t] });
          emptyValuesLeft++;
          continue;
        }
        const why = blocked(cell, overwrite);
        if (why) problems.push({ address: cell.address, why });
        else plan.push({ cell, value, dateFormat: fits[t].dateFormat });
        continue;
      }
      // A row with a key and no data may be an item that sold nothing, or
      // the sheet's own total or a heading, written in the key column.
      // Nothing can tell which. So what such a row already holds is never
      // written over, a formula or a figure, whatever "overwrite" says (that
      // is about the rows the data has): it is kept and reported, and a
      // caller who wants an item's old figure to become 0 says so by giving
      // that item a row in the data.
      if (isFormula(cell)) {
        formulasKept++;
        continue;
      }
      if (cell.isMerged) continue;
      if (!isEmptyValue(cell.value)) {
        unmatchedValuesKept++;
        keptKeys.add(shown(s.id));
        keptRows.add(s.row);
        continue;
      }
      // A 0 is a figure: it does not go under a column of dates.
      if (unmatched === "zero" && !fits[t].holdsDates) {
        plan.push({ cell, value: 0 });
        unmatchedCellsSet++;
      }
    }
  }
  if (staleIfLeft.length > 0) {
    throw new DocOpError(
      `fill_by_key with "overwrite": the data has no value (NULL) for ${staleIfLeft.length} cell${staleIfLeft.length === 1 ? "" : "s"} that hold a figure now (for example ${staleIfLeft.slice(0, 4).map((x) => `${x.address}, "${x.column}" of "${x.key}"`).join("; ")}). ` +
        `They would keep the figure they hold, which in a refresh is the earlier period's. Nothing was written. ` +
        `Make the query give a value for them (COALESCE(x, 0) when no rows means 0), or leave those rows out of the data if they are to stay as they are.`,
    );
  }
  const planned = new Set(plan.map((p) => p.cell.address));
  problems.push(...sharedFormulaProblems(ws, planned));
  refuseBlocked(problems, "fill_by_key");

  const released = releaseSharedFormulas(ws, planned);
  const written: Written = new Map();
  for (const p of plan) {
    if (p.value instanceof Date) writeDate(p.cell, p.value, p.dateFormat);
    else p.cell.value = p.value;
    written.set(p.cell.address, p.value);
  }
  const writtenAs: Record<string, string> = {};
  targetHeaders.forEach((h, t) => void (fits[t].as && (writtenAs[h] = fits[t].as!)));
  const datesAsText = targetHeaders.filter((_, t) => fits[t].datesLeftAsText);

  const without = sheetRows.filter((s) => !match.has(s.row));
  const unusedData = [...data.keys()].filter((id) => !usedData.has(id));
  const rowsTouched = new Set(plan.map((p) => Number(p.cell.row)));
  const report: OpReport = {
    op: "fill_by_key",
    sheet: ws.name,
    headerRow: header.row,
    firstRow: first,
    lastRow: lastRead,
    keyColumns: Object.fromEntries(keyHeaders.map((h, i) => [h, numToCol(keyCols[i])])),
    targetColumns: Object.fromEntries(targetHeaders.map((h, i) => [h, numToCol(targetCols[i])])),
    sheetRowsWithKey: sheetRows.length,
    matched: match.size,
    ...(loosely.length > 0 ? { matchedLoosely: loosely.length, looselyMatchedKeys: loosely.slice(0, SAMPLE) } : {}),
    sheetRowsWithoutData: without.length,
    ...(without.length > 0 ? { sheetKeysWithoutData: without.slice(0, SAMPLE).map((s) => shown(s.id)), unmatched, ...(unmatched !== "leave" ? { unmatchedCellsSet } : {}) } : {}),
    ...(formulasKept > 0 ? { formulasKept } : {}),
    ...(unmatchedValuesKept > 0 ? { unmatchedValuesKept, rowsThatKeptTheirValues: keptRows.size, keysThatKeptTheirValues: [...keptKeys].slice(0, KEPT_SAMPLE) } : {}),
    dataRowsNotInSheet: unusedData.length,
    ...(unusedData.length > 0 ? { dataKeysNotInSheet: unusedData.slice(0, SAMPLE).map(shown) } : {}),
    sheetRowsSharingAKey: shared.reduce((x, [, rows]) => x + rows.length, 0),
    ...(unreadable.length > 0 ? { rowsWithUnreadableKey: unreadable.length, unreadableKeys: unreadable.slice(0, SAMPLE) } : {}),
    ...(partial > 0 ? { rowsWithPartialKey: partial } : {}),
    ...(stoppedAtRow !== undefined ? { stoppedAtRow, stoppedBecause, dataKeysBelowStop: below.size } : below.size > 0 ? { dataKeysBelowLastRow: below.size } : {}),
    ...(headerRowsPassed > 0 ? { headerRowsPassed } : {}),
    ...(headingsInside.length > 0 ? { rowsThatReadLikeHeadings: headingsInside.slice(0, SAMPLE) } : {}),
    ...(Object.keys(writtenAs).length > 0 ? { writtenAs } : {}),
    ...(datesAsText.length > 0 ? { datesAsText } : {}),
    ...(emptyValuesLeft > 0 ? { emptyValuesLeft } : {}),
    rowsWritten: rowsTouched.size,
    cellsWritten: plan.length,
    firstRows: sheetRows.slice(0, 3).map((s) => {
      const row = ws.getRow(s.row);
      return {
        row: s.row,
        ...Object.fromEntries(keyHeaders.map((h, i) => [h, cellText(row.getCell(keyCols[i]))])),
        ...Object.fromEntries(targetHeaders.map((h, i) => [h, row.getCell(targetCols[i]).value as unknown])),
      };
    }),
  };
  return { report, written, released };
}

// --- append_rows -------------------------------------------------------------

/**
 * Rows added after the sheet's content, each value under the header of its
 * own name. Whatever adds the existing rows up (a total, a named range, an
 * Excel table) and would not take the new rows in makes the sheet wrong
 * without looking wrong, so that is refused. What can be seen is seen: a
 * range written out in a formula on any sheet, a name, a table. A total
 * written as B2+B3+B4, or reached through OFFSET or INDIRECT, cannot be.
 */
export function appendByHeader(ws: ExcelJS.Worksheet, rows: Record<string, unknown>[]): { report: OpReport; written: Written } {
  requireColumns(rows, [], "append_rows");
  const names = Object.keys(rows[0]);
  const ragged = rows.findIndex((r) => Object.keys(r).some((k) => !names.includes(k)));
  if (ragged >= 0) throw new DocOpError(`append_rows: data row ${ragged + 1} has columns the first row does not; every row must have the same columns. Nothing was written.`);
  refuseMixedTypes(rows, names);
  const header = findHeaderRow(ws, names);
  // The table's own last row: a list standing beside the table may run further down.
  const span = headerSpan(names.map((n) => header.cols.get(n)!));
  const end = Math.max(lastRowIn(ws, span), header.row);
  const NEW_WORKBOOK = "Build a new workbook from the full data instead.";
  const inLastRow: string[] = [];
  // A column the table works out belongs to it whether or not the op names it.
  if (end > header.row) eachCellIn(ws.getRow(end), headerRun(ws, header.row, names.map((n) => header.cols.get(n)!)), (cell) => void (isFormula(cell) && inLastRow.push(cell.address)));
  if (inLastRow.length > 0) {
    throw new DocOpError(
      `The last row of sheet "${ws.name}" that holds anything (row ${end}) has formulas (${inLastRow.slice(0, 4).join(", ")}${inLastRow.length > 4 ? ", …" : ""}). Either it is the sheet's totals, which rows added below would be left out of, or every row works a column out with a formula, which rows added here would not have. Nothing was added. ${NEW_WORKBOOK}`,
    );
  }
  const cols0 = names.map((n) => header.cols.get(n)!);
  // Rows are added after the last thing on the sheet. That is the foot of the
  // table only when the table plainly runs from its headers to there: no
  // empty row in between (what follows one may be another table, a note, a
  // footer), and a last row that looks like a row of the table.
  for (let r = header.row + 1; r < end; r++) {
    if (isBlankRow(ws.getRow(r), span)) {
      throw new DocOpError(
        `Sheet "${ws.name}" has an empty row (row ${r}) between its headers (row ${header.row}) and the last row that holds anything (row ${end}: ${rowAsRead(ws.getRow(end), span) || "no text"}). What lies below an empty row may be another table, a note or a footer, and rows added at the end of the sheet would go under that instead of at the foot of the table. Nothing was added. ${NEW_WORKBOOK}`,
      );
    }
  }
  if (end > header.row && cols0.length > 1 && cols0.filter((c) => !isEmptyValue(ws.getRow(end).getCell(c).value)).length <= 1) {
    throw new DocOpError(
      `The last row of sheet "${ws.name}" that holds anything (row ${end}: ${rowAsRead(ws.getRow(end), span) || "no text"}) has a value under at most one of the headers being filled: it reads like a note or a footer below the table, not like its last row, and rows added below it would not be at the foot of the table. Nothing was added. ${NEW_WORKBOOK}`,
    );
  }
  const lastNew = end + rows.length;
  // Over these columns, over rows already there, and ending before the last row to be added.
  const short = (g: Box) => cols0.some((c) => c >= g.c1 && c <= g.c2) && g.r2 > header.row && g.r1 <= end && g.r2 < lastNew;
  const wb = ws.workbook;
  for (const sheet of wb?.worksheets ?? [ws]) {
    let found: string | undefined;
    sheet.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (found || !isFormula(cell)) return;
        const text = formulaText(cell);
        for (const g of rangesOn(text, ws.name, sheet === ws)) {
          // A range of one row adds up no rows: it works one row out (=SUM(B2:C2)).
          if (g.r1 === g.r2) continue;
          if (short(g)) found = `${sheet === ws ? "" : `${sheet.name}!`}${cell.address} (=${text})`;
        }
      }),
    );
    if (found) {
      throw new DocOpError(`A formula over the rows already on sheet "${ws.name}" would not take in the rows to be added: ${found}. Appended rows would be left out of it, so nothing was added. ${NEW_WORKBOOK}`);
    }
  }
  const namesModel = (wb?.definedNames as unknown as { model?: Array<{ name?: string; ranges?: string[] }> } | undefined)?.model ?? [];
  for (const n of namesModel) {
    if (/^_xlnm\./i.test(String(n.name))) continue; // print areas and filters, which Excel keeps itself
    for (const range of n.ranges ?? []) {
      if (rangesOn(String(range), ws.name, false).some(short)) {
        throw new DocOpError(`The name "${String(n.name)}" (${String(range)}) covers the rows already on sheet "${ws.name}" and would not take in the rows to be added: whatever uses it would leave them out. Nothing was added. ${NEW_WORKBOOK}`);
      }
    }
  }
  const tables = Object.values((ws as unknown as { tables?: Record<string, { model?: { name?: string; tableRef?: string; ref?: string } }> }).tables ?? {});
  for (const t of tables) {
    const ref = String(t?.model?.tableRef ?? t?.model?.ref ?? "");
    const g = rangesOn(`'${ws.name.replace(/'/g, "''")}'!${ref}`, ws.name, false)[0];
    if (g && short(g)) {
      throw new DocOpError(`The rows of sheet "${ws.name}" are an Excel table ("${String(t?.model?.name ?? "")}", ${ref}). Rows added below it here would not be part of the table, and its totals and whatever reads the table would leave them out. Nothing was added. ${NEW_WORKBOOK}`);
    }
  }
  // What each column already holds, read from the rows nearest the foot of the table.
  const above = Array.from({ length: end - header.row }, (_, i) => end - i);
  const fits = new Map(
    names.map((n) => {
      const col = header.cols.get(n)!;
      const into = rows.map((_, i) => ws.getRow(end + 1 + i).getCell(col));
      return [n, fitColumn("append_rows", n, ws, col, above, into, rows.map((r) => toCellValue(r[n])))] as const;
    }),
  );
  const written: Written = new Map();
  rows.forEach((r, i) => {
    const row = ws.getRow(end + 1 + i);
    for (const n of names) {
      const fit = fits.get(n)!;
      const value = fit.write(toCellValue(r[n]));
      if (value === null) continue;
      const cell = row.getCell(header.cols.get(n)!);
      if (value instanceof Date) writeDate(cell, value, fit.dateFormat);
      else cell.value = value;
      written.set(cell.address, value);
    }
  });
  const writtenAs: Record<string, string> = {};
  for (const n of names) if (fits.get(n)!.as) writtenAs[n] = fits.get(n)!.as!;
  const datesAsText = names.filter((n) => fits.get(n)!.datesLeftAsText);
  const cols = names.map((n) => header.cols.get(n)!);
  // A filter or a print area is set to a range; the rows added lie below it.
  const doesNotCover: string[] = [];
  if (ws.autoFilter) doesNotCover.push("the sheet's filter");
  if (ws.pageSetup?.printArea) doesNotCover.push("the sheet's print area");
  return {
    report: {
      op: "append_rows",
      sheet: ws.name,
      headerRow: header.row,
      targetColumns: Object.fromEntries(names.map((n) => [n, numToCol(header.cols.get(n)!)])),
      range: `${addr(Math.min(...cols), end + 1)}:${addr(Math.max(...cols), end + rows.length)}`,
      rowsWritten: rows.length,
      cellsWritten: written.size,
      ...(Object.keys(writtenAs).length > 0 ? { writtenAs } : {}),
      ...(datesAsText.length > 0 ? { datesAsText } : {}),
      ...(doesNotCover.length > 0 ? { doesNotCover } : {}),
    },
    written,
  };
}

// --- populate_sheet ----------------------------------------------------------

/**
 * Values written as a block from one cell: for the empty data area of a
 * template. Position is all that ties a value to its place here, so the block
 * may not sit beside anything it could be misaligned with: if the rows it
 * covers already hold values in another column, those rows have an identity
 * of their own and fill_by_key is the op that respects it. A formula beside
 * the block is the template working the row out from what is filled in, and
 * gives the row no identity.
 */
export function populateBlock(
  ws: ExcelJS.Worksheet,
  a: { startCell?: string; columns?: string[]; overwrite?: boolean; rows: Record<string, unknown>[] },
): { report: OpReport; written: Written; released: string[] } {
  const { col: c0, row: r0 } = parseSingleCell(a.startCell, 'populate_sheet "startCell"');
  if (a.rows.length === 0) throw new DocOpError("populate_sheet: the data has no rows. Nothing was written.");
  const first = Object.keys(a.rows[0]);
  // JavaScript lists keys that are whole numbers ("2025") before the others
  // whatever order the query gave them, so a result with such a column has no
  // column order to rely on.
  const names = a.columns && a.columns.length > 0 ? a.columns : first;
  if (!a.columns?.length && first.some((k) => /^\d+$/.test(k))) {
    throw new DocOpError(`populate_sheet: the data has a column named with a number (${first.filter((k) => /^\d+$/.test(k)).map((k) => `"${k}"`).join(", ")}), and such columns do not keep their place in the result. Give "columns": the data's columns in the order they are to be written. Nothing was written.`);
  }
  requireColumns(a.rows, names, "populate_sheet");
  if (!a.columns?.length) {
    const ragged = a.rows.findIndex((r) => Object.keys(r).length !== first.length || Object.keys(r).some((k) => !first.includes(k)));
    if (ragged >= 0) throw new DocOpError(`populate_sheet: data row ${ragged + 1} does not have the same columns as the first row. Nothing was written.`);
  }
  refuseMixedTypes(a.rows, names);

  const rEnd = r0 + a.rows.length - 1;
  const cEnd = c0 + names.length - 1;

  // The block's columns go in the data's order. Where the sheet has headers
  // above the block that carry the data's own column names, the two must
  // agree: a "qty" written under "PRICE" is a wrong figure that looks right.
  const position = new Map(names.map((n, i) => [headerKey(n), i]));
  for (let r = r0 - 1; r >= Math.max(1, r0 - 500); r--) {
    const row = ws.getRow(r);
    const under: Array<{ c: number; text: string; i: number }> = [];
    for (let c = c0; c <= cEnd; c++) {
      const text = cellText(row.getCell(c));
      const i = text ? position.get(headerKey(text)) : undefined;
      if (i !== undefined) under.push({ c, text, i });
    }
    if (under.length === 0) continue;
    const off = under.filter((u) => u.i !== u.c - c0);
    if (off.length > 0) {
      throw new DocOpError(
        `populate_sheet writes the data's columns in their own order, which is not the order of the headers on row ${r} of sheet "${ws.name}": ${off.slice(0, 4).map((u) => `column ${numToCol(u.c)} is headed "${u.text}" but would receive "${names[u.c - c0]}"`).join("; ")}. ` +
          `Give "columns" in the order of the sheet's headers, or use append_rows, which places each value under the header of its own name. Nothing was written.`,
      );
    }
    break;
  }

  const beside: string[] = [];
  const problems: Array<{ address: string; why: string }> = [];
  const block = new Set<string>();
  for (let r = r0; r <= rEnd; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (c >= c0 && c <= cEnd) return;
      // A formula that works the row out from the block's own cells (a value
      // column, =B2*C2) gives the row no identity. One that brings something
      // in from elsewhere (=Items!A2, a looked-up name) does.
      if (isFormula(cell) ? !readsColumns(formulaText(cell), ws.name, c0, cEnd) : !isEmptyValue(cell.value)) beside.push(cell.address);
    });
    for (let c = c0; c <= cEnd; c++) {
      const cell = row.getCell(c);
      block.add(cell.address);
      const why = blocked(cell, a.overwrite === true);
      if (why) problems.push({ address: cell.address, why });
    }
  }
  if (beside.length > 0) {
    throw new DocOpError(
      `populate_sheet writes by position, and rows ${r0}–${rEnd} of sheet "${ws.name}" already hold data in other columns (${beside.slice(0, 5).join(", ")}${beside.length > 5 ? ", …" : ""}). Values placed by position there can land against the wrong rows. ` +
        `Use fill_by_key: name the column that identifies a row (an item code, a name; a column that only numbers the rows 1, 2, 3 will do, with the same numbers in the data) and the columns to fill. ` +
        `If nothing in those rows identifies them, build a new workbook that lists each row with its figures instead. Nothing was written.`,
    );
  }
  problems.push(...sharedFormulaProblems(ws, block));
  refuseBlocked(
    problems,
    "populate_sheet",
    'The block would run into cells that already hold something: usually the data has more rows than the empty area has room for (what lies below it, such as totals, would be written over), or the area was filled before. Only if this same area is being filled again, pass "overwrite": true.',
  );

  const released = releaseSharedFormulas(ws, block);
  const written: Written = new Map();
  a.rows.forEach((r, ri) => {
    const row = ws.getRow(r0 + ri);
    names.forEach((n, ci) => {
      const value = toCellValue(r[n]);
      const cell = row.getCell(c0 + ci);
      cell.value = value;
      written.set(cell.address, value);
    });
  });
  return {
    report: { op: "populate_sheet", sheet: ws.name, range: `${addr(c0, r0)}:${addr(cEnd, rEnd)}`, rowsWritten: a.rows.length, cellsWritten: written.size },
    written,
    released,
  };
}

// --- Formulas ----------------------------------------------------------------

function formulaText(cell: ExcelJS.Cell): string {
  try {
    return String(cell.formula ?? "");
  } catch {
    return "";
  }
}

type Box = { c1: number; r1: number; c2: number; r2: number };

/** Text in quotes says nothing about cells. */
const withoutStrings = (f: string): string => f.replace(/"(?:[^"]|"")*"/g, '""');

// Sheet!A1 or 'My Sheet'!A1:B2: the sheet, then one cell or a range.
const ON_A_SHEET = /(?:'((?:[^']|'')*)'|([\p{L}\p{N}_.]+))!\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?/gu;
// Sheet!A:B, whole columns.
const COLUMNS_ON_A_SHEET = /(?:'((?:[^']|'')*)'|([\p{L}\p{N}_.]+))!\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![A-Za-z0-9_(])/gu;
const A_RANGE = /(?<![A-Za-z0-9_.$!'])\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/g;
const A_CELL = /(?<![A-Za-z0-9_.$!'])\$?([A-Za-z]{1,3})\$?\d+(?![A-Za-z0-9_(!])/g;
const WHOLE_COLUMNS = /(?<![A-Za-z0-9_.$!'])\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![A-Za-z0-9_(!])/g;

const sameSheet = (quoted: string | undefined, plain: string | undefined, sheet: string): boolean =>
  (quoted !== undefined ? quoted.replace(/''/g, "'") : (plain ?? "")).toLowerCase() === sheet.toLowerCase();

const box = (ca: string, ra: string, cb: string, rb: string): Box => {
  const [c1, c2] = [colToNum(ca), colToNum(cb)].sort((x, y) => x - y);
  const [r1, r2] = [Number(ra), Number(rb)].sort((x, y) => x - y);
  return { c1, r1, c2, r2 };
};

/**
 * The A1:B2 ranges a formula names on the sheet called `sheet`: those written
 * with that sheet's name, and, when the formula sits on that sheet itself
 * (`own`), those written with no sheet name.
 */
export function rangesOn(formula: string, sheet: string, own: boolean): Box[] {
  const out: Box[] = [];
  const f = withoutStrings(formula);
  for (const m of f.matchAll(ON_A_SHEET)) {
    if (m[6] !== undefined && sameSheet(m[1], m[2], sheet)) out.push(box(m[3], m[4], m[5], m[6]));
  }
  if (own) {
    for (const m of f.replace(ON_A_SHEET, "").replace(COLUMNS_ON_A_SHEET, "").matchAll(A_RANGE)) out.push(box(m[1], m[2], m[3], m[4]));
  }
  return out;
}

/**
 * Does a formula on sheet `sheet` read a cell of that sheet in one of these
 * columns? A formula that speaks of "this row" of an Excel table
 * ([@Qty], [#This Row]) works the row out from the row itself, and counts.
 */
export function readsColumns(formula: string, sheet: string, c0: number, cEnd: number): boolean {
  const f = withoutStrings(formula);
  const within = (a: number, b: number) => Math.min(a, b) <= cEnd && Math.max(a, b) >= c0;
  if (/\[@|\[#this row\]/i.test(f) && !f.includes("!")) return true;
  for (const m of f.matchAll(ON_A_SHEET)) {
    if (sameSheet(m[1], m[2], sheet) && within(colToNum(m[3]), colToNum(m[5] ?? m[3]))) return true;
  }
  for (const m of f.matchAll(COLUMNS_ON_A_SHEET)) {
    if (sameSheet(m[1], m[2], sheet) && within(colToNum(m[3]), colToNum(m[4]))) return true;
  }
  const own = f.replace(ON_A_SHEET, "").replace(COLUMNS_ON_A_SHEET, "");
  for (const m of own.matchAll(A_CELL)) if (within(colToNum(m[1]), colToNum(m[1]))) return true;
  for (const m of own.matchAll(WHOLE_COLUMNS)) if (within(colToNum(m[1]), colToNum(m[2]))) return true;
  return false;
}

// A formula filled down a column (or across a row) is stored once, in its
// first cell; the others only point at it, and Excel works each one's own
// formula out from the first. Left alone, such cells are saved exactly as
// they were. Only writing the FIRST cell needs care: the others would be left
// pointing at a formula that is no longer there. Then, and only then, each of
// them is given its own formula, and only when that can be worked out here
// without doubt: a formula made of plain cell references, numbers, operators
// and functions. Anything else (another sheet, a name, text in quotes, a
// whole column, a table column) is refused rather than guessed at. An
// earlier version rewrote every such cell on loading, with the library's
// pattern-based rewriting: it turned "Q1" in quotes into "Q2" and a sheet
// called 'Jan26' into 'Jan27', on sheets no op had touched.

const A1_REF = /^\$?([A-Za-z]{1,3})\$?[1-9]\d{0,6}$/;

/** Can the library's rewriting of this formula for another cell be relied on? Only for the plainest formulas. */
export function translatesSafely(formula: string): boolean {
  if (formula === "" || /[^A-Za-z0-9_.$:,;+\-*/^%()<>=& ]/.test(formula)) return false;
  for (const m of formula.matchAll(/[A-Za-z0-9_.$]+/g)) {
    const t = m[0];
    const before = formula[m.index! - 1];
    const after = formula[m.index! + t.length];
    if (after === "(") {
      // A function. No part of its name before the last may read as a cell (the rewriting would move it).
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t) || t.split(".").slice(0, -1).some((part) => /^[A-Za-z]+[1-9]\d*$/.test(part))) return false;
      continue;
    }
    const ref = A1_REF.exec(t);
    if (ref && colToNum(ref[1]) <= 16384 && Number(/\d+$/.exec(t)![0]) <= 1048576) continue;
    // A colon beside anything but a cell is a whole column or a whole row.
    if (before === ":" || after === ":") return false;
    // A number: digits on both sides of a point when there is one ("1.E3" would be read as the cell E3).
    if (/^(\d+(\.\d+)?|\.\d+)([eE]\d*)?$/.test(t) || /^(true|false)$/i.test(t)) continue;
    return false;
  }
  return true;
}

/** The cells that take their formula from this one, when it is the first cell of a filled-down formula. */
function pointingAt(ws: ExcelJS.Worksheet, first: ExcelJS.Cell): ExcelJS.Cell[] {
  const v = first.value as { shareType?: unknown; ref?: unknown } | null;
  if (!v || typeof v !== "object" || v.shareType !== "shared") return [];
  const out: ExcelJS.Cell[] = [];
  const take = (cell: ExcelJS.Cell | undefined) => {
    const cv = cell?.value as { sharedFormula?: unknown } | null | undefined;
    if (cell && cv && typeof cv === "object" && cv.sharedFormula === first.address) out.push(cell);
  };
  const m = typeof v.ref === "string" ? /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(v.ref) : null;
  if (m) {
    const g = box(m[1], m[2], m[3] ?? m[1], m[4] ?? m[2]);
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) take(ws.findCell(r, c));
  } else {
    ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, take));
  }
  return out;
}

/** Of the cells about to be written, the first cells of filled-down formulas whose other cells are NOT about to be written. */
function leftPointing(ws: ExcelJS.Worksheet, addresses: Set<string>): Array<{ first: ExcelJS.Cell; others: ExcelJS.Cell[] }> {
  const out: Array<{ first: ExcelJS.Cell; others: ExcelJS.Cell[] }> = [];
  for (const address of addresses) {
    const first = ws.getCell(address);
    const others = pointingAt(ws, first).filter((c) => !addresses.has(c.address));
    if (others.length > 0) out.push({ first, others });
  }
  return out;
}

/** What stands in the way of writing these cells: a first cell whose formula cannot safely be carried to the cells that take theirs from it. */
export function sharedFormulaProblems(ws: ExcelJS.Worksheet, addresses: Set<string>): Array<{ address: string; why: string }> {
  return leftPointing(ws, addresses)
    .filter((g) => !translatesSafely(String((g.first.value as { formula?: unknown }).formula ?? "")))
    .map((g) => ({ address: g.first.address, why: FIRST_OF_FILLED_DOWN }));
}

/** Before those cells are written: every cell left pointing at one of them gets its own formula. Returns their addresses. */
export function releaseSharedFormulas(ws: ExcelJS.Worksheet, addresses: Set<string>): string[] {
  const todo: Array<{ cell: ExcelJS.Cell; formula: string; result: unknown }> = [];
  for (const g of leftPointing(ws, addresses)) {
    for (const cell of g.others) todo.push({ cell, formula: formulaText(cell), result: (cell.value as { result?: unknown }).result });
  }
  // All of them are read before any is changed: each is read through the first cell.
  for (const t of todo) t.cell.value = { formula: t.formula, ...(t.result !== undefined ? { result: t.result } : {}) } as ExcelJS.CellValue;
  return todo.map((t) => t.cell.address);
}

// --- After writing -----------------------------------------------------------

/**
 * A formula keeps the result it had when the file was last saved. After a
 * fill, a total over the filled cells would go on showing the old figure to
 * anything that reads the file without recalculating it, this server's own
 * queryable copy included. Every stored result is dropped and Excel is told
 * to calculate on opening. Returns how many formulas the workbook has.
 *
 * Every formula is written back without a result, whether or not one shows:
 * a result of 0, FALSE or "" is not visible on the cell's value but is still
 * in the file, and 0 is exactly what an empty template's totals hold.
 */
export function dropFormulaResults(wb: ExcelJS.Workbook): number {
  let formulas = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as unknown;
        if (typeof v !== "object" || v === null || !("formula" in v || "sharedFormula" in v)) return;
        formulas++;
        const { result: _old, ...rest } = v as Record<string, unknown>;
        cell.value = rest as unknown as ExcelJS.CellValue;
      });
    });
  }
  if (formulas > 0) wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };
  return formulas;
}

/** Characters the workbook writer leaves out of text; a cell that held one reads back without it. */
const NOT_STORED = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** A cell reduced to what it says: its formula, or its value; never a formula's stored result. */
function signature(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return `d:${v.toISOString()}`;
  if (typeof v === "object") {
    const o = v as { formula?: unknown; sharedFormula?: unknown; richText?: Array<{ text?: string }>; text?: unknown; hyperlink?: unknown; error?: unknown };
    if (o.formula !== undefined) return `=${String(o.formula)}`;
    if (o.sharedFormula !== undefined) return `=shared:${String(o.sharedFormula)}`;
    if (Array.isArray(o.richText)) return signature(o.richText.map((p) => p.text ?? "").join(""));
    if (o.error !== undefined) return `e:${String(o.error)}`;
    if (o.text !== undefined) return signature(typeof o.text === "object" ? o.text : String(o.text));
    return `o:${JSON.stringify(v)}`;
  }
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  // A line break is stored one way whichever way it was written.
  const s = String(v).replace(/\r\n?/g, "\n").replace(NOT_STORED, "");
  return s === "" ? "" : `s:${s}`;
}

function cellSignature(cell: ExcelJS.Cell): string {
  // A shared formula's copies name only their master; the formula text itself
  // is what has to be unchanged.
  if (isFormula(cell)) {
    try {
      return `=${cell.formula}`;
    } catch {
      return signature(cell.value);
    }
  }
  return signature(cell.value);
}

/** The cell that holds a merged range's value: every other cell of the range only shows it. */
export function masterOf(cell: ExcelJS.Cell): ExcelJS.Cell {
  return cell.isMerged ? cell.master : cell;
}

/** What every cell of a workbook says, by sheet and address; and how many there are. */
export type Signatures = Map<string, Map<string, string>>;

/**
 * A workbook as plain text per cell, so that it need not be kept in memory
 * to be compared with later. A merged range is its master cell: the cells it
 * covers repeat the master's value and would otherwise read as changes of
 * their own when the master is written.
 */
export function signaturesOf(wb: ExcelJS.Workbook): { sheets: Signatures; cells: number } {
  const sheets: Signatures = new Map();
  let cells = 0;
  for (const ws of wb.worksheets) {
    const of = new Map<string, string>();
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const sig = cellSignature(cell);
        if (sig !== "") {
          of.set(cell.address, sig);
          cells++;
        }
      }),
    );
    sheets.set(ws.name, of);
  }
  return { sheets, cells };
}

/**
 * The saved file, read back, against the file it was copied from (as it read
 * before any op ran): every cell an op wrote holds what was written, and no
 * other cell differs, in either direction. Sheets the ops added are new and
 * have nothing to be compared with. Returns what is wrong, at most a
 * handful, or nothing.
 */
export function compareWithBase(base: Signatures, saved: ExcelJS.Workbook, written: Map<string, Written>): string[] {
  const wrong: string[] = [];
  const note = (s: string) => void (wrong.length < 8 && wrong.push(s));
  const now = signaturesOf(saved).sheets;
  for (const [name, was] of base) {
    const is = now.get(name);
    if (!is) {
      note(`sheet "${name}" is missing from the saved workbook`);
      continue;
    }
    const mine = written.get(name) ?? new Map<string, ExcelJS.CellValue>();
    for (const address of new Set([...was.keys(), ...is.keys(), ...mine.keys()])) {
      const got = is.get(address) ?? "";
      if (mine.has(address)) {
        const want = signature(mine.get(address));
        if (got !== want) note(`${name}!${address} was written as ${want || "(blank)"} and reads ${got || "(blank)"}`);
      } else {
        const before = was.get(address) ?? "";
        if (got !== before) note(`${name}!${address} was ${before || "(blank)"} and now reads ${got || "(blank)"}, though nothing was to be written there`);
      }
    }
  }
  return wrong;
}
