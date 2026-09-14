/**
 * Page snapshots — materialize every sheet of a page into ONE pinned,
 * multi-table DuckDB file, server-side, so ToolPlex's alert evaluator can run
 * read-only SQL over "the page as it was at this refresh" (and diff it against
 * the previous one) without paging rows across the network.
 *
 * POST /snapshots  { pageId, filters?, resources?, maxRows? }
 *   → { manifest, columns: { [table]: string[] }, lastSync, rowCounts }
 *
 * Tables: one per resource the page's sections read (`source`), named after
 * the resource, plus `__meta` (page_id, taken_at, last_sync). Rows are the
 * handler's full result under the given filters, gathered with the same
 * cursor/page loop the /download route uses.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { appendFile, writeFile, rm } from "node:fs/promises";
import type { AppServerConfig, ColumnFilter, FetchRequest, ResourceDefinition } from "../types.js";
import { readUserHeaders, readOrgHeader } from "../user.js";
import { FileStore, FileStoreError, type Requester } from "../files/store.js";
import { validateFetchResponse } from "../validation.js";

const CHUNK = 100_000;
/** The only row limit is the store's own ceiling; a page that exceeds it is a page design problem the reading can explain. */
const HARD_MAX_ROWS = 2_000_000;

/** Every `source` a page's sections read, in order, deduplicated (groups recurse). */
export function pageResources(config: AppServerConfig, pageId: string): string[] {
  const page = config.pages[pageId];
  if (!page) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (entries: unknown[]) => {
    for (const e of entries) {
      const list = Array.isArray(e) ? e : [e];
      for (const s of list as Array<{ type?: string; source?: unknown; sections?: unknown[] }>) {
        if (!s || typeof s !== "object") continue;
        if (s.type === "group" && Array.isArray(s.sections)) { walk(s.sections); continue; }
        if (typeof s.source === "string" && s.source && !seen.has(s.source)) { seen.add(s.source); out.push(s.source); }
      }
    }
  };
  walk(page.sections as unknown[]);
  return out;
}

/** Column keys the page's sections declare for a resource — the schema of an empty sheet. */
export function declaredColumns(config: AppServerConfig, pageId: string, resource: string): string[] {
  const page = config.pages[pageId];
  if (!page) return [];
  const out = new Set<string>();
  const walk = (entries: unknown[]) => {
    for (const e of entries) {
      const list = Array.isArray(e) ? e : [e];
      for (const s of list as Array<{ type?: string; source?: unknown; sections?: unknown[]; columns?: Array<{ key?: unknown }>; rowKey?: unknown }>) {
        if (!s || typeof s !== "object") continue;
        if (s.type === "group" && Array.isArray(s.sections)) { walk(s.sections); continue; }
        if (s.source !== resource) continue;
        if (typeof s.rowKey === "string") out.add(s.rowKey);
        for (const c of s.columns ?? []) if (typeof c?.key === "string") out.add(c.key);
      }
    }
  };
  walk(page.sections as unknown[]);
  return [...out].sort();
}

/**
 * Every row of a resource under filters, handed over a chunk at a time —
 * cursor loop when the handler supports it, page loop otherwise. Nothing is
 * kept here: the caller writes each chunk where it wants it, so a page of
 * millions costs the memory of one chunk. Returns how many rows were passed.
 */
export async function streamAllRows(
  definition: ResourceDefinition,
  resource: string,
  base: Pick<FetchRequest, "filters" | "columnFilters" | "sort" | "user">,
  maxRows: number,
  onChunk: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  let count = 0;
  const take = async (rows: Record<string, unknown>[]) => {
    const room = maxRows - count;
    if (room <= 0) return;
    const part = rows.length > room ? rows.slice(0, room) : rows;
    if (part.length === 0) return;
    count += part.length;
    await onChunk(part);
  };
  const first = await definition.fetch({ page: 1, pageSize: CHUNK, ...base });
  validateFetchResponse(resource, first);
  await take(first.rows);
  if (first.nextCursor !== undefined && first.nextCursor !== null) {
    let cursor: string | null = first.nextCursor;
    while (cursor !== null && count < maxRows) {
      const res = await definition.fetch({ page: 1, pageSize: CHUNK, ...base, cursor, skipTotal: true });
      await take(res.rows);
      cursor = res.nextCursor ?? null;
    }
  } else {
    const total = Math.min(first.total ?? first.rows.length, maxRows);
    const pages = Math.ceil(total / CHUNK);
    for (let page = 2; page <= pages && count < maxRows; page++) {
      const res = await definition.fetch({ page, pageSize: CHUNK, ...base, skipTotal: true });
      await take(res.rows);
    }
  }
  return count;
}

