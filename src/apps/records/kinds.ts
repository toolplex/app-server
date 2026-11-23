// What each kind of app knows about its own records, for the parts of the
// server that must answer before an app is running (startup checks, the page
// definitions that are served). One entry per kind; a kind without records
// has none.

import type { AppDefinition, AppKind } from "../types.js";
import { encodingRelation, encodingTables, type EncodingRecordsOptions } from "../encoding/records.js";
import { relationsOf, type Relation } from "./database.js";
import type { RecordTable } from "./types.js";

/** A page source that is a query of the client's own over the app's tables. */
export interface RecordsQueryOptions {
  /**
   * One SELECT statement over the app's tables. It is kept as a view named
   * after the resource, so it sorts, filters, pages and feeds alerts like
   * any table, and the assistant can read it by that name.
   */
  sql: string;
  /** What its rows are, in a few words, for the assistant. */
  label?: string;
}

/**
 * What a page says to pick what it reads of an app's records: one of the
 * kind's own tables (each kind has its own way of naming them; today there
 * is one kind), or a query of the client's own.
 */
export type AppRecordsOptions = EncodingRecordsOptions | RecordsQueryOptions;

export const isRecordsQuery = (options: AppRecordsOptions | undefined): options is RecordsQueryOptions =>
  !!options && typeof options === "object" && "sql" in options;

interface RecordsKind {
  tables(app: AppDefinition): RecordTable[];
  /** The table or view these options name, or why they name none. */
  relation(app: AppDefinition, options: EncodingRecordsOptions): { name: string } | { error: string };
}

const RECORD_KINDS: Partial<Record<AppKind, RecordsKind>> = {
  "document-encoding": { tables: encodingTables, relation: encodingRelation },
};

/**
 * The table or view a page's options name in this app, with its columns; or
 * why not. Only for the kind's own tables: a client's query has no columns
 * until the database has been asked what they are.
 */
export function recordRelation(app: AppDefinition, options: EncodingRecordsOptions): Relation | { error: string } {
  const kind = RECORD_KINDS[app.kind];
  if (!kind) return { error: `apps of kind "${app.kind}" have no records to read` };
  const named = kind.relation(app, options);
  if ("error" in named) return named;
  return relationsOf(kind.tables(app)).get(named.name) ?? { error: `no table "${named.name}"` };
}
