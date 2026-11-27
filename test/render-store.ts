/**
 * Integration test for FileStore.renderXlsx — the full M1/M2 store path
 * including source resolution (SQL against a local DuckDB snapshot) and the
 * projection rebuild. Exercises real DuckDB + exceljs end-to-end.
 *
 * Run with: npx tsx test/render-store.ts
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { FileStore } from "../src/files/store.js";

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

    console.log(`\n✓ render-store: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ render-store test failed:", err);
  process.exit(1);
});
