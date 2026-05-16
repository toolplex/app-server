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

export type Section =
  | CardRowSection
  | CardColumnSection
  | TableSection
  | ChartSection
  | SectionGroup
  | LinkToPageSection
  | TopNSection
  | StatusGridSection;

export interface CardRowSection {
  type: "card-row";
  source: string;
  span?: number;
  /** Small heading rendered above the section. Use for self-describing
   *  groups of cards (e.g. "Reconciliation"); leave undefined when the
   *  card labels themselves already make the section's purpose obvious. */
  title?: string;
  /**
   * When present, render these CardData rows directly without fetching
   * from `source`. Useful for static or pre-baked data — notably
   * agent-generated dashboards where the values are baked into the spec.
   * The `source` string is still used as a stable identifier for
   * selection / ask-agent flows even when data is inline.
   */
  inline_rows?: CardData[];
}

export interface CardColumnSection {
  type: "card-column";
  source: string;
  span?: number;
  title?: string;
  /** See CardRowSection.inline_rows. */
  inline_rows?: CardData[];
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
  /**
   * When present, render the chart from these rows directly (one row per
   * X-axis point, with each Y series read by `y[].key`) without fetching
   * from `source`. See CardRowSection.inline_rows for rationale.
   */
  inline_data?: Record<string, unknown>[];
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
  /** Small heading rendered above the table. Useful when a page has
   *  multiple tables and "what is this listing?" isn't obvious from
   *  the columns alone (e.g. "Distributors" vs "Files this month"). */
  title?: string;
  /**
   * When present, render these rows directly without fetching from
   * `source`. See CardRowSection.inline_rows for rationale. Static
   * tables (config, glossary, agent-baked dashboards) can ship the
   * data inline rather than wiring a fetch handler.
   */
  inline_rows?: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// SectionGroup — labeled group of nested sections.
//
// Allows hierarchical organization of a page: a group has a label
// (rendered as a heading) and contains its own sections. Used by
// Pulse to encode slot semantics ("Now" / "Watch" / "Recent"), but
// equally applicable to any hand-authored page that wants
// sub-organization (e.g. forecast-accuracy grouped by region).
//
// Recursive: groups can contain groups. The renderer flattens visual
// depth — there's no extra indentation past the first nesting level.
// ---------------------------------------------------------------------------

export interface SectionGroup {
  type: "group";
  /** Heading displayed above the group's sections. */
  label: string;
  /** Optional smaller subtitle under the label. */
  subtitle?: string;
  /** Sections within this group. Same shape as PageDefinition.sections. */
  sections: (Section | Section[])[];
  span?: number;
}

// ---------------------------------------------------------------------------
// LinkToPageSection — CTA card that navigates to another Page.
//
// Use when the best surface for an item is a richer Page elsewhere
// in the app — render a CTA on the source page that opens the target
// Page with filters and (optionally) a row pre-selected.
// ---------------------------------------------------------------------------

export interface LinkToPageSection {
  type: "link-to-page";
  /** Stable identifier — used for selection. Even when the section has
   *  no data resource, callers may want to select / ask-agent about it. */
  source: string;
  /** Required for visual hierarchy. */
  title: string;
  /** Description rendered above the CTA. */
  description?: string;
  /** Optional preview metric. Makes the card more substantive than a
   *  bare button — useful when the metric *is* the reason to drill in. */
  preview?: {
    label: string;
    value: number | string;
    format?: ColumnFormat;
  };
  /** Where the CTA navigates to. */
  link: PageLink;
  /** Button text. Default: "Open". */
  cta_label?: string;
  span?: number;
}

// ---------------------------------------------------------------------------
// TopNSection — ranked list with values.
//
// Use for "top 5 by metric X" / "biggest contributors" / "worst
// offenders". Each item carries an optional drill-in link.
// ---------------------------------------------------------------------------

export interface TopNSection {
  type: "top-n";
  source: string;
  title?: string;
  /** Inline data path: when present, render directly. */
  inline_items?: TopNItem[];
  /** Format applied to item values when item.format is unset. */
  default_format?: ColumnFormat;
  /** Maximum items to render. Default 5. */
  max_items?: number;
  span?: number;
}

export interface TopNItem {
  label: string;
  value: number | string;
  format?: ColumnFormat;
  /** Smaller secondary text below the label. */
  sublabel?: string;
  /** Optional drill-in when this item is clicked. */
  link?: PageLink;
}

// ---------------------------------------------------------------------------
// StatusGridSection — colored cells for "health at a glance" views.
// ---------------------------------------------------------------------------

export interface StatusGridSection {
  type: "status-grid";
  source: string;
  title?: string;
  /** Inline data path: when present, render directly. */
  inline_cells?: StatusCell[];
  /** Number of columns. Renderer picks a sensible default based on
   *  cell count when omitted. */
  columns?: number;
  /** Legend entries rendered below the grid. */
  legend?: { color: StatusColor; label: string }[];
  span?: number;
}

export interface StatusCell {
  label: string;
  status: StatusColor;
  value?: string | number;
  tooltip?: string;
  link?: PageLink;
}

export type StatusColor = "green" | "yellow" | "red" | "gray" | "blue";

// ---------------------------------------------------------------------------
// PageLink — reference to another Page in app-server.
//
// Used by LinkToPageSection's CTA and by drill-in links on
// TopNItem / StatusCell. The desktop's PageRenderer translates these
// into navigation events to the target page with filters/selection
// pre-applied.
// ---------------------------------------------------------------------------

export interface PageLink {
  /** Page id (matches PageDefinition.id of the target). */
  page_id: string;
  /** Filter values keyed by the target page's filter keys. */
  filters?: Record<string, string>;
  /** Optional row id to pre-select when the target Page opens. */
  selected_row_id?: string;
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
  /**
   * When true, the filter is treated as always-having-a-value:
   *   - The "All" / empty placeholder is omitted from the dropdown
   *   - "Clear filters" leaves this filter untouched
   * Pair with `default` so the filter has a meaningful initial value.
   * Useful for filters that scope an entire workflow (e.g. month picker
   * on a receive page where "All months" makes no sense).
   */
  required?: boolean;
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
  type: "text" | "textarea" | "number" | "select" | "file";
  options?: string[];
  default?: string | number;
  required?: boolean;          // default: true
  placeholder?: string;
  /**
   * For type="file" only: when true, the picker accepts multiple files
   * and the action handler receives an array under files[key].
   * (For single-file inputs, the array still has one entry.)
   */
  multiple?: boolean;
  /**
   * For type="file" only: comma-separated MIME patterns or extensions
   * the file picker accepts (e.g. ".xlsx,.xls,application/pdf").
   * Passed through to the desktop's <input type="file" accept="...">.
   */
  accept?: string;
}

/**
 * A single uploaded file attached to an action invocation. Created by
 * the multipart parser when an action declares `type: "file"` inputs.
 *
 * The buffer is held in memory; for large uploads (>~25 MB) handlers
 * should write it to disk and process from there. Action handlers must
 * not retain the buffer across the response — the server clears it
 * after the action completes.
 */
export interface UploadedFile {
  filename: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
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

/**
 * The signed-in user behind the current request, as attested by the
 * upstream proxy (toolplex-api) via X-Toolplex-User-* headers.
 *
 * The app-server does NOT independently verify identity — the connection-
 * level bearer token already proves "this is toolplex-api talking," and
 * toolplex-api is the identity authority (Firebase-backed). The user
 * fields here are trusted as far as the proxy is trusted.
 *
 * Always optional — system / scheduled actions and direct ops-tooling
 * calls won't have a user. Handlers that require attribution must check
 * and refuse rather than fall back to a default.
 */
export interface UserIdentity {
  /** Stable internal user id (toolplex-side primary key). */
  id: string;
  /** User's email — what worker-facing UIs render and audit logs store. */
  email: string;
  /** Org id the user is signed in under. Useful for handlers that
   *  multiplex across orgs on a shared app-server deployment. */
  orgId?: string;
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
  /** Signed-in user identity from the proxy. See UserIdentity. */
  user?: UserIdentity;
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
  /**
   * Optional out-of-band signals attached to a resource response. Read by
   * surfaces that load this resource as context (e.g. an action modal's
   * informational context source) to make the surface react beyond just
   * rendering rows.
   *
   * Currently honored:
   *   - `actionAllowed` (boolean) — when false, an action modal that loaded
   *     this resource as `action.context` disables its Confirm button. Use
   *     for "show the worker why they can't submit yet" preview UX.
   *   - `actionDisabledReason` (string) — short hint rendered next to the
   *     disabled Confirm; defaults to a generic message when omitted.
   *
   * Other keys are ignored by the framework but flow through to clients,
   * so you can extend ad-hoc without a schema bump.
   */
  meta?: Record<string, unknown>;
}

export interface ActionRequest {
  ids: (string | number)[];       // selected row IDs (empty array for global actions)
  params: Record<string, unknown>; // static params from page def + dynamic params from caller
  filters: Record<string, string>; // current page filters (useful for "export current view")
  /**
   * Files uploaded by the caller, keyed by ActionInput.key. Present only
   * when the action declares one or more `type: "file"` inputs and the
   * request was sent as `multipart/form-data`. For single-file inputs the
   * array still has one entry. Absent for JSON-only actions.
   */
  files?: Record<string, UploadedFile[]>;
  /** Signed-in user identity from the proxy. See UserIdentity. */
  user?: UserIdentity;
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
  /** Signed-in user identity from the proxy. See UserIdentity. */
  user?: UserIdentity;
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
  /**
   * Optional staleness thresholds for the freshness pill, expressed in
   * hours since `lastSync`. Lets each page tune the warning/critical
   * cutoffs to its own update cadence (a daily-sync table should warn
   * sooner than a weekly forecast). Backwards-compatible: when omitted,
   * the desktop falls back to its built-in defaults (currently amber at
   * 2 days). Optional `criticalMessage` is rendered next to the pill in
   * the critical state — meant for "page outdated, contact your admin"
   * style hints when self-recovery is unlikely.
   */
  freshness?: {
    warningAfterHours?: number;
    criticalAfterHours?: number;
    criticalMessage?: string;
  };
  /**
   * Optional state surface for page-level Action.condition.
   *
   * The same `condition: { key, eq, neq }` shape that gates inline row
   * actions against row data also gates toolbar (page-level) actions —
   * those evaluate against `data[key]` from this object. Use for
   * stage-aware actions ("Advance" only when stage='receive'),
   * mode-aware actions ("Lock" only when mode='editing'), or any
   * page-state gating that doesn't belong on a specific row.
   *
   * The desktop refetches the page context after every successful
   * action, so a state-changing action automatically flips toolbar
   * visibility on the next render — no manual refresh needed.
   *
   * Backwards-compatible: omit when the page has no state to gate by;
   * toolbar actions without `condition` continue to show unconditionally.
   */
  data?: Record<string, unknown>;
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
  /**
   * Optional human-friendly explanation of the metric. Surfaced as an
   * info-icon tooltip on the card — useful for non-obvious metrics
   * where the label alone isn't self-explanatory.
   */
  description?: string;
  /**
   * Optional severity. When set, the card renders a left-edge stripe
   * and a severity badge. Use for cards that demand attention vs. cards
   * that just report a value.
   *
   *   - "critical": acute issue, threshold breached, immediate action
   *   - "warning":  notable, worth investigating soon
   *   - "info":     advisory, not urgent
   */
  severity?: "info" | "warning" | "critical";
  /**
   * Optional threshold context. Rendered inline near the value to make
   * the severity claim concrete: "12.5% — threshold: >5%".
   */
  threshold?: {
    operator: ">" | "<" | ">=" | "<=";
    value: number;
    /** Optional human-readable description; if absent, renderer composes
     *  one from operator + value. */
    description?: string;
  };
  /** Optional baseline context, e.g. "Normal: 1-2% typical". */
  normal_range?: string;
  /**
   * Optional period-over-period delta. Rendered as a colored badge.
   * Useful for both reporting cards (week-over-week revenue) and
   * anomaly cards (current vs. previous period).
   */
  delta?: {
    value: number;
    format?: ColumnFormat;
    /**
     * Which direction is "good" for this metric. Drives delta color:
     *   - "up":      positive is green, negative is red
     *   - "down":    negative is green, positive is red (e.g. defect rate)
     *   - "neutral": no color applied
     */
    direction_good: "up" | "down" | "neutral";
    /** Optional comparison context, e.g. "vs last week". */
    comparison?: string;
  };
  /**
   * Optional drill-in link. When present, the card becomes a button
   * that navigates to the target Page.
   */
  link?: PageLink;
  /**
   * Optional one-line reasoning from an agent. Surfaces a small "(i)"
   * tooltip explaining why this card is being shown. Used by
   * agent-generated pages (Pulse) but available to any card.
   */
  reasoning?: string;
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
  /**
   * Optional row-level actions. When present, each row gets the actions
   * rendered as buttons in a trailing column; clicking fires the action
   * with `ids: [row[rowKey]]`. Mirrors TableSection's row-action shape
   * for consistency. Use this for in-drawer per-row mutations like
   * "remove this file" or "approve this entry" without leaving the
   * distributor's context.
   */
  rowKey?: string;
  actions?: DetailRowAction[];
}

/** Action button rendered next to each row of a DetailTable. */
export interface DetailRowAction {
  label: string;
  action: string;
  variant?: "default" | "primary" | "success" | "danger" | "warning";
  /** Show only when the row matches the condition (client-side filter). */
  condition?: ActionCondition;
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
  /** See FetchResponse.meta — mirrored through unchanged for clients. */
  meta?: Record<string, unknown>;
}
