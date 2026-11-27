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
  /** Cells in rows with no data that kept the value they already held, and the keys of those rows. */
  unmatchedValuesKept?: number;
  keysThatKeptTheirValues?: string[];
  dataRowsNotInSheet?: number;
  dataKeysNotInSheet?: string[];
  sheetRowsSharingAKey?: number;
  /** Rows passed over because their key cell could not be read as a key (a merged heading, a formula with no result, …). */
  rowsWithUnreadableKey?: number;
  unreadableKeys?: string[];
  /** Rows passed over because only part of a several-column key was there. */
  rowsWithPartialKey?: number;
  /** Another table begins here (its header row), and nothing from this row down was touched. */
  stoppedAtRow?: number;
  stoppedBecause?: string;
  emptyValuesLeft?: number;
  /** The first rows as they now read: key, then each target. */
  firstRows?: Array<Record<string, unknown>>;
}

/** Addresses this op wrote, with what each must now hold; used to check the saved file. */
export type Written = Map<string, ExcelJS.CellValue>;

const SEP = "\u0001";
const HEADER_SEARCH_ROWS = 50;
const SAMPLE = 10;

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
    return squash(cell.text ?? "");
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
export function findHeaderRow(ws: ExcelJS.Worksheet, all: string[]): { row: number; cols: Map<string, number> } {
  const names = all.filter((n) => columnLetter(n) === null);
  if (names.length === 0) {
    throw new DocOpError(`Sheet "${ws.name}": at least one column must be named by its header (the key column is the natural one), so that the header row can be found. Nothing was written.`);
  }
  const withLetters = (row: number, cols: Map<string, number>) => {
    for (const n of all) {
      const c = columnLetter(n);
      if (c !== null) cols.set(n, c);
    }
    return { row, cols };
  };
  const wanted = names.map(headerKey);
  let best: { row: number; found: number; texts: string[] } | null = null;
  let widest: { row: number; texts: string[] } | null = null;
  const last = Math.min(lastValueRow(ws), HEADER_SEARCH_ROWS);
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    const seen = new Map<string, number[]>();
    const texts: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const t = cellText(cell);
      if (!t) return;
      texts.push(t);
      const k = headerKey(t);
      seen.set(k, [...(seen.get(k) ?? []), c]);
    });
    const found = wanted.filter((w) => seen.has(w)).length;
    if (found === wanted.length) {
      const twice = names.filter((n) => (seen.get(headerKey(n)) ?? []).length > 1);
      if (twice.length > 0) {
        const where = twice.map((t) => `"${t}" heads columns ${seen.get(headerKey(t))!.map(numToCol).join(" and ")}`).join("; ");
        throw new DocOpError(`Sheet "${ws.name}" row ${r} uses one header for more than one column: ${where}. Name the column that is meant by its letter instead, as "column:${numToCol(seen.get(headerKey(twice[0]))![0])}". Nothing was written.`);
      }
      return withLetters(r, new Map(names.map((n) => [n, seen.get(headerKey(n))![0]])));
    }
    if (found > 0 && (!best || found > best.found)) best = { row: r, found, texts };
    if (!widest || texts.length > widest.texts.length) widest = { row: r, texts };
  }
  const list = (texts: string[]) => texts.slice(0, 40).map((t) => `"${t}"`).join(", ");
  const missing = (texts: string[]) => names.filter((n) => !texts.map(headerKey).includes(headerKey(n)));
  if (best) {
    throw new DocOpError(
      `Sheet "${ws.name}" has no row with all of these headers: ${names.map((n) => `"${n}"`).join(", ")}. Row ${best.row} comes closest but lacks ${missing(best.texts).map((n) => `"${n}"`).join(", ")}; its headers are: ${list(best.texts)}. Use the headers as they are written there; if the sheet's headings run over two rows (a month above "Qty" and "Amount"), name the key column by its header and each other column by its letter, as "column:D". Nothing was written.`,
    );
  }
  throw new DocOpError(
    `Sheet "${ws.name}" has none of these headers in its first ${HEADER_SEARCH_ROWS} rows: ${names.map((n) => `"${n}"`).join(", ")}.` +
      (widest && widest.texts.length > 0 ? ` Its header row looks like row ${widest.row}: ${list(widest.texts)}. Use the headers as they are written there.` : " The sheet looks empty.") +
      " Nothing was written.",
  );
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

