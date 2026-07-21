/**
 * Render-core tests for document artifacts (M1 blank build + M2 copy-forward).
 *
 * Exercises the real exceljs round-trip: build → write → read back → assert,
 * then load-that-file → applyOps → write → read back → assert the base survived
 * and the ops landed. No DuckDB / store — the pure builders take resolved rows.
 *
 * Run with: npx tsx test/xlsx-builder.ts
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";

import {
  buildWorkbook,
  applyOps,
  type ResolvedSheet,
  type ResolvedOp,
} from "../src/files/documents.js";

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed++;
}

async function readBack(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tp-xlsx-test-"));
  const basePath = join(dir, "base.xlsx");
  const outPath = join(dir, "out.xlsx");

  try {
    // -----------------------------------------------------------------------
    // M1 — blank build: multi-sheet, columns, number formats, header style,
    // freeze panes.
    // -----------------------------------------------------------------------
    const sheets: ResolvedSheet[] = [
      {
        name: "Summary",
        rows: [
          { store: "Alpha", sold: 100, sell_through: 0.5 },
          { store: "Beta", sold: 250, sell_through: 0.82 },
        ],
        columns: [
          { key: "store", header: "Store" },
          { key: "sold", header: "Units Sold", numFmt: "#,##0", width: 14 },
          { key: "sell_through", header: "Sell-through", numFmt: "0.0%" },
        ],
        style: { header: { bold: true, fill: "#1F4E78", color: "#FFFFFF" }, freeze: "A2" },
      },
      // Second sheet with inferred columns (no explicit columns spec).
      { name: "Detail", rows: [{ note: "raw", qty: 3 }] },
    ];

    const wb1 = buildWorkbook(sheets, { theme: "corporate" });
    await wb1.xlsx.writeFile(basePath);

    const built = await readBack(basePath);
    check("two sheets written", built.worksheets.length === 2);

    const summary = built.getWorksheet("Summary")!;
    check("summary exists", !!summary);
    check("header A1 label", summary.getCell("A1").value === "Store");
    check("header B1 label", summary.getCell("B1").value === "Units Sold");
    check("header C1 label", summary.getCell("C1").value === "Sell-through");
    check("data A2", summary.getCell("A2").value === "Alpha");
    check("data B2 numeric", summary.getCell("B2").value === 100);
    check("data C3 numeric", summary.getCell("C3").value === 0.82);
    check("col B number format", summary.getCell("B2").numFmt === "#,##0");
    check("col C percent format", summary.getCell("C2").numFmt === "0.0%");
    check("header bold", summary.getCell("A1").font?.bold === true);

    const fill = summary.getCell("A1").fill as ExcelJS.FillPattern | undefined;
    check("header fill argb", fill?.fgColor?.argb === "FF1F4E78");

    const view = summary.views?.[0];
    check("freeze state", view?.state === "frozen");
    check("freeze top row", (view as { ySplit?: number } | undefined)?.ySplit === 1);

    const detail = built.getWorksheet("Detail")!;
    check("detail inferred header", detail.getCell("A1").value === "note");
    check("detail inferred data", detail.getCell("B2").value === 3);

    // -----------------------------------------------------------------------
    // M2 — copy-forward: load the base file, mutate, save, verify the base
    // survived AND the ops applied (the real round-trip path).
    // -----------------------------------------------------------------------
    const baseCopy = await readBack(basePath);
    const ops: ResolvedOp[] = [
      { op: "append_rows", sheet: "Summary", rows: [{ store: "Gamma", sold: 9, sell_through: 0.1 }] },
      { op: "set_cell", sheet: "Summary", cell: "E1", value: "Refreshed" },
      { op: "set_cell", sheet: "Summary", cell: "E2", value: "=B2+B3" },
      { op: "add_sheet", name: "Notes", rows: [{ note: "hello" }] },
    ];
    applyOps(baseCopy, ops);
    await baseCopy.xlsx.writeFile(outPath);

    const edited = await readBack(outPath);
    const s2 = edited.getWorksheet("Summary")!;

    // Base data preserved.
    check("base A2 preserved", s2.getCell("A2").value === "Alpha");
    check("base A3 preserved", s2.getCell("A3").value === "Beta");
    check("base header preserved", s2.getCell("A1").value === "Store");
    check("base header style preserved", s2.getCell("A1").font?.bold === true);

    // Appended row landed after the base data (rows: 1 header + 2 data → row 4).
    check("appended row store", s2.getCell("A4").value === "Gamma");
    check("appended row numeric", s2.getCell("B4").value === 9);

    // set_cell literal + formula.
    check("set_cell literal", s2.getCell("E1").value === "Refreshed");
    check("set_cell formula", (s2.getCell("E2").value as ExcelJS.CellFormulaValue)?.formula === "B2+B3");

    // add_sheet.
    const notes = edited.getWorksheet("Notes")!;
    check("added sheet exists", !!notes);
    check("added sheet header", notes.getCell("A1").value === "note");
    check("added sheet data", notes.getCell("A2").value === "hello");

    // -----------------------------------------------------------------------
    // Guard: op on a missing sheet throws a clear error.
    // -----------------------------------------------------------------------
    let threw = false;
    try {
      applyOps(await readBack(basePath), [{ op: "append_rows", sheet: "Nope", rows: [{ a: 1 }] }]);
    } catch (e) {
      threw = e instanceof Error && /not found/i.test(e.message);
    }
    check("missing-sheet op throws", threw);

    console.log(`\n✓ xlsx-builder: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ xlsx-builder test failed:", err);
  process.exit(1);
});
