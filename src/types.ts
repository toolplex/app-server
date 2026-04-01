// ---------------------------------------------------------------------------
// Page Definition — the JSON schema that describes a page's layout and behavior
// ---------------------------------------------------------------------------

export interface PageDefinition {
  id: string;
  title: string;
  filters?: Filter[];
  actions?: Action[];
  suggestions?: string[];
  sections: (Section | Section[])[];
  context?: PageContextHandler;
}

export type Section = CardRowSection | CardColumnSection | TableSection;

export interface CardRowSection {
  type: "card-row";
  source: string;
  span?: number;
}

export interface CardColumnSection {
  type: "card-column";
  source: string;
  span?: number;
}

export interface TableSection {
  type: "table";
  source: string;
  rowKey: string;
  columns: Column[];
  span?: number;
  detail?: {
    source: string; // resource fetched when a row is clicked, rendered as a detail drawer
  };
}

export interface Column {
  key: string;
  label: string;
  format?: "text" | "integer" | "number" | "percent" | "currency" | "date";
  width?: number;
}

export interface Filter {
  key: string;
  type: "dropdown" | "text" | "date";
  label?: string;
  options?: string[];
  options_source?: string;
  default?: string;
}

export interface Action {
  label: string;
  action: string;
  params?: Record<string, unknown>;
  confirm?: string;
  placement?: "toolbar" | "inline"; // default: "toolbar"
  // toolbar: button in the toolbar above the table, operates on checkbox-selected rows
  //   - selection_required: true → disabled until rows are selected
  //   - selection_required: false → global action (e.g. "Export CSV", "Refresh")
  // inline: button rendered on each table row, fires with that single row's ID
  selection_required?: boolean;
}

// ---------------------------------------------------------------------------
// Handler contracts — the interfaces developers implement
// ---------------------------------------------------------------------------

export interface FetchRequest {
  page: number;
  pageSize: number;
  sort?: SortSpec;
  filters?: Record<string, string>;
  selection?: Selection;
}

export interface FetchResponse {
  rows: Record<string, unknown>[];
  total: number;
}

export interface ActionRequest {
  ids: (string | number)[];       // selected row IDs (empty array for global actions)
  params: Record<string, unknown>; // static params from page def + dynamic params from caller
  filters: Record<string, string>; // current page filters (useful for "export current view")
}

export interface ActionResponse {
  affected: number;
  message?: string;
  data?: Record<string, unknown>;  // flexible return data (e.g., download URL, generated file path)
}

export interface ContextRequest {
  filters?: Record<string, string>;
  selection?: Selection;
}

export interface ContextResponse {
  summary: string;
  selection?: string;
  suggestions?: string[];
}

export interface PageContextRequest extends ContextRequest {
  sections: string[];
}

// ---------------------------------------------------------------------------
// Handler function types
// ---------------------------------------------------------------------------

export type FetchHandler = (req: FetchRequest) => Promise<FetchResponse>;
export type ActionHandler = (req: ActionRequest) => Promise<ActionResponse>;
export type ContextHandler = (req: ContextRequest) => Promise<ContextResponse>;
export type PageContextHandler = (
  req: PageContextRequest,
) => Promise<ContextResponse>;

// ---------------------------------------------------------------------------
// Resource definition — a data source with a fetch handler and optional context
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  fetch: FetchHandler;
  context?: ContextHandler;
}

// ---------------------------------------------------------------------------
// Plugin configuration — what the developer passes to registerAppPages
// ---------------------------------------------------------------------------

export interface AppServerConfig {
  authToken: string;
  pages: Record<string, Omit<PageDefinition, "id">>;
  resources: Record<string, ResourceDefinition>;
  actions: Record<string, ActionHandler>;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface SortSpec {
  key: string;
  direction: "asc" | "desc";
}

export interface Selection {
  type: "row" | "rows";
  ids?: (string | number)[];
}

// ---------------------------------------------------------------------------
// Card data — the expected row shape for card-row and card-column sections
// ---------------------------------------------------------------------------

/**
 * Card resources use the same FetchHandler as tables, but each row
 * should match this shape. The renderer reads these fields to display
 * metric cards.
 *
 * Example:
 *   { label: "Open Issues", value: 45, format: "integer" }
 *   { label: "Completion", value: 0.71, format: "percent" }
 *   { label: "Revenue", value: 12500, format: "currency" }
 */
export interface CardData {
  label: string;
  value: number | string;
  format?: "text" | "integer" | "number" | "percent" | "currency" | "date";
}

// ---------------------------------------------------------------------------
// Detail block types — the expected row shapes for detail drawer resources
// ---------------------------------------------------------------------------

/**
 * Detail resources use the same FetchHandler, but each row should be a
 * typed block. The drawer renderer uses the `type` field to pick the
 * right component for each block.
 *
 * Example response from a detail fetch handler:
 *   rows: [
 *     { type: "header", value: "Issue #1705: Unmatched Customer" },
 *     { type: "field", label: "Raw Name", value: "ACJDM SALES CORP." },
 *     { type: "field", label: "Confidence", value: 0.92, format: "percent" },
 *     { type: "list", label: "Candidate Matches", items: [
 *       { label: "ACJDM Sales Corporation", value: 0.92, format: "percent", id: "c_441" },
 *       { label: "ACJDM Trading", value: 0.78, format: "percent", id: "c_209" },
 *     ]},
 *     { type: "table", label: "Sample Transactions", columns: [...], rows: [...] },
 *   ]
 */
export type DetailBlock =
  | DetailHeader
  | DetailField
  | DetailList
  | DetailTable;

export interface DetailHeader {
  type: "header";
  value: string;
}

export interface DetailField {
  type: "field";
  label: string;
  value: string | number | boolean | null;
  format?: "text" | "integer" | "number" | "percent" | "currency" | "date";
}

export interface DetailList {
  type: "list";
  label: string;
  items: {
    label: string;
    value?: string | number;
    format?: "text" | "integer" | "number" | "percent" | "currency" | "date";
    id?: string | number;
  }[];
}

export interface DetailTable {
  type: "table";
  label: string;
  columns: { key: string; label: string; format?: Column["format"] }[];
  rows: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Wrapped fetch response — what the API returns to the caller
// ---------------------------------------------------------------------------

export interface PaginatedResponse {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
