// ---------------------------------------------------------------------------
// Page Definition — the JSON schema that describes a page's layout and behavior
// ---------------------------------------------------------------------------

export interface PageDefinition {
  id: string;
  title: string;
  /**
   * Optional one-sentence description of what this page is for. Rendered
   * as a subtitle on the page list card so users can tell pages apart at
   * a glance without opening each one.
   */
  description?: string;
  /**
   * Optional top-level grouping label for the page list UI — e.g.
   * "Sales & Delivery", "Forecasting". When ANY page declares a section
   * the desktop groups pages by this label under small headers;
   * otherwise the list renders flat. Pages without a section are
   * rendered above the labeled groups without a header.
   */
  section?: string;
  /**
   * Optional short description of the page's section. The page list
   * renders this beneath the section header so users can read what the
   * group is for. Repeated across pages in the same section, the first
   * non-empty value wins — set it on one page per section.
   */
  section_description?: string;
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
  | StatusGridSection
  | DecisionFeedSection;

// ---------------------------------------------------------------------------
// min_desktop_version — section-level desktop version gate
//
// When set on a section, an older toolplex-desktop renders an "Update
// required" placeholder in that section's slot instead of attempting to
// render the section (which would fall through to "Unknown section type").
// Format: numeric semver "X.Y.Z" — no prerelease tags. Absent = no gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DecisionFeedSection — triage-queue surface for sequential decision-making.
//
// Mental model: email inbox. One decision = one card. Cards stacked vertically.
// The operator scrolls and clicks action buttons embedded in each card.
// After each action the feed refetches from source — the server is the
// source of truth for order (pending first, then deferred, then resolved).
// ---------------------------------------------------------------------------

export interface DecisionFeedSection {
  type: "decision-feed";
  /** Resource fetched by the desktop; handler returns { rows: DecisionCard[], total }. */
  source: string;
  /** Actions available on every card, rendered as inline buttons. */
  actions?: Action[];
  /** Shown centred when the feed is empty. */
  empty_message?: string;
  /** Grid-span, same as other sections. */
  span?: number;
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
}

/**
 * A single decision card in a DecisionFeedSection.
 *
 * The fetch handler returns these as the `rows` array (typed as
 * Record<string, unknown>[] on the wire, cast by the renderer).
 * Use `id` as the row key — it must be stable across refetches.
 */
export interface DecisionCard {
  /** Stable identifier for this decision. */
  id: string | number;
  /** Top-line heading, e.g. "Limac · Identity decision". */
  title: string;
  /** Second line, smaller, e.g. "Workflow: limac_master_dedup · 3 entries". */
  subtitle?: string;
  /** Small right-aligned chip, e.g. "₱14.2M" or "Blocking". */
  badge?: string;
  /** Chip color treatment. Default: "default". */
  badge_variant?: "default" | "success" | "warning" | "danger" | "info";
  /** The actual question posed to the operator. Rendered larger. */
  question: string;
  /** Rich evidence blocks rendered inside the card using the DetailBlock renderer. */
  evidence: DetailBlock[];
  /** Downstream consequences of the decision, rendered as a tight field list. */
  consequences?: { label: string; value: string }[];
  /** Visual treatment. "pending" is full-color; decided variants dim the card. */
  status?: "pending" | "decided_yes" | "decided_no" | "deferred";
}

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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
}

export interface CardColumnSection {
  type: "card-column";
  source: string;
  span?: number;
  title?: string;
  /** See CardRowSection.inline_rows. */
  inline_rows?: CardData[];
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
}

