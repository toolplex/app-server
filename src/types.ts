// ---------------------------------------------------------------------------
// Page Definition — the JSON schema that describes a page's layout and behavior
// ---------------------------------------------------------------------------

export interface PageDefinition {
  id: string;
  title: string;
  /**
   * Optional top-level grouping label for the page list UI — e.g.
   * "Sales & Delivery", "Forecasting". When ANY page declares a section
   * the desktop groups pages by this label under small headers;
   * otherwise the list renders flat. Pages without a section are
   * rendered above the labeled groups without a header.
   */
  section?: string;
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
  axis?: "left" | "right"; // which Y axis (default: "left"). Use "right" for a second scale.
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
  /**
   * Optional human-friendly explanation of the column. Surfaced as a hover
   * tooltip on the column header — useful for cryptic ERP-derived names
   * like `mdco_r` or `served_knitt_out_packs` where the label alone isn't
   * self-explanatory.
   */
  description?: string;
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
  /**
   * - dropdown / text / date — standard single-value controls
   * - month-range — pair of month dropdowns for an inclusive [from, to]
   *   range. Dispatches `<key>_from` and `<key>_to` as separate filter
   *   keys; the resource handler is responsible for translating them.
   *   For text-month columns ("April 2026"), use a TO_DATE BETWEEN.
   */
  type: "dropdown" | "text" | "date" | "month-range";
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

/**
 * Per-column filter from the in-table column header UI.
 *
 * Wire format: query params with the convention `_cf_<columnKey>__<operator>=<value>`.
 * Example: `_cf_status__equals=pending`. The framework parses these out of
 * the query string and passes them to the handler as `columnFilters`; they
 * NO LONGER appear in `filters` (which is reserved for top-of-page filters).
 *
 * Handlers MUST translate these to their data layer's filter mechanism (SQL
 * WHERE clause, in-memory filter, etc.) and return correctly filtered rows
 * AND a correct `total`. The framework does not post-filter.
 *
 * For in-memory data sources, the `applyColumnFilters` helper is exported
 * from `@toolplex/app-server` and can be applied BEFORE pagination.
 */
export interface ColumnFilter {
  columnKey: string;
  operator: "equals" | "contains" | "gt" | "lt" | "empty" | "not_empty";
  value: string;
}

export interface FetchRequest {
  page: number;
  pageSize: number;
  sort?: SortSpec;
  /** Top-of-page filters (FilterBar dropdowns/text/date inputs). */
  filters?: Record<string, string>;
  /** In-table column filters from per-column header UI. See ColumnFilter. */
  columnFilters?: ColumnFilter[];
  selection?: Selection;
  /**
   * Framework hint that the handler MAY skip computing the total row count
   * (e.g. SELECT COUNT(*)). Set by the /download route on chunks past the
   * first — once the framework knows the total from chunk 1, subsequent
   * chunks don't need it. Handlers that don't have a cheap row source can
   * use this to skip a full COUNT(*) query and return total: 0.
   *
   * Handlers may ignore this and always count if their data source makes
   * counting effectively free.
   */
  skipTotal?: boolean;
  /**
   * Opaque cursor token from a prior response's `nextCursor`. Set by the
   * /download route to advance through results via keyset pagination
   * instead of OFFSET, which is O(N) on the offset position. Handlers
   * that support cursor pagination should decode this token and use it
   * to seek directly to the next chunk.
   *
   * Handlers that don't support cursors should ignore this field. The
   * framework only enters cursor mode if the handler advertises support
   * by returning a `nextCursor` on the FIRST chunk's response.
   */
  cursor?: string;
}

export interface FetchResponse {
  rows: Record<string, unknown>[];
  total: number;
  /**
   * Opaque cursor token that the framework can pass back as `cursor` on
   * the next FetchRequest to continue keyset pagination. When present,
   * the framework MAY switch to cursor mode for subsequent calls (used by
   * the /download route to avoid OFFSET cost on large exports).
   *
   * - Return a non-null string if there are more rows to fetch.
   * - Return null (or omit the field, then return undefined) when there
   *   are no more rows.
   * - Don't include this field at all if your handler doesn't support
   *   cursor pagination — the framework falls back to page-based loops.
   */
  nextCursor?: string | null;
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
  /** In-table column filters (mirrors FetchRequest.columnFilters). */
  columnFilters?: ColumnFilter[];
  selection?: Selection;
}

export interface ContextResponse {
  summary: string;
  selection?: string;
  suggestions?: string[];
  /**
   * Optional ISO timestamp of the latest data sync that backs this page.
   * The desktop renders this as a "Synced Xh ago" pill in the page header
   * so analysts know how fresh the numbers are at a glance.
   */
  lastSync?: string;
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
