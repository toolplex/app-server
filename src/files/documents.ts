// ---------------------------------------------------------------------------
// Document artifacts — xlsx generation (build-from-scratch + copy-forward).
//
// The agent never emits OOXML. It sends a compact SPEC; this module owns the
// exceljs serialization. Data is referenced by handle (a snapshot/attachment
// fileId or inline rows) and resolved by the store BEFORE the pure builders
// here run — so buildWorkbook/applyOps operate on already-fetched rows and stay
// pure + synchronous + unit-testable with no DuckDB or filesystem.
//
//   Blank build   → buildWorkbook(resolvedSheets, opts)
//   Copy-forward  → load the base binary, then applyOps(workbook, resolvedOps)
//
// Fidelity note: exceljs re-serializes the whole workbook on save, so a
// copy-forward preserves cell content / styles / formulas / column layout but
// can drop charts and pivot tables. Fine for data-grid trackers; the store
// warns when a base carries those parts. See DOCUMENT_ARTIFACTS_SCOPING.md §8.
//
// Writing into an existing sheet is in documentFill.ts, with its rules: by
// key or by header where the sheet can say where a value goes, by position
// only into an empty area, everything checked before anything is written.
// ---------------------------------------------------------------------------

import ExcelJS from "exceljs";

import {
  DocOpError,
  appendByHeader,
  fillByKey,
  masterOf,
  parseSingleCell,
  populateBlock,
  toCellValue,
  type KeyPair,
  type OpReport,
  type Written,
} from "./documentFill.js";

export { DocOpError, type OpReport, type Written };

// --- Shared style/column vocabulary (used by both request + resolved specs) --

export interface XlsxColumnSpec {
  /** Row key to read from each source row. */
  key: string;
  /** Header label; defaults to `key`. */
  header?: string;
  /** Excel number format applied to the whole column, e.g. "#,##0", "0.0%". */
  numFmt?: string;
  /** Column width in Excel width units. */
  width?: number;
}

export interface XlsxHeaderStyle {
  bold?: boolean;
  /** Fill color as "#RRGGBB". */
  fill?: string;
  /** Font color as "#RRGGBB". */
  color?: string;
}

export interface XlsxSheetStyle {
  header?: XlsxHeaderStyle;
  /** Freeze panes anchor, e.g. "A2" freezes the top row. */
  freeze?: string;
}

// --- Request-facing spec (sources are handles; the store resolves them) ------

export interface DocSource {
  /** A snapshot/attachment app-file id to query. */
  fileId?: string;
  /** Optional SQL; defaults to `SELECT * FROM <first table>` of that file. */
  sql?: string;
  /** Inline rows (tiny data only — prefer a handle). */
  rows?: Record<string, unknown>[];
}

export interface XlsxSheetSpec {
  name: string;
  source: DocSource;
  columns?: XlsxColumnSpec[];
  style?: XlsxSheetStyle;
}

/** What fill_by_key is told, apart from where its data comes from. */
export interface FillByKeySpec {
  sheet: string;
  /** The column that identifies a row: its header in the sheet and its name in the data. Several make one key together. */
  key: KeyPair | KeyPair[];
  /** Header in the sheet → column in the data. */
  set: Record<string, string>;
  /** A sheet row with no data row: "leave" (default), "blank" or "zero". */
  unmatched?: "leave" | "blank" | "zero";
  /** Write over cells that already hold a value or a formula. */
  overwrite?: boolean;
  /** Sheet rows carrying the same key: "refuse" (default) or "fill_each". */
  sharedKeys?: "refuse" | "fill_each";
}

export type XlsxOpSpec =
  | ({ op: "fill_by_key"; source: DocSource } & FillByKeySpec)
  | { op: "populate_sheet"; sheet: string; startCell: string; columns?: XlsxColumnSpec[]; overwrite?: boolean; source: DocSource }
  | { op: "append_rows"; sheet: string; source: DocSource }
  | { op: "set_cell"; sheet: string; cell: string; value: unknown }
  | {
      op: "add_sheet";
      name: string;
      source: DocSource;
      columns?: XlsxColumnSpec[];
      style?: XlsxSheetStyle;
    };

