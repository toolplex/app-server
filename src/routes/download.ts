import type { FastifyInstance } from "fastify";
import type { AppServerConfig, FetchRequest } from "../types.js";
import { parseFetchParams } from "../parsing.js";
import { validateFetchResponse } from "../validation.js";

/**
 * Internal page size for chunked fetching — not exposed to clients.
 *
 * Bumped from 1000 → 10000: handler.fetch() per-call overhead (auth, query
 * planning, COUNT(*), result marshalling) is mostly fixed-cost. Increasing
 * the chunk size 10× cuts per-call overhead by 10× without proportionally
 * increasing per-query time. For a 1M row export this is the difference
 * between 1000 round-trips and 100.
 */
const DOWNLOAD_CHUNK_SIZE = 10_000;

/** Maximum rows to export (safety valve) */
const MAX_DOWNLOAD_ROWS = 2_000_000;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(",") + "\r\n";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerDownloadRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  fastify.get<{
    Params: { resource: string };
    Querystring: Record<string, string>;
  }>("/download/:resource", async (request, reply) => {
    const { resource } = request.params;
    const definition = config.resources[resource];

    if (!definition) {
      return reply.code(404).send({ error: `Resource "${resource}" not found` });
    }

    // Check that this resource is marked downloadable in at least one table section
    if (!isResourceDownloadable(resource, config)) {
      return reply.code(403).send({ error: `Resource "${resource}" is not downloadable` });
    }

    // Parse filters/sort from query params (page/pageSize ignored — we fetch all).
    // baseParams already includes columnFilters split out of the filter bag;
    // we pass them through to the handler on every chunk request.
    const baseParams = parseFetchParams(request.query);

    // Parse column spec from query param: JSON array of {key, label}
    let columns: { key: string; label: string }[] | undefined;
    try {
      if (request.query.columns) {
        columns = JSON.parse(request.query.columns);
      }
    } catch {
      // Ignore parse errors — we'll discover columns from data
    }

    // Set response headers for CSV download
    const filename = `${resource}_${new Date().toISOString().slice(0, 10)}.csv`;
    reply.raw.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    // Fetch page 1 to discover total and (if needed) column keys.
    // The handler receives both filters AND columnFilters and is responsible
    // for returning a correctly filtered + counted page.
    //
    // Chunk 1 MUST get the real total — we use it to compute totalPages
    // and bound the chunk loop. Subsequent chunks pass skipTotal: true
    // so handlers can skip the (often expensive) COUNT(*) query.
    const firstReq: FetchRequest = {
      page: 1,
      pageSize: DOWNLOAD_CHUNK_SIZE,
      sort: baseParams.sort,
      filters: baseParams.filters,
      columnFilters: baseParams.columnFilters,
    };

    const firstPage = await definition.fetch(firstReq);
    validateFetchResponse(resource, firstPage);

    // Resolve columns — prefer explicit spec, fall back to keys from first row
    if (!columns || columns.length === 0) {
      if (firstPage.rows.length > 0) {
        columns = Object.keys(firstPage.rows[0]).map((k) => ({ key: k, label: k }));
      } else {
        // Empty dataset — write empty CSV
        reply.raw.end("");
        return reply;
      }
    }

    const keys = columns.map((c) => c.key);

    // Write CSV header
    reply.raw.write(csvRow(columns.map((c) => c.label)));

    // Write first page rows
    for (const row of firstPage.rows) {
      reply.raw.write(csvRow(keys.map((k) => row[k])));
    }

    // Calculate remaining pages from the handler's filtered total.
    const total = Math.min(firstPage.total, MAX_DOWNLOAD_ROWS);
    const totalPages = Math.ceil(total / DOWNLOAD_CHUNK_SIZE);

    // Fetch remaining pages and stream. skipTotal: true tells handlers
    // they can omit the COUNT(*) query — we already have the total from
    // chunk 1 and never read result.total in this loop.
    for (let page = 2; page <= totalPages; page++) {
      const req: FetchRequest = {
        page,
        pageSize: DOWNLOAD_CHUNK_SIZE,
        sort: baseParams.sort,
        filters: baseParams.filters,
        columnFilters: baseParams.columnFilters,
        skipTotal: true,
      };

      const result = await definition.fetch(req);

      for (const row of result.rows) {
        reply.raw.write(csvRow(keys.map((k) => row[k])));
      }
    }

    reply.raw.end();
    return reply;
  });
}

// ---------------------------------------------------------------------------
// Check if a resource is marked downloadable in any page's table sections
// ---------------------------------------------------------------------------

function isResourceDownloadable(resource: string, config: AppServerConfig): boolean {
  for (const page of Object.values(config.pages)) {
    for (const sectionOrRow of page.sections) {
      const sections = Array.isArray(sectionOrRow) ? sectionOrRow : [sectionOrRow];
      for (const section of sections) {
        if (
          section.type === "table" &&
          section.source === resource &&
          section.downloadable === true
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
