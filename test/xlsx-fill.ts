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

// Dates in a sheet are kept in UTC. A reader that used the local date would
// agree with this in Asia and be a day out here, so the tests run here.
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { applyOps, validateDocSpec, type ResolvedOp, type XlsxDocSpec } from "../src/files/documents.js";
import { DocOpError, compareWithBase, dropFormulaResults, findHeaderRow, lastValueRow, parseSingleCell, rangesOn, readsColumns, signaturesOf, translatesSafely } from "../src/files/documentFill.js";

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

    // The same key on two sheet rows: two different rows that one key cannot tell apart, unless the caller says otherwise.
    {
      const twice = () => {
        const wb = tracker();
        wb.getWorksheet("Items")!.getCell("A6").value = "A-100";
        return wb;
      };
      refused("a key on two sheet rows", twice(), [{ ...FILL, rows: DATA }], /1 key appears on more than one row .*"A-100" on rows 4, 6.*list of two columns.*"sharedKeys": "fill_each"/);
      const wb = twice();
      const { reports } = applyOps(wb, [{ ...FILL, sharedKeys: "fill_each", rows: DATA }]);
      check('with "sharedKeys": "fill_each" each such row gets the key\'s figures, and they are counted', wb.getWorksheet("Items")!.getCell("D6").value === 1 && wb.getWorksheet("Items")!.getCell("D4").value === 1 && reports[0].sheetRowsSharingAKey === 2);
    }

    // -----------------------------------------------------------------------
    // fill_by_key: what is refused, and that nothing is written when it is.
    // -----------------------------------------------------------------------
    refused("two data rows for one key", tracker(), [{ ...FILL, rows: [...DATA, { code: "A-100", sold: 99, on_hand: 99 }] }], /more than one row for 1 key.*A-100/);
    refused("a header that is not in the sheet", tracker(), [{ ...FILL, set: { "UNITS SOLD": "sold" }, rows: DATA }], /no row with all of these headers.*Row 3 comes closest but lacks "UNITS SOLD".*"ON HAND"/);
    refused("a data column that is not in the data", tracker(), [{ ...FILL, set: { SOLD: "units" }, rows: DATA }], /the data has no column "units"/);
    refused("no key matches at all", tracker(), [{ ...FILL, rows: [{ code: "X", sold: 1, on_hand: 1 }] }], /No row of sheet "Items" in rows 4–9 has a key found in the data.*A-100.*"X"/);
    refused("a column that is numbers in some rows and text in others", tracker(), [{ ...FILL, rows: [DATA[0], { code: "A-100", sold: "12", on_hand: 1 }] }], /"sold" is a number in 1 rows and text in 1/);
    refused("the key named as a column to fill", tracker(), [{ ...FILL, set: { code: "code" }, rows: DATA }], /both as the key and as a column to fill/);
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("F3").value = "SOLD";
      refused("a header that appears twice", wb, [{ ...FILL, rows: DATA }], /"SOLD" heads columns D and F.*as "column:D"/);
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
    // A row whose key cell cannot be read as a key is passed over and reported; the other rows are filled.
    {
      const wb = tracker();
      const ws = wb.getWorksheet("Items")!;
      ws.mergeCells("A4:A5"); // a heading merged over two rows
      const { reports } = applyOps(wb, [{ ...FILL, rows: DATA }]);
      check("rows under a merged key are passed over, the rest are filled", ws.getCell("D4").value === null && ws.getCell("D5").value === null && ws.getCell("D7").value === 3 && ws.getCell("D8").value === 4);
      check("and are reported with the reason", reports[0].rowsWithUnreadableKey === 2 && /row 4 \(part of a merged cell\)/.test(reports[0].unreadableKeys!.join()) && reports[0].matched === 2);
    }
    {
      const wb = tracker();
      const ws = wb.getWorksheet("Items")!;
      ws.getCell("A5").value = 12.5;
      ws.getCell("A7").value = { formula: 'A4&"x"' } as ExcelJS.CellValue;
      const { reports } = applyOps(wb, [{ ...FILL, rows: DATA }]);
      check("a key that is a decimal, or a formula with no stored result, is passed over and reported", ws.getCell("D5").value === null && ws.getCell("D7").value === null && ws.getCell("D4").value === 1 && reports[0].rowsWithUnreadableKey === 2 && /not whole/.test(reports[0].unreadableKeys![0]) && /formula with no stored result/.test(reports[0].unreadableKeys![1]));
    }
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["Store", "Item", "Qty"];
      ws.getRow(2).values = ["North", "Shirt"];
      ws.getRow(3).values = [null, "Polo"]; // the store is written once per group
      ws.getRow(4).values = ["South", "Shirt"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: [{ sheet: "Store", data: "s" }, { sheet: "Item", data: "i" }], set: { Qty: "q" }, rows: [{ s: "North", i: "Shirt", q: 1 }, { s: "North", i: "Polo", q: 2 }, { s: "South", i: "Shirt", q: 3 }] }]);
      check("a row with only part of a several-column key is passed over and counted", ws.getCell("C3").value === null && ws.getCell("C2").value === 1 && reports[0].rowsWithPartialKey === 1 && reports[0].dataRowsNotInSheet === 1);
    }
    refused("no readable key at all", (() => { const wb = tracker(); wb.getWorksheet("Items")!.mergeCells("A4:A8"); return wb; })(), [{ ...FILL, rows: DATA }], /no rows with a readable key/);

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

      const wb2 = new ExcelJS.Workbook();
      wb2.addWorksheet("T").getRow(1).values = ["Store", "Sales value", "Units"];
      applyOps(wb2, [{ op: "populate_sheet", sheet: "T", startCell: "$A$2", columns: [{ key: "store" }, { key: "amount" }, { key: "qty" }], rows }]);
      check('"columns" chooses which data columns are written, and in what order', wb2.getWorksheet("T")!.getCell("B2").value === 10 && wb2.getWorksheet("T")!.getCell("C2").value === 1);
      refused("an order that puts the amount under Qty", template(), [{ op: "populate_sheet", sheet: "T", startCell: "A2", columns: [{ key: "store" }, { key: "amount" }, { key: "qty" }], rows }], /column B is headed "Qty" but would receive "amount"/);

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
      refused("a sheet that ends in its totals", withTotals, [{ op: "append_rows", sheet: "Log", rows: [{ Date: "x", Store: "S", Qty: 2 }] }], /The last row of sheet "Log" that holds anything \(row 3\) has formulas/);
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
      const was = signaturesOf(pristine).sheets;
      check("read back: what was written is there and nothing else changed", compareWithBase(was, saved, written).length === 0);

      saved.getWorksheet("Items")!.getCell("C5").value = "Green";
      check("read back: a cell that changed without being written is caught", compareWithBase(was, saved, written).some((w) => /Items!C5 was s:Olive and now reads s:Green/.test(w)));
      saved.getWorksheet("Items")!.getCell("C5").value = "Olive";
      saved.getWorksheet("Items")!.getCell("D7").value = 33;
      check("read back: a written cell that reads otherwise is caught", compareWithBase(was, saved, written).some((w) => /Items!D7 was written as n:3 and reads n:33/.test(w)));
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
      check("filled-down formulas are intact after a fill beside them", compareWithBase(signaturesOf(pristine).sheets, saved, written).length === 0 && saved.getWorksheet("F")!.getCell("D4").formula === "B4*C4");
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
    invalid("a theme that does not exist", { theme: "modern", sheets: [{ name: "S", source: src }] }, /theme "modern" is not one of corporate, plain/);
    invalid("a column field that does nothing", { sheets: [{ name: "S", source: src, columns: [{ key: "a", align: "right" }] }] }, /Sheet 1 column 1: "align" is not used here/);
    invalid("a header or a format on a populate_sheet column", { base: { fileId: "f" }, ops: [{ op: "populate_sheet", sheet: "S", startCell: "A2", source: src, columns: [{ key: "a", header: "A", numFmt: "0" }] }] }, /populate_sheet\) column 1: "header", "numFmt" are not used here/);
    invalid("a column with no key", { sheets: [{ name: "S", source: src, columns: [{ header: "A" }] }] }, /column 1 needs a "key"/);
    invalid("set_cell with no value", { base: { fileId: "f" }, ops: [{ op: "set_cell", sheet: "S", cell: "A1" }] }, /set_cell\) needs "value" \(null to empty the cell\)/);
    invalid("a style field that does nothing", { sheets: [{ name: "S", source: src, style: { header: { bold: true, italic: true }, zoom: 2 } }] }, /style: "zoom" is not used here.*style header: "italic" is not used here/);
    invalid("an unmatched mode that does not exist", { base: { fileId: "f" }, ops: [{ op: "fill_by_key", sheet: "S", key: { sheet: "A", data: "a" }, set: { B: "a" }, unmatched: "blank", source: src }] }, /"unmatched" is "leave" or "zero"/);
    invalid("a sharedKeys mode that does not exist", { base: { fileId: "f" }, ops: [{ op: "fill_by_key", sheet: "S", key: { sheet: "A", data: "a" }, set: { B: "a" }, sharedKeys: "yes", source: src }] }, /"sharedKeys" is "refuse" or "fill_each"/);
    validateDocSpec({ base: { fileId: "f" }, ops: [{ op: "fill_by_key", sheet: "S", key: { sheet: "A", data: "a" }, set: { B: "a" }, sharedKeys: "fill_each", unmatched: "zero", overwrite: true, source: src }] });
    check("every option fill_by_key takes is accepted", true);

    // A header search does not mistake a title row for the header.
    {
      const ws = tracker().getWorksheet("Items")!;
      check("the header row is found below a title", findHeaderRow(ws, ["CODE", "SOLD"]).row === 3);
    }

    // -----------------------------------------------------------------------
    // Found by an independent review of the first version of this code.
    // -----------------------------------------------------------------------

    // "Items with no sales are 0": nothing a row without data already holds is written over, whatever is asked.
    // Such a row may be an item that sold nothing, or the sheet's own total or a heading in the key column.
    {
      const sheet = () => {
        const wb = tracker();
        const ws = wb.getWorksheet("Items")!;
        ws.getCell("A9").value = "TOTAL"; // a totals row labelled in the key column, with formulas
        ws.getCell("A10").value = "GRAND TOTAL"; // and one with figures somebody typed
        ws.getCell("D10").value = 600;
        ws.getCell("D5").value = 77; // last month's figure for an item with no data now
        return wb;
      };
      const wb = sheet();
      const { reports } = applyOps(wb, [{ ...FILL, unmatched: "zero", overwrite: true, rows: [DATA[1]] }]);
      const ws = wb.getWorksheet("Items")!;
      check("totals keep their formulas", (ws.getCell("D9").value as ExcelJS.CellFormulaValue).formula === "SUM(D4:D8)" && (ws.getCell("E9").value as ExcelJS.CellFormulaValue).formula === "SUM(E4:E8)");
      check("a typed total is not turned into 0", ws.getCell("D10").value === 600);
      check("a figure already there is kept, not zeroed", ws.getCell("D5").value === 77);
      check("empty cells of rows without data are set to 0", ws.getCell("E5").value === 0 && ws.getCell("D7").value === 0 && ws.getCell("E8").value === 0 && ws.getCell("E10").value === 0 && ws.getCell("D4").value === 1);
      const r = reports[0];
      check("the report says what was set, what was kept, and for which keys", r.unmatched === "zero" && r.unmatchedCellsSet === 6 && r.formulasKept === 2 && r.unmatchedValuesKept === 2 && r.keysThatKeptTheirValues?.join() === "A-200,GRAND TOTAL" && r.sheetRowsWithoutData === 5);
      // To make an item's old figure 0, the caller gives the item a row: then it is a row the data has.
      const explicit = sheet();
      applyOps(explicit, [{ ...FILL, overwrite: true, rows: [DATA[1], { code: "A-200", sold: 0, on_hand: 0 }] }]);
      check("an item given a row with 0 is set to 0", explicit.getWorksheet("Items")!.getCell("D5").value === 0 && explicit.getWorksheet("Items")!.getCell("D10").value === 600);
      const left = sheet();
      const leftReport = applyOps(left, [{ ...FILL, rows: [DATA[1]] }]).reports[0];
      check('by default rows without data are left as they were, and the report says "leave"', left.getWorksheet("Items")!.getCell("D5").value === 77 && left.getWorksheet("Items")!.getCell("E5").value === null && leftReport.unmatched === "leave" && leftReport.unmatchedCellsSet === undefined);
      // A row the data has, with no value for a column, is not a row without data: nothing is put there.
      const nulls = tracker();
      const nr = applyOps(nulls, [{ ...FILL, unmatched: "zero", rows: [{ code: "A-100", sold: null, on_hand: 10 }] }]).reports[0];
      check("an empty value in a row the data has is not turned into 0", nulls.getWorksheet("Items")!.getCell("D4").value === null && nulls.getWorksheet("Items")!.getCell("E4").value === 10 && nr.emptyValuesLeft === 1);
      refused("an option that does not exist", tracker(), [{ ...FILL, unmatched: "blank" as never, rows: DATA }], /"unmatched" is "leave" or "zero"/);
    }
    // A refusal over formulas does not send the caller straight to "overwrite".
    {
      const wb = tracker();
      wb.getWorksheet("Items")!.getCell("E7").value = { formula: "C7*2", result: 0 };
      let message = "";
      try {
        applyOps(wb, [{ ...FILL, rows: DATA }]);
      } catch (e) {
        message = (e as Error).message;
      }
      check("a formula in the way is explained before overwrite is mentioned", /the sheet's own calculations.*almost never meant to be replaced.*Only if the user asked/.test(message));
    }

    // Loose matching is one-to-one on the sheet side as well as on the data side.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["ID", "QTY"];
      ws.getRow(2).values = ["00123"];
      ws.getRow(3).values = ["0123"];
      ws.getRow(4).values = ["X"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "ID", data: "id" }, set: { QTY: "q" }, rows: [{ id: "123", q: 5 }, { id: "X", q: 9 }] }]);
      check("two sheet codes that differ only by zeros never share one data row", ws.getCell("B2").value === null && ws.getCell("B3").value === null && ws.getCell("B4").value === 9 && reports[0].sheetRowsWithoutData === 2 && reports[0].matchedLoosely === undefined);
      // and on the data side: one sheet code, two data codes it could loosely be
      const amb = new ExcelJS.Workbook();
      const sa = amb.addWorksheet("S");
      sa.getRow(1).values = ["ID", "QTY"];
      sa.getRow(2).values = ["00123"];
      sa.getRow(3).values = ["X"];
      const ra = applyOps(amb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "ID", data: "id" }, set: { QTY: "q" }, rows: [{ id: "0123", q: 5 }, { id: "123", q: 7 }, { id: "X", q: 9 }] }]).reports[0];
      check("one sheet code is never given the figures of one of two data codes it could be", sa.getCell("B2").value === null && sa.getCell("B3").value === 9 && ra.sheetRowsWithoutData === 1 && ra.dataRowsNotInSheet === 2);
      const ok = new ExcelJS.Workbook();
      const s2 = ok.addWorksheet("S");
      s2.getRow(1).values = ["ID", "QTY"];
      s2.getRow(2).values = ["00123"];
      const r2 = applyOps(ok, [{ op: "fill_by_key", sheet: "S", key: { sheet: "ID", data: "id" }, set: { QTY: "q" }, rows: [{ id: 123, q: 5 }] }]).reports[0];
      check("a loose match names the two keys it joined", r2.matchedLoosely === 1 && r2.looselyMatchedKeys?.[0]?.sheet === "00123" && r2.looselyMatchedKeys?.[0]?.data === "123");
    }

    // A date key is the calendar date in the sheet, in whatever time zone this runs.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["Day", "Qty"];
      ws.getCell("A2").value = new Date(Date.UTC(2026, 0, 5));
      ws.getCell("A3").value = new Date(Date.UTC(2026, 0, 6));
      applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "Day", data: "d" }, set: { Qty: "q" }, rows: [{ d: "2026-01-06", q: 6 }, { d: "2026-01-05", q: 5 }] }]);
      check("date keys match their own day", ws.getCell("B2").value === 5 && ws.getCell("B3").value === 6);
    }

    // A second table below the first, under the same header, is not touched.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Store North";
      ws.getRow(2).values = ["CODE", "SOLD"];
      ws.getRow(3).values = ["A-1"];
      ws.getRow(4).values = ["A-2"];
      ws.getCell("A6").value = "Store South";
      ws.getRow(7).values = ["CODE", "SOLD"];
      ws.getRow(8).values = ["A-1"];
      ws.getRow(9).values = ["A-2"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 1 }, { c: "A-2", q: 2 }] }]);
      check("the first table is filled", ws.getCell("B3").value === 1 && ws.getCell("B4").value === 2);
      check("the table below it, with the same codes, is left alone and that is reported", ws.getCell("B8").value === null && ws.getCell("B9").value === null && reports[0].stoppedAtRow === 7 && reports[0].matched === 2);
      check("with why, the rows that were read, and that the data's keys are also found below", reports[0].stoppedBecause === "the same headers again" && reports[0].firstRow === 3 && reports[0].lastRow === 6 && reports[0].dataKeysBelowStop === 2);
      // The second table is reached by saying which row its headers are on.
      const second = applyOps(wb, [{ op: "fill_by_key", sheet: "S", headerRow: 7, key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 10 }, { c: "A-2", q: 20 }] }]).reports[0];
      check("the second table is filled by its header row, and the first is as it was", ws.getCell("B8").value === 10 && ws.getCell("B9").value === 20 && ws.getCell("B3").value === 1 && ws.getCell("B4").value === 2 && second.headerRow === 7 && second.firstRow === 8 && second.stoppedAtRow === undefined);
      const byLetter = applyOps(wb, [{ op: "fill_by_key", sheet: "S", headerRow: 2, overwrite: true, key: { sheet: "column:A", data: "c" }, set: { "column:B": "q" }, rows: [{ c: "A-1", q: 1 }, { c: "A-2", q: 2 }] }]).reports[0];
      check("with the columns named by letter, the same headers again still end the table", byLetter.stoppedAtRow === 7 && byLetter.stoppedBecause === "the same headers again" && ws.getCell("B8").value === 10);
      refused("a header row that is not one", wb, [{ op: "fill_by_key", sheet: "S", headerRow: 6, key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 1 }] }], /Row 6 of sheet "S" does not hold "CODE", "SOLD"\. It holds: "Store South"/);
      // Said to be one table down to row 9, the same codes are on two rows each: that is asked about, not guessed.
      refused("one table said to span both", wb, [{ op: "fill_by_key", sheet: "S", lastRow: 9, overwrite: true, key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 1 }] }], /"A-1" on rows 3, 8.*two tables one below the other.*"headerRow".*"lastRow"/);
      // The heading of the second block sits in the key column: it is a row with a key and no data, and is said so.
      check("a label in the key column counts as a row without data", reports[0].sheetRowsWithKey === 3 && reports[0].sheetKeysWithoutData?.join() === "Store South");
    }

    // A figure that is not a number at all is not written.
    {
      const wb = tracker();
      const { reports } = applyOps(wb, [{ ...FILL, rows: [{ code: "A-100", sold: Infinity, on_hand: NaN }, DATA[3]] }]);
      check("infinity and not-a-number are left out and counted", wb.getWorksheet("Items")!.getCell("D4").value === null && wb.getWorksheet("Items")!.getCell("E4").value === null && reports[0].emptyValuesLeft === 2);
    }

    // No header found at all: the refusal shows the headers the sheet has.
    refused("headers that are nowhere in the sheet", tracker(), [{ ...FILL, key: { sheet: "SKU", data: "code" }, set: { UNITS: "sold" }, rows: DATA }], /none of these headers.*Its header row looks like row 3: "CODE", "Description", "Colour", "SOLD", "ON HAND"/);

    // A template whose rows are worked out by a formula beside the block is still an empty area.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("T");
      ws.getRow(1).values = ["Qty", "Price", "Value"];
      for (let r = 2; r <= 4; r++) ws.getCell(`C${r}`).value = { formula: `A${r}*B${r}`, result: 0 };
      applyOps(wb, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows: [{ q: 1, p: 10 }, { q: 2, p: 20 }, { q: 3, p: 30 }] }]);
      check("a block beside a formula column is written", ws.getCell("B4").value === 30 && (ws.getCell("C4").value as ExcelJS.CellFormulaValue).formula === "A4*B4");
      const numbered = new ExcelJS.Workbook();
      const wn = numbered.addWorksheet("T");
      wn.getRow(1).values = ["No.", "Qty"];
      wn.getRow(2).values = [1];
      wn.getRow(3).values = [2];
      refused("a block beside numbered rows, with the way to do it", numbered, [{ op: "populate_sheet", sheet: "T", startCell: "B2", rows: [{ q: 5 }, { q: 6 }] }], /already hold data in other columns \(A2, A3\).*only numbers the rows 1, 2, 3 will do/);
      applyOps(numbered, [{ op: "fill_by_key", sheet: "T", key: { sheet: "No.", data: "n" }, set: { Qty: "q" }, rows: [{ n: 2, q: 6 }, { n: 1, q: 5 }] }]);
      check("and that way works", wn.getCell("B2").value === 5 && wn.getCell("B3").value === 6);
    }

    // Rows that are only formatted (borders drawn far down) are not content.
    {
      const sheet = (totals: boolean) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Log");
        ws.getRow(1).values = ["Date", "Qty"];
        ws.getRow(2).values = ["2026-01-01", 1];
        if (totals) ws.getCell("B3").value = { formula: "SUM(B2:B2)", result: 1 };
        for (let r = 3; r <= 60; r++) ws.getCell(`A${r}`).border = { bottom: { style: "thin" } };
        return wb;
      };
      const wb = sheet(false);
      check("the sheet's own row count is fooled by formatting", wb.getWorksheet("Log")!.rowCount === 60 && lastValueRow(wb.getWorksheet("Log")!) === 2);
      const { reports } = applyOps(wb, [{ op: "append_rows", sheet: "Log", rows: [{ Date: "2026-01-02", Qty: 2 }] }]);
      check("rows are appended after the last row that holds something", wb.getWorksheet("Log")!.getCell("B3").value === 2 && reports[0].range === "A3:B3");
      refused("a totals row is seen though formatted rows follow it", sheet(true), [{ op: "append_rows", sheet: "Log", rows: [{ Date: "x", Qty: 2 }] }], /The last row of sheet "Log" that holds anything \(row 3\) has formulas/);
    }

    // What the saved file is compared with, and what the comparison lets through.
    {
      const base = tracker();
      const ws0 = base.getWorksheet("Items")!;
      ws0.mergeCells("A1:C1"); // a merged title
      ws0.getCell("B4").value = "Shirt DELETEMARK";
      ws0.getCell("D9").value = { formula: "SUM(D4:D8)", result: 0 }; // an empty template's total
      const basePath = join(dir, "base2.xlsx");
      await base.xlsx.writeFile(basePath);
      // A file from elsewhere can hold a character this writer leaves out (here DEL, 0x7F). It is
      // put into the file itself, since a file this library wrote would never contain it.
      const zip = await JSZip.loadAsync(await readFile(basePath));
      const shared = await zip.file("xl/sharedStrings.xml")!.async("string");
      zip.file("xl/sharedStrings.xml", shared.replace("DELETEMARK", "\u007f"));
      await writeFile(basePath, await zip.generateAsync({ type: "nodebuffer" }));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(basePath);
      check("the base really holds a character the writer drops", String(wb.getWorksheet("Items")!.getCell("B4").value).includes("\u007f"));
      const before = signaturesOf(wb);
      const { written } = applyOps(wb, [{ ...FILL, rows: DATA }, { op: "set_cell", sheet: "Items", cell: "B1", value: "Season tracker, refreshed" }]);
      dropFormulaResults(wb);
      const saved = await save(wb, out);
      check("a cell inside a merged title sets the title, and the read-back agrees", saved.getWorksheet("Items")!.getCell("A1").value === "Season tracker, refreshed" && compareWithBase(before.sheets, saved, written).length === 0);
      const sheetXml = await (await JSZip.loadAsync(await readFile(out))).file("xl/worksheets/sheet1.xml")!.async("string");
      const d9 = /<c r="D9"[^>]*>(.*?)<\/c>/.exec(sheetXml)?.[1] ?? "";
      check("a total that showed 0 has no stored result left in the file", /<f>SUM\(D4:D8\)<\/f>/.test(d9) && !/<v>/.test(d9));
      saved.getWorksheet("Items")!.getCell("G20").value = "stray";
      check("a cell that appears only in the saved file is caught", compareWithBase(before.sheets, saved, written).some((w) => /Items!G20 was \(blank\) and now reads s:stray/.test(w)));
      check("the base's cells are counted", before.cells > 20);
    }

    // -----------------------------------------------------------------------
    // Found by a second independent review.
    // -----------------------------------------------------------------------

    // A second table below the first under DIFFERENT headers: its columns mean something else.
    {
      const stacked = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("S");
        ws.getRow(1).values = ["CODE", "SOLD"];
        ws.getRow(2).values = ["A-1"];
        ws.getRow(3).values = ["A-2"];
        ws.getCell("A5").value = "Returns";
        ws.getRow(6).values = ["ITEM", "RETURNED"];
        ws.getRow(7).values = ["B-1", 3];
        ws.getRow(8).values = ["B-2"];
        return wb;
      };
      const three = [{ c: "A-1", q: 1 }, { c: "A-2", q: 2 }, { c: "B-2", q: 9 }];
      const sold = (extra: object, rows: object[]) => [{ op: "fill_by_key" as const, sheet: "S", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, ...extra, rows: rows as Record<string, unknown>[] }];
      // A key of the data sits below the row of headings: which table it belongs to is asked, not guessed.
      refused("a row of headings with the data's keys below it", stacked(), sold({}, three), /Row 6 of sheet "S" looks like the headings of another table \(A6 "ITEM", B6 "RETURNED"\), and 1 of the data's keys are found below it \(for example "B-2"\).*"lastRow": 5.*the sheet's last row with anything in it is 8/);
      const wb = stacked();
      const ws = wb.getWorksheet("S")!;
      const { reports } = applyOps(wb, sold({ lastRow: 5 }, three));
      check("a sold figure is never written under the other table's heading", ws.getCell("B8").value === null && ws.getCell("B7").value === 3 && ws.getCell("B2").value === 1 && ws.getCell("B3").value === 2);
      check("told where the table ends, the fill reads to there and says so", reports[0].lastRow === 5 && reports[0].stoppedAtRow === undefined && reports[0].dataRowsNotInSheet === 1 && reports[0].sheetKeysWithoutData?.join() === "Returns");
      // With none of the data's keys below, nothing is in doubt: the fill ends there and reports it.
      const quiet = stacked();
      const q = applyOps(quiet, sold({}, three.slice(0, 2))).reports[0];
      check("without keys below, the fill stops at the row of headings and says so", q.stoppedAtRow === 6 && q.stoppedBecause === "a row of headings" && q.dataKeysBelowStop === 0 && q.lastRow === 5 && quiet.getWorksheet("S")!.getCell("B8").value === null);
      // The table below is filled by naming its own headers.
      applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "ITEM", data: "c" }, set: { RETURNED: "q" }, rows: [{ c: "B-2", q: 4 }] }]);
      check("the second table is reached by its own headers", ws.getCell("B8").value === 4);
      // A row of words that is not a header row does not stop a fill of text.
      const notes = new ExcelJS.Workbook();
      const wn = notes.addWorksheet("S");
      wn.getRow(1).values = ["CODE", "STATUS"];
      wn.getRow(2).values = ["A-1", "old"];
      wn.getRow(3).values = ["A-9", "no data for this one"];
      wn.getRow(4).values = ["A-2", "old"];
      applyOps(notes, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { STATUS: "s" }, overwrite: true, rows: [{ c: "A-1", s: "ok" }, { c: "A-2", s: "late" }] }]);
      check("a fill of words is not stopped by a row of words", wn.getCell("B4").value === "late" && wn.getCell("B3").value === "no data for this one");
    }
    // The header counts as repeated only when every key column repeats it.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["Store", "Item", "Qty"];
      ws.getRow(2).values = ["North", "Shirt"];
      ws.getRow(3).values = ["Store", "Polo"]; // a shop that is called "Store"
      ws.getRow(4).values = ["South", "Shirt"];
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: [{ sheet: "Store", data: "s" }, { sheet: "Item", data: "i" }], set: { Qty: "q" }, rows: [{ s: "North", i: "Shirt", q: 1 }, { s: "Store", i: "Polo", q: 2 }, { s: "South", i: "Shirt", q: 3 }] }]);
      check("one key column that happens to read like its header does not end the table", ws.getCell("C3").value === 2 && ws.getCell("C4").value === 3 && reports[0].stoppedAtRow === undefined);
    }

    // One header text over several columns, or headings that run over two rows: columns named by letter.
    {
      const oneRow = new ExcelJS.Workbook();
      const w1 = oneRow.addWorksheet("S");
      w1.getRow(1).values = ["CODE", "Qty", "Amount", "Qty", "Amount"];
      w1.getRow(2).values = ["A-1"];
      refused("a header used for two columns", oneRow, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { Qty: "q" }, rows: [{ c: "A-1", q: 1 }] }], /"Qty" heads columns B and D.*as "column:B"/);
      const months = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("S");
        ws.getRow(1).values = ["CODE", "Jan", null, "Feb"];
        ws.getRow(2).values = [null, "Qty", "Amount", "Qty", "Amount"];
        ws.getRow(3).values = ["A-1"];
        ws.getRow(4).values = ["A-2"];
        return wb;
      };
      refused("headings on two rows, named by text", months(), [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { Qty: "q" }, rows: [{ c: "A-1", q: 1 }] }], /no row with all of these headers.*headings run over two rows.*as "column:D"/);
      const wb = months();
      const { reports } = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { "column:D": "q", "column:e": "a" }, rows: [{ c: "A-2", q: 7, a: 70 }, { c: "A-1", q: 5, a: 50 }] }]);
      const ws = wb.getWorksheet("S")!;
      check("columns named by letter are filled, under headings on two rows", ws.getCell("D3").value === 5 && ws.getCell("E4").value === 70 && ws.getCell("B3").value === null && ws.getCell("D2").value === "Qty" && reports[0].targetColumns?.["column:D"] === "D" && reports[0].headerRow === 1 && reports[0].matched === 2);
      refused("only letters, so no header row can be found", months(), [{ op: "fill_by_key", sheet: "S", key: { sheet: "column:A", data: "c" }, set: { "column:D": "q" }, rows: [{ c: "A-1", q: 1 }] }], /with every column named by its letter, the header row cannot be found.*or say which row holds the headers with "headerRow"/);
    }

    // append_rows: a total anywhere on the sheet that would not take in the new rows.
    {
      const sheet = (total: string, where: string, tail?: boolean) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Log");
        ws.getRow(3).values = ["Date", "Qty"];
        ws.getRow(4).values = ["d1", 1];
        ws.getRow(5).values = ["d2", 2];
        ws.getCell(where).value = { formula: total, result: 3 };
        if (tail) ws.getCell("A8").value = "Prepared by: someone";
        return wb;
      };
      const one = [{ Date: "d3", Qty: 3 }];
      refused("a total above the data", sheet("SUM(B4:B5)", "B1"), [{ op: "append_rows", sheet: "Log", rows: one }], /would not take in the rows to be added: B1 \(=SUM\(B4:B5\)\)/);
      refused("a total followed by a line of text", sheet("SUM(B4:B5)", "B6", true), [{ op: "append_rows", sheet: "Log", rows: one }], /would not take in the rows to be added: B6/);
      const roomy = sheet("SUM(B4:B6)", "B1");
      applyOps(roomy, [{ op: "append_rows", sheet: "Log", rows: one }]);
      check("a total that reaches the new row lets it in", roomy.getWorksheet("Log")!.getCell("B6").value === 3);
      refused("but not two rows when it reaches only one", sheet("SUM(B4:B6)", "B1"), [{ op: "append_rows", sheet: "Log", rows: [...one, { Date: "d4", Qty: 4 }] }], /would not take in the rows to be added/);
      const other = sheet("SUM(Other!B4:B5)+SUM(D4:D5)", "D1");
      applyOps(other, [{ op: "append_rows", sheet: "Log", rows: one }]);
      check("a formula over another sheet or other columns does not stand in the way", other.getWorksheet("Log")!.getCell("A6").value === "d3");
    }

    // populate_sheet: a formula beside the block is the row's identity unless it reads the block.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("T");
      ws.getRow(1).values = ["Item", "Qty", "Double"];
      for (let r = 2; r <= 3; r++) {
        ws.getCell(`A${r}`).value = { formula: `Items!A${r}`, result: `K${r}` }; // the item, looked up from another sheet
        ws.getCell(`C${r}`).value = { formula: `B${r}*2`, result: 0 };
      }
      refused("a block beside a looked-up key column", wb, [{ op: "populate_sheet", sheet: "T", startCell: "B2", rows: [{ q: 1 }, { q: 2 }] }], /already hold data in other columns \(A2, A3\)/);
      let advice = "";
      const full = new ExcelJS.Workbook();
      const wf = full.addWorksheet("T");
      wf.getRow(1).values = ["Qty"];
      wf.getCell("A3").value = 5;
      try {
        applyOps(full, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows: [{ q: 1 }, { q: 2 }] }]);
      } catch (e) {
        advice = (e as Error).message;
      }
      check("a block that runs into existing cells is told why before overwrite is mentioned", /1 already filled \(A3\).*more rows than the empty area has room for.*Only if this same area is being filled again/.test(advice));
      const big = new ExcelJS.Workbook();
      const wbig = big.addWorksheet("T");
      wbig.getRow(1).values = ["Id"];
      applyOps(big, [{ op: "populate_sheet", sheet: "T", startCell: "A2", rows: [{ id: 2n ** 60n }, { id: 5n }] }]);
      check("a whole number too long to be exact is written as text, not rounded", wbig.getCell("A2").value === "1152921504606846976" && wbig.getCell("A3").value === 5);
    }

    // -----------------------------------------------------------------------
    // Found by a third independent review.
    // -----------------------------------------------------------------------

    // Filled-down formulas. Left alone they are saved exactly as they were: a version that gave every
    // such cell its own formula on loading turned "Q1" in quotes into "Q2" on sheets no op touched.
    {
      const build = async () => {
        const wb0 = new ExcelJS.Workbook();
        const ws0 = wb0.addWorksheet("F");
        ws0.getRow(1).values = ["CODE", "QTY", "PRICE", "VALUE", "NOTE", "FLAG"];
        for (let i = 0; i < 4; i++) ws0.getRow(i + 2).values = [`K${i}`, i + 1, 10];
        ws0.fillFormula("D2:D5", "B2*C2", [10, 20, 30, 40]);
        ws0.fillFormula("F2:F5", 'IF(A2="Q1",B2,0)', [0, 0, 0, 0]);
        ws0.getCell("E2").value = "first line\r\nsecond line";
        const sum = wb0.addWorksheet("Summary");
        sum.getRow(1).values = ["Quarter", "Units", "Other"];
        for (let i = 0; i < 3; i++) sum.getRow(i + 2).values = [`Q${i + 1}`];
        sum.fillFormula("B2:B4", 'SUMIFS(F!B:B,F!A:A,"Q1")', [0, 0, 0]);
        sum.fillFormula("C2:C4", "'Jan26'!B2+F!D2", [0, 0, 0]);
        wb0.addWorksheet("Jan26").getCell("B2").value = 1;
        const basePath = join(dir, "shared2.xlsx");
        await wb0.xlsx.writeFile(basePath);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(basePath);
        return wb;
      };
      const xmlOf = async (path: string, sheet: number) => (await JSZip.loadAsync(await readFile(path))).file(`xl/worksheets/sheet${sheet}.xml`)!.async("string");
      const cellXml = (xml: string, address: string) => new RegExp(`<c r="${address}"[^>]*?(?:/>|>(.*?)</c>)`).exec(xml)?.[1] ?? "";

      let wb = await build();
      check("the base has filled-down formulas", (wb.getWorksheet("F")!.getCell("D3").value as ExcelJS.CellSharedFormulaValue).sharedFormula === "D2");
      let before = signaturesOf(wb);
      // An ordinary fill of another column: no formula is touched.
      let done = applyOps(wb, [{ op: "fill_by_key", sheet: "F", key: { sheet: "CODE", data: "c" }, set: { QTY: "q" }, overwrite: true, rows: [{ c: "K0", q: 7 }, { c: "K3", q: 9 }] }]);
      dropFormulaResults(wb);
      let saved = await save(wb, out);
      check("the read-back agrees", compareWithBase(before.sheets, saved, done.written).length === 0);
      const summary = await xmlOf(out, 2);
      check('text in quotes is as it was: every "Q1" is still "Q1"', /<f t="shared" ref="B2:B4" si="\d+">SUMIFS\(F!B:B,F!A:A,"Q1"\)<\/f>/.test(cellXml(summary, "B2").replace(/&quot;/g, '"')) && /^<f t="shared" si="\d+"\/>$/.test(cellXml(summary, "B3")) && !/Q2|Q3/.test(summary.replace(/<c r="A\d"[^>]*>.*?<\/c>/g, "")));
      check("a sheet name that looks like a cell is as it was", /'Jan26'!B2\+F!D2<\/f>/.test(cellXml(summary, "C2").replace(/&apos;/g, "'")) && !/Jan27/i.test(summary));
      const filled = await xmlOf(out, 1);
      check("the cells below a first cell still point at it, with no result stored", /^<f t="shared" si="\d+"\/>$/.test(cellXml(filled, "D4")) && /<f t="shared" ref="D2:D5" si="\d+">B2\*C2<\/f>/.test(cellXml(filled, "D2")));

      // Writing the FIRST cell of a plain formula: the cells below get their own, and only those.
      wb = await build();
      before = signaturesOf(wb);
      done = applyOps(wb, [{ op: "set_cell", sheet: "F", cell: "D2", value: 99 }, { op: "set_cell", sheet: "F", cell: "E3", value: "written\r\nwith a line break" }]);
      dropFormulaResults(wb);
      saved = await save(wb, out);
      const sf = saved.getWorksheet("F")!;
      check("the first cell takes the value and the cells below keep their own formulas", sf.getCell("D2").value === 99 && sf.getCell("D3").formula === "B3*C3" && sf.getCell("D5").formula === "B5*C5");
      check("and the read-back agrees, line breaks included", compareWithBase(before.sheets, saved, done.written).length === 0);
      const after = await xmlOf(out, 1);
      check("in the file itself: a formula of its own with no stored result", /^<f>B4\*C4<\/f>$/.test(cellXml(after, "D4")));
      check("the other filled-down formulas of the workbook still point at their first cell", /^<f t="shared" si="\d+"\/>$/.test(cellXml(after, "F3")) && /^<f t="shared" si="\d+"\/>$/.test(cellXml(await xmlOf(out, 2), "B3")));

      // Writing the first cell of a formula that cannot be carried over with certainty is refused…
      refused("the first cell of a formula with text in quotes", await build(), [{ op: "set_cell", sheet: "F", cell: "F2", value: 1 }], /F2 on sheet "F" is the first cell of a filled-down formula.*Leave that cell to the sheet, or write every cell that shares the formula/);
      refused("the same through a fill that leaves some of its cells", await build(), [{ op: "fill_by_key", sheet: "F", key: { sheet: "CODE", data: "c" }, set: { FLAG: "q" }, overwrite: true, rows: [{ c: "K0", q: 1 }] }], /1 the first cell of a filled-down formula \(F2\).*write every cell that shares the formula/);
      // …unless every cell that shares it is written too: then nothing is left to carry over.
      wb = await build();
      applyOps(wb, [{ op: "fill_by_key", sheet: "F", key: { sheet: "CODE", data: "c" }, set: { FLAG: "q" }, overwrite: true, rows: [0, 1, 2, 3].map((i) => ({ c: `K${i}`, q: i })) }]);
      saved = await save(wb, out);
      check("a whole filled-down column replaced by figures", [2, 3, 4, 5].every((r) => saved.getWorksheet("F")!.getCell(`F${r}`).value === r - 2));
      // A cell that only points at the first one can be written freely.
      wb = await build();
      applyOps(wb, [{ op: "set_cell", sheet: "F", cell: "F4", value: 5 }]);
      saved = await save(wb, out);
      const pointer = await xmlOf(out, 1);
      check("a cell below the first is written and the rest still point at the first, whose text is as it was", saved.getWorksheet("F")!.getCell("F4").value === 5 && /^<f t="shared" si="\d+"\/>/.test(cellXml(pointer, "F5")) && cellXml(pointer, "F2").replace(/&quot;/g, '"').includes('>IF(A2="Q1",B2,0)</f>'));

      // The same through a fill, and through a block: the cells left pointing at a first cell get their own formula.
      wb = await build();
      applyOps(wb, [{ op: "fill_by_key", sheet: "F", key: { sheet: "CODE", data: "c" }, set: { VALUE: "v" }, overwrite: true, rows: [{ c: "K0", v: 77 }] }]);
      saved = await save(wb, out);
      check("a fill that writes the first cell of a plain formula leaves the rest with their own", saved.getWorksheet("F")!.getCell("D2").value === 77 && saved.getWorksheet("F")!.getCell("D3").formula === "B3*C3" && /^<f>B5\*C5<\/f>/.test(cellXml(await xmlOf(out, 1), "D5")));
      const alone = () => {
        const wb1 = new ExcelJS.Workbook();
        const w1 = wb1.addWorksheet("P");
        w1.getCell("A1").value = "Flag";
        w1.fillFormula("A2:A4", 'IF(Other!B2="x",1,0)', [0, 0, 0]);
        wb1.addWorksheet("Other");
        return wb1;
      };
      refused("a block over the first cell of a formula that cannot be carried over", alone(), [{ op: "populate_sheet", sheet: "P", startCell: "A2", overwrite: true, rows: [{ x: 1 }] }], /1 the first cell of a filled-down formula \(A2\)/);
      const whole = alone();
      applyOps(whole, [{ op: "populate_sheet", sheet: "P", startCell: "A2", overwrite: true, rows: [{ x: 1 }, { x: 2 }, { x: 3 }] }]);
      check("a block over every cell that shares the formula is written", whole.getWorksheet("P")!.getCell("A4").value === 3);
      // A formula filled across a row.
      const across = new ExcelJS.Workbook();
      const wa = across.addWorksheet("R");
      wa.getRow(1).values = ["a", 1, 2, 3];
      wa.fillFormula("B2:D2", "B1*2", [2, 4, 6]);
      await across.xlsx.writeFile(join(dir, "across.xlsx"));
      const acrossBack = new ExcelJS.Workbook();
      await acrossBack.xlsx.readFile(join(dir, "across.xlsx"));
      applyOps(acrossBack, [{ op: "set_cell", sheet: "R", cell: "B2", value: 0 }]);
      saved = await save(acrossBack, out);
      check("the cells beside a first cell get their own formula too", saved.getWorksheet("R")!.getCell("B2").value === 0 && saved.getWorksheet("R")!.getCell("C2").formula === "C1*2" && saved.getWorksheet("R")!.getCell("D2").formula === "D1*2");

      for (const f of ["B2*C2", "SUM(B2:C2)+$D$1*1.5", "ROUND(B2/C$2,2)", "_xlfn.XLOOKUP(A2,B2:B9,C2:C9)", "LOG10(B2)-1E3", "IF(B2>=C2,TRUE,B2%)"]) check(`plain enough to carry over: ${f}`, translatesSafely(f));
      for (const f of ['IF(A2="Q1",1,0)', "'Q1'!B3", "Data!B2", "SUM(D:D)", "SUM(2:2)", "Sales[Qty]", "my.tax1*B2", "TaxRate*B2", "X1.Y(B2)", "{1,2}*B2", "XFE1+1", ""]) check(`not carried over: ${f || "(empty)"}`, !translatesSafely(f));
    }

    // A key header merged over two header rows, the columns named by the second row or by letter.
    {
      const sheet = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("S");
        ws.getRow(1).values = ["CODE", "Jan", null, "Feb"];
        ws.getRow(2).values = [null, "Qty", "Amount", "Units", "Value"];
        ws.mergeCells("A1:A2");
        ws.mergeCells("B1:C1");
        ws.mergeCells("D1:E1");
        ws.getRow(3).values = ["A-1"];
        ws.getRow(4).values = ["A-2"];
        return wb;
      };
      const byLetter = sheet();
      const r1 = applyOps(byLetter, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { "column:D": "q" }, rows: [{ c: "A-2", q: 7 }, { c: "A-1", q: 5 }] }]).reports[0];
      check("filled by letter under a merged key header", byLetter.getWorksheet("S")!.getCell("D3").value === 5 && byLetter.getWorksheet("S")!.getCell("D4").value === 7 && r1.headerRow === 1 && r1.firstRow === 3 && r1.matched === 2);
      const byName = sheet();
      const r2 = applyOps(byName, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { Units: "q", Amount: "a" }, rows: [{ c: "A-1", q: 5, a: 50 }] }]).reports[0];
      check("filled by the headings of the second row", byName.getWorksheet("S")!.getCell("D3").value === 5 && byName.getWorksheet("S")!.getCell("C3").value === 50 && r2.headerRow === 2 && r2.firstRow === 3);
      refused("a heading merged over two columns names neither", sheet(), [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { Jan: "q" }, rows: [{ c: "A-1", q: 5 }] }], /"Jan" heads columns B and C.*as "column:B"/);
    }

    // A table that begins far down the sheet is found; every column by letter needs the header row said.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getCell("A1").value = "Notes";
      ws.getRow(80).values = ["CODE", "SOLD"];
      ws.getRow(81).values = ["A-1"];
      const r = applyOps(wb, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 3 }] }]).reports[0];
      check("headers below row 50 are found", ws.getCell("B81").value === 3 && r.headerRow === 80);
      applyOps(wb, [{ op: "fill_by_key", sheet: "S", headerRow: 80, overwrite: true, key: { sheet: "column:A", data: "c" }, set: { "column:b": "q" }, rows: [{ c: "A-1", q: 4 }] }]);
      check("every column by letter, with the header row said", ws.getCell("B81").value === 4);
      const wide = new ExcelJS.Workbook();
      const ww = wide.addWorksheet("S");
      ww.getCell("A1").value = "CODE";
      ww.getCell("AA1").value = "SOLD";
      ww.getCell("A2").value = "A-1";
      applyOps(wide, [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { "column:AA": "q" }, rows: [{ c: "A-1", q: 3 }] }]);
      check("a column of two letters is that column", ww.getCell("AA2").value === 3 && ww.getCell("B2").value === null);
    }

    // One name per column.
    {
      const sheet = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("S");
        ws.getRow(1).values = ["CODE", "SOLD"];
        ws.getRow(2).values = ["A-1"];
        return wb;
      };
      refused("a letter that is the key column", sheet(), [{ op: "fill_by_key", sheet: "S", overwrite: true, key: { sheet: "CODE", data: "c" }, set: { "column:A": "q" }, rows: [{ c: "A-1", q: 1 }] }], /"CODE" and "column:A" are the same column of sheet "S" \(A\), and it holds the keys/);
      refused("a header and its own letter", sheet(), [{ op: "fill_by_key", sheet: "S", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q", "column:B": "r" }, rows: [{ c: "A-1", q: 1, r: 2 }] }], /"SOLD" and "column:B" are the same column of sheet "S" \(B\)\. Name each column once/);
      refused("a key that is not text", sheet(), [{ op: "fill_by_key", sheet: "S", key: { sheet: 5 as never, data: "c" }, set: { SOLD: "q" }, rows: [{ c: "A-1", q: 1 }] }], /"key": \{ "sheet": <header in the sheet>, "data": <column in the data> \}, both as text/);
    }

    // A refresh: rows without data keep their earlier figures, and every one of them is named.
    {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      ws.getRow(1).values = ["CODE", "SOLD"];
      for (let i = 0; i < 40; i++) ws.getRow(i + 2).values = [`K${i}`, 100 + i];
      const r = applyOps(wb, [{ op: "fill_by_key", sheet: "S", overwrite: true, unmatched: "zero", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: Array.from({ length: 10 }, (_, i) => ({ c: `K${i}`, q: i })) }]).reports[0];
      check("the earlier figures of the other thirty rows are kept", ws.getCell("B12").value === 110 && ws.getCell("B41").value === 139 && ws.getCell("B2").value === 0);
      check("and all thirty are named, not a sample of them", r.unmatchedValuesKept === 30 && r.rowsThatKeptTheirValues === 30 && r.keysThatKeptTheirValues?.length === 30 && r.keysThatKeptTheirValues[29] === "K39");
      // The way through: each of those items is given a row with 0.
      const all = Array.from({ length: 40 }, (_, i) => ({ c: `K${i}`, q: i < 10 ? i : 0 }));
      applyOps(wb, [{ op: "fill_by_key", sheet: "S", overwrite: true, key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: all }]);
      check("given rows, the old figures are replaced", ws.getCell("B12").value === 0 && ws.getCell("B41").value === 0);
    }

    // What ends a table, and what does not.
    {
      const table = (odd: unknown[], more?: (ws: ExcelJS.Worksheet) => void) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("S");
        ws.getRow(1).values = ["CODE", "Name", "SOLD", "STATUS"];
        ws.getRow(2).values = ["A-1", "Shirt"];
        ws.getRow(3).values = odd;
        ws.getRow(4).values = ["A-2", "Polo"];
        more?.(ws);
        return wb;
      };
      const two = [{ c: "A-1", q: 1 }, { c: "A-2", q: 2 }];
      const fill = (extra: object = {}, rows: object[] = two) => [{ op: "fill_by_key" as const, sheet: "S", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, ...extra, rows: rows as Record<string, unknown>[] }];
      const through = (label: string, odd: unknown[], extra: object = {}, rows: object[] = two) => {
        const wb = table(odd);
        const r = applyOps(wb, fill(extra, rows)).reports[0];
        check(`not the end of the table: ${label}`, wb.getWorksheet("S")!.getCell("C4").value === 2 && r.stoppedAtRow === undefined && r.matched === rows.length);
      };
      through('"N/A" where the figure goes', ["A-9", "Cap", "N/A"]);
      through("a dash where the figure goes", ["A-9", "Cap", "-"]);
      through('"TBD" where the figure goes', ["A-9", "Cap", "TBD"]);
      through("a figure written as text with a percent sign and brackets", ["A-9", "Cap", "(5%)"]);
      through("a unit, in a row that also holds a figure", ["A-9", "Cap", "pcs", null, 12]);
      through("words in one cell only", [null, null, "see note"]);
      through("a row the data has, though it holds words", ["A-9", "Cap, old line", "pending"], { overwrite: true }, [...two, { c: "A-9", q: 9 }]);
      // Words where the figure goes, nothing but words in the row, a key the data does not have, and keys below: asked.
      refused("a unit row with the data's keys below it", table(["Accessories", "all sizes", "pcs"]), fill(), /Row 3 of sheet "S" looks like the headings of another table \(A3 "Accessories", B3 "all sizes", C3 "pcs"\).*if row 3 is an ordinary row and the table goes on, send it with "lastRow"/);
      const said = table(["Accessories", "all sizes", "pcs"]);
      const rs = applyOps(said, fill({ lastRow: 4 })).reports[0];
      check("told where the table ends, it is filled to there", said.getWorksheet("S")!.getCell("C4").value === 2 && rs.matched === 2 && rs.sheetKeysWithoutData?.join() === "Accessories" && rs.unmatchedValuesKept === 1);
      // Headings that carry a year or a date are headings still.
      refused("headings with a year among them", table(["ITEM", 2026, "RETURNED"]), fill(), /Row 3 of sheet "S" looks like the headings of another table/);
      refused("headings with a date among them", table(["ITEM", new Date(Date.UTC(2026, 0, 1)), "RETURNED"]), fill(), /looks like the headings of another table/);
      // This table's own column headings under another key heading.
      refused("the same column headings under another key heading", table(["ITEM", "Name", "SOLD", "STATUS"]), fill(), /Row 3 of sheet "S" looks like the headings of another table/);
      // A fill of words only: nothing can be judged by figures, but the table's own headings still show.
      refused("a fill of words meeting the same column headings under another key heading", table(["ITEM", "Name", "SOLD", "STATUS"]), [{ ...fill()[0], set: { STATUS: "s" }, rows: [{ c: "A-1", s: "ok" }, { c: "A-2", s: "late" }] }], /Row 3 of sheet "S" looks like the headings of another table/);
      // A fill of a figure and of words: the figure column is the one that is judged.
      refused("a figure column and a column of words", table(["ITEM", "Name", "RETURNED", "REASON"]), [{ ...fill()[0], set: { SOLD: "q", STATUS: "s" }, rows: [{ c: "A-1", q: 1, s: "ok" }, { c: "A-2", q: 2, s: "late" }] }], /looks like the headings of another table/);
      // Rows without data to be given 0 are figures too, even when the data's own column is empty.
      refused("zeros for rows without data would land under another heading", table(["ITEM", "Name", "RETURNED"]), fill({ unmatched: "zero" }, [{ c: "A-1", q: null }, { c: "A-2", q: null }]), /looks like the headings of another table/);
      // A merged cell in a row without data is not given a 0.
      const merged = table(["A-9", "Cap"], (ws) => ws.mergeCells("C3:D3"));
      const rm = applyOps(merged, fill({ unmatched: "zero" })).reports[0];
      check("a merged cell in a row without data is left as it is", merged.getWorksheet("S")!.getCell("C3").value === null && rm.unmatchedCellsSet === 0 && merged.getWorksheet("S")!.getCell("C4").value === 2);
      // A header printed again inside a table that is said to run on.
      const paged = table(["CODE", "Name", "SOLD", "STATUS"]);
      const rp = applyOps(paged, fill({ lastRow: 4 })).reports[0];
      check("a header repeated inside a table whose end is said is passed over", paged.getWorksheet("S")!.getCell("C4").value === 2 && paged.getWorksheet("S")!.getCell("C3").value === "SOLD" && rp.headerRowsPassed === 1 && rp.stoppedAtRow === undefined);
      refused("a last row above the table", table(["A-9"]), fill({ lastRow: 1 }), /"lastRow" is the number of the last sheet row of the table \(got 1; the headers are on row 1\)/);
    }

    // append_rows: what adds the rows up, wherever it is.
    {
      const log = (more?: (wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet) => void) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Log");
        ws.getRow(3).values = ["Date", "Qty", "Amt"];
        ws.getRow(4).values = ["d1", 1, 10];
        ws.getRow(5).values = ["d2", 2, 20];
        more?.(wb, ws);
        return wb;
      };
      const one = [{ op: "append_rows" as const, sheet: "Log", rows: [{ Date: "d3", Qty: 3, Amt: 30 }] }];
      refused("a total on another sheet", log((wb) => void (wb.addWorksheet("Summary").getCell("B1").value = { formula: "SUM(Log!B4:B5)", result: 3 })), one, /would not take in the rows to be added: Summary!B1 \(=SUM\(Log!B4:B5\)\)/);
      refused("a total on another sheet, the sheet name in quotes", log((wb) => void (wb.addWorksheet("Summary").getCell("B1").value = { formula: "SUM('Log'!$B$4:$B$5)", result: 3 })), one, /would not take in the rows to be added: Summary!B1/);
      refused("a total with fixed references", log((_, ws) => void (ws.getCell("F1").value = { formula: "SUM($B$4:$B$5)", result: 3 })), one, /would not take in the rows to be added: F1/);
      refused("a name over the rows", log((wb) => wb.definedNames.add("Log!$B$4:$B$5", "Quantities")), one, /The name "Quantities" \(Log!\$B\$4:\$B\$5\) covers the rows already on sheet "Log"/);
      const other = log((wb) => {
        wb.addWorksheet("Other").getCell("A1").value = { formula: "SUM(B4:B5)+SUM(Else!B4:B5)", result: 0 };
        wb.definedNames.add("Other!$B$4:$B$5", "Elsewhere");
      });
      applyOps(other, one);
      check("ranges of other sheets do not stand in the way", other.getWorksheet("Log")!.getCell("B6").value === 3);
      const perRow = log((_, ws) => {
        ws.getCell("E4").value = { formula: "SUM(B4:C4)", result: 11 };
        ws.getCell("F4").value = { formula: 'IF(A4="B4:B5",1,0)', result: 0 };
      });
      applyOps(perRow, one);
      check("a formula that works one row out, and text that only looks like a range, do not stand in the way", perRow.getWorksheet("Log")!.getCell("C6").value === 30);
      const filtered = log((wb) => wb.definedNames.add("Log!$A$3:$C$5", "_xlnm._FilterDatabase"));
      applyOps(filtered, one);
      check("the range Excel keeps for a filter is not a total", filtered.getWorksheet("Log")!.getCell("B6").value === 3);
      refused("every row working a column out", log((_, ws) => void (ws.getCell("E5").value = { formula: "B5*C5", result: 40 })), one, /The last row of sheet "Log" that holds anything \(row 5\) has formulas \(E5\)\. Either it is the sheet's totals.*or every row works a column out with a formula/);
      // An Excel table: rows added below it are not part of it.
      const wbT = new ExcelJS.Workbook();
      const wsT = wbT.addWorksheet("Log");
      wsT.addTable({ name: "Sales", ref: "A1", headerRow: true, columns: [{ name: "Date" }, { name: "Qty" }], rows: [["d1", 1], ["d2", 2]] });
      const tablePath = join(dir, "table.xlsx");
      await wbT.xlsx.writeFile(tablePath);
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.readFile(tablePath);
      refused("rows below an Excel table", loaded, [{ op: "append_rows", sheet: "Log", rows: [{ Date: "d3", Qty: 3 }] }], /are an Excel table \("Sales", A1:B3\)\. Rows added below it here would not be part of the table/);
      check("ranges are read with their sheet", JSON.stringify(rangesOn("SUM(Log!B4:B5)+SUM('My Log'!C1:C2)+SUM(D1:D2)+\"E1:E2\"", "Log", true)) === JSON.stringify([{ c1: 2, r1: 4, c2: 2, r2: 5 }, { c1: 4, r1: 1, c2: 4, r2: 2 }]) && rangesOn("SUM(D1:D2)", "Log", false).length === 0);
    }

    // populate_sheet: the order of the columns, and what a formula beside the block reads.
    {
      const sheet = () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("T");
        ws.getRow(1).values = ["Stock list"];
        ws.getRow(2).values = ["QTY", "PRICE"];
        ws.getRow(3).values = [1, 10];
        return wb;
      };
      const swapped = [{ price: 20, qty: 2 }];
      refused("columns in another order than the headers above", sheet(), [{ op: "populate_sheet", sheet: "T", startCell: "A4", rows: swapped }], /not the order of the headers on row 2 of sheet "T": column A is headed "QTY" but would receive "price"; column B is headed "PRICE" but would receive "qty".*Give "columns" in the order of the sheet's headers, or use append_rows/);
      const right = sheet();
      applyOps(right, [{ op: "populate_sheet", sheet: "T", startCell: "A4", columns: [{ key: "qty" }, { key: "price" }], rows: swapped }]);
      check("in the order of the headers it is written", right.getWorksheet("T")!.getCell("A4").value === 2 && right.getWorksheet("T")!.getCell("B4").value === 20);
      const unrelated = sheet();
      applyOps(unrelated, [{ op: "populate_sheet", sheet: "T", startCell: "A4", rows: [{ sold_units: 2, unit_price: 20 }] }]);
      check("names that are not the sheet's headers say nothing either way", unrelated.getWorksheet("T")!.getCell("A4").value === 2);

      const beside = (formula: string) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("T");
        wb.addWorksheet("Other");
        ws.getRow(1).values = ["Item", "Qty", "Double"];
        ws.getCell("C2").value = { formula, result: 0 };
        return wb;
      };
      const block = [{ op: "populate_sheet" as const, sheet: "T", startCell: "B2", rows: [{ q: 1 }] }];
      for (const f of ["$B2*2", "SUM(B:B)", "[@Qty]*2", "T!B2*2", "ROUND(B2,0)"]) {
        const wb = beside(f);
        applyOps(wb, block);
        check(`a formula that works the row out from the block is no identity: ${f}`, wb.getWorksheet("T")!.getCell("B2").value === 1);
      }
      for (const f of ["Other!B2", "Other!A:B", 'IF(A1="B2",1,0)', "A2&\"\"", "LOG10(5)"]) {
        refused(`a formula that reads elsewhere is the row's own: ${f}`, beside(f), block, /already hold data in other columns \(C2\).*If nothing in those rows identifies them, build a new workbook/);
      }
      check("what a formula reads, by sheet", readsColumns("Other!B2+C2", "T", 3, 3) && !readsColumns("Other!B2+C2", "T", 2, 2) && readsColumns("'T'!$B$2", "T", 2, 2) && !readsColumns("ATAN2(1,1)", "T", 1, 100));
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
