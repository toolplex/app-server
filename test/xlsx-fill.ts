/**
 * Writing into a workbook somebody already has (src/files/documentFill.ts).
 *
 * Every case builds a real workbook with exceljs, applies ops, saves, reads
 * the file back and looks at the cells: the same round trip the store makes.
 * The cases are the ways a value has ended up, or could end up, against the
 * wrong row or column, or in a file that looks complete and is not.
 *
 * Run with: npx tsx test/xlsx-fill.ts
 */

import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { applyOps, validateDocSpec, type ResolvedOp, type XlsxDocSpec } from "../src/files/documents.js";
import { DocOpError, compareWithBase, dropFormulaResults, findHeaderRow, parseSingleCell } from "../src/files/documentFill.js";

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed++;
}

/** The op must be refused, with a message that says why; and must have written nothing. */
function refused(label: string, wb: ExcelJS.Workbook, ops: ResolvedOp[], pattern: RegExp): void {
  const before = snapshot(wb);
  let message = "";
  try {
    applyOps(wb, ops);
  } catch (e) {
    assert.ok(e instanceof DocOpError, `${label}: refused with a DocOpError, got ${String(e)}`);
    message = (e as Error).message;
  }
  assert.ok(message !== "", `${label}: was not refused`);
  assert.ok(pattern.test(message), `${label}: message does not say why (${message})`);
  assert.deepStrictEqual(snapshot(wb), before, `${label}: wrote something before refusing`);
  passed++;
}

function snapshot(wb: ExcelJS.Workbook): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        out[`${ws.name}!${cell.address}`] = JSON.stringify(cell.value);
      }),
    );
  }
  return out;
}

async function save(wb: ExcelJS.Workbook, path: string): Promise<ExcelJS.Workbook> {
  await wb.xlsx.writeFile(path);
  const back = new ExcelJS.Workbook();
  await back.xlsx.readFile(path);
  return back;
}

/**
 * A sheet as people send them: a title, a blank line, the header on row 3,
 * a blank line among the items, a totals row at the foot.
 */
function tracker(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Items");
  ws.getCell("A1").value = "Season tracker";
  ws.getRow(3).values = ["CODE", "Description", "Colour", "SOLD", "ON HAND"];
  ws.getRow(4).values = ["A-100", "Shirt", "Brown"];
  ws.getRow(5).values = ["A-200", "Shirt", "Olive"];
  // row 6 is blank
  ws.getRow(7).values = ["B-300", "Polo", "Navy"];
  ws.getRow(8).values = ["B-400", "Polo", "White"];
  ws.getCell("B9").value = "TOTAL";
  ws.getCell("D9").value = { formula: "SUM(D4:D8)", result: 600 };
  ws.getCell("E9").value = { formula: "SUM(E4:E8)", result: 700 };
  ws.getCell("D3").font = { bold: true };
  ws.getCell("D4").numFmt = "#,##0";
  return wb;
}