export interface XlsxDocSpec {
  title?: string;
  /** Named style preset applied as sheet-header defaults. */
  theme?: string;
  /** Copy-forward base: an xlsx snapshot/attachment fileId whose binary is copied first. */
  base?: { fileId: string };
  /** Blank build: sheets assembled from sources. Mutually exclusive with `ops`. */
  sheets?: XlsxSheetSpec[];
  /** Copy-forward: ops applied to the base copy. Mutually exclusive with `sheets`. */
  ops?: XlsxOpSpec[];
  /** Suggested download filename (without extension is fine). */
  downloadName?: string;
}

// --- Resolved shapes (rows already fetched) — what the pure builders consume --

export interface ResolvedSheet {
  name: string;
  rows: Record<string, unknown>[];
  columns?: XlsxColumnSpec[];
  style?: XlsxSheetStyle;
}

export type ResolvedOp =
  | ({ op: "fill_by_key"; rows: Record<string, unknown>[] } & FillByKeySpec)
  | { op: "populate_sheet"; sheet: string; startCell?: string; columns?: XlsxColumnSpec[]; overwrite?: boolean; rows: Record<string, unknown>[] }
  | { op: "append_rows"; sheet: string; rows: Record<string, unknown>[] }
  | { op: "set_cell"; sheet: string; cell: string; value: unknown }
  | {
      op: "add_sheet";
      name: string;
      rows: Record<string, unknown>[];
      columns?: XlsxColumnSpec[];
      style?: XlsxSheetStyle;
    };

// --- The request, checked whole before any of it is carried out --------------

const present = (v: unknown): boolean => v !== undefined && v !== null;

const SPEC_FIELDS = ["title", "theme", "base", "sheets", "ops", "downloadName"];
const SOURCE_FIELDS = ["fileId", "sql", "rows"];
const SHEET_FIELDS = ["name", "source", "columns", "style"];
const COLUMN_FIELDS = ["key", "header", "numFmt", "width"];
const STYLE_FIELDS = ["header", "freeze"];
const HEADER_STYLE_FIELDS = ["bold", "fill", "color"];
const OP_FIELDS: Record<string, { all: string[]; needs: string[] }> = {
  fill_by_key: { all: ["op", "sheet", "key", "set", "unmatched", "overwrite", "sharedKeys", "source"], needs: ["sheet", "key", "set", "source"] },
  populate_sheet: { all: ["op", "sheet", "startCell", "columns", "overwrite", "source"], needs: ["sheet", "startCell", "source"] },
  append_rows: { all: ["op", "sheet", "source"], needs: ["sheet", "source"] },
  set_cell: { all: ["op", "sheet", "cell", "value"], needs: ["sheet", "cell"] },
  add_sheet: { all: ["op", "name", "source", "columns", "style"], needs: ["name", "source"] },
};

/**
 * Everything wrong with a request, found before any of it runs. A field this
 * builder does not use is an error, not something to drop: a caller who gave
 * it meant something by it (a list of columns to write, a sort order), and a
 * workbook built without it is not the one that was asked for.
 */
