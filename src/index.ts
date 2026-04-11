// @toolplex/app-server — Fastify plugin for serving ToolPlex App Pages

export { registerAppPages } from "./plugin.js";

// In-memory column filter helper for handlers that work with JS arrays
// (dev/demo data sources). DB-backed handlers should translate
// req.columnFilters into their query layer's WHERE clause instead.
export { applyColumnFilters } from "./utils/columnFilters.js";

export type {
  ColumnFilter,
  // Plugin config
  AppServerConfig,
  ResourceDefinition,

  // Page definition
  PageDefinition,
  Section,
  CardRowSection,
  CardColumnSection,
  TableSection,
  Column,
  Filter,
  Action,

  // Column formatting
  ColumnFormat,
  SimpleFormat,
  RichFormat,
  StatusFormat,
  DeltaFormat,
  LinkFormat,
  ImageFormat,
  ProgressFormat,

  // Handler contracts
  FetchRequest,
  FetchResponse,
  ActionRequest,
  ActionResponse,
  ContextRequest,
  ContextResponse,
  PageContextRequest,
  PaginatedResponse,

  // Row shape conventions
  CardData,
  DetailBlock,
  DetailHeader,
  DetailField,
  DetailList,
  DetailTable,
  DetailImage,

  // Handler function types
  FetchHandler,
  ActionHandler,
  ContextHandler,
  PageContextHandler,

  // Shared primitives
  SortSpec,
  Selection,
} from "./types.js";