const DATA = [
  { code: "B-400", sold: 4, on_hand: 40 },
  { code: "A-100", sold: 1, on_hand: 10 },
  { code: "B-300", sold: 3, on_hand: 30 },
  { code: "A-200", sold: 2, on_hand: 20 },
];
const FILL = { op: "fill_by_key" as const, sheet: "Items", key: { sheet: "CODE", data: "code" }, set: { SOLD: "sold", "ON HAND": "on_hand" } };

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tp-xlsx-fill-"));
  const out = join(dir, "out.xlsx");
  try {
    // -----------------------------------------------------------------------
    // fill_by_key: each row is found by its own key, whatever order the data
    // is in and whatever lies between the rows.
    // -----------------------------------------------------------------------
    {
      const wb = tracker();
      const { reports, written } = applyOps(wb, [{ ...FILL, rows: DATA }]);
      const back = (await save(wb, out)).getWorksheet("Items")!;
      check("A-100 gets its own figures", back.getCell("D4").value === 1 && back.getCell("E4").value === 10);
      check("A-200 gets its own figures", back.getCell("D5").value === 2 && back.getCell("E5").value === 20);
      check("B-300, after the blank line, gets its own", back.getCell("D7").value === 3 && back.getCell("E7").value === 30);
      check("B-400 gets its own figures", back.getCell("D8").value === 4 && back.getCell("E8").value === 40);
      check("the blank line stays blank", back.getCell("D6").value === null && back.getCell("E6").value === null);
      check("the totals row keeps its formula", (back.getCell("D9").value as ExcelJS.CellFormulaValue).formula === "SUM(D4:D8)");
      check("the title and the header are untouched", back.getCell("A1").value === "Season tracker" && back.getCell("D3").value === "SOLD");
      check("a filled cell keeps its format", back.getCell("D4").numFmt === "#,##0");
      const r = reports[0];
      check("the report names the header row and the columns", r.headerRow === 3 && r.keyColumns?.CODE === "A" && r.targetColumns?.SOLD === "D" && r.targetColumns?.["ON HAND"] === "E");
      check("the report counts the match", r.sheetRowsWithKey === 4 && r.matched === 4 && r.sheetRowsWithoutData === 0 && r.dataRowsNotInSheet === 0 && r.cellsWritten === 8);
      check("the report shows the first rows as they now read", r.firstRows?.[0]?.CODE === "A-100" && r.firstRows?.[0]?.SOLD === 1 && r.firstRows?.[0]?.["ON HAND"] === 10);
      check("every written cell is recorded for the read-back", written.get("Items")?.size === 8 && written.get("Items")?.get("E8") === 40);
    }

    // The same data in every order gives the same sheet.
    {
      const orders = [DATA, [...DATA].reverse(), [DATA[2], DATA[0], DATA[3], DATA[1]]];
      const results = orders.map((rows) => {
        const wb = tracker();
        applyOps(wb, [{ ...FILL, rows }]);
        return JSON.stringify(snapshot(wb));
      });
      check("row order of the data does not matter", results.every((r) => r === results[0]));
      const cols = DATA.map((d) => ({ on_hand: d.on_hand, sold: d.sold, extra: "x", code: d.code }));
      const wb = tracker();
      applyOps(wb, [{ ...FILL, rows: cols }]);
      check("column order of the data, and extra columns, do not matter", JSON.stringify(snapshot(wb)) === results[0]);
    }

    // What matches and what does not is counted and named.
    {
      const wb = tracker();
      const { reports } = applyOps(wb, [{ ...FILL, rows: [DATA[1], DATA[3], { code: "Z-999", sold: 9, on_hand: 9 }] }]);
      const r = reports[0];
      const ws = wb.getWorksheet("Items")!;
      check("matched rows are filled", ws.getCell("D4").value === 1 && ws.getCell("D5").value === 2);
      check("a sheet row with no data is left as it was", ws.getCell("D7").value === null && ws.getCell("E8").value === null);
      check("sheet rows without data are counted and named", r.sheetRowsWithoutData === 2 && r.sheetKeysWithoutData?.join() === "B-300,B-400");
      check("data rows not in the sheet are counted and named", r.dataRowsNotInSheet === 1 && r.dataKeysNotInSheet?.join() === "Z-999");
    }
    {
      const wb = tracker();
      applyOps(wb, [{ ...FILL, unmatched: "zero", rows: [DATA[1]] }]);
      const ws = wb.getWorksheet("Items")!;
      check('"unmatched: zero" writes 0 where there is no data', ws.getCell("D5").value === 0 && ws.getCell("E8").value === 0 && ws.getCell("D4").value === 1);
      check('"unmatched: zero" leaves keyless rows alone', ws.getCell("D6").value === null);
    }
    {
      const wb = tracker();
      const { reports } = applyOps(wb, [{ ...FILL, rows: [{ code: "A-100", sold: null, on_hand: 10 }, DATA[3]] }]);
      const ws = wb.getWorksheet("Items")!;
      check("an empty data value writes nothing and is counted", ws.getCell("D4").value === null && ws.getCell("E4").value === 10 && reports[0].emptyValuesLeft === 1);
    }

    // Keys that differ only by leading zeros, case, or number against text.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["ID", "QTY"];
      ws.getRow(2).values = ["00123"];
      ws.getRow(3).values = [456];
      ws.getRow(4).values = ["ab-7"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "id", data: "id" }, set: { QTY: "q" }, rows: [{ id: 123, q: 1 }, { id: "456", q: 2 }, { id: "AB-7", q: 3 }] }]);
      check("leading zeros, number-as-text and case are matched when unambiguous", ws.getCell("B2").value === 1 && ws.getCell("B3").value === 2 && ws.getCell("B4").value === 3);
      check("and the report says how many were matched that way", reports[0].matched === 3 && reports[0].matchedLoosely === 2);
      check("a header is found whatever its case", reports[0].keyColumns?.id === "A");
    }
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["ID", "QTY"];
      ws.getRow(2).values = ["00123"];
      ws.getRow(3).values = ["123"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "ID", data: "id" }, set: { QTY: "q" }, rows: [{ id: "0123", q: 5 }, { id: "123", q: 7 }] }]);
      check("two different codes are never taken for one", ws.getCell("B3").value === 7 && ws.getCell("B2").value === null && reports[0].sheetRowsWithoutData === 1);
    }

    // A key made of two columns.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["Store", "Item", "Qty"];
      ws.getRow(2).values = ["North", "Shirt"];
      ws.getRow(3).values = ["North", "Polo"];
      ws.getRow(4).values = ["South", "Shirt"];
      applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: [{ sheet: "Store", data: "s" }, { sheet: "Item", data: "i" }], set: { Qty: "q" }, rows: [{ s: "South", i: "Shirt", q: 3 }, { s: "North", i: "Polo", q: 2 }, { s: "North", i: "Shirt", q: 1 }] }]);
      check("a key of two columns", ws.getCell("C2").value === 1 && ws.getCell("C3").value === 2 && ws.getCell("C4").value === 3);
    }

    // Sheet rows that share a key each get the key's figures (a lookup), and are counted.
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("A6").value = "A-100";
      const { reports } = applyOps(wb, [{ ...FILL, rows: DATA }]);
      check("rows sharing a key each get its figures, and are counted", wb.getWorksheet("Items")!.getCell("D6").value === 1 && reports[0].sheetRowsSharingAKey === 2);
    }

    // -----------------------------------------------------------------------
    // fill_by_key: what is refused, and that nothing is written when it is.
    // -----------------------------------------------------------------------
    refused("two data rows for one key", tracker(), [{ ...FILL, rows: [...DATA, { code: "A-100", sold: 99, on_hand: 99 }] }], /more than one row for 1 key.*A-100/);
    refused("a header that is not in the sheet", tracker(), [{ ...FILL, set: { "UNITS SOLD": "sold" }, rows: DATA }], /no row with all of these headers.*Row 3 comes closest but lacks "UNITS SOLD".*"ON HAND"/);
    refused("a data column that is not in the data", tracker(), [{ ...FILL, set: { SOLD: "units" }, rows: DATA }], /the data has no column "units"/);
    refused("no key matches at all", tracker(), [{ ...FILL, rows: [{ code: "X", sold: 1, on_hand: 1 }] }], /No row of sheet "Items" has a key found in the data.*A-100.*"X"/);
    refused("a column that is numbers in some rows and text in others", tracker(), [{ ...FILL, rows: [DATA[0], { code: "A-100", sold: "12", on_hand: 1 }] }], /"sold" is a number in 1 rows and text in 1/);
    refused("the key named as a column to fill", tracker(), [{ ...FILL, set: { code: "code" }, rows: DATA }], /both as the key and as a column to fill/);
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("F3").value = "SOLD";
      refused("a header that appears twice", wb, [{ ...FILL, rows: DATA }], /more than one column headed "SOLD"/);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("D5").value = 77;
      refused("a target cell that already holds a value", wb, [{ ...FILL, rows: DATA }], /1 already filled \(D5\).*"overwrite": true/);
      applyOps(wb, [{ ...FILL, overwrite: true, rows: DATA }]);
      check('"overwrite": true replaces it', wb.getWorksheet("Items")!.getCell("D5").value === 2);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("E7").value = { formula: "C7*2", result: 0 };
      refused("a target cell that holds a formula", wb, [{ ...FILL, rows: DATA }], /1 a formula \(E7\)/);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.mergeCells("D4:D5");
      refused("a merged target cell, even with overwrite", wb, [{ ...FILL, overwrite: true, rows: DATA }], /merged.*Merged cells cannot be filled/);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.mergeCells("A4:A5");
      refused("a merged key cell", wb, [{ ...FILL, rows: DATA }], /Key cell A[45] is part of a merged cell/);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("A5").value = 12.5;
      refused("a key that is not a whole number", wb, [{ ...FILL, rows: DATA }], /Key cell A5 is a number that is not whole/);
    }
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("A5").value = { formula: "A4&\"x\"" } as ExcelJS.CellValue;
      refused("a key that is a formula with no stored result", wb, [{ ...FILL, rows: DATA }], /Key cell A5 is a formula with no stored result/);
    }

    // -----------------------------------------------------------------------
    // A long list (more than one page of a paged read), with the figures
    // handed over in another order than the sheet's: the case in which filling
    // by position put most rows' figures against other items. By key every row
    // is right; by position beside the items it is refused.
    // -----------------------------------------------------------------------
    {
      const build = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Variants");
        ws.getRow(1).values = ["ITEM ID", "DESIGN", "SIZE", "COLOUR", "A", "B", "C", "D", "UNITS SOLD", "UNITS ON HAND"];
        for (let i = 0; i < 400; i++) ws.getRow(i + 2).values = [100000 + i, `D${i % 40}`, ["S", "M", "L"][i % 3], `C${i % 11}`];
        return wb;
      };
      const truth = Array.from({ length: 400 }, (_, i) => ({ item_id: 100000 + i, sold: (i * 7) % 53, inv: (i * 13) % 211 }));
      // As the paged read returned them: sorted by the figures, not by the sheet.
      const scrambled = [...truth].sort((a, b) => a.sold - b.sold || a.inv - b.inv || a.item_id - b.item_id);
      check("the replay really is in another order", scrambled.filter((r, i) => r.item_id === truth[i].item_id).length < 20);

      const wb = build();
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "Variants", key: { sheet: "ITEM ID", data: "item_id" }, set: { "UNITS SOLD": "sold", "UNITS ON HAND": "inv" }, rows: scrambled }]);
      const back = (await save(wb, out)).getWorksheet("Variants")!;
      let right = 0;
      for (let i = 0; i < 400; i++) if (back.getCell(`I${i + 2}`).value === truth[i].sold && back.getCell(`J${i + 2}`).value === truth[i].inv) right++;
      check("by key: all 400 rows hold their own figures", right === 400 && reports[0].matched === 400 && reports[0].cellsWritten === 800);

      refused("by position beside the items: refused", build(), [{ op: "populate_sheet", sheet: "Variants", startCell: "I2", rows: scrambled.map((r) => ({ sold: r.sold, inv: r.inv })) }], /writes by position, and rows 2–401 .* already hold data in other columns.*Use fill_by_key/);
    }

    // -----------------------------------------------------------------------
    // populate_sheet: by position, so only where nothing can be misaligned.
    // -----------------------------------------------------------------------
    {
      const template = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("T");
        ws.getRow(1).values = ["Store", "Qty", "Amount"];
        return wb;
      };
      const rows = [{ store: "N", qty: 1, amount: 10 }, { store: "S", qty: 2, amount: 20 }];
      const wb = template();
      const { reports } = applyOps(wb, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows }]);
      check("an empty area under a header is filled", wb.getWorksheet("T")!.getCell("C3").value === 20 && reports[0].range === "A2:C3" && reports[0].rowsWritten === 2);

      const wb2 = template();
      applyOps(wb2, [{ op: "populate_sheet", sheet: "T", startCell: "$A$2", columns: [{ key: "store" }, { key: "amount" }, { key: "qty" }], rows }]);
      check('"columns" chooses which data columns are written, and in what order', wb2.getWorksheet("T")!.getCell("B2").value === 10 && wb2.getWorksheet("T")!.getCell("C2").value === 1);

      for (const bad of ["A2:C3", "T!A2", "A", "2", "", undefined]) {
        refused(`start cell ${JSON.stringify(bad)}`, template(), [{ op: "populate_sheet", sheet: "T", startCell: bad as string, rows }], /"startCell" must be one cell/);
      }
      refused("a column the data does not have", template(), [{ op: "populate_sheet", sheet: "T", startCell: "A2", columns: [{ key: "store" }, { key: "units" }], rows }], /the data has no column "units"/);
      refused("columns named with numbers, which do not keep their order", template(), [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows: [{ store: "N", "2025": 1, "2024": 2 }] }], /column named with a number.*Give "columns"/);
      refused("rows that do not all have the same columns", template(), [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows: [{ store: "N", qty: 1 }, { store: "S", amount: 2 }] }], /does not have the same columns/);
      const filled = template();
      filled.getWorksheet("T")!.getCell("B2").value = 5;
      refused("an area that is not empty", filled, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows }], /already filled \(B2\)/);
      const totals = template();
      totals.getWorksheet("T")!.getCell("B3").value = { formula: "SUM(B2:B2)", result: 0 };
      refused("an extra row that would run over the totals", totals, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows }], /a formula \(B3\)/);
    }

    // -----------------------------------------------------------------------
    // append_rows: under the header of the same name.
    // -----------------------------------------------------------------------
    {
      const log = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Log");
        ws.getRow(1).values = ["Date", "Store", "Qty"];
        ws.getRow(2).values = ["2026-01-01", "N", 1];
        return wb;
      };
      const wb = log();
      const { reports } = applyOps(wb, [{ op: "append_rows", sheet: "Log", rows: [{ Qty: 2, Store: "S", Date: "2026-01-02" }] }]);
      const ws = wb.getWorksheet("Log")!;
      check("each value goes under its own header", ws.getCell("A3").value === "2026-01-02" && ws.getCell("B3").value === "S" && ws.getCell("C3").value === 2 && reports[0].range === "A3:C3");
      refused("a column with no header in the sheet", log(), [{ op: "append_rows", sheet: "Log", rows: [{ Date: "x", Shop: "S", Qty: 2 }] }], /lacks "Shop"/);
      const withTotals = log();
      withTotals.getWorksheet("Log")!.getCell("C3").value = { formula: "SUM(C2:C2)", result: 1 };
      refused("a sheet that ends in its totals", withTotals, [{ op: "append_rows", sheet: "Log", rows: [{ Date: "x", Store: "S", Qty: 2 }] }], /ends in a row of formulas \(row 3\)/);
    }

    // set_cell takes one cell.
    refused("set_cell with a range", tracker(), [{ op: "set_cell", sheet: "Items", cell: "A1:B2", value: 1 }], /"cell" must be one cell/);
    check("a cell reference may carry $ signs", parseSingleCell("$AB$12", "x").col === 28 && parseSingleCell("ab12", "x").row === 12);

    // -----------------------------------------------------------------------
    // After a fill: a total must not go on showing its old figure, and the
    // saved file must be the base plus exactly what was written.
    // -----------------------------------------------------------------------
    {
      const base = tracker();
      const basePath = join(dir, "base.xlsx");
      await base.xlsx.writeFile(basePath);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(basePath);
      const { written } = applyOps(wb, [{ ...FILL, rows: DATA }]);
      check("stored formula results are dropped", dropFormulaResults(wb) === 2 && wb.calcProperties.fullCalcOnLoad === true);
      const saved = await save(wb, out);
      const total = saved.getWorksheet("Items")!.getCell("D9").value as ExcelJS.CellFormulaValue;
      check("the saved total is a formula with no stale result", total.formula === "SUM(D4:D8)" && (total.result === undefined || total.result === null));
      // exceljs writes this setting but does not read it back, so the file itself is asked.
      const workbookXml = await (await JSZip.loadAsync(await readFile(out))).file("xl/workbook.xml")!.async("string");
      check("the saved file asks Excel to calculate on opening", /<calcPr[^>]*fullCalcOnLoad="1"/.test(workbookXml));

      const pristine = new ExcelJS.Workbook();
      await pristine.xlsx.readFile(basePath);
      check("read back: what was written is there and nothing else changed", compareWithBase(pristine, saved, written).length === 0);

      saved.getWorksheet("Items")!.getCell("C5").value = "Green";
      check("read back: a cell that changed without being written is caught", compareWithBase(pristine, saved, written).some((w) => /Items!C5 was s:Olive and now reads s:Green/.test(w)));
      saved.getWorksheet("Items")!.getCell("C5").value = "Olive";
      saved.getWorksheet("Items")!.getCell("D7").value = 33;
      check("read back: a written cell that reads otherwise is caught", compareWithBase(pristine, saved, written).some((w) => /Items!D7 was written as n:3 and reads n:33/.test(w)));
    }

    // A sheet with a filled-down (shared) formula survives the round trip unchanged.
    {
      const wb0 = new ExcelJS.Workbook();
      const ws0 = wb0.addWorksheet("F");
      ws0.getRow(1).values = ["CODE", "QTY", "PRICE", "VALUE"];
      for (let i = 0; i < 5; i++) ws0.getRow(i + 2).values = [`K${i}`, null, 10 + i];
      ws0.fillFormula("D2:D6", "B2*C2", [0, 0, 0, 0, 0]);
      const basePath = join(dir, "shared.xlsx");
      await wb0.xlsx.writeFile(basePath);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(basePath);
      const { written } = applyOps(wb, [{ op: "fill_by_key", sheet: "F", key: { sheet: "CODE", data: "c" }, set: { QTY: "q" }, rows: [0, 1, 2, 3, 4].map((i) => ({ c: `K${i}`, q: i + 1 })) }]);
      dropFormulaResults(wb);
      const saved = await save(wb, out);
      const pristine = new ExcelJS.Workbook();
      await pristine.xlsx.readFile(basePath);
      check("filled-down formulas are intact after a fill beside them", compareWithBase(pristine, saved, written).length === 0 && saved.getWorksheet("F")!.getCell("D4").formula === "B4*C4");
    }

    // -----------------------------------------------------------------------
    // The request is checked whole, and nothing it says is quietly dropped.
    // -----------------------------------------------------------------------
    const invalid = (label: string, spec: unknown, pattern: RegExp) => {
      let message = "";
      try {
        validateDocSpec(spec as XlsxDocSpec);
      } catch (e) {
        message = (e as Error).message;
      }
      check(`${label} (${message.slice(0, 60)})`, pattern.test(message));
    };
    const src = { rows: [{ a: 1 }] };
    validateDocSpec({ title: "ok", sheets: [{ name: "S", source: src, columns: [{ key: "a" }] }] });
    validateDocSpec({ title: "ok", base: { fileId: "f" }, ops: [{ op: "fill_by_key", sheet: "S", key: { sheet: "A", data: "a" }, set: { B: "a" }, source: src }, { op: "set_cell", sheet: "S", cell: "A1", value: null }] });
    validateDocSpec({ title: "ok", base: { fileId: "f" }, ops: [{ op: "append_rows", sheet: "S", source: { fileId: "x", sql: "SELECT 1" } }] } as XlsxDocSpec);
    check("requests that say only what is used are accepted", true);
    invalid("a column list on append_rows", { base: { fileId: "f" }, ops: [{ op: "append_rows", sheet: "S", source: src, columns: [{ key: "a" }] }] }, /Op 1 \(append_rows\): "columns" is not used here/);
    invalid("a style on populate_sheet", { base: { fileId: "f" }, ops: [{ op: "populate_sheet", sheet: "S", startCell: "A2", source: src, style: {} }] }, /"style" is not used here/);
    invalid("sql beside inline rows", { sheets: [{ name: "S", source: { rows: [], sql: "SELECT 1" } }] }, /"sql" does nothing with "rows"/);
    invalid("an order on a source", { sheets: [{ name: "S", source: { fileId: "x", order_by: "a" } }] }, /source: "order_by" is not used here/);
    invalid("sheets and ops together", { base: { fileId: "f" }, sheets: [{ name: "S", source: src }], ops: [{ op: "set_cell", sheet: "S", cell: "A1", value: 1 }] }, /not both/);
    invalid("ops with no base", { ops: [{ op: "set_cell", sheet: "S", cell: "A1", value: 1 }] }, /"ops" need a "base"/);
    invalid("an op that does not exist", { base: { fileId: "f" }, ops: [{ op: "fill_sheet", sheet: "S" }] }, /"fill_sheet" is not an op/);
    invalid("an op missing what it needs", { base: { fileId: "f" }, ops: [{ op: "fill_by_key", sheet: "S", source: src }] }, /needs "key", "set"/);
    invalid("a populate with no start cell", { base: { fileId: "f" }, ops: [{ op: "populate_sheet", sheet: "S", source: src }] }, /needs "startCell"/);
    invalid("a source with neither a file nor rows", { sheets: [{ name: "S", source: {} }] }, /needs a file to read or "rows"/);
    invalid("an unknown field at the top", { title: "x", sheets: [{ name: "S", source: src }], format: "wide" }, /The request: "format" is not used here/);

    // A header search does not mistake a title row for the header.
    {
      const ws = tracker().getWorksheet("Items")!;
      check("the header row is found below a title", findHeaderRow(ws, ["CODE", "SOLD"]).row === 3);
    }

    console.log(`\n✓ xlsx-fill: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ xlsx-fill test failed:", err);
  process.exit(1);
});
