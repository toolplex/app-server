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
    const built = await store.renderXlsx(
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
    const fwd = await store.renderXlsx(
      {
        title: "SR Report v2",
        base: { fileId: built.fileId },
        ops: [{ op: "append_rows", sheet: "Summary", source: { rows: [{ store: "Gamma", sold: 9 }] } }],
      },
      requester,
    );
    check("forward is a new fileId", fwd.fileId !== built.fileId);
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

    console.log(`\n✓ render-store: ${passed} checks passed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n✗ render-store test failed:", err);
  process.exit(1);
});