function refuseBlocked(problems: Array<{ address: string; why: string }>, what: string, filled?: string): void {
  if (problems.length === 0) return;
  const by = new Map<string, string[]>();
  for (const p of problems) by.set(p.why, [...(by.get(p.why) ?? []), p.address]);
  const parts = [...by.entries()].map(([why, a]) => `${a.length} ${why} (${a.slice(0, 5).join(", ")}${a.length > 5 ? ", …" : ""})`);
  const advice: string[] = [];
  if (by.has("merged")) advice.push("Merged cells cannot be filled row by row: build a new workbook that lists each key with its figures instead.");
  if (by.has("a formula")) advice.push('The formulas are the sheet\'s own calculations (totals, computed columns) and are almost never meant to be replaced: check that the right column is being filled. Only if the user asked for those formulas to be replaced, pass "overwrite": true.');
  if (by.has("already filled")) advice.push(filled ?? 'If the existing figures of these rows are to be replaced (a refresh), pass "overwrite": true.');
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

const looksNumeric = (s: string): boolean => /^[-+(]?[\d.,\s%]+\)?$/.test(s.trim());

/**
 * A row of headings: words under every column that is to receive figures,
 * no number, date or formula anywhere in the row, and nothing in the key
 * column that the data has a row for.
 */
function looksLikeHeaderRow(row: ExcelJS.Row, keyCols: number[], targetCols: number[], known: (key: string) => boolean): boolean {
  for (const c of targetCols) {
    const v = row.getCell(c).value as unknown;
    if (typeof v !== "string" && !(typeof v === "object" && v !== null && "richText" in v)) return false;
    const t = cellText(row.getCell(c));
    if (t === "" || looksNumeric(t)) return false;
  }
  let words = 0;
  let other = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    const v = cell.value as unknown;
    if (isEmptyValue(v)) return;
    if (typeof v === "string" || (typeof v === "object" && v !== null && "richText" in v)) words++;
    else other = true;
  });
  if (other || words < 2) return false;
  const key = keyCols.map((c) => cellText(row.getCell(c))).join(SEP);
  return !known(key);
}