export function validateDocSpec(spec: XlsxDocSpec): void {
  const wrong: string[] = [];
  const extra = (where: string, o: object, allowed: string[]) => {
    const unknown = Object.entries(o).filter(([k, v]) => present(v) && !allowed.includes(k)).map(([k]) => `"${k}"`);
    if (unknown.length > 0) wrong.push(`${where}: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not used here (accepted: ${allowed.join(", ")})`);
  };
  const source = (where: string, src: unknown) => {
    if (!src || typeof src !== "object") return void wrong.push(`${where} needs a "source"`);
    const o = src as DocSource;
    extra(`${where} source`, o, SOURCE_FIELDS);
    const rows = Array.isArray(o.rows);
    if (present(o.rows) && !rows) wrong.push(`${where} source: "rows" must be a list of rows`);
    if (rows && present(o.fileId)) wrong.push(`${where} source: give "rows" or a file to read, not both`);
    if (rows && present(o.sql)) wrong.push(`${where} source: "sql" does nothing with "rows" and would be ignored`);
    if (!rows && !present(o.fileId)) wrong.push(`${where} source needs a file to read or "rows"`);
    if (rows && o.rows!.some((r) => !r || typeof r !== "object" || Array.isArray(r))) wrong.push(`${where} source: every row must be an object of column → value`);
  };

  // Columns and styling say how a sheet this builder creates is laid out. On
  // populate_sheet a column list only chooses which data columns are written,
  // and in what order: a header or a format given there would do nothing.
  const columns = (where: string, cols: unknown, allowed: string[]) => {
    if (!present(cols)) return;
    if (!Array.isArray(cols)) return void wrong.push(`${where}: "columns" must be a list`);
    cols.forEach((c, i) => {
      if (!c || typeof c !== "object" || !present((c as XlsxColumnSpec).key)) return void wrong.push(`${where}: column ${i + 1} needs a "key" (the data column it reads)`);
      extra(`${where} column ${i + 1}`, c as object, allowed);
    });
  };
  const style = (where: string, st: unknown) => {
    if (!present(st)) return;
    if (typeof st !== "object") return void wrong.push(`${where}: "style" must be an object`);
    extra(`${where} style`, st as object, STYLE_FIELDS);
    const h = (st as XlsxSheetStyle).header;
    if (present(h) && typeof h === "object") extra(`${where} style header`, h as object, HEADER_STYLE_FIELDS);
  };

  extra("The request", spec, SPEC_FIELDS);
  if (present(spec.theme) && !Object.keys(THEMES).includes(String(spec.theme))) {
    wrong.push(`theme "${String(spec.theme)}" is not one of ${Object.keys(THEMES).join(", ")}; leave it out for the default look`);
  }
  const hasSheets = Array.isArray(spec.sheets) && spec.sheets.length > 0;
  const hasOps = Array.isArray(spec.ops) && spec.ops.length > 0;
  if (hasSheets && hasOps) wrong.push('give "sheets" (a new workbook) or "base" with "ops" (a copy of an existing one), not both: the sheets would be ignored');
  if (hasSheets && present(spec.base)) wrong.push('"base" does nothing with "sheets": a new workbook is not a copy of anything');
  if (hasOps && !present(spec.base?.fileId)) wrong.push('"ops" need a "base" workbook to be applied to');

  (spec.sheets ?? []).forEach((sh, i) => {
    const where = `Sheet ${i + 1}`;
    if (!sh || typeof sh !== "object") return void wrong.push(`${where} is not an object`);
    extra(where, sh, SHEET_FIELDS);
    if (!present(sh.name)) wrong.push(`${where} needs a "name"`);
    source(where, sh.source);
    columns(where, sh.columns, COLUMN_FIELDS);
    style(where, sh.style);
  });
  (spec.ops ?? []).forEach((op, i) => {
    const where = `Op ${i + 1}`;
    if (!op || typeof op !== "object") return void wrong.push(`${where} is not an object`);
    const o = op as unknown as Record<string, unknown>;
    const fields = OP_FIELDS[String(o.op)];
    if (!fields) return void wrong.push(`${where}: "${String(o.op)}" is not an op (ops: ${Object.keys(OP_FIELDS).join(", ")})`);
    extra(`${where} (${String(o.op)})`, o, fields.all);
    const missing = fields.needs.filter((f) => !present(o[f])).map((f) => `"${f}"`);
    if (missing.length > 0) wrong.push(`${where} (${String(o.op)}) needs ${missing.join(", ")}`);
    if (fields.all.includes("source") && present(o.source)) source(`${where} (${String(o.op)})`, o.source);
    if (o.op === "add_sheet") {
      columns(where, o.columns, COLUMN_FIELDS);
      style(where, o.style);
    }
    if (o.op === "populate_sheet") columns(`${where} (populate_sheet)`, o.columns, ["key"]);
    // Without a value the cell would be blanked: that has to be said, not left out.
    if (o.op === "set_cell" && !("value" in o)) wrong.push(`${where} (set_cell) needs "value" (null to empty the cell)`);
  });
  if (wrong.length > 0) throw new DocOpError(`The workbook request cannot be carried out as written: ${wrong.join("; ")}.`);
}

// --- Themes: one-token defaults the agent can override per element -----------

const THEMES: Record<string, { header: XlsxHeaderStyle }> = {
  "corporate": { header: { bold: true, fill: "#1F4E78", color: "#FFFFFF" } },
  "plain": { header: { bold: true } },
};

// ---------------------------------------------------------------------------
// Blank build
// ---------------------------------------------------------------------------

export function buildWorkbook(
  sheets: ResolvedSheet[],
  opts: { theme?: string; creator?: string } = {},
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.creator ?? "ToolPlex";
  const themeHeader = opts.theme ? THEMES[opts.theme]?.header : undefined;

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheetName(sheet.name, wb));
    writeSheet(ws, sheet.rows, sheet.columns, sheet.style?.header ?? themeHeader);
    applyFreeze(ws, sheet.style?.freeze);
  }
  // A workbook must have at least one sheet to be a valid xlsx.
  if (wb.worksheets.length === 0) wb.addWorksheet("Sheet1");
  return wb;
}

