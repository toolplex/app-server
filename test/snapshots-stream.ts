/**
 * The photo route streams: a quarter-million synthetic rows go through
 * POST /snapshots with a column filter and a projection, and the process
 * never holds more than a chunk. Also covers /snapshots/estimate.
 *
 * Run with: npx tsx test/snapshots-stream.ts
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";

import { FileStore } from "../src/files/store.js";
import { registerSnapshotRoutes } from "../src/routes/snapshots.js";
import type { AppServerConfig } from "../src/types.js";

const SCRATCH_PREFIX = join(process.cwd(), ".tp-test-snap-");
const ROWS = 250_000;
const PAGE = 100_000;

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed++;
}

// A resource of ROWS rows, served by page, with a column filter on `region`.
function row(i: number): Record<string, unknown> {
  return { id: i, region: i % 4 === 0 ? "north" : "south", amount: (i * 7) % 1000, note: "x".repeat(40), extra1: i, extra2: `e${i}`, extra3: i % 9 };
}
const config = {
  pages: {
    big: { title: "Big", sections: [{ type: "table", source: "rows", rowKey: "id", columns: [{ key: "id" }, { key: "region" }, { key: "amount" }] }] },
  },
  resources: {
    rows: {
      fetch: async ({ page, pageSize, columnFilters }: { page: number; pageSize: number; columnFilters?: { columnKey: string; operator: string; value: string }[] }) => {
        const wantRegion = columnFilters?.find((f) => f.columnKey === "region" && f.operator === "equals")?.value;
        const all = wantRegion ? Math.ceil(ROWS / 4) : ROWS;
        const start = (page - 1) * pageSize;
        const out: Record<string, unknown>[] = [];
        for (let n = start; n < Math.min(all, start + pageSize); n++) out.push(row(wantRegion ? n * 4 : n));
        return { rows: out, total: all };
      },
    },
  },
} as unknown as AppServerConfig;

async function main(): Promise<void> {
  const dir = await mkdtemp(SCRATCH_PREFIX);
  const store = new FileStore({ enabled: true, dir, minFreeBytes: 0 });
  await store.init();
  const app = Fastify();
  registerSnapshotRoutes(app, config, store);
  try {
    // Estimate: whole and filtered.
    const est = await app.inject({ method: "POST", url: "/snapshots/estimate", payload: { pageId: "big" } });
    check("estimate answers", est.statusCode === 200);
    check("estimate counts the whole sheet", est.json().totals.rows === ROWS);
    const estF = await app.inject({ method: "POST", url: "/snapshots/estimate", payload: { pageId: "big", columnFilters: { rows: [{ columnKey: "region", operator: "equals", value: "north" }] } } });
    check("estimate honours a column filter", estF.json().totals.rows === Math.ceil(ROWS / 4));

    // The photo: all rows, projected to three columns, watching memory.
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
    const res = await app.inject({ method: "POST", url: "/snapshots", payload: { pageId: "big", columns: { rows: ["id", "region", "amount"] } } });
    clearInterval(timer);
    check("photo taken", res.statusCode === 200);
    const body = res.json();
    check("every row counted", body.rowCounts.rows === ROWS);
    check("projection kept the three columns", JSON.stringify(body.columns.rows) === JSON.stringify(["amount", "id", "region"]));
    const table = body.manifest.tables.find((t: { name: string }) => t.name === "rows");
    check("the table has the projected columns only", table.columns.length === 3);
    check("the table has every row", table.rowCount === ROWS);
    const grewMb = (peak - before) / 1e6;
    console.log(`heap grew by ${grewMb.toFixed(0)} MB while photographing ${ROWS.toLocaleString()} rows in pages of ${PAGE.toLocaleString()}`);
    check("memory stayed near one page, not the whole sheet", grewMb < 400);

    // The photo with a column filter: a quarter of the rows.
    const resF = await app.inject({ method: "POST", url: "/snapshots", payload: { pageId: "big", columnFilters: { rows: [{ columnKey: "region", operator: "equals", value: "north" }] } } });
    check("filtered photo taken", resF.statusCode === 200);
    check("filtered photo holds the slice", resF.json().rowCounts.rows === Math.ceil(ROWS / 4));

    // No staged files left behind.
    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".staged.json"));
    check("no staged files left behind", leftovers.length === 0);

    console.log(`ok — ${passed} checks passed`);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