/** All rows of a resource under filters, in memory. Kept for callers that want an array; the photo route streams instead. */
export async function collectAllRows(
  definition: ResourceDefinition,
  resource: string,
  base: Pick<FetchRequest, "filters" | "columnFilters" | "sort" | "user">,
  maxRows: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  await streamAllRows(definition, resource, base, maxRows, async (part) => { rows.push(...part); });
  return rows;
}

/** In-table column filters per resource from a request body, kept to the shape the handlers accept. */
function readColumnFilters(raw: unknown): Record<string, ColumnFilter[]> {
  const out: Record<string, ColumnFilter[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [resource, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter((f): f is ColumnFilter =>
      !!f && typeof f === "object" && typeof (f as ColumnFilter).columnKey === "string"
      && ["equals", "contains", "gt", "lt", "empty", "not_empty"].includes(String((f as ColumnFilter).operator))
      && typeof (f as ColumnFilter).value === "string");
    if (clean.length > 0) out[resource] = clean;
  }
  return out;
}

/** Column projection per resource from a request body: the columns a photo should keep. */
function readProjection(raw: unknown): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [resource, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const cols = list.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (cols.length > 0) out[resource] = new Set(cols);
  }
  return out;
}

export function registerSnapshotRoutes(fastify: FastifyInstance, config: AppServerConfig, store: FileStore): void {
  /**
   * POST /snapshots/query — one read-only SQL statement across a page's album.
   * ToolPlex resolves which files make up the album (newest first) and gates
   * the page; this route only opens the files it is handed, read-only.
   */
  fastify.post<{ Body: { files?: Array<{ fileId?: string; takenAt?: string; sourceSync?: string | null }>; sql?: string } }>("/snapshots/query", async (request, reply) => {
    const body = request.body ?? {};
    const sql = body.sql;
    if (typeof sql !== "string") return reply.code(400).send({ error: "Body must include a 'sql' string." });
    const files = (Array.isArray(body.files) ? body.files : [])
      .filter((f) => f && typeof f.fileId === "string" && typeof f.takenAt === "string")
      .map((f) => ({ fileId: f.fileId as string, takenAt: f.takenAt as string, sourceSync: typeof f.sourceSync === "string" ? f.sourceSync : null }));
    if (files.length === 0) return reply.code(400).send({ error: "Body must include 'files'." });
    const user = readUserHeaders(request);
    const requester: Requester = { userId: user?.id, orgId: user?.orgId ?? readOrgHeader(request) };
    const result = await store.queryMany(files, sql, requester);
    return reply.send(result);
  });

  /**
   * POST /snapshots/estimate — how big a photo would be, without taking it.
   * One single-row fetch per resource, reading the `total` the handler
   * reports (null when a handler can't count, e.g. a cursor-only source).
   * ToolPlex asks before photographing a page an alert wants to watch, so a
   * table of millions is refused with a reason instead of pulled in full.
   */
  fastify.post<{ Body: { pageId?: string; filters?: Record<string, string>; columnFilters?: Record<string, ColumnFilter[]>; resources?: string[] } }>("/snapshots/estimate", async (request, reply) => {
    const body = request.body ?? {};
    const pageId = typeof body.pageId === "string" ? body.pageId : "";
    const page = config.pages[pageId];
    if (!page) return reply.code(404).send({ error: `Page "${pageId}" not found.` });
    const user = readUserHeaders(request);
    const wanted = Array.isArray(body.resources) && body.resources.length > 0 ? body.resources : pageResources(config, pageId);
    const resources = wanted.filter((r) => config.resources[r]);
    const filters = body.filters && typeof body.filters === "object" ? body.filters : undefined;
    const columnFilters = readColumnFilters(body.columnFilters);
    const totals: Record<string, number | null> = {};
    for (const resource of resources) {
      try {
        const first = await config.resources[resource].fetch({ page: 1, pageSize: 1, filters, columnFilters: columnFilters[resource], user });
        totals[resource] = typeof first.total === "number" && Number.isFinite(first.total) ? first.total : null;
      } catch {
        totals[resource] = null;
      }
    }
    return reply.send({ totals, hardMaxRows: HARD_MAX_ROWS });
  });

  fastify.post<{
    Body: {
      pageId?: string; filters?: Record<string, string>; columnFilters?: Record<string, ColumnFilter[]>; resources?: string[];
      /** Per resource, the columns to keep. Absent: every column. The row key columns must be among them; the caller knows which those are. */
      columns?: Record<string, string[]>;
      maxRows?: number; previousFileId?: string;
    };
  }>("/snapshots", async (request, reply) => {
    const body = request.body ?? {};
    const pageId = typeof body.pageId === "string" ? body.pageId : "";
    const page = config.pages[pageId];
    if (!page) return reply.code(404).send({ error: `Page "${pageId}" not found.` });
    const user = readUserHeaders(request);
    const requester: Requester = { userId: user?.id, orgId: user?.orgId ?? readOrgHeader(request) };
    const wanted = Array.isArray(body.resources) && body.resources.length > 0 ? body.resources : pageResources(config, pageId);
    const resources = wanted.filter((r) => config.resources[r]);
    if (resources.length === 0) return reply.code(400).send({ error: "This page reads no resources." });
    const maxRows = Math.min(HARD_MAX_ROWS, Math.max(1, Number(body.maxRows) || HARD_MAX_ROWS));
    const filters = body.filters && typeof body.filters === "object" ? body.filters : undefined;
    const columnFilters = readColumnFilters(body.columnFilters);
    const projection = readProjection(body.columns);

    // The sync is read BEFORE the rows. If the page refreshes while rows are
    // being collected, the file holds (at least) the earlier sync's data and
    // is labelled with it, so the newer sync is still evaluated next tick.
    // Labelling with the later sync would skip it.
    const readSync = async (): Promise<string | null> => {
      try {
        const ctx = page.context ? await page.context({ sections: [], user }) : null;
        return ctx?.lastSync ?? null;
      } catch { return null; }
    };
    const lastSync = await readSync();

    // The page's previous photo, when the caller names it: an empty sheet
    // today keeps the column types it had yesterday, so a check comparing a
    // number still runs against it. Best effort — a missing or foreign file
    // just means text columns.
    const previousTypes: Record<string, Record<string, string>> = {};
    if (typeof body.previousFileId === "string" && /^[0-9a-f-]{36}$/i.test(body.previousFileId)) {
      try {
        const prev = await store.getManifest(body.previousFileId, requester);
        for (const t of prev.tables ?? []) {
          const types: Record<string, string> = {};
          for (const c of t.columns ?? []) types[c.name] = c.type;
          previousTypes[t.sheetName || t.name] = types;
          previousTypes[t.name] = types;
        }
      } catch { /* no previous types */ }
    }

    const datasets: Parameters<typeof store.materializeDatasets>[0] = [];
    const columns: Record<string, string[]> = {};
    const rowCounts: Record<string, number> = {};
    const staged: string[] = [];
    let budget = maxRows;
    try {
    for (const resource of resources) {
      // Each chunk goes straight to a staged file on the store's disk; the
      // process never holds more than one chunk of any sheet.
      const keep = projection[resource];
      const project = keep
        ? (r: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const k of keep) if (k in r) o[k] = r[k]; return o; }
        : (r: Record<string, unknown>) => r;
      const path = await store.stagingPath();
      staged.push(path);
      await writeFile(path, "", "utf8");
      let firstKeys: string[] | null = null;
      const count = await streamAllRows(config.resources[resource], resource, { filters, columnFilters: columnFilters[resource], user }, budget, async (part) => {
        const projected = part.map(project);
        if (!firstKeys && projected.length > 0) firstKeys = Object.keys(projected[0]);
        await appendFile(path, projected.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      });
      budget -= count;
      if (count > 0) {
        datasets.push({ name: resource, sourcePath: path, rowCount: count });
        columns[resource] = (firstKeys ?? []).slice().sort();
      } else {
        await rm(path, { force: true }).catch(() => {});
        staged.splice(staged.indexOf(path), 1);
        // An empty sheet is still a sheet: the table must exist (with the
        // columns the page declares for it) so a check that reads it sees
        // zero rows rather than a missing table. Zero exceptions is the
        // healthy state of an exceptions sheet, not an error.
        const declaredAll = declaredColumns(config, pageId, resource);
        const declared = keep ? declaredAll.filter((c) => keep.has(c)) : declaredAll;
        datasets.push({ name: resource, rows: [], columns: declared, columnTypes: previousTypes[resource] });
        columns[resource] = declared;
      }
      rowCounts[resource] = count;
      if (budget <= 0) break;
    }
    const takenAt = new Date().toISOString();
    datasets.push({ name: "__meta", rows: [{ page_id: pageId, taken_at: takenAt, last_sync: lastSync }] });

    // materialize removes the staged files itself, on success and on failure.
    const manifest = await store.materializeDatasets(datasets, requester);
    return reply.send({ manifest, columns, rowCounts, lastSync, takenAt, truncated: budget <= 0 });
    } catch (err) {
      // A fetch that failed part-way leaves staged files behind: not ours to keep.
      await Promise.all(staged.map((p) => rm(p, { force: true }).catch(() => {})));
      throw err;
    }
  });
}

export { FileStoreError };