// ---------------------------------------------------------------------------
// Copy-forward ops (applied to a workbook loaded from the base binary)
// ---------------------------------------------------------------------------

/**
 * Apply the ops in order. Returns what each did, and every cell that was
 * written with the value it must now hold, by sheet: the caller reads the
 * saved file back against that. An op that cannot be carried out safely
 * throws DocOpError; the workbook in memory may then be part-written and is
 * to be thrown away, not saved.
 */
export function applyOps(wb: ExcelJS.Workbook, ops: ResolvedOp[]): { reports: OpReport[]; written: Map<string, Written> } {
  const reports: OpReport[] = [];
  const written = new Map<string, Written>();
  const record = (sheet: string, cells: Written) => {
    const have = written.get(sheet) ?? new Map();
    for (const [address, value] of cells) have.set(address, value);
    written.set(sheet, have);
  };
  for (const op of ops) {
    switch (op.op) {
      case "add_sheet": {
        const ws = wb.addWorksheet(sheetName(op.name, wb));
        writeSheet(ws, op.rows, op.columns, op.style?.header);
        applyFreeze(ws, op.style?.freeze);
        reports.push({ op: op.op, sheet: ws.name, rowsWritten: op.rows.length });
        break;
      }
      case "fill_by_key": {
        const ws = sheetOrThrow(wb, op.sheet);
        const done = fillByKey(ws, op);
        record(ws.name, done.written);
        reports.push(done.report);
        break;
      }
      case "populate_sheet": {
        const ws = sheetOrThrow(wb, op.sheet);
        const done = populateBlock(ws, { startCell: op.startCell, columns: op.columns?.map((c) => c.key), overwrite: op.overwrite, rows: op.rows });
        record(ws.name, done.written);
        reports.push(done.report);
        break;
      }
      case "append_rows": {
        const ws = sheetOrThrow(wb, op.sheet);
        const done = appendByHeader(ws, op.rows);
        record(ws.name, done.written);
        reports.push(done.report);
        break;
      }
      case "set_cell": {
        const ws = sheetOrThrow(wb, op.sheet);
        const { col, row } = parseSingleCell(op.cell, 'set_cell "cell"');
        // A cell inside a merged range shows the range's one value: that is the cell that is set.
        const cell = masterOf(ws.getRow(row).getCell(col));
        const value = toFormulaAwareValue(op.value);
        cell.value = value;
        record(ws.name, new Map([[cell.address, value]]));
        reports.push({ op: op.op, sheet: ws.name, range: cell.address, cellsWritten: 1 });
        break;
      }
      default: {
        // Exhaustiveness guard — a new op type must be handled above.
        const _never: never = op;
        throw new DocOpError(`Unknown op: ${JSON.stringify((_never as { op?: unknown }).op)}`);
      }
    }
  }
  return { reports, written };
}

// ---------------------------------------------------------------------------
// Sheet writing
// ---------------------------------------------------------------------------

function writeSheet(
  ws: ExcelJS.Worksheet,
  rows: Record<string, unknown>[],
  columns: XlsxColumnSpec[] | undefined,
  header: XlsxHeaderStyle | undefined,
): void {
  const cols = columns && columns.length > 0 ? columns : inferColumns(rows);
  if (cols.length === 0) return; // nothing to write (empty sheet)
  if (columns && columns.length > 0 && rows.length > 0) {
    // A column the data does not have used to come out as an empty column
    // under its header, which reads as "no figures" rather than "wrong name".
    const have = new Set(rows.flatMap((r) => Object.keys(r)));
    const missing = columns.filter((c) => !have.has(c.key)).map((c) => `"${c.key}"`);
    if (missing.length > 0) {
      throw new DocOpError(`Sheet "${ws.name}": the data has no column ${missing.join(", ")}. Its columns are: ${[...have].map((h) => `"${h}"`).join(", ")}.`);
    }
  }

  const headerRow = ws.addRow(cols.map((c) => c.header ?? c.key));
  applyHeaderStyle(headerRow, header);

  for (const r of rows) {
    ws.addRow(cols.map((c) => toCellValue(r[c.key])));
  }

  // Width: authored wins; otherwise size to content (header + sampled cell
  // lengths) so the sheet opens readable instead of every column clipped at
  // Excel's 8.43-character default.
  const widthSample = rows.slice(0, INFER_SAMPLE_ROWS);
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    if (c.width != null) {
      col.width = c.width;
      return;
    }
    let maxLen = String(c.header ?? c.key).length;
    for (const r of widthSample) {
      const v = r[c.key];
      if (v === null || v === undefined) continue;
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      if (s.length > maxLen) maxLen = s.length;
    }
    col.width = Math.min(60, Math.max(9, maxLen + 2));
  });
}