export function fillByKey(ws: ExcelJS.Worksheet, a: FillByKeyArgs): { report: OpReport; written: Written } {
  const keys = Array.isArray(a.key) ? a.key : [a.key];
  const targets = Object.entries(a.set ?? {});
  if (keys.length === 0 || keys.some((k) => !k?.sheet || !k?.data)) throw new DocOpError('fill_by_key needs "key": { "sheet": <header in the sheet>, "data": <column in the data> }.');
  if (targets.length === 0) throw new DocOpError('fill_by_key needs "set": { <header in the sheet>: <column in the data>, … }.');
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

  const header = findHeaderRow(ws, [...keyHeaders, ...targetHeaders]);
  const keyCols = keyHeaders.map((h) => header.cols.get(h)!);
  const targetCols = targetHeaders.map((h) => header.cols.get(h)!);

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
  let stoppedAtRow: number | undefined;
  let stoppedBecause: string | undefined;
  const end = lastValueRow(ws);
  const dataLoose = new Set([...data.keys()].map(looseKey));
  // Figures are being written when every mapped data column holds numbers.
  const figures = targets.every(([, d]) => a.rows.some((r) => typeof r[d] === "number" || typeof r[d] === "bigint"));
  for (let r = header.row + 1; r <= end; r++) {
    const row = ws.getRow(r);
    // The header again: another table starts here, with rows of its own that
    // this key was not asked about.
    if (keyCols.every((c, i) => headerKey(cellText(row.getCell(c))) === headerKey(keyHeaders[i]))) {
      stoppedAtRow = r;
      stoppedBecause = "the header row repeats";
      break;
    }
    // Or another table under different headers. Its columns mean something
    // else, so a figure written under this table's column letter would sit
    // under that table's heading. Such a row has words where the figures go,
    // nothing but words anywhere, and a key the data does not know. Before
    // the first row of the table itself such a row is only the second line of
    // this table's own headings (a month above "Qty" and "Amount").
    if (figures && sheetRows.length > 0 && looksLikeHeaderRow(row, keyCols, targetCols, (k) => data.has(k) || dataLoose.has(looseKey(k)))) {
      stoppedAtRow = r;
      stoppedBecause = "a row of headings";
      break;
    }
    let parts: Array<string | null>;
    try {
      parts = keyCols.map((c) => sheetKey(row.getCell(c)));
    } catch (e) {
      if (!(e instanceof NotAKey)) throw e;
      unreadable.push(`row ${r} (${e.message})`);
      continue;
    }
    if (parts.every((p) => p === null)) continue; // a blank line, or a totals row with no key
    if (parts.some((p) => p === null)) {
      partial++;
      continue;
    }
    sheetRows.push({ row: r, id: parts.join(SEP) });
  }
  if (sheetRows.length === 0) {
    const formulas = unreadable.some((u) => /formula with no stored result/.test(u));
    throw new DocOpError(
      `Sheet "${ws.name}" has no rows with a readable key under ${keyHeaders.map((h) => `"${h}"`).join(" + ")} below row ${header.row}${unreadable.length > 0 ? ` (${unreadable.slice(0, 3).join("; ")})` : ""}. Nothing was written.` +
        (formulas
          ? " The keys in this workbook are formulas, and a workbook this tool has already written does not store their results (they are worked out when it is opened in Excel). Fill the file the user originally gave instead of an earlier filled copy, or use another column that holds plain values as the key."
          : " Use a column that holds a plain value in each row as the key."),
    );
  }

  const sheetIds = new Map<string, number[]>();
  for (const s of sheetRows) sheetIds.set(s.id, [...(sheetIds.get(s.id) ?? []), s.row]);
  const shared = [...sheetIds.entries()].filter(([, rows]) => rows.length > 1);
  if (shared.length > 0 && sharedKeys !== "fill_each") {
    throw new DocOpError(
      `${shared.length} key${shared.length === 1 ? " appears" : "s appear"} on more than one row of sheet "${ws.name}" (${shared.slice(0, 4).map(([k, rows]) => `"${shown(k)}" on rows ${rows.slice(0, 4).join(", ")}`).join("; ")}${shared.length > 4 ? "; …" : ""}). ` +
        `If those rows belong to different groups (the same item under two stores, two sections), the key needs the column that tells them apart: give "key" as a list of two columns. ` +
        `If it is one thing listed twice and each row should get the same figures, pass "sharedKeys": "fill_each". Nothing was written.`,
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
    throw new DocOpError(`No row of sheet "${ws.name}" has a key found in the data. Sheet keys look like ${sheetRows.slice(0, 5).map((s) => `"${shown(s.id)}"`).join(", ")}; data keys look like ${[...data.keys()].slice(0, 5).map((k) => `"${shown(k)}"`).join(", ")}. Nothing was written.`);
  }

  // Everything is checked before anything is written.
  const plan: Array<{ cell: ExcelJS.Cell; value: ExcelJS.CellValue }> = [];
  const problems: Array<{ address: string; why: string }> = [];
  let emptyValuesLeft = 0;
  let unmatchedCellsSet = 0;
  let formulasKept = 0;
  let unmatchedValuesKept = 0;
  const keptKeys = new Set<string>();
  for (const s of sheetRows) {
    const d = match.get(s.row);
    const row = ws.getRow(s.row);
    for (let t = 0; t < targets.length; t++) {
      const cell = row.getCell(targetCols[t]);
      if (d) {
        const value = toCellValue(d[targets[t][1]]);
        if (value === null) {
          emptyValuesLeft++;
          continue;
        }
        const why = blocked(cell, overwrite);
        if (why) problems.push({ address: cell.address, why });
        else plan.push({ cell, value });
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
        continue;
      }
      if (unmatched === "zero") {
        plan.push({ cell, value: 0 });
        unmatchedCellsSet++;
      }
    }
  }
  refuseBlocked(problems, "fill_by_key");

  const written: Written = new Map();
  for (const p of plan) {
    p.cell.value = p.value;
    written.set(p.cell.address, p.value);
  }

  const without = sheetRows.filter((s) => !match.has(s.row));
  const unusedData = [...data.keys()].filter((id) => !usedData.has(id));
  const rowsTouched = new Set(plan.map((p) => Number(p.cell.row)));
  const report: OpReport = {
    op: "fill_by_key",
    sheet: ws.name,
    headerRow: header.row,
    keyColumns: Object.fromEntries(keyHeaders.map((h, i) => [h, numToCol(keyCols[i])])),
    targetColumns: Object.fromEntries(targetHeaders.map((h, i) => [h, numToCol(targetCols[i])])),
    sheetRowsWithKey: sheetRows.length,
    matched: match.size,
    ...(loosely.length > 0 ? { matchedLoosely: loosely.length, looselyMatchedKeys: loosely.slice(0, SAMPLE) } : {}),
    sheetRowsWithoutData: without.length,
    ...(without.length > 0 ? { sheetKeysWithoutData: without.slice(0, SAMPLE).map((s) => shown(s.id)), unmatched, ...(unmatched !== "leave" ? { unmatchedCellsSet } : {}) } : {}),
    ...(formulasKept > 0 ? { formulasKept } : {}),
    ...(unmatchedValuesKept > 0 ? { unmatchedValuesKept, keysThatKeptTheirValues: [...keptKeys].slice(0, SAMPLE) } : {}),
    dataRowsNotInSheet: unusedData.length,
    ...(unusedData.length > 0 ? { dataKeysNotInSheet: unusedData.slice(0, SAMPLE).map(shown) } : {}),
    sheetRowsSharingAKey: shared.reduce((x, [, rows]) => x + rows.length, 0),
    ...(unreadable.length > 0 ? { rowsWithUnreadableKey: unreadable.length, unreadableKeys: unreadable.slice(0, SAMPLE) } : {}),
    ...(partial > 0 ? { rowsWithPartialKey: partial } : {}),
    ...(stoppedAtRow ? { stoppedAtRow, stoppedBecause } : {}),
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
  return { report, written };
}

// --- append_rows -------------------------------------------------------------

/**
 * Rows added after the sheet's content, each value under the header of its
 * own name. A sheet that ends in formulas ends in totals: rows added below
 * them would be outside every total, so that is refused.
 */
export function appendByHeader(ws: ExcelJS.Worksheet, rows: Record<string, unknown>[]): { report: OpReport; written: Written } {
  requireColumns(rows, [], "append_rows");
  const names = Object.keys(rows[0]);
  const ragged = rows.findIndex((r) => Object.keys(r).some((k) => !names.includes(k)));
  if (ragged >= 0) throw new DocOpError(`append_rows: data row ${ragged + 1} has columns the first row does not; every row must have the same columns. Nothing was written.`);
  refuseMixedTypes(rows, names);
  const header = findHeaderRow(ws, names);
  const end = Math.max(lastValueRow(ws), header.row);
  let formulas = 0;
  if (end > header.row) ws.getRow(end).eachCell({ includeEmpty: false }, (cell) => void (isFormula(cell) && formulas++));
  if (formulas > 0) {
    throw new DocOpError(`Sheet "${ws.name}" ends in a row of formulas (row ${end}), which is usually its totals. Rows appended below it would be left out of them, so nothing was added. Build a new workbook from the full data instead.`);
  }
  // A total need not be the last row: it can sit above the data, or be
  // followed by a line of text. Any formula on the sheet that adds up a range
  // of these columns over the rows already there, and stops short of the rows
  // to be added, would leave them out.
  const cols0 = names.map((n) => header.cols.get(n)!);
  const lastNew = end + rows.length;
  let shortTotal: string | undefined;
  ws.eachRow({ includeEmpty: false }, (row) =>
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (shortTotal || !isFormula(cell)) return;
      for (const g of rangesIn(formulaText(cell))) {
        const overColumns = cols0.some((c) => c >= g.c1 && c <= g.c2);
        const overData = g.r2 > header.row && g.r1 <= end;
        if (overColumns && overData && g.r2 < lastNew) shortTotal = `${cell.address} (=${formulaText(cell)})`;
      }
    }),
  );
  if (shortTotal) {
    throw new DocOpError(`Sheet "${ws.name}" has a formula over the rows already there that would not take in the rows to be added: ${shortTotal}. Appended rows would be left out of it, so nothing was added. Build a new workbook from the full data instead.`);
  }
  const written: Written = new Map();
  rows.forEach((r, i) => {
    const row = ws.getRow(end + 1 + i);
    for (const n of names) {
      const value = toCellValue(r[n]);
      if (value === null) continue;
      const cell = row.getCell(header.cols.get(n)!);
      cell.value = value;
      written.set(cell.address, value);
    }
  });
  const cols = names.map((n) => header.cols.get(n)!);
  return {
    report: {
      op: "append_rows",
      sheet: ws.name,
      headerRow: header.row,
      targetColumns: Object.fromEntries(names.map((n) => [n, numToCol(header.cols.get(n)!)])),
      range: `${addr(Math.min(...cols), end + 1)}:${addr(Math.max(...cols), end + rows.length)}`,
      rowsWritten: rows.length,
      cellsWritten: written.size,
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
): { report: OpReport; written: Written } {
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
  const beside: string[] = [];
  const problems: Array<{ address: string; why: string }> = [];
  for (let r = r0; r <= rEnd; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (c >= c0 && c <= cEnd) return;
      // A formula that works the row out from the block's own cells (a value
      // column, =B2*C2) gives the row no identity. One that brings something
      // in from elsewhere (=Items!A2, a looked-up name) does.
      if (isFormula(cell) ? !readsColumns(formulaText(cell), c0, cEnd) : !isEmptyValue(cell.value)) beside.push(cell.address);
    });
    for (let c = c0; c <= cEnd; c++) {
      const cell = row.getCell(c);
      const why = blocked(cell, a.overwrite === true);
      if (why) problems.push({ address: cell.address, why });
    }
  }
  if (beside.length > 0) {
    throw new DocOpError(
      `populate_sheet writes by position, and rows ${r0}–${rEnd} of sheet "${ws.name}" already hold data in other columns (${beside.slice(0, 5).join(", ")}${beside.length > 5 ? ", …" : ""}). Values placed by position there can land against the wrong rows. ` +
        `Use fill_by_key: name the column that identifies a row (an item code, a name; a column that only numbers the rows 1, 2, 3 will do, with the same numbers in the data) and the columns to fill. Nothing was written.`,
    );
  }
  refuseBlocked(
    problems,
    "populate_sheet",
    'The block would run into cells that already hold something: usually the data has more rows than the empty area has room for (what lies below it, such as totals, would be written over), or the area was filled before. Only if this same area is being filled again, pass "overwrite": true.',
  );

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

const OTHER_SHEET_REF = /(?:'[^']*'|[A-Za-z0-9_.]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/g;

/** The A1:B2 ranges a formula names on its own sheet. */
function rangesIn(formula: string): Array<{ c1: number; r1: number; c2: number; r2: number }> {
  const out: Array<{ c1: number; r1: number; c2: number; r2: number }> = [];
  const own = formula.replace(OTHER_SHEET_REF, "");
  for (const m of own.matchAll(/\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)/g)) {
    const [c1, c2] = [colToNum(m[1]), colToNum(m[3])].sort((x, y) => x - y);
    const [r1, r2] = [Number(m[2]), Number(m[4])].sort((x, y) => x - y);
    out.push({ c1, r1, c2, r2 });
  }
  return out;
}

