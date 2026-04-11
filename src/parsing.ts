import type { FetchRequest, ContextRequest, SortSpec, Selection } from "./types.js";
import { extractColumnFilters } from "./utils/columnFilters.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const MAX_PAGE = 10_000;

// ---------------------------------------------------------------------------
// Parse query params into typed request objects
// ---------------------------------------------------------------------------

export function parseFetchParams(
  query: Record<string, string | undefined>,
): FetchRequest {
  const page = clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE);
  const pageSize = clampInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const sort = parseSort(query.sort);
  const rawFilters = parseFilters(query);

  // Split _cf_* keys out of the filter bag into a typed columnFilters array
  // so handlers receive a clean separation between top-of-page filters and
  // in-table column filters. Handlers must apply columnFilters themselves;
  // the framework no longer post-filters (the post-filter only worked
  // correctly for handlers that returned the full unpaginated dataset,
  // which is impossible for any real DB-backed handler).
  const columnFilters = extractColumnFilters(rawFilters);
  const filters = stripColumnFilterKeys(rawFilters);
  const selection = parseSelection(query.selection);

  return { page, pageSize, sort, filters, columnFilters, selection };
}

function stripColumnFilterKeys(
  filters: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!filters) return undefined;
  const out: Record<string, string> = {};
  let any = false;
  for (const [k, v] of Object.entries(filters)) {
    if (k.startsWith("_cf_")) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : undefined;
}

export function parseContextParams(
  query: Record<string, string | undefined>,
): ContextRequest {
  const rawFilters = parseFilters(query);
  return {
    filters: stripColumnFilterKeys(rawFilters),
    columnFilters: extractColumnFilters(rawFilters),
    selection: parseSelection(query.selection),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  if (n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function parseSort(raw: string | undefined): SortSpec | undefined {
  if (!raw) return undefined;
  const [key, dir] = raw.split(",");
  if (!key) return undefined;
  return {
    key,
    direction: dir === "desc" ? "desc" : "asc",
  };
}

function parseSelection(raw: string | undefined): Selection | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Selection;
    if (!Array.isArray(parsed.ids)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Extract filter params from query string.
 * Reserved keys (page, pageSize, sort, selection) are excluded.
 */
const RESERVED_KEYS = new Set(["page", "pageSize", "sort", "selection"]);

function parseFilters(
  query: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const filters: Record<string, string> = {};
  let hasFilters = false;

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_KEYS.has(key) || value === undefined) continue;
    filters[key] = value;
    hasFilters = true;
  }

  return hasFilters ? filters : undefined;
}