function applyHeaderStyle(row: ExcelJS.Row, style: XlsxHeaderStyle | undefined): void {
  const s = style ?? { bold: true };
  row.eachCell((cell) => {
    cell.font = { bold: s.bold ?? true, ...(s.color ? { color: { argb: argb(s.color) } } : {}) };
    if (s.fill) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(s.fill) } };
    }
  });
}

function applyFreeze(ws: ExcelJS.Worksheet, freeze: string | undefined): void {
  if (!freeze) return;
  const { col, row } = parseSingleCell(freeze, 'style "freeze"');
  ws.views = [{ state: "frozen", xSplit: col - 1, ySplit: row - 1 }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when every value in the row is null/undefined or blank text. */
function isEmptyRow(row: Record<string, unknown>): boolean {
  return Object.values(row).every(
    (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === ""),
  );
}

/** Drop trailing all-empty rows; interior blanks are kept faithfully. */
export function trimTrailingEmptyRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  let end = rows.length;
  while (end > 0 && isEmptyRow(rows[end - 1])) end--;
  return end === rows.length ? rows : rows.slice(0, end);
}

/** Initialisms that read wrong half-capitalized ("Shipment Id"). */
const HEADER_INITIALISMS = new Set(["id", "sku", "qty", "vat", "po", "dr", "url", "vpo", "csv", "sql"]);

/**
 * Snake/kebab column key → readable header ("shipment_id" → "Shipment ID").
 * Keys that already carry their own casing or punctuation are left alone —
 * the author formatted those deliberately.
 */
function humanizeKey(key: string): string {
  if (!/^[a-z0-9_-]+$/.test(key)) return key;
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (HEADER_INITIALISMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const INFER_SAMPLE_ROWS = 100;

/**
 * Columns for a sheet with no authored spec (agent blank-builds without
 * `columns`, and the on-the-fly artifact export): readable headers, and a
 * thousands-separator format for numeric columns. The separator only kicks
 * in when the column actually holds large numbers — "2,026" on a year
 * column is worse than no format at all.
 */
function inferColumns(rows: Record<string, unknown>[]): XlsxColumnSpec[] {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]).map((k) => {
    let numeric = true;
    let integral = true;
    let large = false;
    let seen = 0;
    for (const r of rows.slice(0, INFER_SAMPLE_ROWS)) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      seen++;
      if (typeof v !== "number" && typeof v !== "bigint") {
        numeric = false;
        break;
      }
      const n = Number(v);
      if (!Number.isInteger(n)) integral = false;
      if (Math.abs(n) >= 10_000) large = true;
    }
    const numFmt =
      numeric && seen > 0
        ? integral
          ? large
            ? "#,##0"
            : undefined
          : "#,##0.00"
        : undefined;
    return { key: k, header: humanizeKey(k), ...(numFmt ? { numFmt } : {}) };
  });
}

/** Like toCellValue, but a leading "=" makes it a formula (set_cell only). */
function toFormulaAwareValue(v: unknown): ExcelJS.CellValue {
  if (typeof v === "string" && v.startsWith("=")) {
    return { formula: v.slice(1) } as ExcelJS.CellValue;
  }
  return toCellValue(v);
}

/** "#1F4E78" → "FF1F4E78" (exceljs wants ARGB); pass through 8-char ARGB. */
function argb(hex: string): string {
  const h = hex.replace(/^#/, "").toUpperCase();
  return h.length === 6 ? `FF${h}` : h;
}

function sheetOrThrow(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    const have = wb.worksheets.map((w) => w.name).join(", ");
    throw new DocOpError(`Sheet "${name}" not found. Sheets: ${have || "(none)"}.`);
  }
  return ws;
}

/**
 * Excel sheet names are ≤31 chars, can't contain \ / ? * [ ] :, and must be
 * unique within a workbook. Sanitize + de-dupe so a bad/duplicate name never
 * fails the write.
 */
function sheetName(raw: string, wb: ExcelJS.Workbook): string {
  let base = (raw || "Sheet").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
  const used = new Set(wb.worksheets.map((w) => w.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
