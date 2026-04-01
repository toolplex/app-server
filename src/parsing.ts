import type { FetchRequest, ContextRequest, SortSpec, Selection } from "./types.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Parse query params into typed request objects
// ---------------------------------------------------------------------------

export function parseFetchParams(
  query: Record<string, string | undefined>,
): FetchRequest {
  const page = clampInt(query.page, DEFAULT_PAGE, 1);
  const pageSize = clampInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const sort = parseSort(query.sort);
  const filters = parseFilters(query);
  const selection = parseSelection(query.selection);

  return { page, pageSize, sort, filters, selection };
}

export function parseContextParams(
  query: Record<string, string | undefined>,
): ContextRequest {
  return {
    filters: parseFilters(query),
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
