/**
 * Integration test for FileStore.renderXlsx — the full M1/M2 store path
 * including source resolution (SQL against a local DuckDB snapshot) and the
 * projection rebuild. Exercises real DuckDB + exceljs end-to-end.
 *
 * Run with: npx tsx test/render-store.ts
 */

import assert from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import ExcelJS from "exceljs";

import JSZip from "jszip";

import { FileStore, FileStoreError, numbersFromText, plainNumbersFromText } from "../src/files/store.js";

// The store refuses a dir under the OS temp dir (data-durability guard), so the
// test scratch lives under cwd (the repo tree) and is removed in `finally`.
const SCRATCH_PREFIX = join(process.cwd(), ".tp-test-render-");

const requester = { orgId: "org-test" };
let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed++;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(SCRATCH_PREFIX);
  const store = new FileStore({ enabled: true, dir });
  await store.init();

  try {
    // 1. A source snapshot the document will reference by handle.
    const src = await store.materialize(
      "data",
      [
        { store: "Alpha", sold: 100 },
        { store: "Beta", sold: 250 },
      ],
      requester,
    );

    // 2. Blank build — a sheet sourced from a SQL read of that snapshot.
    const { manifest: built } = await store.renderXlsx(
      {
        title: "SR Report",
        theme: "corporate",
        sheets: [
          {
            name: "Summary",
            source: { fileId: src.fileId, sql: "SELECT store, sold FROM data ORDER BY sold DESC" },
            columns: [
              { key: "store", header: "Store" },
              { key: "sold", header: "Sold", numFmt: "#,##0" },
            ],
          },
        ],
      },
      requester,
    );
    check("built kind is xlsx", built.kind === "xlsx");
    check("built filename", built.filename === "SR Report.xlsx");
    check("one sheet table", built.tables.length === 1);

    // The projection is queryable exactly like a smart file.
    const count = await store.query(
      built.fileId,
      `SELECT count(*) AS c FROM "${built.tables[0].name}"`,
      requester,
    );
    check("projection has 2 rows", Number(count.rows[0].c) === 2);

    // 3. Copy-forward from the built workbook + append a row (inline source).
    const { manifest: fwd, report: fwdReport } = await store.renderXlsx(
      {
        title: "SR Report v2",
        base: { fileId: built.fileId },
        ops: [{ op: "append_rows", sheet: "Summary", source: { rows: [{ Sold: 9, Store: "Gamma" }] } }],
      },
      requester,
    );
    check("forward is a new fileId", fwd.fileId !== built.fileId);
    check("copy-forward says what it wrote", fwdReport?.[0]?.op === "append_rows" && fwdReport[0].range === "A4:B4" && fwdReport[0].rowsWritten === 1);
    const fwdCount = await store.query(
      fwd.fileId,
      `SELECT count(*) AS c FROM "${fwd.tables[0].name}"`,
      requester,
    );
    check("copy-forward appended → 3 rows", Number(fwdCount.rows[0].c) === 3);

    // Base snapshot is untouched by the copy-forward.
    const baseStill = await store.query(
      built.fileId,
      `SELECT count(*) AS c FROM "${built.tables[0].name}"`,
      requester,
    );
    check("base workbook unchanged (still 2 rows)", Number(baseStill.rows[0].c) === 2);

    // 4. Guards.
    let threw = false;
    try {
      await store.renderXlsx({ title: "empty" }, requester);
    } catch {
      threw = true;
    }
    check("empty spec rejected", threw);

    threw = false;
    try {
      // A materialized (rows-only) snapshot has no xlsx binary → invalid base.
      await store.renderXlsx(
        { title: "bad base", base: { fileId: src.fileId }, ops: [{ op: "set_cell", sheet: "data", cell: "A1", value: 1 }] },
        requester,
      );
    } catch {
      threw = true;
    }
    check("non-xlsx base rejected", threw);

    // 5. Filling a copy by key, end to end: the report comes back, the
    // queryable copy holds the figures against the right rows, and a total
    // over them does not go on showing what it showed before.
    const { manifest: tracker } = await store.renderXlsx(
      {
        title: "Tracker",
        sheets: [{ name: "Items", source: { rows: [{ CODE: "A-1", NAME: "Shirt", SOLD: null }, { CODE: "B-2", NAME: "Polo", SOLD: null }, { CODE: "C-3", NAME: "Cap", SOLD: null }] }, columns: [{ key: "CODE" }, { key: "NAME" }, { key: "SOLD" }] }],
      },
      requester,
    );
    const { manifest: withTotal } = await store.renderXlsx(
      { title: "Tracker with total", base: { fileId: tracker.fileId }, ops: [{ op: "set_cell", sheet: "Items", cell: "B5", value: "TOTAL" }, { op: "set_cell", sheet: "Items", cell: "C5", value: "=SUM(C2:C4)" }] },
      requester,
    );
    const filled = await store.renderXlsx(
      {
        title: "Tracker filled",
        base: { fileId: withTotal.fileId },
        ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "code" }, set: { SOLD: "sold" }, source: { rows: [{ code: "C-3", sold: 9 }, { code: "A-1", sold: 5 }, { code: "B-2", sold: 6 }] } }],
      },
      requester,
    );
    check("fill_by_key reports the match", filled.report?.[0]?.matched === 3 && filled.report[0].cellsWritten === 3 && filled.report[0].targetColumns?.SOLD === "C");
    const t = filled.manifest.tables[0].name;
    const got = await store.query(filled.manifest.fileId, `SELECT "CODE" AS code, "SOLD" AS sold FROM "${t}" WHERE "CODE" IS NOT NULL ORDER BY "CODE"`, requester);
    check("the queryable copy has each figure against its own code", JSON.stringify(got.rows.map((r) => [r.code, Number(r.sold)])) === JSON.stringify([["A-1", 5], ["B-2", 6], ["C-3", 9]]));
    const totalRow = await store.query(filled.manifest.fileId, `SELECT "SOLD" AS sold FROM "${t}" WHERE "NAME" = 'TOTAL'`, requester);
    check("the total shows no stale figure", totalRow.rows.length === 1 && (totalRow.rows[0].sold === null || totalRow.rows[0].sold === ""));
    check("and the workbook says its formulas are calculated on opening", (filled.manifest.notes ?? []).some((n) => /calculated when it is opened/.test(n)));

    // 6. Refusals reach the caller as they are, and nothing is saved.
    const refusal = async (spec: Parameters<typeof store.renderXlsx>[0]): Promise<{ status?: number; message: string }> => {
      try {
        await store.renderXlsx(spec, requester);
        return { message: "" };
      } catch (e) {
        return { status: (e as { statusCode?: number; status?: number }).statusCode ?? (e as { status?: number }).status, message: (e as Error).message };
      }
    };
    const beside = await refusal({ title: "x", base: { fileId: tracker.fileId }, ops: [{ op: "populate_sheet", sheet: "Items", startCell: "C2", source: { rows: [{ sold: 1 }, { sold: 2 }, { sold: 3 }] } }] });
    check("a positional fill beside existing rows is refused, with the way out", /writes by position.*Use fill_by_key/.test(beside.message));
    const unknown = await refusal({ title: "x", base: { fileId: tracker.fileId }, ops: [{ op: "append_rows", sheet: "Items", source: { rows: [{ CODE: "D" }] }, columns: [{ key: "CODE" }] } as never] });
    check("a field the op does not use is refused, not dropped", /"columns" is not used here/.test(unknown.message));
    // A source larger than a sheet may read from one query: whole or refused.
    const tooBig = await refusal({ title: "big", sheets: [{ name: "S", source: { fileId: src.fileId, sql: "SELECT i, 'x' AS pad FROM range(60000) t(i)" } }] });
    check("a source over the limit is refused, not cut short", /more than a workbook sheet can take.*Nothing was saved/.test(tooBig.message));
    const justUnder = await store.renderXlsx({ title: "many", sheets: [{ name: "S", source: { fileId: src.fileId, sql: "SELECT i FROM range(1500) t(i)" } }] }, requester);
    const manyCount = await store.query(justUnder.manifest.fileId, `SELECT count(*) AS c FROM "${justUnder.manifest.tables[0].name}"`, requester);
    check("a source past the old 1,000-row cut is now whole (1,500 rows)", Number(manyCount.rows[0].c) === 1500);

    // 7. A whole read for the platform's own readers: all of it in one go, or a refusal.
    const capped = await store.query(src.fileId, "SELECT i FROM range(1500) t(i)", requester);
    check("the assistant's query still stops at its small cap, and says so", capped.rows.length === 1000 && capped.truncated === true);
    const whole = await store.queryWhole(src.fileId, "SELECT i FROM range(1500) t(i) ORDER BY i DESC", requester);
    check("a whole read returns every row, in the query's own order", whole.rows.length === 1500 && whole.truncated === false && Number(whole.rows[0].i) === 1499 && Number(whole.rows[1499].i) === 0);
    let wholeRefused = "";
    try {
      await store.queryWhole(src.fileId, "SELECT i FROM range(60000) t(i)", requester);
    } catch (e) {
      wholeRefused = (e as Error).message;
    }
    check("a whole read over its limit is refused, not cut", /more rows than can be read whole.*Nothing was read/.test(wholeRefused));

    // 8. Figures from a query on a file reach the sheet as numbers. DuckDB
    // hands DECIMAL over as text; written as text, a column of figures looks
    // right and no total in Excel counts it.
    const dec = await store.renderXlsx(
      { title: "decimals", sheets: [{ name: "S", source: { fileId: src.fileId, sql: "SELECT store, CAST(SUM(sold) AS DECIMAL(18,2)) AS total, ROUND(SUM(sold) * 1.12, 2) AS with_tax, 1.0 / 0 AS broken FROM data GROUP BY store ORDER BY store" } }] },
      requester,
    );
    const decBook = new ExcelJS.Workbook();
    await decBook.xlsx.readFile((await store.getBinaryInfo(dec.manifest.fileId, requester)).path);
    const ds = decBook.worksheets[0];
    check("a DECIMAL total is a number in the sheet", ds.getCell("B2").value === 100 && typeof ds.getCell("C2").value === "number" && ds.getCell("C2").value === 112);
    check("a figure that is not finite is left empty, not written as Infinity", ds.getCell("D2").value === null);
    check("an id too long for a number keeps its whole column as text", JSON.stringify(numbersFromText([{ name: "id", type: "HUGEINT" }, { name: "n", type: "DECIMAL(18,2)" }, { name: "t", type: "VARCHAR" }], [{ id: "12345678901234567890", n: "10.50", t: "007" }, { id: "5", n: "2", t: "8" }])) === JSON.stringify([{ id: "12345678901234567890", n: 10.5, t: "007" }, { id: "5", n: 2, t: "8" }]));

    // 9. A write that does not come out as it went in is refused and nothing is kept.
    class WritesSomethingElse extends FileStore {
      protected async saveWorkbook(wb: ExcelJS.Workbook, path: string): Promise<void> {
        wb.worksheets[0].getCell("B2").value = "not what was asked";
        await wb.xlsx.writeFile(path);
      }
    }
    const dir2 = await mkdtemp(SCRATCH_PREFIX);
    try {
      const faulty = new WritesSomethingElse({ enabled: true, dir: dir2 });
      await faulty.init();
      const { manifest: base2 } = await faulty.renderXlsx({ title: "base", sheets: [{ name: "Items", source: { rows: [{ CODE: "A-1", NAME: "Shirt", SOLD: null }] }, columns: [{ key: "CODE" }, { key: "NAME" }, { key: "SOLD" }] }] }, requester);
      const filesBefore = (await readdir(dir2)).filter((f) => f.endsWith(".xlsx")).length;
      let said = "";
      try {
        await faulty.renderXlsx({ title: "filled", base: { fileId: base2.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 5 }] } }] }, requester);
      } catch (e) {
        said = (e as Error).message;
      }
      check("a saved file that differs from what was written is refused", /did not save as it was written, so it was not kept: Items!B2 was s:Shirt and now reads s:not what was asked/.test(said));
      check("and no workbook is left behind", (await readdir(dir2)).filter((f) => f.endsWith(".xlsx")).length === filesBefore);
      let saidAgain = "";
      try {
        await faulty.renderXlsx({ title: "nothing to write", base: { fileId: base2.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: null }] } }] }, requester);
      } catch (e) {
        saidAgain = (e as Error).message;
      }
      check("the saved file is read back even when the request wrote nothing", /did not save as it was written/.test(saidAgain));
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }

    // 10. Every option of an op reaches the code that carries it out. (One did
    // not: it was dropped where the request's fields were copied by hand.)
    const book = async (fileId: string) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile((await store.getBinaryInfo(fileId, requester)).path);
      return wb;
    };
    const failure = async (spec: Parameters<typeof store.renderXlsx>[0]): Promise<{ status?: number; message: string }> => {
      try {
        await store.renderXlsx(spec, requester);
        return { message: "" };
      } catch (e) {
        return { status: e instanceof FileStoreError ? e.statusCode : undefined, message: (e as Error).message };
      }
    };
    const { manifest: dup } = await store.renderXlsx(
      { title: "dup", sheets: [{ name: "Items", source: { rows: [{ CODE: "A-1", SOLD: null }, { CODE: "B-2", SOLD: 7 }, { CODE: "A-1", SOLD: null }, { CODE: "C-3", SOLD: null }] }, columns: [{ key: "CODE" }, { key: "SOLD" }] }] },
      requester,
    );
    const fillDup = (extra: object, rows: object[]) => ({ title: "x", base: { fileId: dup.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, ...extra, source: { rows } }] }) as Parameters<typeof store.renderXlsx>[0];
    const shared = await failure(fillDup({}, [{ c: "A-1", q: 1 }]));
    check("a key on two rows is refused, as a refusal the caller can act on (422)", shared.status === 422 && /"sharedKeys": "fill_each"/.test(shared.message));
    const each = await store.renderXlsx(fillDup({ sharedKeys: "fill_each" }, [{ c: "A-1", q: 1 }]), requester);
    const eachSheet = (await book(each.manifest.fileId)).worksheets[0];
    check('"sharedKeys": "fill_each" reaches the fill and does what the refusal said it would', eachSheet.getCell("B2").value === 1 && eachSheet.getCell("B4").value === 1 && each.report?.[0]?.sheetRowsSharingAKey === 2);
    const bogus = await failure(fillDup({ sharedKeys: "sure" }, [{ c: "A-1", q: 1 }]));
    check("an option value that does not exist is a bad request (400), not ignored", bogus.status === 400 && /"sharedKeys" is "refuse" or "fill_each"/.test(bogus.message));
    const noOverwrite = await failure(fillDup({ sharedKeys: "fill_each" }, [{ c: "B-2", q: 9 }]));
    check("a figure already there is not replaced without overwrite", noOverwrite.status === 422 && /already filled \(B3\)/.test(noOverwrite.message));
    const over = await store.renderXlsx(fillDup({ sharedKeys: "fill_each", overwrite: true }, [{ c: "B-2", q: 9 }]), requester);
    check('"overwrite" reaches the fill', (await book(over.manifest.fileId)).worksheets[0].getCell("B3").value === 9);
    const zeroed = await store.renderXlsx(fillDup({ sharedKeys: "fill_each", unmatched: "zero" }, [{ c: "C-3", q: 4 }]), requester);
    const zs = (await book(zeroed.manifest.fileId)).worksheets[0];
    check('"unmatched": "zero" reaches the fill: empty cells of rows without data are 0, a figure already there is kept', zs.getCell("B2").value === 0 && zs.getCell("B4").value === 0 && zs.getCell("B3").value === 7 && zs.getCell("B5").value === 4 && zeroed.report?.[0]?.unmatchedValuesKept === 1);
    const laid = await store.renderXlsx(
      {
        title: "template",
        base: { fileId: dup.fileId },
        ops: [
          { op: "add_sheet", name: "T", source: { rows: [{ h1: "Store", h2: "Amount", h3: "Qty" }] } },
          { op: "populate_sheet", sheet: "T", startCell: "A3", columns: [{ key: "store" }, { key: "amount" }, { key: "qty" }], source: { rows: [{ qty: 1, store: "N", amount: 10, extra: "x" }] } },
        ],
      },
      requester,
    );
    const ts = (await book(laid.manifest.fileId)).getWorksheet("T")!;
    check("a populate_sheet column list reaches the fill: those columns, in that order", ts.getCell("A3").value === "N" && ts.getCell("B3").value === 10 && ts.getCell("C3").value === 1 && ts.getCell("D3").value === null);
    check("and the read-back passes with a sheet added and filled in one request", laid.report?.length === 2 && laid.report[1].range === "A3:C3");

    // 11. Figures written out as text by the caller are numbers in the sheet; codes stay as they are.
    const typed = await store.renderXlsx({ title: "typed", sheets: [{ name: "S", source: { rows: [{ code: "007", qty: "12", amount: "1250.50" }, { code: "0456", qty: "3", amount: "10" }] } }] }, requester);
    const tys = (await book(typed.manifest.fileId)).worksheets[0];
    check("typed figures become numbers and a code with a leading zero stays text", tys.getCell("A2").value === "007" && tys.getCell("B2").value === 12 && tys.getCell("C2").value === 1250.5);
    check("the rule, column by column", JSON.stringify(plainNumbersFromText([{ a: "1", b: "x", c: "01", d: null }, { a: "2.5", b: "3", c: "2", d: "4" }])) === JSON.stringify([{ a: 1, b: "x", c: "01", d: null }, { a: 2.5, b: "3", c: "2", d: 4 }]));
    check("a decimal column with many places is still figures", JSON.stringify(numbersFromText([{ name: "n", type: "DECIMAL(38,12)" }, { name: "k", type: "BIGINT" }, { name: "big", type: "HUGEINT" }, { name: "d", type: "DATE" }], [{ n: "12345.500000000000", k: "123", big: "12345678901234567890", d: "2026-01-05" }, { n: null, k: "-4", big: "7", d: "2026-01-06" }])) === JSON.stringify([{ n: 12345.5, k: 123, big: "12345678901234567890", d: "2026-01-05" }, { n: null, k: -4, big: "7", d: "2026-01-06" }]));

    // 12. A workbook too large for this server's memory is refused, before it is loaded when that is certain.
    class SmallHost extends FileStore {
      limit = 3;
      protected copyForwardCellLimit(): number {
        return this.limit;
      }
    }
    const dir3 = await mkdtemp(SCRATCH_PREFIX);
    try {
      const small = new SmallHost({ enabled: true, dir: dir3 });
      await small.init();
      const { manifest: nine } = await small.renderXlsx({ title: "nine", sheets: [{ name: "Items", source: { rows: [{ CODE: "A", NAME: "a", SOLD: null }, { CODE: "B", NAME: "b", SOLD: null }, { CODE: "C", NAME: "c", SOLD: null }] }, columns: [{ key: "CODE" }, { key: "NAME" }, { key: "SOLD" }] }] }, requester);
      const tooBig = async () => {
        try {
          await small.renderXlsx({ title: "x", base: { fileId: nine.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A", q: 1 }] } }] }, requester);
          return "";
        } catch (e) {
          return `${(e as FileStoreError).statusCode} ${(e as Error).message}`;
        }
      };
      check("refused from its rows and columns alone, before it is loaded, when it is far over the limit", /^422 This workbook is too large .*\(9 cells by its rows and columns; the limit here is 3 filled cells\)/.test(await tooBig()));
      small.limit = 8; // nine cells hold something (three headers, six values): over, but not by enough to tell without loading
      check("and refused after counting when it is just over", /^422 This workbook is too large .*\(9 filled cells; the limit here is 8 filled cells\)/.test(await tooBig()));
      small.limit = 9;
      check("a workbook at the limit is filled", (await tooBig()) === "");
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }

    // 13. A base with charts: the copy cannot carry them, and the result says so.
    const plain = new ExcelJS.Workbook();
    plain.addWorksheet("Items").addRows([["CODE", "SOLD"], ["A-1", null]]);
    const zip = await JSZip.loadAsync(await plain.xlsx.writeBuffer());
    zip.file("xl/charts/chart1.xml", "<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"/>");
    const withChart = await store.ingest("charted.xlsx", await zip.generateAsync({ type: "nodebuffer" }), requester, { pinned: true });
    const charted = await store.renderXlsx({ title: "charted, filled", base: { fileId: withChart.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 2 }] } }] }, requester);
    check("the result notes that the original's charts are not in the copy", (charted.manifest.notes ?? []).some((n) => /original workbook has charts.*not carried into this copy/.test(n)));
    check("and a workbook without them carries no such note", !(filled.manifest.notes ?? []).some((n) => /not carried into this copy/.test(n)));

    // 14. A base with a formula filled down a column: writing its first cell must leave the rest as they were.
    const filledDown = new ExcelJS.Workbook();
    const sh = filledDown.addWorksheet("F");
    sh.addRows([["CODE", "QTY", "PRICE", "VALUE"], ["K0", 1, 10], ["K1", 2, 10], ["K2", 3, 10]]);
    sh.fillFormula("D2:D4", "B2*C2", [10, 20, 30]);
    const sharedUp = await store.ingest("shared.xlsx", Buffer.from(await filledDown.xlsx.writeBuffer()), requester, { pinned: true });
    const sharedOut = await store.renderXlsx({ title: "shared, first cell set", base: { fileId: sharedUp.fileId }, ops: [{ op: "set_cell", sheet: "F", cell: "D2", value: 99 }] }, requester);
    const so = (await book(sharedOut.manifest.fileId)).getWorksheet("F")!;
    check("the first cell of a filled-down formula takes a value and the cells below keep their formulas", so.getCell("D2").value === 99 && so.getCell("D3").formula === "B3*C3" && so.getCell("D4").formula === "B4*C4");

    console.log(`\n✓ render-store: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ render-store test failed:", err);
  process.exit(1);
});