/** Does the formula read a cell of its own sheet in one of these columns? */
function readsColumns(formula: string, c0: number, cEnd: number): boolean {
  const own = formula.replace(OTHER_SHEET_REF, "");
  for (const m of own.matchAll(/\$?([A-Za-z]{1,3})\$?\d+/g)) {
    const c = colToNum(m[1]);
    if (c >= c0 && c <= cEnd) return true;
  }
  return false;
}

/**
 * A formula filled down a column is stored once, in its first cell, with the
 * cells below only pointing at it. Writing that first cell (a figure into
 * it, or another formula) would change or break every cell below, in ways
 * the caller never asked for. Each such cell is given its own formula before
 * anything is written; the sheet calculates exactly as before.
 */
export function unshareFormulas(wb: ExcelJS.Workbook): number {
  const todo: Array<{ cell: ExcelJS.Cell; formula: string; result: unknown }> = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as { sharedFormula?: unknown; shareType?: unknown; formula?: unknown; result?: unknown } | null;
        if (!v || typeof v !== "object") return;
        if (v.sharedFormula !== undefined || v.shareType === "shared") {
          const text = formulaText(cell);
          if (text) todo.push({ cell, formula: text, result: v.result });
        }
      }),
    );
  }
  // The cells that point first, their master last: a pointer is read through its master.
  for (const t of todo.filter((x) => (x.cell.value as { sharedFormula?: unknown }).sharedFormula !== undefined)) {
    t.cell.value = { formula: t.formula, ...(t.result !== undefined ? { result: t.result } : {}) } as ExcelJS.CellValue;
  }
  for (const t of todo.filter((x) => (x.cell.value as { shareType?: unknown }).shareType === "shared")) {
    t.cell.value = { formula: t.formula, ...(t.result !== undefined ? { result: t.result } : {}) } as ExcelJS.CellValue;
  }
  return todo.length;
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
