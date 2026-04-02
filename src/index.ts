// @toolplex/app-server — Fastify plugin for serving ToolPlex App Pages

export { registerAppPages } from "./plugin.js";

export type {
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