export interface ChartSection {
  type: "chart";
  source: string;
  chart: "line" | "bar" | "pie" | "scatter";
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
  /**
   * Optional reference markers drawn over the chart. Common uses:
   *  - vertical line at the current cutoff/today on a time series
   *  - horizontal target/threshold line
   *  - diagonal y=x line on a scatter (bias visualization)
   * Multiple lines render in declaration order.
   */
  referenceLines?: ReferenceLine[];
  /**
   * For bar charts: stack series instead of grouping side-by-side. No effect
   * on line/pie/scatter. Default: false.
   */
  stacked?: boolean;
  /**
   * Optional y-axis domain control. Pass [min, max] to clamp to fixed
   * bounds, or "fit" to auto-zoom around the data range with a small pad
   * (useful for percentage charts where values cluster in a narrow band
   * like 75-90% and would otherwise look flat at the default 0→max
   * scale). Default: Recharts auto (typically 0→max).
   */
  yDomain?: [number, number] | "fit";
  /**
   * Bar-chart orientation. Default "horizontal" = vertical bars rising from
   * the X axis (the conventional layout). Set "vertical" to flip: horizontal
   * bars extending right from the Y axis, with category names listed down
   * the left. Use "vertical" when:
   *   - Category names are long (no tilted-X-axis truncation needed)
   *   - You have many categories (more vertical room than horizontal)
   *   - The distribution is skewed and you want value labels readable
   * Has no effect on line / pie / scatter.
   */
  layout?: "horizontal" | "vertical";
  /**
   * Bar-chart inline value labels. When true, every bar segment is annotated
   * with its numeric value (formatted compactly: K/M/B). Useful for
   * skewed distributions where the tail bars are too small to read by
   * size alone. Default: false.
   */
  value_labels?: boolean;
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
}

export interface ChartSeries {
  key: string;
  label?: string;
  color?: string;
  axis?: "left" | "right"; // which Y axis (default: "left"). Use "right" for a second scale.
  /**
   * Optional confidence band for line charts. Shades the area between the
   * lower and upper row keys at each x-value. Use for forecast uncertainty
   * ("likely range"). Ignored on bar/pie/scatter.
   */
  band?: {
    lower_key: string;
    upper_key: string;
  };
}

/**
 * Reference marker drawn over a chart. At least one of x or y must be set;
 * `type: "diagonal"` ignores both and draws a y=x line (scatter only).
 */
