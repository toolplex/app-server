import type { FastifyInstance } from "fastify";
import type { AppServerConfig, PaginatedResponse } from "../types.js";
import { parseFetchParams } from "../parsing.js";
import { validateFetchResponse } from "../validation.js";

export function registerDataRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  fastify.get<{
    Params: { resource: string };
    Querystring: Record<string, string>;
  }>("/data/:resource", async (request, reply) => {
    const { resource } = request.params;
    const definition = config.resources[resource];

    if (!definition) {
      return reply.code(404).send({ error: `Resource "${resource}" not found` });
    }

    const params = parseFetchParams(request.query);
    const response = await definition.fetch(params);

    validateFetchResponse(resource, response);

    // Apply column filters (_cf_ prefixed) post-fetch
    // These are auto-applied by the library so developers don't need to handle them
    const columnFilters = extractColumnFilters(params.filters);
    let filteredRows = response.rows;
    let filteredTotal = response.total;

    if (columnFilters.length > 0) {
      filteredRows = applyColumnFilters(filteredRows, columnFilters);
      filteredTotal = filteredRows.length;
      // Re-paginate after filtering
      const start = (params.page - 1) * params.pageSize;
      filteredRows = filteredRows.slice(start, start + params.pageSize);
    }

    const result: PaginatedResponse = {
      rows: filteredRows,
      total: filteredTotal,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.ceil(filteredTotal / params.pageSize),
    };

    return reply.send(result);
  });
}

// ---------------------------------------------------------------------------
// Column filter parsing and application
// ---------------------------------------------------------------------------

interface ColumnFilter {
  columnKey: string;
  operator: "equals" | "contains" | "gt" | "lt" | "empty" | "not_empty";
  value: string;
}

function extractColumnFilters(
  filters?: Record<string, string>,
): ColumnFilter[] {
  if (!filters) return [];
  const result: ColumnFilter[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (!key.startsWith("_cf_")) continue;
    const rest = key.slice(4); // remove _cf_ prefix
    const parts = rest.split("__");
    const columnKey = parts[0];
    const operator = (parts[1] || "contains") as ColumnFilter["operator"];
    result.push({ columnKey, operator, value });
  }

  return result;
}

function resolveKey(
  row: Record<string, unknown>,
  key: string,
): unknown {
  const parts = key.split(".");
  let current: unknown = row;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object")
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyColumnFilters(
  rows: Record<string, unknown>[],
  filters: ColumnFilter[],
): Record<string, unknown>[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const cellValue = resolveKey(row, f.columnKey);

      switch (f.operator) {
        case "empty":
          return (
            cellValue === null ||
            cellValue === undefined ||
            cellValue === ""
          );
        case "not_empty":
          return (
            cellValue !== null &&
            cellValue !== undefined &&
            cellValue !== ""
          );
        case "equals":
          return (
            String(cellValue ?? "").toLowerCase() ===
            f.value.toLowerCase()
          );
        case "contains":
          return String(cellValue ?? "")
            .toLowerCase()
            .includes(f.value.toLowerCase());
        case "gt":
          return Number(cellValue) > Number(f.value);
        case "lt":
          return Number(cellValue) < Number(f.value);
        default:
          return true;
      }
    }),
  );
}
