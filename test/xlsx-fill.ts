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
  // What refuses an append (anything but the question itself) refuses it whether or not the last row was confirmed.
  const asksOnly = /^append_rows adds rows after the last row of the sheet/.test(message);
  if (!asksOnly && ops.every((o) => o.op === "append_rows" && o.afterRow === undefined && wb.getWorksheet(o.sheet))) {
    let again = "";
    try {
      applyOps(wb, ops.map((o) => ({ ...o, afterRow: lastValueRow(wb.getWorksheet(o.sheet)!) })) as ResolvedOp[]);
    } catch (e) {
      again = (e as Error).message;
    }
    assert.ok(pattern.test(again), `${label}: confirming the last row waives it (${again || "the rows were written"})`);
    assert.deepStrictEqual(snapshot(wb), before, `${label}: wrote something when confirmed`);
    passed++;
  }
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
      const { reports } = applyOps(wb, [{ ...FILL, lastRow: 8, rows: [DATA[1], DATA[3], { code: "Z-999", sold: 9, on_hand: 9 }] }]);
      const r = reports[0];
      const ws = wb.getWorksheet("Items")!;
      check("matched rows are filled", ws.getCell("D4").value === 1 && ws.getCell("D5").value === 2);
      // Without the table's last row said: an empty line, then rows the data has nothing for. Whether they
      // belong to the table changes nothing here (they would be left as they are either way), so the
      // reading goes on and they are counted as rows without data.
      const open = applyOps(tracker(), [{ ...FILL, rows: [DATA[1], DATA[3]] }]).reports[0];
      check("a gap with nothing of the data below it is read across", open.stoppedAtRow === undefined && open.lastRow === 9 && open.sheetRowsWithoutData === 2 && open.sheetKeysWithoutData?.join() === "B-300,B-400");
      // The same sheet with rows without data to be given 0: now it matters, and it is asked.
      refused("zeros for rows without data, across a gap", tracker(), [{ ...FILL, unmatched: "zero", rows: [DATA[1], DATA[3]] }], /Where the table under row 3 of sheet "Items" ends cannot be told.*Row 7 \(A7 "B-300", B7 "Polo", C7 "Navy"\) has a row above it with nothing under these columns, and no key the data has, and 2 rows with a key lie from there down, which would or would not be given 0/);
      check("a sheet row with no data is left as it was", ws.getCell("D7").value === null && ws.getCell("E8").value === null);
      check("sheet rows without data are counted and named", r.sheetRowsWithoutData === 2 && r.sheetKeysWithoutData?.join() === "B-300,B-400");
      check("data rows not in the sheet are counted and named", r.dataRowsNotInSheet === 1 && r.dataKeysNotInSheet?.join() === "Z-999");
    }
    {
      const wb = tracker();
      applyOps(wb, [{ ...FILL, lastRow: 8, unmatched: "zero", rows: [DATA[1]] }]);
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
      const { reports } = applyOps(wb, [{ ...FILL, lastRow: 8, rows: DATA }]);
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
      const { reports } = applyOps(wb, [{ op: "append_rows", sheet: "Log", afterRow: 2, rows: [{ Qty: 2, Store: "S", Date: "2026-01-02" }] }]);
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
      const { reports } = applyOps(wb, [{ ...FILL, lastRow: 10, unmatched: "zero", overwrite: true, rows: [DATA[1]] }]);
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
      const nr = applyOps(nulls, [{ ...FILL, lastRow: 8, unmatched: "zero", rows: [{ code: "A-100", sold: null, on_hand: 10 }] }]).reports[0];
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
      const { reports } = applyOps(wb, [{ op: "append_rows", sheet: "Log", afterRow: 2, rows: [{ Date: "2026-01-02", Qty: 2 }] }]);
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
      // A key of the data sits below an empty row and a title: which table it belongs to is asked, not guessed.
      refused("a gap and a title with the data's keys below", stacked(), sold({}, three), /Where the table under row 1 of sheet "S" ends cannot be told from the sheet\. Row 5 \(A5 "Returns"\) has a row above it with nothing under these columns, and no key the data has, and 1 of the data's keys are found from there down \(for example "B-2"\).*each of these rows may begin something else, or be only a label or an item the data has no row for: row 5 \(A5 "Returns"\), which follows a row with nothing under these columns and has no key the data has; row 6 \(A6 "ITEM", B6 "RETURNED"\), which reads like column headings\. Send the same op with "lastRow": the row just above the first of them that does begin something else\. That is 4 if another table, a note or a footer begins at row 5.*The sheet's last row with anything in it is 8: that is the answer only if every row down to it belongs to this one table/);
      const wb = stacked();
      const ws = wb.getWorksheet("S")!;
      const { reports } = applyOps(wb, sold({ lastRow: 4 }, three));
      check("a sold figure is never written under the other table's heading", ws.getCell("B8").value === null && ws.getCell("B7").value === 3 && ws.getCell("B2").value === 1 && ws.getCell("B3").value === 2);
      check("told where the table ends, the fill reads to there and says what of the data lies beyond", reports[0].lastRow === 4 && reports[0].stoppedAtRow === undefined && reports[0].dataRowsNotInSheet === 1 && reports[0].dataKeysBelowLastRow === 1);
      // Told wrongly that it is all one table, a header of this table's own key heading over other columns is still seen.
      const sameKey = stacked();
      sameKey.getWorksheet("S")!.getCell("A6").value = "CODE";
      refused("another table's header inside the rows said to be one table", sameKey, sold({ lastRow: 8 }, three), /Row 6 of sheet "S" holds the key heading again over other column headings \(A6 "CODE", B6 "RETURNED"\): another table begins there, inside the rows said to be one table \("lastRow": 8\)\. Nothing was written\. Give "lastRow": 5/);
      // With none of the data's keys below, nothing is in doubt: the title is read across, and the reading ends at the headings.
      const quiet = stacked();
      const q = applyOps(quiet, sold({}, three.slice(0, 2))).reports[0];
      check("without keys below, the fill stops at what reads like headings and says so", q.stoppedAtRow === 6 && q.stoppedBecause === "what reads like column headings" && q.dataKeysBelowStop === 0 && q.lastRow === 5 && q.sheetKeysWithoutData?.join() === "Returns" && quiet.getWorksheet("S")!.getCell("B8").value === null);
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
      refused("a total followed by a line of text", sheet("SUM(B4:B5)", "B6", true), [{ op: "append_rows", sheet: "Log", rows: one }], /has an empty row \(row 7\) between its headers \(row 3\) and the last row that holds anything \(row 8: A8 "Prepared by: someone"\)/);
      const roomy = sheet("SUM(B4:B6)", "B1");
      applyOps(roomy, [{ op: "append_rows", sheet: "Log", afterRow: 5, rows: one }]);
      check("a total that reaches the new row lets it in", roomy.getWorksheet("Log")!.getCell("B6").value === 3);
      refused("but not two rows when it reaches only one", sheet("SUM(B4:B6)", "B1"), [{ op: "append_rows", sheet: "Log", rows: [...one, { Date: "d4", Qty: 4 }] }], /would not take in the rows to be added/);
      const other = sheet("SUM(Other!B4:B5)+SUM(D4:D5)", "D1");
      applyOps(other, [{ op: "append_rows", sheet: "Log", afterRow: 5, rows: one }]);
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
      through("a unit, in a row that also holds a figure", ["A-9", 12, "pcs"]);
      // A figure outside the columns the op names is not part of the row as it is read: that list may be something else's.
      refused("a unit row, with a figure only beyond the columns named", table(["A-9", "Cap", "pcs", 12]), fill(), /Row 3 \(A3 "A-9", B3 "Cap", C3 "pcs", D3 "12"\) has what reads like column headings/);
      through("words in one cell only", [null, null, "see note"]);
      through("a row the data has, though it holds words", ["A-9", "Cap, old line", "pending"], { overwrite: true }, [...two, { c: "A-9", q: 9 }]);
      // Words where the figure goes, nothing but words in the row, a key the data does not have, and keys below: asked.
      refused("a unit row with the data's keys below it", table(["Accessories", "all sizes", "pcs"]), fill(), /Row 3 \(A3 "Accessories", B3 "all sizes", C3 "pcs"\) has what reads like column headings, and 1 of the data's keys are found from there down.*if row 3 is only a label or an item the data has no row for and the table goes on/);
      const said = table(["Accessories", "all sizes", "pcs"]);
      const rs = applyOps(said, fill({ lastRow: 4 })).reports[0];
      check("told where the table ends, it is filled to there", said.getWorksheet("S")!.getCell("C4").value === 2 && rs.matched === 2 && rs.sheetKeysWithoutData?.join() === "Accessories" && rs.unmatchedValuesKept === 1);
      // Headings that carry a year or a date are headings still.
      refused("headings with a year among them", table(["ITEM", 2026, "RETURNED"]), fill(), /Where the table under row 1 of sheet "S" ends cannot be told from the sheet\. Row 3 /);
      refused("headings with a date among them", table(["ITEM", new Date(Date.UTC(2026, 0, 1)), "RETURNED"]), fill(), /ends cannot be told from the sheet\. Row 3 /);
      // This table's own column headings under another key heading.
      refused("the same column headings under another key heading", table(["ITEM", "Name", "SOLD", "STATUS"]), fill(), /Row 3 \(A3 "ITEM", B3 "Name", C3 "SOLD", D3 "STATUS"\) has this table's column headings again, under another key heading/);
      // A fill of words only: nothing can be judged by figures, but the table's own headings still show.
      refused("a fill of words meeting the same column headings under another key heading", table(["ITEM", "Name", "SOLD", "STATUS"]), [{ ...fill()[0], set: { STATUS: "s" }, rows: [{ c: "A-1", s: "ok" }, { c: "A-2", s: "late" }] }], /Where the table under row 1 of sheet "S" ends cannot be told from the sheet\. Row 3 /);
      // A fill of a figure and of words: the figure column is the one that is judged.
      refused("a figure column and a column of words", table(["ITEM", "Name", "RETURNED", "REASON"]), [{ ...fill()[0], set: { SOLD: "q", STATUS: "s" }, rows: [{ c: "A-1", q: 1, s: "ok" }, { c: "A-2", q: 2, s: "late" }] }], /ends cannot be told from the sheet\. Row 3 /);
      // Rows without data to be given 0 are figures too, even when the data's own column is empty.
      refused("zeros for rows without data would land under another heading", table(["ITEM", "Name", "RETURNED"]), fill({ unmatched: "zero" }, [{ c: "A-1", q: null }, { c: "A-2", q: null }]), /ends cannot be told from the sheet\. Row 3 /);
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
      applyOps(other, [{ ...one[0], afterRow: 5 }]);
      check("ranges of other sheets do not stand in the way", other.getWorksheet("Log")!.getCell("B6").value === 3);
      const perRow = log((_, ws) => {
        ws.getCell("E4").value = { formula: "SUM(B4:C4)", result: 11 };
        ws.getCell("F4").value = { formula: 'IF(A4="B4:B5",1,0)', result: 0 };
      });
      applyOps(perRow, [{ ...one[0], afterRow: 5 }]);
      check("a formula that works one row out, and text that only looks like a range, do not stand in the way", perRow.getWorksheet("Log")!.getCell("C6").value === 30);
      const filtered = log((wb) => wb.definedNames.add("Log!$A$3:$C$5", "_xlnm._FilterDatabase"));
      applyOps(filtered, [{ ...one[0], afterRow: 5 }]);
      check("the range Excel keeps for a filter is not a total", filtered.getWorksheet("Log")!.getCell("B6").value === 3);
      refused(
        "every row working a column out",
        log((_, ws) => {
          ws.getCell("D3").value = "Value";
          ws.getCell("D5").value = { formula: "B5*C5", result: 40 };
        }),
        one,
        /The last row of sheet "Log" that holds anything \(row 5\) has formulas \(D5\)\. Either it is the sheet's totals.*or every row works a column out with a formula/,
      );
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

    // -----------------------------------------------------------------------
    // Found by a fourth independent review. The answer to most of it is the
    // same: where the sheet leaves a doubt that changes what would be written,
    // nothing is written and the caller is asked.
    // -----------------------------------------------------------------------
    const sheetOf = (rows: unknown[][], more?: (ws: ExcelJS.Worksheet) => void) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("S");
      rows.forEach((r, i) => void (ws.getRow(i + 1).values = r));
      more?.(ws);
      return wb;
    };
    const byCode = (set: Record<string, string>, rows: object[], extra: object = {}) => [{ op: "fill_by_key" as const, sheet: "S", key: { sheet: "CODE", data: "c" }, set, ...extra, rows: rows as Record<string, unknown>[] }];

    // Told that the sheet is one table, a second table's header inside it is still seen.
    {
      const two = () =>
        sheetOf([["CODE", "QTY", "AMOUNT"], ["A"], ["North"], ["B"], [], ["CODE", "RETURNED", "REFUND"], ["D"], ["E"]], (ws) => ws.mergeCells("A3:C3"));
      const data = [{ c: "A", q: 1, a: 10 }, { c: "B", q: 2, a: 20 }, { c: "D", q: 4, a: 40 }, { c: "E", q: 5, a: 50 }];
      const set = { QTY: "q", AMOUNT: "a" };
      const wb = two();
      const r = applyOps(wb, byCode(set, data)).reports[0];
      const ws = wb.getWorksheet("S")!;
      check("a banner merged across the row does not end the table, and the key heading again does", ws.getCell("B4").value === 2 && ws.getCell("B7").value === null && r.stoppedAtRow === 6 && r.stoppedBecause === "the key heading again, over other column headings" && r.dataKeysBelowStop === 2);
      refused("the whole sheet said to be one table", two(), byCode(set, data, { lastRow: 8 }), /Row 6 of sheet "S" holds the key heading again over other column headings \(A6 "CODE", B6 "RETURNED", C6 "REFUND"\): another table begins there.*Give "lastRow": 5 for the table under row 1, and fill the table that begins at row 6 with an op of its own \("headerRow": 6/);
      const other = sheetOf([["CODE", "QTY"], ["A"], ["ITEM", "QTY"], ["D"]]);
      refused("this table's headings under another key heading, inside the rows said to be one table", other, byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "D", q: 4 }], { lastRow: 4 }), /Row 3 of sheet "S" holds this table's column headings again under another key heading \(A3 "ITEM", B3 "QTY"\)/);
      // Both tables filled in one request, each by its header row.
      const both = two();
      applyOps(both, [...byCode(set, data.slice(0, 2), { lastRow: 4 }), { op: "fill_by_key", sheet: "S", headerRow: 6, key: { sheet: "CODE", data: "c" }, set: { RETURNED: "q", REFUND: "a" }, rows: data.slice(2) }]);
      check("two tables filled in one request, each under its own headings", both.getWorksheet("S")!.getCell("B4").value === 2 && both.getWorksheet("S")!.getCell("B7").value === 4 && both.getWorksheet("S")!.getCell("C8").value === 50);
    }

    // Another table that does not announce itself in words.
    {
      const set = { QTY: "q" };
      const d = [{ c: "A", q: 1 }, { c: "X", q: 9 }];
      const asked = /Where the table under row 1 of sheet "S" ends cannot be told from the sheet/;
      refused('headings such as "Q1", directly below', sheetOf([["CODE", "QTY"], ["A"], ["ITEM", "Q1"], ["X"]]), byCode(set, d), asked);
      refused("headings that are dates, directly below", sheetOf([["CODE", "QTY"], ["A"], ["ITEM", new Date(Date.UTC(2026, 0, 1))], ["X"]]), byCode(set, d), asked);
      refused("headings that are years, after an empty row", sheetOf([["CODE", "QTY"], ["A"], [], ["Branch", 2025], ["X"]]), byCode(set, d), /Row 4 \(A4 "Branch", B4 "2025"\) has a row above it with nothing under these columns, and no key the data has/);
      refused("a narrower table, after an empty row", sheetOf([["CODE", "NAME", "QTY"], ["A"], [], ["ITEM"], ["X"]]), byCode(set, d), asked);
      refused("a fill of words, after an empty row", sheetOf([["CODE", "QTY"], ["A"], [], ["ITEM", "NOTE"], ["X"]]), byCode(set, [{ c: "A", q: "ok" }, { c: "X", q: "late" }]), asked);
      refused("a first table with headers and no rows yet", sheetOf([["CODE", "QTY"], ["ITEM", "RETURNED"], ["X"]]), byCode(set, [{ c: "X", q: 9 }]), /Row 2 \(A2 "ITEM", B2 "RETURNED"\) has what reads like column headings/);
      refused("zeros for rows without data, with another table's rows below a gap", sheetOf([["CODE", "QTY"], ["A"], [], ["ITEM", "RETURNED"], ["Z"]]), byCode(set, [{ c: "A", q: 1 }], { unmatched: "zero" }), /2 rows with a key lie from there down, which would or would not be given 0/);
      // A key of the data written differently below the gap is a key of the data all the same.
      refused("the data's key below a gap, as a number where the data has text", sheetOf([["CODE", "QTY"], ["A"], [], ["Returns"], [123]]), byCode(set, [{ c: "A", q: 1 }, { c: "00123", q: 9 }]), /1 of the data's keys are found from there down \(for example "123"\)/);
      // What is plainly one table is not asked about.
      const spaced = sheetOf([["CODE", "QTY"], ["A"], [], ["X"], [], ["Z", 7]]);
      const rs = applyOps(spaced, byCode(set, d)).reports[0];
      check("an empty line before a row the data has is read across", spaced.getWorksheet("S")!.getCell("B4").value === 9 && rs.stoppedAtRow === undefined && rs.sheetKeysWithoutData?.join() === "Z");
      const partly = sheetOf([["CODE", "QTY", "AMT"], ["A"], ["X", "QTY", 5], ["Y"]]);
      applyOps(partly, byCode({ QTY: "q", AMT: "a" }, [{ c: "A", q: 1, a: 2 }, { c: "Y", q: 3, a: 4 }]));
      check("one heading of two repeated in a row with a figure is an ordinary row", partly.getWorksheet("S")!.getCell("B2").value === 1 && partly.getWorksheet("S")!.getCell("B4").value === 3);
      const twice = sheetOf([["CODE", "QTY"], ["A"], ["TOTAL", 5], ["B"], ["TOTAL", 6]]);
      applyOps(twice, byCode(set, [{ c: "A", q: 1 }, { c: "B", q: 2 }]));
      check("a label on two rows that the data has nothing for is not a key in doubt", twice.getWorksheet("S")!.getCell("B4").value === 2 && twice.getWorksheet("S")!.getCell("B5").value === 6);
      // Columns named by letter over empty header cells: nothing there to be repeated.
      const bare = sheetOf([[null, "SOLD"], ["K1"], [null, 5], ["K2"]]);
      applyOps(bare, [{ op: "fill_by_key", sheet: "S", key: { sheet: "column:A", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "K1", q: 1 }, { c: "K2", q: 2 }] }]);
      check("a key column with no heading: a row with no key is not the heading again", bare.getWorksheet("S")!.getCell("B4").value === 2);
      const bare2 = sheetOf([["CODE"], ["K1"], ["ZZ"], ["K2"]]);
      applyOps(bare2, byCode({ "column:B": "q" }, [{ c: "K1", q: 1 }, { c: "K2", q: 2 }]));
      check("a column to fill with no heading: an empty cell is not its heading again", bare2.getWorksheet("S")!.getCell("B4").value === 2);
    }

    // The refusals that name a row to give back name the right one.
    {
      const stackedSame = sheetOf([["Title"], ["CODE", "QTY"], ["A"], ["CODE", "QTY"], ["D"]]);
      refused("no key of the data in the first table", stackedSame, byCode({ QTY: "q" }, [{ c: "D", q: 4 }]), /No row of sheet "S" in rows 3–3 has a key found in the data.*row 4 has the same headers again, and 1 of the data's keys are found below it\. To fill the table that begins there, pass "headerRow": 4/);
      const empty = sheetOf([["Title"], ["CODE", "QTY"], [null, "note"], ["CODE", "QTY"], ["D"]]);
      refused("a first table with no rows", empty, byCode({ QTY: "q" }, [{ c: "D", q: 4 }]), /has no rows with a readable key under "CODE" in rows 3–3.*Row 4 has the same headers again, so the table under row 2 has no rows; if the table meant begins at row 4, pass "headerRow": 4/);
      refused("a row of the table given as its header row", sheetOf([["CODE", "QTY"], ["A"], ["B"]]), [{ op: "fill_by_key", sheet: "S", headerRow: 2, key: { sheet: "column:A", data: "c" }, set: { "column:B": "q" }, rows: [{ c: "A", q: 1 }, { c: "B", q: 2 }] }], /Row 2 of sheet "S" holds a key the data has \("A"\): it is a row of the table, not the row of its headers/);
      refused("a header row with one heading on two columns", sheetOf([["CODE", "QTY", "QTY"], ["A"]]), byCode({ QTY: "q" }, [{ c: "A", q: 1 }], { headerRow: 1 }), /"QTY" heads columns B and C/);
      const far = sheetOf([["CODE", "SOLD QTY"], ["A"], [], [], [], ["CODE", "SOLD"], ["A"]]);
      refused("the headers found far below a row that has some of them", far, byCode({ SOLD: "q" }, [{ c: "A", q: 1 }]), /has these headers on row 6, and some of them on row 1 above it, which lacks "SOLD" \(it holds: "CODE", "SOLD QTY"\)\. Which table is meant cannot be told\. For the table whose headers are on row 6, add "headerRow": 6/);
      applyOps(far, byCode({ SOLD: "q" }, [{ c: "A", q: 1 }], { headerRow: 6 }));
      check("and with the header row said, that table is filled", far.getWorksheet("S")!.getCell("B7").value === 1 && far.getWorksheet("S")!.getCell("B2").value === null);
      // Merged headers of other shapes.
      const target = sheetOf([["CODE", "TOTAL"], ["(code)", null], ["A"]], (ws) => ws.mergeCells("B1:B2"));
      check("a column heading merged over two rows", applyOps(target, byCode({ TOTAL: "q" }, [{ c: "A", q: 1 }])).reports[0].firstRow === 3 && target.getWorksheet("S")!.getCell("B3").value === 1);
      const three = sheetOf([["CODE", "QTY"], [], [], ["A"]], (ws) => ws.mergeCells("A1:A3"));
      check("a key heading merged over three rows", applyOps(three, byCode({ QTY: "q" }, [{ c: "A", q: 1 }])).reports[0].firstRow === 4 && three.getWorksheet("S")!.getCell("B4").value === 1);
    }

    // A refresh in which the data has no value where the sheet has a figure.
    {
      const sheet = () => sheetOf([["CODE", "QTY", "AMT"], ["A", 7, 70], ["B", null, { formula: "B3*2" }]]);
      const set = { QTY: "q", AMT: "a" };
      refused("a refresh with no value for a cell that holds a figure", sheet(), byCode(set, [{ c: "A", q: null, a: 1 }], { overwrite: true }), /the data has no value \(NULL\) for 1 cell that hold a figure now \(for example B2, "QTY" of "A"\)\. They would keep the figure they hold, which in a refresh is the earlier period's\. Nothing was written\. Make the query give a value for them \(COALESCE\(x, 0\)/);
      const kept = sheet();
      const rk = applyOps(kept, byCode({ QTY: "q" }, [{ c: "A", q: null }, { c: "B", q: 2 }])).reports[0];
      check("without overwrite, no value means the cell is left, and that is counted", kept.getWorksheet("S")!.getCell("B2").value === 7 && kept.getWorksheet("S")!.getCell("B3").value === 2 && rk.emptyValuesLeft === 1);
      const over = sheet();
      applyOps(over, byCode(set, [{ c: "B", q: null, a: null }, { c: "A", q: 1, a: 2 }], { overwrite: true }));
      check("no value against an empty cell or a formula is nothing to ask about", over.getWorksheet("S")!.getCell("B2").value === 1 && (over.getWorksheet("S")!.getCell("C3").value as ExcelJS.CellFormulaValue).formula === "B3*2");
    }

    // append_rows: only at the foot of a table that plainly runs to the end of the sheet.
    {
      const one = (rows: object[]) => [{ op: "append_rows" as const, sheet: "S", rows: rows as Record<string, unknown>[] }];
      refused("another table below an empty row", sheetOf([["CODE", "QTY"], ["A", 1], [], ["ITEM", "RETURNED"], ["X", 2]]), one([{ CODE: "B", QTY: 2 }]), /has an empty row \(row 3\) between its headers \(row 1\) and the last row that holds anything \(row 5: A5 "X", B5 "2"\)/);
      refused("a footer directly below the rows", sheetOf([["CODE", "QTY"], ["A", 1], ["Prepared by: someone"]]), one([{ CODE: "B", QTY: 2 }]), /The last rows of sheet "S" are: row 2 \(A2 "A", B2 "1"\); row 3 \(A3 "Prepared by: someone"\)\. Signs that row 3 may not be an ordinary row of the table under those headers: A3 "Prepared by: someone" reads like the label of a total, an average or a closing line; .*\. Read them\. If row 3 is an ordinary row of the table under those headers \(and any row named above is only an odd value in it\), send the same op with "afterRow": 3/);
      const plain = sheetOf([["Report"], [], ["CODE", "QTY"], ["A", 1]], (ws) => void (ws.getCell("D1").value = { formula: "SUM(B1:B2)", result: 0 }));
      plain.addWorksheet("Other").getCell("A1").value = { formula: "SUM(S!A4:B4)+SUM(Données!B4:B5)", result: 0 };
      refused("rows are not added until the last row has been read and confirmed, however plain the table", plain, one([{ CODE: "B", QTY: 2 }]), /^append_rows adds rows after the last row of the sheet, and only once that row has been read and confirmed\. Nothing was added\. The headers are on row \d+ \(.*?\)\. The last rows of sheet "S" are: row 4 \(A4 "A", B4 "1"\)\. Read them\. If row 4 is an ordinary row of the table under those headers, send the same op with "afterRow": 4 and the rows are added from row 5\. If it is a total, a subtotal, an average, a note, a signature line or part of another table, do not: build a new workbook from the full data instead\.$/);
      const confirmedPlain = applyOps(plain, [{ ...one([{ CODE: "B", QTY: 2 }])[0], afterRow: 4 }]).reports[0];
      check("confirmed, the report says which row the rows were added after, and names no sign when there was none", confirmedPlain.addedAfter === 'row 4 (A4 "A", B4 "1")' && confirmedPlain.lastRowSigns === undefined);
      check("a table that runs to the end takes the rows; a range above its headers, or of one row read from another sheet, is no total", plain.getWorksheet("S")!.getCell("B5").value === 2);
      check("a sheet name in another alphabet is read as one", rangesOn("SUM(Données!B4:B5)", "Données", false).length === 1 && rangesOn("SUM(Données!B4:B5)", "S", true).length === 0);
      const single = sheetOf([["CODE"], ["A"]]);
      applyOps(single, [{ ...one([{ CODE: "B" }])[0], afterRow: 2 }]);
      check("a table of one column takes the row once its last row is confirmed", single.getWorksheet("S")!.getCell("A3").value === "B");
      // What no sign catches: rows that read like rows of the table to anything that reads cells. None is added under without the question.
      const noSign = /^append_rows adds rows after the last row of the sheet, and only once that row has been read and confirmed\. Nothing was added\. The headers are on row \d+ \(.*?\)\. The last rows of sheet "S" are: [^.]*(\.\d[^.]*)*\. Read them\. If row \d+ is an ordinary row of the table under those headers, send the same op with "afterRow": \d+ /;
      const region = [{ Region: "West", Item: "z", Qty: 1, Amount: 10 }];
      const grouped = (last: unknown[]) => sheetOf([["Region", "Item", "Qty", "Amount"], ["North", "a", 3, 30], ["North", "b", 4, 41], ["South", "c", 5, 52], ["South", "d", 9, 88], last]);
      refused("a subtotal labelled only with its group", grouped(["South", "all", 14, 140.5]), one(region), /The last rows of sheet "S" are: .*row 6 \(A6 "South", B6 "all", C6 "14", D6 "140\.5"\)\. /);
      refused("an average row with no label", grouped(["All", "all", 5.25, 52.75]), one(region), noSign);
      refused("a row that repeats the one above it", grouped(["South", "d", 9, 88]), one(region), noSign);
      const words = (...below: unknown[][]) => sheetOf([["Name", "Team", "Phone"], ["Ana", "Sales", "0917"], ["Ben", "Ops", "0918"], ...below]);
      const person = [{ Name: "Cy", Team: "Ops", Phone: "0919" }];
      refused("a footer that fills every column of a table of words", words(["Verified by:", "J. Cruz", "Nov 27"]), one(person), /The last rows of sheet "S" are: .*row 4 \(A4 "Verified by:", B4 "J\. Cruz", C4 "Nov 27"\)\. /);
      refused("a line of signs under a table of words", words(["=====", "=====", "====="]), one(person), noSign);
      refused("another table of words directly below", words(["Branch", "City", "Manager"], ["Main", "Pasig", "Dee"]), one(person), noSign);
      refused("another table headed by years directly below", sheetOf([["Item", "Qty", "Amount"], ["a", 3, 30], ["b", 4, 41], ["c", 5, 52], ["Region", 2025, 2026], ["North", 10, 12]]), one([{ Item: "d", Qty: 1, Amount: 2 }]), /The last rows of sheet "S" are: /);
      // Headers with nothing below them: confirmed like any other last row, since a label at the foot of a sheet can be taken for them.
      const bare = sheetOf([["Title"], [], ["CODE", "QTY"]]);
      refused("a table that has only its headers", bare, one([{ CODE: "B", QTY: 2 }]), /^append_rows adds rows after the last row of the sheet, and only once that row has been read and confirmed\. Nothing was added\. The headers are on row 3 \(A3 "CODE", B3 "QTY"\)\. Nothing on sheet "S" lies below them\. Above them: row 1 \(A1 "Title"\)\. If row 3 is the header row of a table that has no rows yet, send the same op with "afterRow": 3 and the rows are added from row 4\. If it is a label or a line at the foot of something else, do not: build a new workbook from the full data instead\.$/);
      const bareReport = applyOps(bare, [{ ...one([{ CODE: "B", QTY: 2 }])[0], afterRow: 3 }]).reports[0];
      check("confirmed, it takes its first rows", bare.getWorksheet("S")!.getCell("A4").value === "B" && bareReport.addedAfter === 'row 3 (A3 "CODE", B3 "QTY")');
      refused("a label at the foot of a list, named as the only column", sheetOf([["Item", "Qty"], ["a", 1], ["b", 2], ["Remarks"]]), one([{ Remarks: "late" }]), /The headers are on row 4 \(A4 "Remarks"\)\. Nothing on sheet "S" lies below them\. Above them: row 2 \(A2 "a", B2 "1"\); row 3 \(A3 "b", B3 "2"\)\. If row 4 is the header row of a table that has no rows yet/);

      // Headers merged down over two rows are one header.
      const tall = () =>
        sheetOf([["Item", "Qty"], [null, null], ["a", 1], ["b", 2]], (ws) => {
          ws.mergeCells("A1:A2");
          ws.mergeCells("B1:B2");
        });
      refused("a table under headers merged down two rows is asked about like any other", tall(), one([{ Item: "c", Qty: 3 }]), /The headers are on row 1 \(A1 "Item", B1 "Qty"\), merged down to row 2\. The last rows of sheet "S" are: row 3 \(A3 "a", B3 "1"\); row 4 \(A4 "b", B4 "2"\)\. Read them/);
      const tallBook = tall();
      applyOps(tallBook, [{ ...one([{ Item: "c", Qty: 3 }])[0], afterRow: 4 }]);
      check("and takes the rows below its last one", tallBook.getWorksheet("S")!.getCell("B5").value === 3);
      const tallBare = sheetOf([["Item", "Qty"], [null, null]], (ws) => {
        ws.mergeCells("A1:A2");
        ws.mergeCells("B1:B2");
      });
      applyOps(tallBare, [{ ...one([{ Item: "c", Qty: 3 }])[0], afterRow: 2 }]);
      check("with no rows yet, the first goes below the merged headers", tallBare.getWorksheet("S")!.getCell("A3").value === "c");

      // A label held as rich text (part of it in bold) or as a link is a label all the same.
      const bold = sheetOf([["Item", "Amount"], ["a", 100.25], ["b", 110.2], ["c", 100.3], [null, 310.75]], (ws) => void (ws.getCell("A5").value = { richText: [{ font: { bold: true }, text: "TOTAL" }] }));
      refused("a total whose label is in bold", bold, one([{ Item: "d", Amount: 5 }]), /is the table's total or closing line, by its label, A5 "TOTAL"/);
      const linked = sheetOf([["Item", "Amount"], ["a", 100.25], ["b", 110.2], ["c", 100.3], [null, 99]], (ws) => void (ws.getCell("A5").value = { text: "Total sales", hyperlink: "https://example.com/" }));
      refused("a label that is a link", linked, one([{ Item: "d", Amount: 5 }]), /A5 "Total sales" reads like the label of a total, an average or a closing line/);

      // A merged block where the rows would go: said before the question, not after it is answered.
      const block = sheetOf([["Item", "Qty", "Fig"], ["a", 1, 2], ["b", 3, 4]], (ws) => ws.mergeCells("A4:A5"));
      refused("merged cells below the last row", block, one([{ Item: "c", Qty: 5, Fig: 6 }, { Item: "d", Qty: 7, Fig: 8 }]), /The rows below the table on sheet "S" hold merged cells \(A4\): a value written into a merged block is lost/);
      refused("merged cells in the second row to be written, beside the named columns", sheetOf([["Item", "Qty", "Fig"], ["a", 1, 2], ["b", 3, 4]], (ws) => ws.mergeCells("C5:C6")), one([{ Item: "c", Qty: 5 }, { Item: "d", Qty: 7 }]), /hold merged cells \(C5\)/);

      // Words under every column of figures: headings when they differ, a day without figures when they are the same word.
      refused("another table's headings under two columns of figures", sheetOf([["Item", "Qty", "Amount"], ["a", 3, 30], ["b", 4, 41], ["c", 5, 52], ["Region", "Target", "Actual"], ["North", 10, 12]]), one([{ Item: "d", Qty: 1, Amount: 2 }]), /holds words under every column of figures on row 5 \(A5 "Region", B5 "Target", C5 "Actual"\): it reads like another table's headings/);
      const shut = sheetOf([["Day", "Qty", "Amount"], ["Mon", 3, 30], ["Tue", "closed", "closed"], ["Wed", 5, 52], ["Thu", 6, 61]]);
      refused("a day with the same word under each column of figures", shut, one([{ Day: "Fri", Qty: 1, Amount: 2 }]), /Signs that row 5 may not be an ordinary row of the table under those headers: row 3 \(A3 "Tue", B3 "closed", C3 "closed"\) holds words under "Qty", a column of figures: another table's headings, a note, or only an odd value\. Read them/);
      applyOps(shut, [{ ...one([{ Day: "Fri", Qty: 1, Amount: 2 }])[0], afterRow: 5 }]);
      check("and such a log takes rows once its last row is confirmed", shut.getWorksheet("S")!.getCell("B6").value === 1);

      // Many rows with the same word do not hide the one row whose word is said once.
      const busy = sheetOf([["Item", "Amount"], ["a", 1], ["b", "pending"], ["c", "pending"], ["d", "pending"], ["e", 5], ["f", 6], ["g", 7], ["h", "pending"], ["i", "pending"], ["j", "pending"], ["k", 11], ["l", 12], ["m", 13], ["n", 14], ["o", 15], ["Region", "Sales"], ["North", 10], ["South", 12]]);
      refused("another table's headings among rows that hold an odd word", busy, one([{ Item: "z", Amount: 1 }]), /under those headers: row 17 \(A17 "Region", B17 "Sales"\) holds words under "Amount", a column of figures: another table's headings, a note, or only an odd value; row 11 \(A11 "j", B11 "pending"\) holds words under "Amount"[^;]*; row 10 \(A10 "i", B10 "pending"\) holds words under "Amount"[^;]*; 4 more rows hold words under a column of figures or dates \(rows 3, 4, 5, 9\)\. Read them/);
      const shared = sheetOf([["Item", "Amount"], ["a", 1], ["b", 2], ["Region", "Sales"], ["North", "high"], ["South", "low"], ["East", "low"]]);
      refused("a column to take figures that holds more words than figures", shared, one([{ Item: "z", Amount: 1 }]), /under those headers: the rows under "Amount" hold words on 4 rows and figures or dates on 2: more than one table may lie under those headers\. Read them/);

      // A hidden last row is said to be hidden; a long row is said to be cut.
      const tucked = sheetOf([["Item", "Qty"], ["a", 1], ["b", 2]], (ws) => void (ws.getRow(3).hidden = true));
      refused("a hidden last row", tucked, one([{ Item: "c", Qty: 3 }]), /under those headers: row 3 is hidden\. Read them/);
      const wide = sheetOf([["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
      refused("a row of more cells than are quoted", wide, one([{ A: 2 }]), /The last rows of sheet "S" are: row 2 \(A2 "1", B2 "2", C2 "3", D2 "4", E2 "5", F2 "6", G2 "7", H2 "8", …\)\. /);
    }

    // A block over the first cell of a plain filled-down formula: the cells left get their own, and the file saves.
    {
      const wb0 = new ExcelJS.Workbook();
      const w0 = wb0.addWorksheet("P");
      w0.getCell("A1").value = "Double";
      w0.getCell("C1").value = 4;
      w0.fillFormula("A2:A4", "C1*2", [8, 0, 0]);
      const { released } = applyOps(wb0, [{ op: "populate_sheet", sheet: "P", startCell: "A2", overwrite: true, rows: [{ x: 1 }] }]);
      const back = await save(wb0, out);
      check("a block over the first cell leaves the rest with their own formulas, and says which", back.getWorksheet("P")!.getCell("A2").value === 1 && back.getWorksheet("P")!.getCell("A3").formula === "C2*2" && back.getWorksheet("P")!.getCell("A4").formula === "C3*2" && [...(released.get("P") ?? [])].join() === "A3,A4");
      for (const f of ["1.E3*B2", "ABC1234567+B2", "B1048577*2"]) check(`not carried over: ${f}`, !translatesSafely(f));
    }

    // -----------------------------------------------------------------------
    // Found by a fifth independent review.
    // -----------------------------------------------------------------------

    // What stands beside a table is not part of its rows: a list out to the right does not hide an empty row.
    {
      const beside = (rows: unknown[][]) => sheetOf(rows.map((r, i) => [...r, ...Array(7 - r.length).fill(null), ["Region", "North", "South", "East", "West", "Mid"][i] ?? "More", i + 1]));
      const two = beside([["CODE", "QTY", "AMOUNT"], ["A"], [], ["ITEM", "RETURNED", "REFUND"], ["X"]]);
      refused("two tables with a list beside them", two, byCode({ QTY: "q", AMOUNT: "a" }, [{ c: "A", q: 1, a: 10 }, { c: "X", q: 9, a: 90 }]), /Row 4 \(A4 "ITEM", B4 "RETURNED", C4 "REFUND"\) has what reads like column headings, and 1 of the data's keys are found from there down/);
      const gap = beside([["CODE", "QTY", "AMOUNT"], ["A"], [], ["Branch", 2025, 2026], ["X"]]);
      refused("an empty row across the table, though not across the sheet", gap, byCode({ QTY: "q", AMOUNT: "a" }, [{ c: "A", q: 1, a: 10 }, { c: "X", q: 9, a: 90 }]), /Row 4 \(A4 "Branch", B4 "2025", C4 "2026"\) has a row above it with nothing under these columns, and no key the data has/);
    }

    // The question names every row that may begin something else, with its number.
    {
      const grouped = () => sheetOf([["CODE", "QTY"], ["A"], [], ["Group B"], ["B"], [], ["Returns"], ["ITEM", "RETURNED"], ["X"]]);
      const data = [{ c: "A", q: 1 }, { c: "B", q: 2 }, { c: "X", q: 9 }];
      refused(
        "a label after a gap, then another table further down",
        grouped(),
        byCode({ QTY: "q" }, data),
        /each of these rows may begin something else, or be only a label or an item the data has no row for: row 4 \(A4 "Group B"\), which follows a row with nothing under these columns and has no key the data has; row 7 \(A7 "Returns"\), which follows a row with nothing under these columns and has no key the data has; row 8 \(A8 "ITEM", B8 "RETURNED"\), which reads like column headings\. Send the same op with "lastRow": the row just above the first of them that does begin something else/,
      );
      const right = grouped();
      const r = applyOps(right, byCode({ QTY: "q" }, data, { lastRow: 5 })).reports[0];
      check("answered with the table's own last row, the group is filled and the other table is not", right.getWorksheet("S")!.getCell("B5").value === 2 && right.getWorksheet("S")!.getCell("B9").value === null && r.dataKeysBelowLastRow === 1 && r.lastRow === 5);
      const wrong = applyOps(grouped(), byCode({ QTY: "q" }, data, { lastRow: 99 })).reports[0];
      check("answered with the whole sheet, the row that reads like headings is named in the result", wrong.rowsThatReadLikeHeadings?.join() === "8" && wrong.lastRow === 9);
      // The flag for "after an empty row" is about the next row only.
      const once = sheetOf([["CODE", "QTY"], ["A"], [], ["B"], ["Z"], ["C"]]);
      applyOps(once, byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "B", q: 2 }, { c: "C", q: 3 }]));
      check("a row the data has nothing for, two rows after a gap, is an ordinary row", once.getWorksheet("S")!.getCell("B6").value === 3);
      refused("a row of nothing but spaces is an empty row", sheetOf([["CODE", "QTY"], ["A"], ["  ", " "], ["Label"], ["X"]]), byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "X", q: 9 }]), /Row 4 \(A4 "Label"\) has a row above it with nothing under these columns/);
    }

    // A value is written as the column it goes into holds its values; decided for the whole column, never value by value.
    {
      const day = (d: number) => new Date(Date.UTC(2026, 10, d));
      const log = () =>
        sheetOf([["Date", "Branch", "Qty"], [day(2), "101", 5], [day(3), "0222", 7]], (ws) => {
          ws.getCell("A2").numFmt = "dd-mmm-yy";
          ws.getCell("A3").numFmt = "dd-mmm-yy";
        });
      const wb = log();
      const { reports } = applyOps(wb, [{ op: "append_rows", sheet: "S", afterRow: 3, rows: [{ Date: "2026-11-04", Branch: 103, Qty: "9" }, { Date: "2026-11-05 13:45:00", Branch: 104, Qty: "12.5" }] }]);
      const saved = await save(wb, out);
      const ws = saved.getWorksheet("S")!;
      check("a date that arrives as text is a date under a column of dates, shown as the others are", ws.getCell("A4").value instanceof Date && (ws.getCell("A4").value as Date).toISOString() === "2026-11-04T00:00:00.000Z" && ws.getCell("A4").numFmt === "dd-mmm-yy" && (ws.getCell("A5").value as Date).toISOString() === "2026-11-05T13:45:00.000Z");
      check("a number under digits kept as text is text, and text that is a number under numbers is a number", ws.getCell("B4").value === "103" && ws.getCell("C4").value === 9 && ws.getCell("C5").value === 12.5);
      check("and the result says which columns were written as the sheet holds them", JSON.stringify(reports[0].writtenAs) === JSON.stringify({ Date: "dates", Branch: "digits kept as text", Qty: "numbers" }));
      refused("something that is not a date, under a column of dates", log(), [{ op: "append_rows", sheet: "S", rows: [{ Date: "Nov 4", Branch: "103", Qty: 1 }] }], /the column "Date" holds dates in the sheet \(A3\), and the data gives "Nov 4" for it, which is not a date.*Give dates as YYYY-MM-DD/);
      refused("a day that does not exist", log(), [{ op: "append_rows", sheet: "S", rows: [{ Date: "2026-02-30", Branch: "103", Qty: 1 }] }], /the data gives "2026-02-30" for it, which is not a date/);
      refused("a number under a column of dates", log(), [{ op: "append_rows", sheet: "S", rows: [{ Date: 46000, Branch: "103", Qty: 1 }] }], /the column "Date" holds dates in the sheet \(A3\), and the data gives 46000 for it/);
      // The same in a fill by key; a formula, a placeholder or one stray word in the column does not change what it holds.
      const filled = sheetOf([["CODE", "Last sold", "PO"], ["A", day(1), 450012], ["B", day(1), 450013], ["C", null, null], ["D", { formula: "B2+1" }, "N/A"], ["E", day(2), 1], ["F", day(2), 2], ["G", "tbc soon", 3], ["H", day(3), 4]], (w) => void (w.getCell("B2").numFmt = "d mmm yyyy"));
      const rf = applyOps(filled, byCode({ "Last sold": "d", PO: "po" }, [{ c: "B", d: "2026-11-09", po: "450099" }, { c: "C", d: "2026-11-10", po: "450100" }], { overwrite: true })).reports[0];
      const savedFill = (await save(filled, out)).getWorksheet("S")!;
      check("a fill writes a date under dates, shown as the column's dates are, and a number under numbers", (savedFill.getCell("B3").value as Date).toISOString() === "2026-11-09T00:00:00.000Z" && savedFill.getCell("B4").value instanceof Date && savedFill.getCell("B4").numFmt === "d mmm yyyy" && savedFill.getCell("C3").value === 450099 && rf.writtenAs?.["Last sold"] === "dates" && rf.writtenAs?.PO === "numbers");
      // A column of text dates, or an empty one with no date format, keeps dates as text, and says so.
      const empty = sheetOf([["CODE", "When"], ["A"], ["B"]]);
      const re = applyOps(empty, byCode({ When: "d" }, [{ c: "A", d: "2026-11-09" }])).reports[0];
      check("dates for a column that gives no sign of holding dates are written as text, and that is said", empty.getWorksheet("S")!.getCell("B2").value === "2026-11-09" && re.datesAsText?.join() === "When" && re.writtenAs === undefined);
      // An empty column whose cells are formatted as dates takes dates.
      const template = sheetOf([["CODE", "When"], ["A"], ["B"]], (w) => {
        w.getCell("B2").numFmt = "dd/mm/yyyy";
        w.getCell("B3").numFmt = "dd/mm/yyyy";
      });
      const rt = applyOps(template, byCode({ When: "d" }, [{ c: "A", d: "2026-11-09" }, { c: "B", d: "2026-11-10" }])).reports[0];
      check("an empty column formatted for dates takes real dates", template.getWorksheet("S")!.getCell("B2").value instanceof Date && template.getWorksheet("S")!.getCell("B2").numFmt === "dd/mm/yyyy" && rt.writtenAs?.When === "dates");
      // A date into a cell whose own format is not a date's is given one: saved without it, it would be a bare number.
      const odd = sheetOf([["CODE", "When"], ["A", day(1)], ["B", null]], (w) => {
        w.getCell("B2").numFmt = "dd/mm/yyyy";
        w.getCell("B3").numFmt = "0.00";
      });
      applyOps(odd, byCode({ When: "d" }, [{ c: "B", d: "2026-11-10" }]));
      const savedOdd = (await save(odd, out)).getWorksheet("S")!;
      check("a date written into a cell formatted as a number reads back as a date", savedOdd.getCell("B3").value instanceof Date && savedOdd.getCell("B3").numFmt === "dd/mm/yyyy");

      // Figures stay figures. One stray "0" typed as text decides nothing; a fraction or a minus sign means figures.
      const stray = sheetOf([["CODE", "Qty"], ["A", null], ["B", null], ["Z", "0"]]);
      const rs = applyOps(stray, byCode({ Qty: "q" }, [{ c: "A", q: 10 }, { c: "B", q: 20 }])).reports[0];
      check("one cell of digits as text does not turn figures into text", stray.getWorksheet("S")!.getCell("B2").value === 10 && stray.getWorksheet("S")!.getCell("B3").value === 20 && rs.writtenAs === undefined);
      const textDigits = () => sheetOf([["CODE", "Amt"], ["A", "120"], ["B", "45"], ["C", "7"]]);
      const frac = textDigits();
      applyOps(frac, byCode({ Amt: "q" }, [{ c: "A", q: 10 }, { c: "B", q: 2.5 }, { c: "C", q: -3 }], { overwrite: true }));
      check("with a fraction or a minus sign among them, all of the column's values are written as numbers", frac.getWorksheet("S")!.getCell("B2").value === 10 && frac.getWorksheet("S")!.getCell("B3").value === 2.5 && frac.getWorksheet("S")!.getCell("B4").value === -3);
      const whole = textDigits();
      const rw = applyOps(whole, byCode({ Amt: "q" }, [{ c: "A", q: 10 }, { c: "B", q: 20 }], { overwrite: true })).reports[0];
      check("whole numbers under digits kept as text are all text, and that is said", whole.getWorksheet("S")!.getCell("B2").value === "10" && whole.getWorksheet("S")!.getCell("B3").value === "20" && rw.writtenAs?.Amt === "digits kept as text");
      // Under numbers, text that is not a plain number is not written as text beside numbers: it is refused.
      const nums = () => sheetOf([["CODE", "Amt"], ["A", 1], ["B", 2], ["C", null], ["D", null]]);
      for (const bad of ["1,250", "007", "12345678901234567", "12%"]) {
        refused(`text under numbers: ${bad}`, nums(), byCode({ Amt: "q" }, [{ c: "C", q: "5" }, { c: "D", q: bad }]), /the column "Amt" holds numbers in the sheet, and the data gives ".*" for it, which is text and not a plain number/);
      }
      const ok = nums();
      applyOps(ok, byCode({ Amt: "q" }, [{ c: "C", q: "5" }, { c: "D", q: "N/A" }]));
      check("a placeholder under numbers is left as the placeholder it is", ok.getWorksheet("S")!.getCell("B4").value === 5 && ok.getWorksheet("S")!.getCell("B5").value === "N/A");
      // A column that holds one thing and another says nothing, and the value is written as it came.
      const mixed = sheetOf([["CODE", "Note"], ["A", "101"], ["B", "see file"], ["C", null]]);
      const rm = applyOps(mixed, byCode({ Note: "n" }, [{ c: "C", n: 7 }], { lastRow: 4 })).reports[0];
      check("a mixed column decides nothing", mixed.getWorksheet("S")!.getCell("B4").value === 7 && rm.writtenAs === undefined);
      const two = sheetOf([["CODE", "X"], ["A", 5], ["B", "0222"], ["B2", "0333"], ["C", null]]);
      applyOps(two, byCode({ X: "n" }, [{ c: "C", n: 7 }]));
      check("a column of numbers and of digits kept as text decides nothing", two.getWorksheet("S")!.getCell("B5").value === 7);
      const codes = sheetOf([["CODE", "Branch"], ["A", "101"], ["B", "0222"], ["B2", "N/A"], ["C", null]]);
      applyOps(codes, byCode({ Branch: "n" }, [{ c: "C", n: 103 }]));
      check("a placeholder among codes kept as text does not change what the column holds", codes.getWorksheet("S")!.getCell("B5").value === "103");
      refused("a fill that would put something that is not a date under dates", sheetOf([["CODE", "Due"], ["A", day(1)], ["B", null]]), byCode({ Due: "d" }, [{ c: "B", d: "soon" }]), /fill_by_key: the column "Due" holds dates in the sheet \(B2\), and the data gives "soon" for it, which is not a date/);
      // Rows without data are given 0 under figures, never under dates.
      const zeros = sheetOf([["CODE", "Due", "Qty"], ["A", day(1), 1], ["B", null, null], ["C", day(2), 2]]);
      applyOps(zeros, byCode({ Due: "d", Qty: "q" }, [{ c: "A", d: "2026-11-09", q: 9 }], { overwrite: true, unmatched: "zero" }));
      check("a 0 for a row without data goes under figures, not under dates", zeros.getWorksheet("S")!.getCell("B3").value === null && zeros.getWorksheet("S")!.getCell("C3").value === 0);

      // A sheet as it comes from a file: cells that look alike share one style. A date written into one of
      // them must not change how the others are shown.
      const styled = new ExcelJS.Workbook();
      const st = styled.addWorksheet("S");
      st.addRows([["CODE", "Due", "Amount"], ["A", day(1), 100], ["B", null, 200], ["C", null, 300], ["TOTAL", null, null]]);
      st.getCell("C5").value = { formula: "SUM(C2:C4)", result: 600 };
      const border = { top: { style: "thin" as const }, bottom: { style: "thin" as const } };
      for (let r = 2; r <= 5; r++) for (const c of ["A", "B", "C"]) st.getCell(`${c}${r}`).border = border;
      st.getCell("B2").numFmt = "dd-mmm-yy";
      const styledPath = join(dir, "styled.xlsx");
      await styled.xlsx.writeFile(styledPath);
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.readFile(styledPath);
      const beforeStyled = signaturesOf(loaded);
      const doneStyled = applyOps(loaded, byCode({ Due: "d" }, [{ c: "B", d: "2026-11-09" }, { c: "C", d: "2026-11-10" }]));
      dropFormulaResults(loaded);
      const savedStyled = await save(loaded, out);
      const ss = savedStyled.getWorksheet("S")!;
      check("dates written into bordered cells are dates, with the column's format", ss.getCell("B3").value instanceof Date && ss.getCell("B3").numFmt === "dd-mmm-yy" && ss.getCell("B4").numFmt === "dd-mmm-yy");
      check("and the cells that shared their style keep their own: amounts and the total are not shown as dates", !ss.getCell("C3").numFmt?.includes("mmm") && !ss.getCell("C5").numFmt?.includes("mmm") && ss.getCell("C3").value === 200 && !ss.getCell("A3").numFmt?.includes("mmm"));
      check("and the read-back agrees", compareWithBase(beforeStyled.sheets, savedStyled, doneStyled.written).length === 0);
    }

    // append_rows: the foot of the table, not of whatever stands beside it; and what does not take the rows in.
    {
      const wb = sheetOf([["CODE", "QTY", null, "List"], ["A", 1, null, "x"], ["B", 2, null, "y"]], (ws) => {
        ws.autoFilter = "A1:B3";
        ws.pageSetup.printArea = "A1:B3";
        ws.getCell("F1").value = { formula: "SUM(A2:B2)", result: 1 };
      });
      const r = applyOps(wb, [{ op: "append_rows", sheet: "S", afterRow: 3, rows: [{ CODE: "C", QTY: 3 }] }]).reports[0];
      check("rows are added at the foot of the table, with a list beside it that ends where the table does", wb.getWorksheet("S")!.getCell("A4").value === "C" && r.range === "A4:B4");
      check("a filter and a print area that do not take the new rows in are said", r.doesNotCover?.join() === "the sheet's filter,the sheet's print area");
      // A list beside the table that runs further down: the end of the sheet is then not the foot of the table.
      refused("a list beside the table that runs further down", sheetOf([["CODE", "QTY", null, "List"], ["A", 1, null, "x"], ["B", 2, null, "y"], [null, null, null, "z"], [null, null, null, "w"]]), [{ op: "append_rows", sheet: "S", rows: [{ CODE: "C", QTY: 3 }] }], /has an empty row \(row 4\) between its headers \(row 1\) and the last row that holds anything \(row 5: D5 "w"\)/);
      refused("an empty row of the table, with a list beside it and more below", sheetOf([["CODE", "QTY", "List"], ["A", 1, "x"], [null, null, "y"], ["ITEM", "RET", "z"], ["X", 2, "w"]]), [{ op: "append_rows", sheet: "S", rows: [{ CODE: "C", QTY: 3 }] }], /has an empty row \(row 3\) between its headers \(row 1\) and the last row that holds anything \(row 5: A5 "X", B5 "2", C5 "w"\)/);
      check("a filter and a print area that do not take the new rows in are said", r.doesNotCover?.join() === "the sheet's filter,the sheet's print area");
    }

    // -----------------------------------------------------------------------
    // Found by the last narrow check before a live test.
    // -----------------------------------------------------------------------
    {
      const day = (d: number) => new Date(Date.UTC(2026, 10, d));
      // Adding rows never writes into the table's last row because the op does not name the column that fills it.
      const totals = (last: unknown) => sheetOf([["Date", "Store", "Qty", "Amount"], ["d1", "N", 1, 10], ["d2", "S", 2, 20], ["d3", "E", 3, 30], [null, null, null, last]]);
      const three = [{ op: "append_rows" as const, sheet: "S", rows: [{ Date: "d4", Store: "W", Qty: 9 }] }];
      refused("a total in a column the append does not name", totals({ formula: "SUM(D2:D4)", result: 60 }), three, /\(row 5: D5 "60"\) holds nothing under the headers being filled: it is a total kept in another column/);
      refused("a typed total in a column the append does not name", totals(60), three, /\(row 5: D5 "60"\) holds nothing under the headers being filled/);
      // The same total past a column with no heading, where the table's headings stop short of it.
      const pastAGap = sheetOf([["Date", "Store", "Qty", null, "Amount"], ["d1", "N", 1, null, 10], ["d2", "S", 2, null, 20], [null, null, null, null, 30]]);
      refused("a total under a column past one with no heading", pastAGap, three, /\(row 4: E4 "30"\) holds nothing under the headers being filled/);
      // A total somebody typed, with its label, or known only by being the sum of what is above it.
      const typed = (last: unknown[]) => sheetOf([["Date", "Store", "Qty", "Amount"], ["d1", "N", 1, 10], ["d2", "S", 2, 20], ["d3", "E", 3, 30], last]);
      const four = [{ op: "append_rows" as const, sheet: "S", rows: [{ Date: "d4", Store: "W", Qty: 9, Amount: 90 }] }];
      const closing = /The last row of sheet "S" that holds anything \(row \d+\) is the table's total or closing line, by /;
      const asked = /append_rows adds rows after the last row of the sheet, and only once that row has been read and confirmed\. Nothing was added\. The headers are on row \d+ \(.*?\)\. The last rows of sheet "S" are: .*Signs that row \d+ may not be an ordinary row of the table under those headers: /;
      refused("a typed total that leaves a column empty", typed(["TOTAL", null, 6, 60]), four, /is the table's total or closing line, by its label, A5 "TOTAL"/);
      refused("a typed total with its label, every column filled", typed(["Total", "all", 6, 61]), four, /by its label, A5 "Total"/);
      refused("a typed total with no label", typed(["all", "all", 6, 60]), four, /by C5 \(6\) and D5 \(60\) each being the sum of the figures above them/);
      // What closes a table without a formula and without the word "total".
      refused("an average row", typed(["Average", null, 2, 20]), four, /Signs that row \d+ may not be an ordinary row of the table under those headers: A5 "Average" reads like the label of a total, an average or a closing line/);
      refused("a total in another language", typed(["Kabuuan", "lahat", 6.0, 60.01]), four, /by its label, A5 "Kabuuan"/);
      refused("a line net of something", typed(["Net of returns", "all", 5, 50]), four, /by its label, A5 "Net of returns"/);
      refused("a label followed by a colon", typed(["Total:", "all", 7, 61]), four, /by its label, A5 "Total:"/);
      refused("a last row that lacks what every row above has, with no other sign", typed(["d9", null, 20, 61]), four, /Signs that row \d+ may not be an ordinary row of the table under those headers: row 5 does not hold anything under "Store", which every row above it does/);
      // A label that only begins like one is certain together with a figure that is the sum above it (rounded as typed totals are).
      const items = (last: unknown[]) => sheetOf([["Item", "Amount"], ["a", 100.25], ["b", 110.2], ["c", 100.3], last]);
      const oneItem = [{ op: "append_rows" as const, sheet: "S", rows: [{ Item: "d", Amount: 5 }] }];
      refused("a total with a longer label", items(["Total Amount", 310.75]), oneItem, /by its label, A5 "Total Amount", and B5 \(310\.75\) being the sum of the figures above it/);
      refused("a total rounded to a whole number", items(["TOTAL PHP", 311]), oneItem, /by its label, A5 "TOTAL PHP", and B5 \(311\) being the sum/);
      refused("a subtotal named for its group", items(["Sub-total South", 310.75]), oneItem, closing);
      // Without the sum to confirm it, such a label only raises the question; so do the other words a closing line begins with.
      for (const label of ["Total Amount", "Count", "Maximum", "Average per item", "% of target", "Balance c/f", "Note: prices exclude VAT", "Checked by"]) {
        refused(`a last row labelled "${label}"`, items([label, 42]), oneItem, asked);
      }
      refused("an unlabelled total in the table's only column of figures", items(["all", 310.75]), oneItem, /B5 \(310\.75\) is the sum of the figures above it, in the table's only column of figures/);
      // The answer to the question: the row to add after, once the rows have been read.
      const confirmed = items(["Total Engine Oil 1L", 42]);
      refused("an item whose name begins like a total, until it is confirmed", confirmed, oneItem, /The last rows of sheet "S" are: row 3 \(A3 "b", B3 "110\.2"\); row 4 \(A4 "c", B4 "100\.3"\); row 5 \(A5 "Total Engine Oil 1L", B5 "42"\)\. Signs that row 5 may not be an ordinary row of the table under those headers: A5 "Total Engine Oil 1L" reads like the label of a total, an average or a closing line\. Read them\. If row 5 is an ordinary row of the table.*send the same op with "afterRow": 5 and the rows are added from row 6/);
      const overSign = applyOps(confirmed, [{ ...oneItem[0], afterRow: 5 }]).reports[0];
      check("confirmed, the rows are added after it", confirmed.getWorksheet("S")!.getCell("A6").value === "d" && confirmed.getWorksheet("S")!.getCell("B6").value === 5);
      check("and the report keeps the sign that was confirmed over", overSign.addedAfter === 'row 5 (A5 "Total Engine Oil 1L", B5 "42")' && overSign.lastRowSigns?.length === 1 && /reads like the label of a total/.test(overSign.lastRowSigns[0]));
      refused("a row to add after that is not the sheet's last", items(["e", 42]), [{ ...oneItem[0], afterRow: 4 }], /"afterRow" is 4, and the last row of sheet "S" that holds anything is row 5 \(A5 "e", B5 "42"\)\. Rows are added only after that row/);
      refused("what is certain is not waived by confirming", items(["Total", 42]), [{ ...oneItem[0], afterRow: 5 }], /by its label, A5 "Total"/);
      const pending = sheetOf([["Item", "Qty"], ["a", 1], ["b", 2], ["c", "pending"]]);
      refused("a word under a column of figures in the last row", pending, [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 4 }] }], /row 4 \(A4 "c", B4 "pending"\) holds words under "Qty", a column of figures: another table's headings, a note, or only an odd value/);
      applyOps(pending, [{ op: "append_rows", sheet: "S", afterRow: 4, rows: [{ Item: "d", Qty: 4 }] }]);
      check("and confirmed as only an odd value, the log takes the row", pending.getWorksheet("S")!.getCell("B5").value === 4);
      refused("a note in one cell under a table with an optional column", sheetOf([["Item", "Qty", "Remark"], ["a", 1, null], ["b", 2, "x"], ["prices exclude VAT", null, null]]), [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 4, Remark: null }] }], /row 4 holds a value under one header only, where the rows above it hold more/);
      refused("a note in one cell directly under headers with no rows yet", sheetOf([["Item", "Qty"], ["prices exclude VAT"]]), [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 4 }] }], /row 2 is the only row under the headers and holds a value under one of them only/);
      const datedLog = (last: unknown[]) => sheetOf([["Date", "Store", "Qty", "Amount"], [day(1), "N", 1, 10], [day(2), "S", 2, 20], [day(3), "S", 3, 30], last]);
      const fourD = [{ op: "append_rows" as const, sheet: "S", rows: [{ Date: "2026-11-04", Store: "W", Qty: 9, Amount: 90 }] }];
      refused("a subtotal for the last group, labelled with the group", datedLog(["South", "S", 5, 50]), fourD, /Signs that row 5 may not be an ordinary row of the table under those headers: row 5 does not hold a date under "Date", which every row above it does; row 5 \(.*\) holds words under "Date", a column of dates/);
      refused("a signature line that fills two columns", datedLog(["Prepared by:", "J. Cruz", null, null]), fourD, /A5 "Prepared by:" reads like the label of a total, an average or a closing line/);
      refused("another table directly below, with no empty row", sheetOf([["Date", "Store", "Qty", "Amount"], [day(1), "N", 1, 10], [day(2), "S", 2, 20], ["Date", "Store", "Returned", "Refund"], [day(3), "S", 11, 110]]), fourD, /holds words under every column of figures on row 4 \(A4 "Date", B4 "Store", C4 "Returned", D4 "Refund"\): it reads like another table's headings/);
      refused("the headers again inside a table of words", sheetOf([["Name", "Remarks"], ["a", "x"], ["Name", "Remarks"], ["b", "y"]]), [{ op: "append_rows", sheet: "S", rows: [{ Name: "c", Remarks: "z" }] }], /holds the headers again on row 3 \(A3 "Name", B3 "Remarks"\): another table begins there/);
      const hidden = datedLog([day(4), "E", 4, 40]);
      hidden.getWorksheet("S")!.getRow(6).hidden = true;
      refused("rows below the table that are hidden", hidden, fourD, /The rows below the table on sheet "S" \(from row 6\) are hidden/);
      // Ordinary logs are not refused for looking a little like one of those.
      const chance = sheetOf([["No.", "Date", "Qty"], [1, day(1), 5], [2, day(2), 7], [3, day(3), 12]]);
      refused("a last figure that equals the sum of those above, in the only column of figures: asked, with the rows shown as they are written", chance, [{ op: "append_rows", sheet: "S", rows: [{ Date: "2026-11-04", Qty: 9 }] }], /The last rows of sheet "S" are: row 2 \(A2 "1", B2 "2026-11-01", C2 "5"\); row 3 \(A3 "2", B3 "2026-11-02", C3 "7"\); row 4 \(A4 "3", B4 "2026-11-03", C4 "12"\)\. Signs that row 4 may not be an ordinary row of the table under those headers: C4 \(12\) is the sum of the figures above it, in the table's only column of figures\. Read them/);
      applyOps(chance, [{ op: "append_rows", sheet: "S", afterRow: 4, rows: [{ Date: "2026-11-04", Qty: 9 }] }]);
      check("and confirmed, it is a row like any other (a running number is never taken for a total)", chance.getWorksheet("S")!.getCell("C5").value === 9 && chance.getWorksheet("S")!.getCell("B5").value instanceof Date);
      // One figure that sums, beside others that do not: chance, or a total beside an average. Asked either way.
      const longer = () => sheetOf([["No.", "Date", "Qty", "Amt"], [1, day(1), 5, 50], [2, day(2), 7, 71], [3, day(3), 12, 99]]);
      refused("one figure that is the sum above it, beside one that is not", longer(), [{ op: "append_rows", sheet: "S", rows: [{ Date: "2026-11-04", Qty: 9, Amt: 9 }] }], /Signs that row 4 may not be an ordinary row of the table under those headers: C4 \(12\) is the sum of the figures above it\. Read them/);
      const confirmedLonger = longer();
      applyOps(confirmedLonger, [{ op: "append_rows", sheet: "S", afterRow: 4, rows: [{ Date: "2026-11-04", Qty: 9, Amt: 9 }] }]);
      check("and confirmed, the row is added", confirmedLonger.getWorksheet("S")!.getCell("C5").value === 9);
      // A total rounded to tens, with no label: not exact enough to be certain, close enough to be asked about.
      refused("a total rounded to tens", sheetOf([["Item", "Qty", "Amt"], ["a", 3, 1234], ["b", 4, 2345], ["c", 5, 3456], ["all", 99, 7040]]), [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 1, Amt: 1 }] }], /C5 \(7040\) is the sum of the figures above it, rounded/);
      // "Total" anywhere in a label, with figures that are no exact sum.
      for (const label of ["Month total", "South Total", "** TOTAL **", "Share of total"]) {
        refused(`a last row labelled "${label}"`, sheetOf([["Item", "Qty"], ["a", 3], ["b", 4], ["c", 5], [label, 99]]), [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 1 }] }], label === "** TOTAL **" ? /by its label, A5 "\*\* TOTAL \*\*"/ : /reads like the label of a total, an average or a closing line/);
      }
      // A value that is only a word a total could be labelled with is asked about, not refused: it can be a rating or a remark.
      const rated = sheetOf([["Item", "Rating"], ["a", "Good"], ["b", "Poor"], ["c", "Average"]]);
      refused("a rating of Average in the last row", rated, [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Rating: "Good" }] }], /B4 "Average" reads like the label of a total, an average or a closing line/);
      applyOps(rated, [{ op: "append_rows", sheet: "S", afterRow: 4, rows: [{ Item: "d", Rating: "Good" }] }]);
      check("and confirmed as a value, the row is added", rated.getWorksheet("S")!.getCell("B5").value === "Good");
      // Another table directly below, when the column of figures already holds an odd word of its own.
      const below = sheetOf([["Item", "Qty"], ["a", 3], ["b", "pending"], ["c", 5], ["Item", "Returned"], ["x", 9]]);
      refused("another table's headings under a column of figures that has an odd word in it", below, [{ op: "append_rows", sheet: "S", rows: [{ Item: "d", Qty: 1 }] }], /row 5 \(A5 "Item", B5 "Returned"\) holds words under "Qty", a column of figures/);
      // The signs that are looked for in every row, in every new row, and in the last row's layout.
      refused("a word under a column of figures in the middle of the table", sheetOf([["Item", "Qty"], ["a", 3], ["b", "pending"], ["c", 5], ["d", 6]]), [{ op: "append_rows", sheet: "S", rows: [{ Item: "e", Qty: 1 }] }], /row 3 \(A3 "b", B3 "pending"\) holds words under "Qty"/);
      const mergedLast = sheetOf([["Item", "Qty", "Note"], ["a", 3, "x"], ["b", 4, "y"], ["c", 5, "z"]], (ws) => ws.mergeCells("C4:D4"));
      refused("merged cells in the last row", mergedLast, [{ op: "append_rows", sheet: "S", rows: [{ Item: "e", Qty: 1, Note: "n" }] }], /row 4 has merged cells, as a banner or a footer has/);
      const secondHidden = sheetOf([["Item", "Qty"], ["a", 3], ["b", 4]]);
      secondHidden.getWorksheet("S")!.getRow(5).hidden = true;
      refused("the second of two rows to be added is hidden", secondHidden, [{ op: "append_rows", sheet: "S", rows: [{ Item: "e", Qty: 1 }, { Item: "f", Qty: 2 }] }], /The rows below the table on sheet "S" \(from row 4\) are hidden/);
      const product = sheetOf([["Item", "Qty"], ["Brake Fluid 500ml", 4], ["Total Engine Oil 1L", 7]]);
      applyOps(product, [{ op: "append_rows", sheet: "S", afterRow: 3, rows: [{ Item: "Coolant 1L", Qty: 2 }] }]);
      check('an item whose name begins with "Total" is a row of the table once that is confirmed', product.getWorksheet("S")!.getCell("A4").value === "Coolant 1L");
      const optional = sheetOf([["Date", "Note"], [day(1), "rain"], [day(2), null], [day(3), null]]);
      applyOps(optional, [{ op: "append_rows", sheet: "S", afterRow: 4, rows: [{ Date: "2026-11-04", Note: "ok" }] }]);
      check("a last row that lacks a value some rows above also lack is a row of the table", optional.getWorksheet("S")!.getCell("B5").value === "ok");
      const ordinary = typed(["d4", "W", 4, 40]);
      const ra = applyOps(ordinary, [{ op: "append_rows", sheet: "S", afterRow: 5, rows: [{ Date: "d5", Store: "X", Qty: 5, Amount: 50 }] }]).reports[0];
      check("a last row that is a row of the table takes the new rows below it", ordinary.getWorksheet("S")!.getCell("C6").value === 5 && ra.range === "A6:D6");

      // A label in a column of the table the op does not name is not an empty row.
      // A category written in a column the op does not name, on a row of its own: that row has nothing under
      // the columns named. Followed by an item the data has, the table plainly goes on; followed by one it
      // lacks, with the data's keys further down, it is asked about like any other gap, and the row is quoted
      // across the table's whole width so that the label is seen.
      const grouped = (afterLabel: string) => sheetOf([["Cat", "CODE", "QTY"], [null, "A", null], ["Veg", null, null], [null, afterLabel, null], [null, "B", null]]);
      const goesOn = grouped("C");
      applyOps(goesOn, byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "C", q: 3 }, { c: "B", q: 2 }]));
      check("a category label followed by an item the data has is read across", goesOn.getWorksheet("S")!.getCell("C4").value === 3 && goesOn.getWorksheet("S")!.getCell("C5").value === 2);
      const two12 = [{ c: "A", q: 1 }, { c: "B", q: 2 }];
      refused("a category label followed by an item the data lacks, with the data's keys below", grouped("Z"), byCode({ QTY: "q" }, two12), /Row 4 \(B4 "Z"\) has a row above it with nothing under these columns, and no key the data has, and 1 of the data's keys are found from there down/);
      const said = grouped("Z");
      const rg = applyOps(said, byCode({ QTY: "q" }, two12, { lastRow: 5 })).reports[0];
      check("and told where the table ends, it is filled to there", said.getWorksheet("S")!.getCell("C5").value === 2 && rg.sheetKeysWithoutData?.join() === "Z");

      // What a column holds is what most of its cells are; a label or a total among them changes nothing.
      const dated = (extra: unknown[]) => sheetOf([["CODE", "Due"], ["A", day(1)], ["B", day(2)], ["C", day(3)], ...extra.map((x, i) => [`X${i}`, x]), ["T", null]]);
      const due = (wb: ExcelJS.Workbook, d: unknown, extra: object = {}) => applyOps(wb, byCode({ Due: "d" }, [{ c: "T", d }], extra));
      for (const [label, odd] of [["a label", "Subtotal"], ["a count", 3]] as const) {
        const wb = dated([odd]);
        due(wb, "2026-11-09");
        check(`three dates and ${label}: still a column of dates`, wb.getWorksheet("S")!.getCell("B6").value instanceof Date);
      }
      const tie = dated(["one", "two", "three"]);
      const rt = due(tie, "2026-11-09", { lastRow: 8 }).reports[0];
      check("as many words as dates: no longer a column of dates, and the date goes in as text, which is said", tie.getWorksheet("S")!.getCell("B8").value === "2026-11-09" && rt.datesAsText?.join() === "Due");
      const mostlyNumbers = sheetOf([["CODE", "Amt"], ["A", 1], ["B", 2], ["C", 3], ["D", "pending"], ["T", null]]);
      applyOps(mostlyNumbers, byCode({ Amt: "q" }, [{ c: "T", q: "1250.50" }], { lastRow: 6 }));
      check("three numbers and a word: still a column of numbers", mostlyNumbers.getWorksheet("S")!.getCell("B6").value === 1250.5);
      const computed = sheetOf([["CODE", "Amt"], ["A", { formula: "DATE(2026,1,1)", result: day(1) }], ["B", { formula: "DATE(2026,1,2)", result: day(2) }], ["C", 5], ["T", null]]);
      applyOps(computed, byCode({ Amt: "q" }, [{ c: "T", q: "7" }]));
      check("what formulas work out is not what the column is typed as", computed.getWorksheet("S")!.getCell("B5").value === 7);

      // A moment (…Z) is not a day as someone wrote it, unless it is midnight.
      const z = dated([]);
      due(z, "2026-11-04T00:00:00.000Z");
      check("midnight Z is that day", (z.getWorksheet("S")!.getCell("B5").value as Date).toISOString() === "2026-11-04T00:00:00.000Z");
      refused("a time of day with Z, which is another day somewhere", dated([]), byCode({ Due: "d" }, [{ c: "T", d: "2026-11-03T16:00:00.000Z" }]), /the data gives "2026-11-03T16:00:00\.000Z" for it, which is not a date as this reads one.*without a Z/);
      const blank = dated([]);
      const rb = due(blank, "  ").reports[0];
      check("text with nothing in it is no value: nothing is written and that is counted", blank.getWorksheet("S")!.getCell("B5").value === null && rb.emptyValuesLeft === 1 && rb.cellsWritten === 0);
      refused("text with nothing in it against a figure, in a refresh", sheetOf([["CODE", "QTY"], ["A", 7]]), byCode({ QTY: "q" }, [{ c: "A", q: "" }], { overwrite: true }), /the data has no value \(NULL\) for 1 cell that hold a figure now/);
      const noDue = sheetOf([["CODE", "Due", "Qty"], ["A", null, null], ["B", null, null], ["C", day(2), 2], ["D", day(3), 3]]);
      applyOps(noDue, byCode({ Due: "d", Qty: "q" }, [{ c: "A", d: null, q: 9 }], { unmatched: "zero" }));
      check("a 0 is not put under dates even when the data gives that column nothing", noDue.getWorksheet("S")!.getCell("B3").value === null && noDue.getWorksheet("S")!.getCell("C3").value === 0 && noDue.getWorksheet("S")!.getCell("C2").value === 9);

      // Times of day are not dates.
      const time = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m));
      const shifts = () =>
        sheetOf([["CODE", "Start"], ["A", time(7, 30)], ["B", time(8, 0)], ["C", null]], (ws) => {
          for (const a of ["B2", "B3"]) ws.getCell(a).numFmt = "hh:mm";
        });
      refused("text under a column of times", shifts(), byCode({ Start: "t" }, [{ c: "C", t: "13:30" }]), /the column "Start" holds times of day in the sheet \(B2\), and the data gives "13:30" for it.*Give a time as a number, the fraction of a day it is/);
      refused("a date as text under a column of times", shifts(), byCode({ Start: "t" }, [{ c: "C", t: "2026-11-04" }]), /holds times of day in the sheet/);
      const sh = shifts();
      const beforeShift = signaturesOf(sh);
      const doneShift = applyOps(sh, byCode({ Start: "t" }, [{ c: "C", t: 0.5625 }]));
      const savedShift = await save(sh, out);
      check("a time given as a number is a time, shown as the column's times are", savedShift.getWorksheet("S")!.getCell("B4").numFmt === "hh:mm" && (savedShift.getWorksheet("S")!.getCell("B4").value as Date).toISOString() === "1899-12-30T13:30:00.000Z");
      check("and the read-back takes the number and the time it shows for the same thing", compareWithBase(beforeShift.sheets, savedShift, doneShift.written).length === 0);

      // An empty column: the format of its cells is all there is to go by.
      const template = (fmt: string | undefined, rows = 3) =>
        sheetOf([["CODE", "Amt"], ...Array.from({ length: rows }, (_, i) => [`K${i}`])], (ws) => {
          if (fmt) for (let r = 2; r <= rows + 1; r++) ws.getCell(`B${r}`).numFmt = fmt;
        });
      const amounts = (wb: ExcelJS.Workbook, values: unknown[]) => applyOps(wb, byCode({ Amt: "q" }, values.map((q, i) => ({ c: `K${i}`, q }))));
      const formatted = template("#,##0.00");
      const rn = amounts(formatted, ["1250.50", "", "12.25"]).reports[0];
      check("figures given as text for cells formatted for numbers are numbers; an empty one is no value", formatted.getWorksheet("S")!.getCell("B2").value === 1250.5 && formatted.getWorksheet("S")!.getCell("B3").value === null && formatted.getWorksheet("S")!.getCell("B4").value === 12.25 && rn.writtenAs?.Amt === "numbers" && rn.numbersAsText === undefined);
      const withNa = template("#,##0.00");
      amounts(withNa, ["1250.50", "N/A", "12.25"]);
      check("and a placeholder among them stays the placeholder it is", withNa.getWorksheet("S")!.getCell("B2").value === 1250.5 && withNa.getWorksheet("S")!.getCell("B3").value === "N/A");
      refused("text that is not a plain number for cells formatted for numbers", template("#,##0.00"), byCode({ Amt: "q" }, [{ c: "K0", q: "1,250.50" }, { c: "K1", q: "2" }]), /the cells of the column "Amt" are formatted for numbers \(B2: #,##0\.00\), and the data gives "1,250\.50" for it/);
      const plain = template(undefined);
      const rp = amounts(plain, ["1250.50", "N/A", "12.25"]).reports[0];
      check("with no format and nothing in the column, text goes in as text, and that is said", plain.getWorksheet("S")!.getCell("B2").value === "1250.50" && rp.numbersAsText?.join() === "Amt" && rp.writtenAs === undefined);
      const half = template(undefined, 2);
      half.getWorksheet("S")!.getCell("B2").numFmt = "dd/mm/yyyy";
      applyOps(half, byCode({ Amt: "q" }, [{ c: "K0", q: "2026-11-09" }, { c: "K1", q: "2026-11-10" }]));
      check("only some of the cells formatted for dates is not a column for dates", half.getWorksheet("S")!.getCell("B2").value === "2026-11-09");
      const worded = sheetOf([["CODE", "Amt"], ["A", "to follow"], ["K0", null]], (ws) => void (ws.getCell("B3").numFmt = "dd/mm/yyyy"));
      applyOps(worded, byCode({ Amt: "q" }, [{ c: "K0", q: "2026-11-09" }]));
      check("a column that already holds words is not judged by one cell's format", worded.getWorksheet("S")!.getCell("B3").value === "2026-11-09");
      const red = sheetOf([["CODE", "When"], ["A", day(1)], ["B", null]], (ws) => {
        ws.getCell("B2").numFmt = "dd/mm/yyyy";
        ws.getCell("B3").numFmt = "[Red]0.00";
      });
      applyOps(red, byCode({ When: "d" }, [{ c: "B", d: "2026-11-10" }]));
      check("a colour named in a number format is not a date format", red.getWorksheet("S")!.getCell("B3").numFmt === "dd/mm/yyyy" && red.getWorksheet("S")!.getCell("B3").value instanceof Date);

      // Codes kept as text take whole numbers as text; anything else among the values and they are left as given.
      const codes = () => sheetOf([["CODE", "Branch"], ["A", "101"], ["B", "0222"], ["C", null], ["D", null]]);
      const neg = codes();
      applyOps(neg, byCode({ Branch: "n" }, [{ c: "C", n: 103 }, { c: "D", n: -4 }]));
      check("a minus sign among the values means figures", neg.getWorksheet("S")!.getCell("B4").value === 103 && neg.getWorksheet("S")!.getCell("B5").value === -4);
      refused("a number and a word for one column", codes(), byCode({ Branch: "n" }, [{ c: "C", n: 103 }, { c: "D", n: "HQ" }]), /Data column "n" is a number in 1 rows and text in 1/);
    }

    // -----------------------------------------------------------------------
    // Found by the check of that last change.
    // -----------------------------------------------------------------------
    {
      const day = (d: number) => new Date(Date.UTC(2026, 10, d));
      // A moment written with a Z is not put into a sheet as text without a word.
      const plainCol = sheetOf([["CODE", "When"], ["A"], ["B"]]);
      const rz = applyOps(plainCol, byCode({ When: "d" }, [{ c: "A", d: "2026-11-03T16:00:00.000Z" }])).reports[0];
      check("a moment with Z into an empty column goes in as text, and that is said", plainCol.getWorksheet("S")!.getCell("B2").value === "2026-11-03T16:00:00.000Z" && rz.datesAsText?.join() === "When");
      const dateCol = () => sheetOf([["CODE", "When"], ["A"], ["B"]], (ws) => void ["B2", "B3"].forEach((a) => (ws.getCell(a).numFmt = "dd/mm/yyyy")));
      refused("a moment with Z into cells formatted for dates", dateCol(), byCode({ When: "d" }, [{ c: "A", d: "2026-11-03T16:00:00.000Z" }, { c: "B", d: "2026-11-04" }]), /the cells of the column "When" are formatted for dates \(B2\), and the data gives "2026-11-03T16:00:00\.000Z" for it, which is not a date as this reads one/);
      // Figures dressed as text into a column that says nothing: text, and said.
      const dressed = sheetOf([["CODE", "Amt"], ["A"], ["B"], ["C"], ["D"]]);
      const rd = applyOps(dressed, byCode({ Amt: "q" }, [{ c: "A", q: "1,250.50" }, { c: "B", q: "(500)" }, { c: "C", q: "45%" }, { c: "D", q: "$12.50" }])).reports[0];
      check("figures with separators, brackets, a percent sign or a currency sign are named as having gone in as text", dressed.getWorksheet("S")!.getCell("B2").value === "1,250.50" && rd.numbersAsText?.join() === "Amt");
      const asText = sheetOf([["CODE", "Amt"], ["A"], ["B"]], (ws) => void ["B2", "B3"].forEach((a) => (ws.getCell(a).numFmt = "@")));
      applyOps(asText, byCode({ Amt: "q" }, [{ c: "A", q: "12" }, { c: "B", q: "13" }]));
      check("cells formatted as Text are not cells formatted for numbers", asText.getWorksheet("S")!.getCell("B2").value === "12");
      const oneOfTwo = sheetOf([["CODE", "Amt"], ["A"], ["B"]], (ws) => void (ws.getCell("B2").numFmt = "#,##0.00"));
      applyOps(oneOfTwo, byCode({ Amt: "q" }, [{ c: "A", q: "12" }, { c: "B", q: "13" }]));
      check("one cell of two formatted for numbers is not a column formatted for numbers", oneOfTwo.getWorksheet("S")!.getCell("B2").value === "12");

      // What most of a column's cells are: exactly half and more than any other kind is enough; less is not.
      const kinds = (cells: unknown[]) => sheetOf([["CODE", "Due"], ...cells.map((x, i) => [`X${i}`, x]), ["T", null]]);
      const half = kinds([day(1), day(2), "tbc soon", 5]);
      applyOps(half, byCode({ Due: "d" }, [{ c: "T", d: "2026-11-09" }], { lastRow: 6 }));
      check("two dates of four cells, the rest a word and a figure: a column of dates", half.getWorksheet("S")!.getCell("B6").value instanceof Date);
      const fewer = kinds([day(1), day(2), "tbc soon", 5, "0222"]);
      applyOps(fewer, byCode({ Due: "d" }, [{ c: "T", d: "2026-11-09" }], { lastRow: 7 }));
      check("two dates of five cells, though more than any other kind: no longer a column of dates", fewer.getWorksheet("S")!.getCell("B7").value === "2026-11-09");

      // A calendar date under a column that receives figures is a heading, however many of them there are.
      const months = sheetOf([["CODE", "QTY"], ["A", 5], ["ITEM", day(1)], ["X"], ["ITEM2", day(2)], ["Y"]]);
      refused("two tables below with dates for headings", months, byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "X", q: 9 }], { overwrite: true }), /Row 3 \(A3 "ITEM".*\) has what reads like column headings/);
      // A list standing against the table does not hide the gap between two blocks.
      const against = sheetOf([["CODE", "QTY", "List"], ["A", null, "x"], [null, null, "y"], ["DAMAGED STOCK", null, "z"], ["X", null, "w"]]);
      refused("a gap under the columns named, with a list's entry on that row", against, byCode({ QTY: "q" }, [{ c: "A", q: 1 }, { c: "X", q: 9 }]), /Row 4 \(A4 "DAMAGED STOCK", C4 "z"\) has a row above it with nothing under these columns/);
      // Rows without data to get 0, and a column of dates the data gives dates for: its dates are values, not headings.
      const due = sheetOf([["CODE", "Due", "Qty"], ["A", null, null], ["B", day(1), 4], ["C", null, null]]);
      applyOps(due, byCode({ Due: "d", Qty: "q" }, [{ c: "A", d: "2026-11-09", q: 1 }, { c: "C", d: "2026-11-10", q: 3 }], { unmatched: "zero" }));
      check("a date under a column the data gives dates for is not a heading", due.getWorksheet("S")!.getCell("C4").value === 3 && due.getWorksheet("S")!.getCell("B3").value instanceof Date);

      const onlyDue = sheetOf([["CODE", "Due"], ["A", null], ["B", day(1)], ["C", null]]);
      applyOps(onlyDue, byCode({ Due: "d" }, [{ c: "A", d: "2026-11-09" }, { c: "C", d: "2026-11-10" }], { unmatched: "zero" }));
      check("and with zeros asked for, a row holding a date under it is still an ordinary row", onlyDue.getWorksheet("S")!.getCell("B4").value instanceof Date && onlyDue.getWorksheet("S")!.getCell("B3").value instanceof Date);
      // The read-back takes a number and the moment it shows for the same thing, and nothing else.
      const one = new ExcelJS.Workbook();
      one.properties.date1904 = true;
      const w1 = one.addWorksheet("S");
      w1.getCell("A1").value = "Start";
      w1.getCell("A2").value = new Date(Date.UTC(1904, 0, 1, 13, 30));
      w1.getCell("A2").numFmt = "hh:mm";
      const savedOne = await save(one, out);
      const serial = 0.5625;
      check("a number against the time a 1904 workbook shows for it", compareWithBase(new Map([["S", new Map()]]), savedOne, new Map([["S", new Map<string, ExcelJS.CellValue>([["A1", "Start"], ["A2", serial]])]])).length === 0);
      check("another number against that time is a difference", compareWithBase(new Map([["S", new Map()]]), savedOne, new Map([["S", new Map<string, ExcelJS.CellValue>([["A1", "Start"], ["A2", 0.25]])]])).length === 1);

      // Rows added to a table are laid out as its rows are, and what went in as text is said for an append too.
      const laid = sheetOf([["Date", "Qty", "Code"], [day(1), 1, "x1"], [day(2), 2, "x2"]], (ws) => {
        for (const r of [2, 3]) {
          ws.getCell(`A${r}`).numFmt = "dd-mmm-yy";
          ws.getCell(`B${r}`).numFmt = "#,##0.00";
          ws.getCell(`B${r}`).border = { bottom: { style: "thin" } };
        }
      });
      const rl = applyOps(laid, [{ op: "append_rows", sheet: "S", afterRow: 3, rows: [{ Date: "2026-11-03", Qty: 5002, Code: "12" }] }]).reports[0];
      const wl = (await save(laid, out)).getWorksheet("S")!;
      check("an added row takes the number format and the borders of the row above it", wl.getCell("B4").value === 5002 && wl.getCell("B4").numFmt === "#,##0.00" && wl.getCell("B4").border?.bottom?.style === "thin" && wl.getCell("A4").numFmt === "dd-mmm-yy" && wl.getCell("A4").value instanceof Date);
      check("and digits that went in as text are named", rl.numbersAsText?.join() === "Code" && rl.writtenAs?.Date === "dates");
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