export interface ReferenceLine {
  /** Horizontal line at this y-value. Mutually exclusive with `x` and `type: "diagonal"`. */
  y?: number;
  /** Vertical line at this x-value. Categorical x-values pass as the same
   *  string used in the data rows. */
  x?: string | number;
  /** When set to "diagonal", renders a y=x line — for scatter bias plots. */
  type?: "diagonal";
  /** Label rendered next to the line. */
  label?: string;
  /** Stroke color. Default: a neutral gray. */
  color?: string;
  /** Stroke style. Default: "dashed". */
  style?: "solid" | "dashed";
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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
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
  /** Minimum toolplex-desktop version required to render this section. See Section version gate docs. */
  min_desktop_version?: string;
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
  /**
   * Optional filter-based visibility gate. Evaluated against the page's
   * current filter values, not row data: `condition.key` is looked up in
   * the active filters and compared against `eq` / `neq`. Use this to
   * hide kind-specific columns on a multi-shape table (e.g. a Master
   * page that filters between customers and products, where each kind
   * has its own field set).
   *
   * Different from `Action.condition` which evaluates against a single
   * row. Columns are page-level so per-row evaluation doesn't make
   * sense; filter-level does.
   */
  condition?: ActionCondition;
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
  | ProgressFormat
  | CurrencyFormat
  | SparklineFormat
  | ChipFormat;

/** Localised currency. Use this object form when the simple "currency"
 *  string isn't enough — for non-USD currencies (PHP, EUR, etc.) or
 *  when you want compact notation ("₱126.9M") for cards that would
 *  otherwise clip the full digit string. Renders via Intl.NumberFormat
 *  with the given currency code; falls back to USD when omitted so
 *  client behaviour stays close to the legacy "currency" string. */
export interface CurrencyFormat {
  type: "currency";
  /** ISO 4217 currency code (e.g. "PHP", "USD", "EUR"). Default: "USD". */
  currency?: string;
  /** BCP 47 locale tag for grouping/decimal conventions (e.g. "en-PH",
   *  "de-DE"). Default: the user's browser locale. */
  locale?: string;
  /** "compact" → "₱126.9M" (short), "standard" → "₱126,899,928.31".
   *  Default: "standard". Useful on summary cards where long values
   *  get clipped by max-width. */
  notation?: "standard" | "compact";
  /** Decimal places. Default: 2 for standard, 1 for compact. */
  fractionDigits?: number;
}

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

/**
 * Inline mini line chart inside a table cell. The cell value itself is
 * ignored — the renderer reads an array of numbers from another column
 * named `values_key` on the same row. Use for at-a-glance trend signals
 * ("is this SKU's demand going up or down?") without leaving the table.
 */
export interface SparklineFormat {
  type: "sparkline";
  /** Column key on the same row containing the array of numeric values. */
  values_key: string;
  /** Stroke color. Default: theme accent. */
  color?: string;
  /** Render a faint zero/baseline reference line. Default: false. */
  baseline?: boolean;
}

/**
 * Auto-colored chip for non-semantic categoricals (department names, segment
 * codes, store clusters). The renderer hashes each distinct cell value to a
 * stable color from an internal palette so every value gets its own chip
 * without needing an explicit colors map.
 *
 * Use ChipFormat for category labels. Use StatusFormat when the color carries
 * semantic meaning (red = error, green = success).
 */
export interface ChipFormat {
  type: "chip";
  /** Optional palette name. Default: muted multi-color. */
  palette?: "default" | "soft";
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
  /**
   * Other filter keys whose values this dropdown's options depend on.
   * When any listed value changes, the desktop client re-fetches the
   * options_source with the dependency values appended as query params.
   * The resource handler reads them from its `filters` argument and
   * scopes results accordingly. Without this, a dependent dropdown
   * (e.g. a per-month version dropdown) keeps showing whatever options
   * it was first loaded with after the parent filter changes.
   *
   * Requires toolplex-desktop ≥ 1.3.8. Older clients ignore the field
   * and fall back to the previous one-shot-on-mount fetch — safe.
   */
  options_depends_on?: string[];
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
  /**
   * When true, the action's handler is expected to return a
   * FileActionResponse (or a normal response that throws). The desktop
   * skips its usual success-toast / data-refresh flow and instead
   * streams the response body as a file download. Confirmation modals
   * are bypassed for one-click downloads unless the action also
   * declares `inputs`.
   *
   * The wire format is detected per-response — handlers returning a
   * standard JSON ActionResponse still work; this flag is purely a UX
   * hint so the desktop renders the click affordance correctly.
   */
  download?: boolean;
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
   * For type="textarea" only: visible row count. Defaults to a
   * sensible body-text height; bump for code/JSON inputs where the
   * worker needs to see ~15+ lines at once. Has no effect on other
   * input types.
   */
  rows?: number;
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
  /**
   * Show this input only when the action's `context` resource returns a
   * matching value in its `FetchResponse.meta`. Evaluated client-side
   * when the modal opens, using the same shape and machinery as
   * top-level `Action.condition` — `meta[condition.key]` compared
   * against `eq` / `neq`.
   *
   * Use cases: a Changelog field that only renders for a re-publication
   * (parent_publication_id != null in context.meta); a "merge target"
   * field only when "transition type = merge"; any required input that
   * only applies to a subset of the action's scenarios.
   *
   * When `condition` is set but the action declares no `context`
   * resource, the input renders unconditionally (no meta to evaluate).
   * When the condition does not match, the input is omitted from the
   * form AND from the submitted params — handlers should not assume a
   * value will be present.
   */
  condition?: ActionCondition;
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
  /**
   * Per-input default values for an action confirmation modal that
   * loaded this resource as `action.context`. Keys match
   * `ActionInput.key`; values prefill the form fields when the modal
   * opens.
   *
   * Use this in place of an ad-hoc `meta.defaults` convention — the
   * desktop reads `inputDefaults` specifically and treats it as the
   * authoritative prefill source. Static `ActionInput.default` still
   * applies when an input's key is absent from this map.
   *
   * For required inputs that depend on row state (e.g. an edit form
   * pre-filling the entity's current values), handlers should provide
   * a non-empty default here so the modal doesn't silently render
   * required fields as empty.
   */
  inputDefaults?: Record<string, string | number | null>;
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

export interface StandardActionResponse {
  affected: number;
  message?: string;
  data?: Record<string, unknown>;  // flexible return data (e.g., download URL, generated file path)
  /**
   * When set, the desktop keeps the detail drawer open and navigates it to
   * the specified row instead of closing after a successful action. Enables
   * wizard-style sequential walkthroughs (e.g. HITL decision batches) where
   * the handler knows which row to visit next.
   *
   * `row_id` — the `rowKey` value of the next row to open in the drawer.
   * `section` — optional; reserved for future cross-section navigation.
   *             Currently ignored by the desktop (single-table pages cover
   *             the primary HITL use case), but including it in the type
   *             now avoids a wire-breaking change later.
   *
   * When absent or null, the desktop closes the drawer and refreshes the
   * table (existing behavior, unchanged).
   */
  open_next?: {
    row_id: string | number;
    section?: string;
  };
}

/**
 * Action handlers can return this shape instead of the standard JSON
 * response to stream a file to the client (browser save dialog). The
 * actions route detects the `type: "file"` tag and streams the file
 * with appropriate Content-Disposition / Content-Type headers.
 *
 * Either `path` (filesystem path on the server) or `buffer` (in-memory
 * bytes) must be provided. Use `buffer` for generated content (e.g. a
 * zip built on the fly); use `path` for existing files on disk. The
 * path is streamed via fs.createReadStream — no buffering on the
 * server side.
 *
 * Path safety: action handlers are responsible for validating the
 * path against an allowlist before returning. The route does not
 * second-guess what the handler decided was safe.
 *
 * The desktop hint is `Action.download: true` — when set, the desktop
 * skips its success-toast / data-refresh flow and triggers a file
 * save instead.
 */
export interface FileActionResponse {
  type: "file";
  /** Filesystem path on the server; streamed via fs.createReadStream. */
  path?: string;
  /** In-memory bytes; used when the file is generated dynamically. */
  buffer?: Buffer;
  /** Filename for the Content-Disposition header. Defaults to the
   *  basename of `path` when omitted. */
  filename?: string;
  /** MIME type for the Content-Type header. Defaults to
   *  application/octet-stream. */
  mimetype?: string;
}

export type ActionResponse = StandardActionResponse | FileActionResponse;

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
  | DetailImage
  | DetailChart;

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
  columns: { key: string; label: string; format?: ColumnFormat; width?: number }[];
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

/** Action button rendered next to each row of a DetailTable — or as a
 *  toolbar button above the table when `toolbar_only` is set. */
export interface DetailRowAction {
  label: string;
  action: string;
  variant?: "default" | "primary" | "success" | "danger" | "warning";
  /** Show only when the row matches the condition (client-side filter). */
  condition?: ActionCondition;
  /** When true, render in the table's toolbar instead of per-row.
   *  Used for bulk operations ("Download all (zip)", "Remove selected").
   *  Toolbar actions receive the user's row selection (or all rows if
   *  none are selected). Mirrors top-level Action.toolbar_only. */
  toolbar_only?: boolean;
  /** When true, the handler returns a file response and the desktop
   *  triggers a browser save instead of refreshing data. Mirrors
   *  top-level Action.download. See FileActionResponse. */
  download?: boolean;
}

export interface DetailImage {
  type: "image";
  label?: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * Chart inside a detail drawer. Unlike ChartSection (which fetches its own
 * source), DetailChart carries its data inline — the entire detail panel
 * is one fetch, so chart data ships in the same payload.
 *
 * Shape mirrors ChartSection: x/y series, optional reference lines, optional
 * confidence band on line series. Scatter and stacked-bar both supported.
 */
export interface DetailChart {
  type: "chart";
  /** Optional heading rendered above the chart. */
  label?: string;
  chart: "line" | "bar" | "scatter";
  x: { key: string; label?: string };
  y: ChartSeries[];
  /** Data rows — one row per x-value. Required (no source fetch). */
  rows: Record<string, unknown>[];
  /** Height in pixels. Default: 240. */
  height?: number;
  /** Reference markers (see ChartSection.referenceLines). */
  referenceLines?: ReferenceLine[];
  /** Bar-chart stacking. */
  stacked?: boolean;
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
  /** See FetchResponse.inputDefaults — mirrored through unchanged so action
   *  confirmation modals that loaded this resource as context can prefill
   *  their inputs. Without this passthrough the field is silently stripped
   *  at the wire and prefill never works. */
  inputDefaults?: Record<string, string | number | null>;
}
