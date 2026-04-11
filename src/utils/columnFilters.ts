// Shared column filter helpers used by both /data and /download routes.
//
// Column filters arrive in query params with the convention:
//   _cf_<columnKey>__<operator>=<value>
// e.g. _cf_status__equals=pending
//
// data.ts applies them post-fetch on a single page (limitation: only filters
// the current page's rows). download.ts applies them per chunk while
// iterating the full dataset, which produces a CORRECT filtered CSV.

export interface ColumnFilter {
  columnKey: string;
  operator: "equals" | "contains" | "gt" | "lt" | "empty" | "not_empty";
  value: string;
}

export function extractColumnFilters(
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

function resolveKey(row: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = row;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object")
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function applyColumnFilters(
  rows: Record<string, unknown>[],
  filters: ColumnFilter[],
): Record<string, unknown>[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((f) => {
      const cellValue = resolveKey(row, f.columnKey);

      switch (f.operator) {
        case "empty":
          return (
            cellValue === null || cellValue === undefined || cellValue === ""
          );
        case "not_empty":
          return (
            cellValue !== null && cellValue !== undefined && cellValue !== ""
          );
        case "equals":
          return (
            String(cellValue ?? "").toLowerCase() === f.value.toLowerCase()
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
