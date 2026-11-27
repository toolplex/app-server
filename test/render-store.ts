/**
 * Integration test for FileStore.renderXlsx — the full M1/M2 store path
 * including source resolution (SQL against a local DuckDB snapshot) and the
 * projection rebuild. Exercises real DuckDB + exceljs end-to-end.
 *
 * Run with: npx tsx test/render-store.ts
 */

import assert from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import ExcelJS from "exceljs";

import JSZip from "jszip";

import { FileStore, FileStoreError, numbersFromText, plainNumbersFromText } from "../src/files/store.js";
import { formulaDifferences, formulasInFile, formulasInSheetXml } from "../src/files/workbookFormulas.js";

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
      fresh: number | undefined;
      protected newWorkbookCellLimit(): number {
        return this.fresh ?? this.limit;
      }
    }
    const dir3 = await mkdtemp(SCRATCH_PREFIX);
    try {
      const small = new SmallHost({ enabled: true, dir: dir3 });
      await small.init();
      small.limit = 1000; // room to build the workbook that is then too large to be copied
      const { manifest: nine } = await small.renderXlsx({ title: "nine", sheets: [{ name: "Items", source: { rows: [{ CODE: "A", NAME: "a", SOLD: null }, { CODE: "B", NAME: "b", SOLD: null }, { CODE: "C", NAME: "c", SOLD: null }] }, columns: [{ key: "CODE" }, { key: "NAME" }, { key: "SOLD" }] }] }, requester);
      const tooBig = async () => {
        try {
          await small.renderXlsx({ title: "x", base: { fileId: nine.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A", q: 1 }] } }] }, requester);
          return "";
        } catch (e) {
          return `${(e as FileStoreError).statusCode} ${(e as Error).message}`;
        }
      };
      small.limit = 3;
      check("refused from its rows and columns alone, before it is loaded, when it is far over the limit", /^422 This workbook is too large .*\(9 cells by its rows and columns; the limit here is 3 filled cells\)/.test(await tooBig()));
      small.limit = 8; // nine cells hold something (three headers, six values): over, but not by enough to tell without loading
      check("and refused after counting when it is just over", /^422 This workbook is too large .*\(9 filled cells, 0 of them formulas, which count for more; the limit here is 8 filled cells\)/.test(await tooBig()));
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

    // 15. Found by a third review: a fill of one sheet must leave every formula of every other sheet as it was
    // in the file, text in quotes and sheet names included. (A version that rewrote filled-down formulas on
    // loading turned "Q1" into "Q2" and 'Jan26' into 'Jan27' on sheets it was never asked to touch.)
    const quarterly = new ExcelJS.Workbook();
    const qd = quarterly.addWorksheet("Data");
    qd.addRows([["CODE", "QTR", "SOLD"], ["A-1", "Q1", null], ["A-2", "Q1", null], ["A-3", "Q2", null]]);
    const qs = quarterly.addWorksheet("Summary");
    qs.addRows([["Quarter", "Units", "Other"], ["Q1"], ["Q2"], ["Q3"]]);
    qs.fillFormula("B2:B4", 'SUMIFS(Data!C:C,Data!B:B,"Q1")', [0, 0, 0]);
    qs.fillFormula("C2:C4", "'Jan26'!B2+Data!C2", [0, 0, 0]);
    quarterly.addWorksheet("Jan26").getCell("B2").value = 1;
    const quarterlyUp = await store.ingest("quarterly.xlsx", Buffer.from(await quarterly.xlsx.writeBuffer()), requester, { pinned: true });
    const quarterlyOut = await store.renderXlsx(
      { title: "quarterly, filled", base: { fileId: quarterlyUp.fileId }, ops: [{ op: "fill_by_key", sheet: "Data", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 5 }, { c: "A-2", q: 6 }, { c: "A-3", q: 7 }] } }] },
      requester,
    );
    const sheetXml = async (fileId: string, n: number) =>
      (await (await JSZip.loadAsync(await readFile((await store.getBinaryInfo(fileId, requester)).path))).file(`xl/worksheets/sheet${n}.xml`)!.async("string")).replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const summaryBefore = (await sheetXml(quarterlyUp.fileId, 2)).match(/<f[^>]*>[^<]*<\/f>|<f[^>]*\/>/g) ?? [];
    const summaryAfter = (await sheetXml(quarterlyOut.manifest.fileId, 2)).match(/<f[^>]*>[^<]*<\/f>|<f[^>]*\/>/g) ?? [];
    check("the formulas of a sheet no op touched are in the saved file exactly as they were in the original", summaryBefore.length === 6 && JSON.stringify(summaryAfter) === JSON.stringify(summaryBefore));
    check('"Q1" is still "Q1" and the sheet is still \'Jan26\'', summaryAfter.join(" ").includes('SUMIFS(Data!C:C,Data!B:B,"Q1")') && summaryAfter.join(" ").includes("'Jan26'!B2+Data!C2") && !/Q2"|Jan27/i.test(summaryAfter.join(" ")));
    check("and the sheet that was filled holds the figures", (await book(quarterlyOut.manifest.fileId)).getWorksheet("Data")!.getCell("C4").value === 7);

    // 16. Numbers that arrive as text: figures become numbers, what may be an id does not.
    const typedRows = [{ id20: "12345678901234567890", small: "42", sixteen: "1234567890123456", places: "1234567.500000000000", wide: "12345678901234567890.000000000000", huge: "1e999", f: "2.5" }];
    const typedOut = numbersFromText(
      [{ name: "id20", type: "DECIMAL(20,0)" }, { name: "small", type: "DECIMAL(18,0)" }, { name: "sixteen", type: "BIGINT" }, { name: "places", type: "DECIMAL(38,12)" }, { name: "wide", type: "DECIMAL(38,12)" }, { name: "huge", type: "DOUBLE" }, { name: "f", type: "DOUBLE" }],
      typedRows,
    )[0];
    check("a decimal with no places is a whole number: twenty digits stay text, two become a number", typedOut.id20 === "12345678901234567890" && typedOut.small === 42);
    check("a whole number of sixteen digits stays text", typedOut.sixteen === "1234567890123456");
    check("a decimal with places is a figure, unless its whole part is longer than a number holds", typedOut.places === 1234567.5 && typedOut.wide === "12345678901234567890.000000000000");
    check("what is not a finite number stays as it came", typedOut.huge === "1e999" && typedOut.f === 2.5);
    check("a barcode written out as text stays text", JSON.stringify(plainNumbersFromText([{ code: "4800016644801", qty: "3" }, { code: "4800016644802", qty: "12" }])) === JSON.stringify([{ code: "4800016644801", qty: 3 }, { code: "4800016644802", qty: 12 }]));

    // 17. The size limit follows this server's memory; it is not one number for every server.
    class Limit extends FileStore {
      shown(): { limit: number; fresh: number; memoryMb: number } {
        return { limit: this.copyForwardCellLimit(), fresh: this.newWorkbookCellLimit(), memoryMb: (this as unknown as { bounds: { memoryMb: number } }).bounds.memoryMb };
      }
    }
    const lim = new Limit({ enabled: true, dir: dir }).shown();
    check("the size limit is this server's memory share divided by what a cell costs, within its two ends", lim.limit === Math.min(1_000_000, Math.max(100_000, Math.floor((lim.memoryMb * 1024 * 1024) / 1300))) && lim.limit < 1_000_000);
    check("a new workbook costs more per cell, so its limit is lower for the same memory, and never below an ordinary size", lim.fresh === Math.min(1_000_000, Math.max(200_000, Math.floor((lim.memoryMb * 1024 * 1024) / 2400))) && lim.fresh < lim.limit && lim.fresh >= 200_000);

    // 18. Pivot tables are named too; an op cannot carry rows of its own beside its source.
    const pz = await JSZip.loadAsync(await plain.xlsx.writeBuffer());
    pz.file("xl/pivotTables/pivotTable1.xml", "<pivotTableDefinition/>");
    const withPivot = await store.ingest("pivoted.xlsx", await pz.generateAsync({ type: "nodebuffer" }), requester, { pinned: true });
    const pivoted = await store.renderXlsx({ title: "pivoted, filled", base: { fileId: withPivot.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 2 }] } }] }, requester);
    check("the result notes that the original's pivot tables are not in the copy", (pivoted.manifest.notes ?? []).some((n) => /original workbook has pivot tables\. They are not carried into this copy/.test(n)));
    const smuggled = await failure({ title: "x", base: { fileId: dup.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: null, source: { rows: [{ c: "A-1", q: 1 }] } } as never] });
    const smuggled2 = await failure({ title: "x", base: { fileId: dup.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: [{ c: "B-2", q: 99 }], source: { rows: [{ c: "A-1", q: 1 }] } } as never] });
    check('rows given on the op itself, beside its "source", are refused, not used', smuggled2.status === 400 && /"rows" is not used here/.test(smuggled2.message));
    const headerRowBad = await failure({ title: "x", base: { fileId: dup.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", headerRow: 0, key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 1 }] } }] });
    check("a header row that is not a row number is a bad request", headerRowBad.status === 400 && /"headerRow" is the number of a sheet row/.test(headerRowBad.message));
    // An empty "rows" beside the source is no rows of its own: the source is what is read.
    const emptyRows = await failure({ title: "x", base: { fileId: dup.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", sharedKeys: "fill_each", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, rows: null, source: { rows: [{ c: "A-1", q: 1 }] } } as never] });
    check('an empty "rows" on an op does not stand in for its source', emptyRows.message === "");
    void smuggled;

    // 19. Found by a fourth review: the library that makes the copy changes or drops what it does not model,
    // on sheets no op touches, and cannot be asked whether it did. The copy is held to the original as a file.
    const crafted = async (name: string, edit?: (zip: JSZip) => Promise<void> | void) => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet("Data").addRows([["CODE", "SOLD"], ["A-1", null], ["A-2", null]]);
      const calc = wb.addWorksheet("Calc");
      calc.addRows([["x", "double"], [1], [2], [3]]);
      calc.getCell("B2").value = { formula: "Data!B2*2", result: 0 };
      calc.getCell("B3").value = { formula: "Data!B3*2", result: 0 };
      calc.fillFormula("C2:C4", 'IF(A2>1,"hi","lo")', ["lo", "hi", "hi"]);
      const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
      await edit?.(zip);
      return (await store.ingest(`${name}.xlsx`, await zip.generateAsync({ type: "nodebuffer" }), requester, { pinned: true })).fileId;
    };
    const change = async (zip: JSZip, path: string, from: string | RegExp, to: string) => {
      const before = await zip.file(path)!.async("string");
      const after = before.replace(from, to);
      assert.notStrictEqual(after, before, `the test's edit of ${path} changed nothing`);
      zip.file(path, after);
    };
    const fillOf = (fileId: string) => failure({ title: "held to the original", base: { fileId }, ops: [{ op: "fill_by_key", sheet: "Data", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 5 }, { c: "A-2", q: 6 }] } }] });
    check("a workbook the copy carries whole is filled", (await fillOf(await crafted("whole"))).message === "");
    check("with a name for a range, too", (await fillOf(await crafted("named", (zip) => change(zip, "xl/workbook.xml", "</sheets>", '</sheets><definedNames><definedName name="Sold">Data!$B$2:$B$3</definedName></definedNames>')))).message === "");
    const spill = await fillOf(await crafted("spill", (zip) => change(zip, "xl/worksheets/sheet2.xml", '<c r="B2"', '<c r="B2" cm="1"')));
    check("a formula that spills is not copied: refused before the workbook is loaded", spill.status === 422 && /cannot carry: a formula that spills into the cells around it \(Calc!B2\)\. Nothing was saved\. Build a new workbook/.test(spill.message));
    const constant = await fillOf(await crafted("constant", (zip) => change(zip, "xl/workbook.xml", "</sheets>", '</sheets><definedNames><definedName name="Rate">0.12</definedName></definedNames>')));
    check("a name that is a constant, which the copy would drop, is refused before the workbook is loaded", constant.status === 422 && /cannot carry: the name "Rate" \(0\.12\), which is not a plain range of cells/.test(constant.message));
    const twoScopes = await fillOf(await crafted("scopes", (zip) => change(zip, "xl/workbook.xml", "</sheets>", '</sheets><definedNames><definedName name="Local" localSheetId="0">Data!$B$2</definedName><definedName name="Local" localSheetId="1">Calc!$B$2</definedName></definedNames>')));
    check("a name two sheets each define for themselves is refused", twoScopes.status === 422 && /the name "Local", which more than one sheet defines for itself/.test(twoScopes.message));
    const linked = await fillOf(
      await crafted("linked", async (zip) => {
        await change(zip, "xl/worksheets/sheet2.xml", "</sheetData>", '</sheetData><hyperlinks><hyperlink ref="B2" r:id="rId77"/></hyperlinks>');
        zip.file("xl/worksheets/_rels/sheet2.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId77" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>');
      }),
    );
    check("a formula on a cell that is also a link, which the copy would save as a value, is found the same way", linked.status === 422 && /Calc!B2 holds a formula in the original \(=Data!B2\*2\) and none in the copy/.test(linked.message));

    // The reading of a sheet's formulas from its XML.
    const lost: string[] = [];
    const read = formulasInSheetXml(
      '<worksheet><sheetData><row r="1"><c r="A1" s="1"/><c r="B1"><f>A1&amp;&quot;x&quot;</f><v>1</v></c><c r="C1" t="s"><v>0</v></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" ref="A2:A4" si="0">B2*2</f></c><c r="B2"><f t="array" ref="B2:B3">C2:C3*2</f></c></row><row r="3"><c r="A3"><f t="shared" si="0"/></c></row></sheetData>' +
        '<conditionalFormatting sqref="A1"><cfRule type="expression"><formula>A1&gt;1</formula></cfRule></conditionalFormatting><dataValidations><dataValidation><formula1>Z1</formula1></dataValidation></dataValidations></worksheet>',
      "S",
      lost,
    );
    check("formulas are read as they are written, and rules that are not cells are not", JSON.stringify([...read]) === JSON.stringify([["B1", '=A1&"x"'], ["A2", "first of A2:A4: =B2*2"], ["B2", "array over B2:B3: =C2:C3*2"], ["A3", "as A2"]]) && lost.length === 0);
    formulasInSheetXml('<x:worksheet xmlns:x="m"><x:sheetData/></x:worksheet>', "P", lost);
    check("a sheet written in a form that is not read is said, not passed", lost.length === 1 && /sheet "P" is written in a form/.test(lost[0]));
    // (A workbook with a what-if data table does not get as far as being copied: it cannot be taken in at all.)
    const tableLost: string[] = [];
    formulasInSheetXml('<worksheet><sheetData><row r="3"><c r="B3"><f t="dataTable" ref="B3:B4" dt2D="0" dtr="0" r1="A1"/><v>1</v></c><c r="C3" cm="1"><f t="array" ref="C3:C5">SEQUENCE(3)</f></c></row></sheetData></worksheet>', "W", tableLost);
    check("a what-if data table and a formula that spills are named as what a copy cannot carry", tableLost.join("; ") === "a what-if data table (W!B3); a formula that spills into the cells around it (W!C3)");
    const fa = await formulasInFile(await readFile((await store.getBinaryInfo(await crafted("pair"), requester)).path));
    const fb = { ...fa, sheets: new Map([...fa.sheets].map(([k, v]) => [k, new Map(v)])) };
    fb.sheets.get("Calc")!.set("B2", "=Data!B2*3");
    fb.sheets.get("Calc")!.delete("B3");
    fb.sheets.get("Calc")!.set("Z9", "=1");
    const diffs = formulaDifferences(fa, fb, new Map([["Calc", new Set(["Z9"])]]), new Map());
    check("a changed formula and a lost one are both named; a cell an op wrote is not held to the original", diffs.length === 2 && /the formula at Calc!B2 reads "=Data!B2\*2" in the original and "=Data!B2\*3" in the copy/.test(diffs.join(" ")) && /Calc!B3 holds a formula in the original/.test(diffs.join(" ")));
    check("a cell that was to keep a formula of its own must hold one", formulaDifferences(fa, fb, new Map(), new Map([["Calc", new Set(["B3"])]])).some((d) => /Calc!B3 was to keep its formula and holds none/.test(d)) && fa.formulas === 5);

    // 20. Found by a fifth review: more that a copy does not carry, and what it may leave behind with a note.
    const withNames = (names: string) => (zip: JSZip) => change(zip, "xl/workbook.xml", "</sheets>", `</sheets><definedNames>${names}</definedNames>`);
    const linkedOut = await fillOf(await crafted("external", (zip) => void zip.file("xl/externalLinks/externalLink1.xml", "<externalLink/>")));
    check("a workbook that reads figures from another workbook is refused", linkedOut.status === 422 && /cannot carry: links to other workbooks, which its formulas read figures through/.test(linkedOut.message));
    const asShown = await fillOf(await crafted("asshown", (zip) => change(zip, "xl/workbook.xml", "<calcPr ", '<calcPr fullPrecision="0" ')));
    check('"precision as displayed" is refused: it changes what a figure is', asShown.status === 422 && /cannot carry: the setting "precision as displayed"/.test(asShown.message));
    const circular = await fillOf(await crafted("iterate", (zip) => change(zip, "xl/workbook.xml", "<calcPr ", '<calcPr iterate="1" ')));
    check("iterative calculation is refused", circular.status === 422 && /cannot carry: iterative calculation/.test(circular.message));
    const wholeColumn = await fillOf(await crafted("wholecol", withNames('<definedName name="Codes">Data!$A:$A</definedName>')));
    check("a name for a whole column is refused before the workbook is loaded", wholeColumn.status === 422 && /cannot carry: the name "Codes" \(Data!\$A:\$A\), which is not a plain range of cells/.test(wholeColumn.message));
    check("a name that is already dead has nothing to lose", (await fillOf(await crafted("dead", withNames('<definedName name="Old">#REF!</definedName><definedName name="Older">Data!#REF!</definedName>')))).message === "");
    const solverId = await crafted("solver", withNames('<definedName name="solver_adj" hidden="1">Data!$B$2</definedName><definedName name="solver_opt" hidden="1">0.5</definedName>'));
    const solver = await store.renderXlsx({ title: "solver", base: { fileId: solverId }, ops: [{ op: "fill_by_key", sheet: "Data", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 5 }] } }] }, requester);
    check("a hidden name that no formula uses is left behind with a note, not a refusal", (solver.manifest.notes ?? []).some((n) => /original workbook has 1 hidden name that no formula uses .*They are not carried into this copy/.test(n)));
    const usedHidden = await fillOf(
      await crafted("usedhidden", async (zip) => {
        await withNames('<definedName name="TaxRate" hidden="1">0.12</definedName>')(zip);
        await change(zip, "xl/worksheets/sheet2.xml", /<f>Data!B3\*2<\/f>/, "<f>Data!B3*TaxRate</f>");
      }),
    );
    check("a hidden name that a formula uses is refused: the formula would show an error", usedHidden.status === 422 && /cannot carry: the name "TaxRate" \(0\.12\), which is not a plain range of cells and which a formula uses \(Calc!B3\)/.test(usedHidden.message));
    const usedOtherwise = await fillOf(
      await crafted("usedhidden2", async (zip) => {
        await withNames('<definedName name="TaxRate" hidden="true">0.12</definedName>')(zip);
        await change(zip, "xl/worksheets/sheet2.xml", /<f>Data!B3\*2<\/f>/, "<f>Data!B3*taxrate</f>");
      }),
    );
    check('hidden written as "true", and the name used in another case, are the same thing', usedOtherwise.status === 422 && /the name "TaxRate" \(0\.12\), which is not a plain range of cells and which a formula uses \(Calc!B3\)/.test(usedOtherwise.message));
    check("text with nothing in it does not stop a column of figures written as text from being figures", JSON.stringify(plainNumbersFromText([{ a: "1250.50", b: "x" }, { a: "", b: "" }, { a: " ", b: "y" }, { a: "12.25", b: "z" }])) === JSON.stringify([{ a: 1250.5, b: "x" }, { a: "", b: "" }, { a: " ", b: "y" }, { a: 12.25, b: "z" }]));
    const spelled = await fillOf(await crafted("spelled", (zip) => change(zip, "xl/workbook.xml", "<calcPr ", "<calcPr iterate='true' fullPrecision=\"false\" ")));
    check("the settings are read however they are spelled", spelled.status === 422 && /precision as displayed/.test(spelled.message) && /iterative calculation/.test(spelled.message));
    // What Excel keeps for itself, and a sheet name that needs quotes, are no obstacle.
    const ordinary = new ExcelJS.Workbook();
    const od = ordinary.addWorksheet("My Data");
    od.addRows([["CODE", "SOLD"], ["A-1", null], ["A-2", null]]);
    od.autoFilter = "A1:B3";
    od.pageSetup.printArea = "A1:B3";
    ordinary.definedNames.add("'My Data'!$B$2:$B$3", "Sold");
    const ordinaryUp = await store.ingest("ordinary.xlsx", Buffer.from(await ordinary.xlsx.writeBuffer()), requester, { pinned: true });
    const ordinaryOut = await failure({ title: "ordinary", base: { fileId: ordinaryUp.fileId }, ops: [{ op: "fill_by_key", sheet: "My Data", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A-1", q: 5 }, { c: "A-2", q: 6 }] } }] });
    check("a filter, a print area and a name on a sheet whose name needs quotes are carried", ordinaryOut.message === "");
    const excelsOwn = await fillOf(await crafted("printtitles", withNames('<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1</definedName><definedName name="Sold">\'Data\'!$B$2:$B$3</definedName>')));
    check("rows to repeat on each printed page, and a sheet name written in quotes it does not need, are no obstacle", excelsOwn.message === "");

    // Formulas weigh more than values against the size limit.
    const dir4 = await mkdtemp(SCRATCH_PREFIX);
    try {
      const heavy = new SmallHost({ enabled: true, dir: dir4 });
      await heavy.init();
      const hw = new ExcelJS.Workbook();
      const hs = hw.addWorksheet("Items");
      hs.addRows([["CODE", "SOLD", "TWICE"], ["A", null], ["B", null], ["C", null]]);
      for (const r of [2, 3, 4]) hs.getCell(`C${r}`).value = { formula: `B${r}*2`, result: 0 };
      const heavyUp = await heavy.ingest("heavy.xlsx", Buffer.from(await hw.xlsx.writeBuffer()), requester, { pinned: true });
      const tryFill = async () => {
        try {
          await heavy.renderXlsx({ title: "x", base: { fileId: heavyUp.fileId }, ops: [{ op: "fill_by_key", sheet: "Items", key: { sheet: "CODE", data: "c" }, set: { SOLD: "q" }, source: { rows: [{ c: "A", q: 1 }] } }] }, requester);
          return "";
        } catch (e) {
          return `${(e as FileStoreError).statusCode} ${(e as Error).message}`;
        }
      };
      // A new workbook is held to the same limit, over all of its sheets together.
      const newBook = async () => {
        try {
          await heavy.renderXlsx({ title: "new", sheets: [{ name: "A", source: { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] } }, { name: "B", source: { rows: [{ a: 5, b: 6 }, { a: 7, b: 8 }] } }] }, requester);
          return "";
        } catch (e) {
          return `${(e as FileStoreError).statusCode} ${(e as Error).message}`;
        }
      };
      heavy.limit = 7;
      check("a new workbook over the limit across its sheets is refused, with what to do instead", /^422 This workbook would be too large to build on this server: 8 cells over 2 sheets; the limit here is 7\. Nothing was saved\. Save the full list as a table instead/.test(await newBook()));
      heavy.limit = 8;
      check("and one at the limit is built", (await newBook()) === "");
      heavy.limit = 1000;
      heavy.fresh = 7;
      check("a new workbook is held to its own limit, not to the one for a copied workbook", /the limit here is 7\./.test(await newBook()));
      heavy.fresh = undefined;
      heavy.limit = 5;
      let listed = "";
      try {
        await heavy.renderXlsx({ title: "listed", sheets: [{ name: "A", columns: [], source: { rows: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] } }] }, requester);
      } catch (e) {
        listed = (e as Error).message;
      }
      check("an empty column list means every column, for the count as for the sheet", /too large to build on this server: 6 cells over 1 sheet; the limit here is 5/.test(listed));
      const named = await heavy.renderXlsx({ title: "two of three", sheets: [{ name: "A", columns: [{ key: "a" }, { key: "b" }], source: { rows: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] } }] }, requester).then(() => "", (e) => (e as Error).message);
      check("and the columns that are written are the ones counted", named === "");
      heavy.limit = 13; // nine filled cells, three of them formulas: 9 + 3 × 1.5, rounded, is 14
      check("three formulas among nine cells put a workbook over a limit of thirteen", /^422 This workbook is too large .*\(9 filled cells, 3 of them formulas, which count for more; the limit here is 13 filled cells\)/.test(await tryFill()));
      heavy.limit = 14;
      check("and not over a limit of fourteen", (await tryFill()) === "");
    } finally {
      await rm(dir4, { recursive: true, force: true });
    }

    // The comparison itself, and the reading of the XML, where a slip would let a difference through.
    const base2 = { sheets: new Map([["A", new Map([["B1", "=1"]])], ["B", new Map<string, string>()]]), names: new Map([["One", "A!$A$1"], ["Two", "A!$A$2"]]), cannotCarry: [], notes: [], formulas: 1 };
    const copy2 = { sheets: new Map([["A", new Map([["B1", "=1"], ["C1", "=2"]])]]), names: new Map([["One", "A!$A$1"], ["Two", "A!$A$3"]]), cannotCarry: [], notes: [], formulas: 2 };
    const d2 = formulaDifferences(base2, copy2, new Map(), new Map()).join(" | ");
    check("a formula only the copy has, a sheet the copy lacks and a second name that changed are each named", /A!C1 holds a formula in the copy \(=2\) that the original does not have/.test(d2) && /sheet "B" is not in the copy/.test(d2) && /the name "Two" refers to "A!\$A\$2" in the original and to "A!\$A\$3" in the copy/.test(d2) && !/"One"/.test(d2));
    const stray: string[] = [];
    const odd = formulasInSheetXml(
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c nr="Q9" r="B1"><f>A1&#38;&#34;x&#34;&#x41;\r\n+1</f></c><c r="C1"><v>2</v></c></row></sheetData><extLst><ext><f>Z9</f></ext></extLst></worksheet>',
      "S",
      stray,
    );
    check("a formula outside any cell belongs to none; an attribute is read by its whole name; character references are decoded; a line break is one thing", JSON.stringify([...odd]) === JSON.stringify([["B1", '=A1&"x"A\n+1']]));

    console.log(`\n✓ render-store: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ render-store test failed:", err);
  process.exit(1);
});
