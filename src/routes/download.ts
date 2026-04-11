import type { FastifyInstance } from "fastify";
import type { AppServerConfig, FetchRequest } from "../types.js";
import { parseFetchParams } from "../parsing.js";
import { validateFetchResponse } from "../validation.js";

/**
 * Internal page size for chunked fetching — not exposed to clients.
 *
 * 100_000 rows/chunk. The dominant cost on cloud-proxied deploys is the
 * fixed per-call overhead (auth, proxy hops, token verification, fastify
 * request lifecycle) — typically 1-2 seconds per chunk regardless of row
 * count. Pushing the chunk size up amortizes that overhead across more
 * rows. For a 1M row export this is 10 round-trips total (vs 1000 at the
 * original 1k chunk size) — the per-chunk overhead is paid 10 times, not
 * 1000 times.
 *
 * Memory cost: ~100k rows × ~500 bytes = ~50 MB JSON payload per chunk,
 * with Node needing 2-3× that during marshalling (~150 MB peak per
 * concurrent download). Comfortably within reasonable bounds even for
 * 10 concurrent users.
 *
 * For handlers that support keyset cursor pagination (return `nextCursor`
 * from their fetch handler), each chunk is also O(1) instead of O(N) —
 * the OFFSET amplification disappears entirely.
 */
const DOWNLOAD_CHUNK_SIZE = 100_000;

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
    let rowsWritten = 0;
    for (const row of firstPage.rows) {
      if (rowsWritten >= MAX_DOWNLOAD_ROWS) break;
      reply.raw.write(csvRow(keys.map((k) => row[k])));
      rowsWritten++;
    }

    // Two loop modes — pick based on whether the handler advertises cursor
    // pagination support by returning a nextCursor on chunk 1.
    //
    // CURSOR MODE (preferred for large exports):
    //   The handler returned a non-null nextCursor on chunk 1, signalling
    //   support for keyset pagination. We pass that cursor back on each
    //   subsequent call. The handler uses it to seek directly to the next
    //   chunk via WHERE (sort_cols) > (cursor_vals) — O(1) per chunk
    //   regardless of position. Loop ends when nextCursor is null/absent.
    //
    // PAGE MODE (legacy fallback):
    //   The handler omitted nextCursor entirely. We loop with page numbers
    //   2..N as before, using firstPage.total to compute the page count.
    //   This works for any handler but pays OFFSET cost on later chunks.

    if (firstPage.nextCursor !== undefined && firstPage.nextCursor !== null) {
      // CURSOR MODE
      let cursor: string | null = firstPage.nextCursor;
      while (cursor !== null && rowsWritten < MAX_DOWNLOAD_ROWS) {
        const req: FetchRequest = {
          page: 1, // ignored when cursor is set
          pageSize: DOWNLOAD_CHUNK_SIZE,
          sort: baseParams.sort,
          filters: baseParams.filters,
          columnFilters: baseParams.columnFilters,
          cursor,
          skipTotal: true,
        };
        const result = await definition.fetch(req);
        for (const row of result.rows) {
          if (rowsWritten >= MAX_DOWNLOAD_ROWS) break;
          reply.raw.write(csvRow(keys.map((k) => row[k])));
          rowsWritten++;
        }
        cursor = result.nextCursor ?? null;
      }
    } else {
      // PAGE MODE (legacy)
      const total = Math.min(firstPage.total, MAX_DOWNLOAD_ROWS);
      const totalPages = Math.ceil(total / DOWNLOAD_CHUNK_SIZE);
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
          if (rowsWritten >= MAX_DOWNLOAD_ROWS) break;
          reply.raw.write(csvRow(keys.map((k) => row[k])));
          rowsWritten++;
        }
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
