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

export type Section = CardRowSection | CardColumnSection | TableSection | ChartSection;

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

export interface ChartSection {
  type: "chart";
  source: string;
  chart: "line" | "bar" | "pie";
  title?: string;
  x: { key: string; label?: string };
  y: ChartSeries[];
  controls?: ChartControl[]; // pill-tab controls rendered in chart header
  span?: number;
  height?: number; // px, default 280
}

export interface ChartSeries {
  key: string;
  label?: string;
  color?: string;
}

/** Compact tab control on a chart — selected value passed as a filter to the fetch handler */
export interface ChartControl {
  key: string;
  label?: string;
  options: string[];
  default?: string;
}

export interface TableSection {
  type: "table";
  source: string;
  rowKey: string;
  columns: Column[];
  actions?: Action[];  // table/row-level actions (inline per-row + toolbar when selected)
  span?: number;
  downloadable?: boolean; // allow CSV export of full dataset (default: false)
  detail?: {
    source: string; // resource fetched when a row is clicked, rendered as a detail drawer
  };
}

export interface Column {
  key: string;
  label: string;
  format?: ColumnFormat;
  width?: number;
}

// ---------------------------------------------------------------------------
// Column formatting — string shorthands for simple cases, objects for rich
// ---------------------------------------------------------------------------

export type ColumnFormat = SimpleFormat | RichFormat;

/** String shorthands — cover 90% of columns */
export type SimpleFormat =
  | "text"       // String(value) — default
  | "integer"    // toLocaleString, no decimals
  | "number"     // toLocaleString with decimals
  | "percent"    // (value * 100).toFixed(1) + "%"
  | "currency"   // "$" + toLocaleString
  | "date"       // date string formatting
  | "boolean";   // ✓ / ✗

/** Object format — richer visual treatment */
export type RichFormat =
  | StatusFormat
  | DeltaFormat
  | LinkFormat
  | ImageFormat
  | ProgressFormat;

/** Colored badge — maps cell values to colors */
export interface StatusFormat {
  type: "status";
  colors?: Record<string, string>; // e.g. { approved: "green", pending: "yellow", rejected: "red" }
  // If omitted, renderer uses sensible defaults for common values
}

/** Signed delta — green positive, red negative */
export interface DeltaFormat {
  type: "delta";
  format?: "number" | "percent"; // how to format the numeric value (default: "number")
}

/** Clickable URL */
export interface LinkFormat {
  type: "link";
  label?: string; // static label text; if omitted, shows the URL value
}

/** Inline thumbnail */
export interface ImageFormat {
  type: "image";
  width?: number;  // default: 32
  height?: number; // default: 32
}

/** Progress bar for 0–1 values */
export interface ProgressFormat {
  type: "progress";
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
  variant?: "default" | "primary" | "success" | "danger" | "warning";
  bulk?: boolean;              // appear in toolbar for multi-select? (default: true)
  toolbar_only?: boolean;      // hide inline, show only in toolbar (default: false)
  condition?: ActionCondition; // show only when row matches (client-side, per-row for inline)
  inputs?: ActionInput[];      // dynamic inputs collected in confirmation modal
  params?: Record<string, unknown>;
  context?: { source: string };  // resource fetched when modal opens, returns DetailBlock[]
}

/** Show/hide an action based on a row value. Evaluated client-side. */
export interface ActionCondition {
  key: string;               // column key to check
  eq?: unknown;              // show when value === eq
  neq?: unknown;             // show when value !== neq
}

export interface ActionInput {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  options?: string[];
  default?: string | number;
  required?: boolean;          // default: true
  placeholder?: string;
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
  format?: ColumnFormat;
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
  | DetailTable
  | DetailImage;

export interface DetailHeader {
  type: "header";
  value: string;
}

export interface DetailField {
  type: "field";
  label: string;
  value: string | number | boolean | null;
  format?: ColumnFormat;
}

export interface DetailList {
  type: "list";
  label: string;
  items: {
    label: string;
    value?: string | number;
    format?: ColumnFormat;
    id?: string | number;
  }[];
}

export interface DetailTable {
  type: "table";
  label: string;
  columns: { key: string; label: string; format?: ColumnFormat }[];
  rows: Record<string, unknown>[];
}

export interface DetailImage {
  type: "image";
  label?: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
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
