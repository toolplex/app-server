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

  // Handler contracts
  FetchRequest,
  FetchResponse,
  ActionRequest,
  ActionResponse,
  ContextRequest,
  ContextResponse,
  PageContextRequest,
  CardData,
  DetailBlock,
  DetailHeader,
  DetailField,
  DetailList,
  DetailTable,
  PaginatedResponse,

  // Handler function types
  FetchHandler,
  ActionHandler,
  ContextHandler,
  PageContextHandler,

  // Shared primitives
  SortSpec,
  Selection,
} from "./types.js";
