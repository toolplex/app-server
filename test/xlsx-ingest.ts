/**
 * Ingestion regression for the "IPS, REPLENISH, MPSP.xlsx" bug: a sheet with
 * a merged title row and a rich-text cell used to come out as ONE row of 24
 * generic columns (rich text JSON-serialised into the CSV, exploded on commas,
 * then the error-skipping fallback dropped every normal row).
 *
 * Run with: npx tsx test/xlsx-ingest.ts
 */

import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { FileStore } from "../src/files/store.js";

let passed = 0;
const check = (cond: unknown, msg: string) => { assert.ok(cond, msg); passed++; };

async function buildWorkbook(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("FORMAT REPORT");
  ws.mergeCells("A1:E1");
  ws.getCell("A1").value = "IPS, REPLENISH, MPSP — data dictionary";
  ws.addRow([]); // blank spacer under the title
  ws.addRow(["Field Name", "Description", "Data Source", "Data Type", "Formula"]);
  ws.addRow([
    "REPLENISH STORE INV",
    { richText: [
      { font: { size: 11, name: "Calibri" }, text: "inner join of master_stock_file & master store_file to sales_buying_file" },
      { font: { italic: true, color: { argb: "FFFF0000" } }, text: " (connect to str_branch_id & stock_id for innerjoin)" },
    ] },
    "MAIN DATASOURCE",
    "NUMBER",
    "IFNULL(SUM(replenish store inv socks), 0) + IFNULL(SUM(replenish store inv ug), 0)",
  ]);
  ws.addRow(["IPS QTY", "plain description, with a comma", "MAIN DATASOURCE", "NUMBER", { formula: "1+1", result: 2 }]);
  ws.addRow(["MPSP DATE", new Date(Date.UTC(2026, 8, 12)), "MAIN DATASOURCE", "DATE", ""]);
  for (const name of ["IPS", "REPLENISH", "MPSP"]) {
    const s = wb.addWorksheet(name);
    s.addRow(["Metric", "Value"]);
    s.addRow([`${name} a`, 1]);
    s.addRow([`${name} b`, 2]);
  }
  wb.addWorksheet("Notes"); // genuinely empty
  await wb.xlsx.writeFile(path);
}

// The store refuses the OS temp dir (wiped on reboot); use a scratch folder under $HOME like render-store.ts.
const scratchRoot = join(homedir(), ".toolplex-app-server-test");
await mkdir(scratchRoot, { recursive: true });
const dir = await mkdtemp(join(scratchRoot, "ingest-"));
const store = new FileStore({ enabled: true, dir });
await store.init();
const requester = { orgId: "org-test" };

try {
  // --- XLSX: rich text, merged title, formula result, date, several sheets
  const xlsxPath = join(dir, "IPS, REPLENISH, MPSP.xlsx");
  await buildWorkbook(xlsxPath);
  const m = await store.ingest("IPS, REPLENISH, MPSP.xlsx", await readFile(xlsxPath), requester);

  check(m.tables.length === 4, `four non-empty sheets ingested (got ${m.tables.map((t) => t.name).join(", ")})`);
  const fr = m.tables.find((t) => t.sheetName === "FORMAT REPORT" || t.name.toLowerCase().includes("format"));
  check(fr, "FORMAT REPORT table present");
  check(
    JSON.stringify(fr!.columns.map((c) => c.name)) === JSON.stringify(["Field Name", "Description", "Data Source", "Data Type", "Formula"]),
    `header row detected below the merged title (got ${fr!.columns.map((c) => c.name).join(" | ")})`,
  );
  check(fr!.rowCount === 3, `all three data rows kept (got ${fr!.rowCount})`);
  check((m.notes ?? []).some((n) => /title row/.test(n)), "manifest notes mention the skipped title row");
  check(!(m.notes ?? []).some((n) => /dropped/.test(n)), "no rows reported dropped");

  const q = await store.query(m.fileId, `SELECT * FROM ${JSON.stringify(fr!.name).replace(/^"|"$/g, "\"")} ORDER BY "Field Name"`, requester);
  const byField = Object.fromEntries(q.rows.map((r) => [String(r["Field Name"]), r]));
  check(
    String(byField["REPLENISH STORE INV"]["Description"]) ===
      "inner join of master_stock_file & master store_file to sales_buying_file (connect to str_branch_id & stock_id for innerjoin)",
    "rich text flattened to its display text",
  );
  check(String(byField["IPS QTY"]["Formula"]) === "2", `formula cell carries its result (got ${byField["IPS QTY"]["Formula"]})`);
  check(String(byField["MPSP DATE"]["Description"]).startsWith("2026-09-12"), `date cell is ISO (got ${byField["MPSP DATE"]["Description"]})`);
  check(String(byField["IPS QTY"]["Description"]) === "plain description, with a comma", "commas inside cells survive quoting");
  for (const name of ["IPS", "REPLENISH", "MPSP"]) {
    const t = m.tables.find((x) => x.sheetName === name || x.name.toLowerCase() === name.toLowerCase());
    check(t && t.rowCount === 2 && t.columns.map((c) => c.name).join(",") === "Metric,Value", `sheet ${name} intact`);
  }
  check((m.notes ?? []).some((n) => /Skipped empty sheet "Notes"/.test(n)), "empty sheet skipped with a note");

  // --- CSV: ragged rows and a stray quote must not lose rows silently
  const ragged = ['id,name,amount', '1,"Acme, Inc",10', '2,Bob', '3,Ca"rol,30', '4,Dee,40,extra'].join("\n") + "\n";
  const c = await store.ingest("ragged.csv", Buffer.from(ragged, "utf8"), requester);
  const ct = c.tables[0];
  check(ct.rowCount === 4, `ragged csv keeps all four rows (got ${ct.rowCount}; notes: ${(c.notes ?? []).join(" / ")})`);
  check((c.notes ?? []).some((n) => /treated as text/.test(n)), "ragged csv notes the text fallback");

  console.log(`\n✓ xlsx-ingest: ${passed} checks passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
