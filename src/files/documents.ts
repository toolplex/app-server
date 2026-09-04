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
// ---------------------------------------------------------------------------

import ExcelJS from "exceljs";

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

export type XlsxOpSpec =
  | { op: "populate_sheet"; sheet: string; startCell?: string; source: DocSource }
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
  | { op: "populate_sheet"; sheet: string; startCell?: string; rows: Record<string, unknown>[] }
  | { op: "append_rows"; sheet: string; rows: Record<string, unknown>[] }
  | { op: "set_cell"; sheet: string; cell: string; value: unknown }
  | {
      op: "add_sheet";
      name: string;
      rows: Record<string, unknown>[];
      columns?: XlsxColumnSpec[];
      style?: XlsxSheetStyle;
    };

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

export function applyOps(wb: ExcelJS.Workbook, ops: ResolvedOp[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "add_sheet": {
        const ws = wb.addWorksheet(sheetName(op.name, wb));
        writeSheet(ws, op.rows, op.columns, op.style?.header);
        applyFreeze(ws, op.style?.freeze);
        break;
      }
      case "populate_sheet": {
        const ws = sheetOrThrow(wb, op.sheet);
        populateAt(ws, op.startCell ?? "A1", op.rows);
        break;
      }
      case "append_rows": {
        const ws = sheetOrThrow(wb, op.sheet);
        appendRows(ws, op.rows);
        break;
      }
      case "set_cell": {
        const ws = sheetOrThrow(wb, op.sheet);
        ws.getCell(op.cell).value = toFormulaAwareValue(op.value);
        break;
      }
      default: {
        // Exhaustiveness guard — a new op type must be handled above.
        const _never: never = op;
        throw new Error(`Unknown op: ${JSON.stringify(_never)}`);
      }
    }
  }
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

/** Write rows (values only, no header) starting at a cell — for filling a template's data area. */
function populateAt(
  ws: ExcelJS.Worksheet,
  startCell: string,
  rows: Record<string, unknown>[],
): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const { col: c0, row: r0 } = parseCell(startCell);
  rows.forEach((r, ri) => {
    const row = ws.getRow(r0 + ri);
    keys.forEach((k, ci) => {
      row.getCell(c0 + ci).value = toCellValue(r[k]);
    });
    row.commit?.();
  });
}

/** Append rows after the sheet's current content — for logs / growing tables. */
function appendRows(ws: ExcelJS.Worksheet, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  for (const r of rows) {
    ws.addRow(keys.map((k) => toCellValue(r[k])));
  }
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
  const { col, row } = parseCell(freeze);
  ws.views = [{ state: "frozen", xSplit: col - 1, ySplit: row - 1 }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Coerce an arbitrary value to a valid exceljs cell value. */
function toCellValue(v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (v instanceof Date) return v;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  return String(v);
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

function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseCell(ref: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return { col: 1, row: 1 };
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) };
}

function sheetOrThrow(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    const have = wb.worksheets.map((w) => w.name).join(", ");
    throw new Error(`Sheet "${name}" not found. Sheets: ${have || "(none)"}.`);
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
