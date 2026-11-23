// ---------------------------------------------------------------------------
// App records as data — the shapes shared by every kind of app.
//
// Two kinds of data live on a client's server, with opposite rules.
//
//   Copied data (most of what pages show) has its truth somewhere else. It
//   can be dropped and rebuilt, so it is.
//
//   App records are born here. Nothing else holds them. They live in the
//   app's own store, written only by the app, under its permissions.
//
// A record store is the wrong shape for questions ("total received this
// month"), so beside it the server keeps a QUERY DATABASE: ordinary tables,
// built from the records, thrown away and rebuilt from them whenever that is
// easier than changing it in place. Pages, alerts and the assistant read the
// tables. Nothing ever writes to them except the code that builds them from
// the records, so the two cannot disagree for longer than one write.
//
// A kind says what its tables are, what one record contributes to them, and
// when a record's contribution last changed. Everything else (keeping the
// database, answering a page, running a query, handing changes to a copy) is
// the same for every kind and lives in this folder.
//
// The database is held in memory and built from the records every time the
// server starts. Nothing about it is kept from one run to the next, so there
// is nothing that can go stale, be damaged, or be changed behind the records'
// back: what it holds is always what the records said when it was built, plus
// every change since.
// ---------------------------------------------------------------------------

/** How a column is stored, and so how it sorts, filters and adds up. */
export type RecordColumnType = "text" | "number" | "integer" | "boolean" | "timestamp" | "date";

export interface RecordColumn {
  /** The column's name in SQL and its key in a row. */
  name: string;
  type: RecordColumnType;
  /** What a person would call it. */
  label: string;
  /** Kept by the platform about the record itself; not one of the client's own fields. */
  system?: boolean;
  /**
   * Whether a page's search box looks in it. Default: the client's own
   * columns are searched and the platform's are not; a kind turns it on for
   * the few of its own columns a person would search by (a file name).
   */
  searchable?: boolean;
}

/**
 * One table of a kind's records.
 *
 * Every table has a text column `record_id`: the id of the record a row came
 * from. It is what rows are replaced and removed by, what joins a line to
 * its record, and what a client opens the app at.
 */
export interface RecordTable {
  /** SQL name. Lower case letters, digits and underscores. */
  name: string;
  /** What its rows are, in a few words, for the assistant. */
  label: string;
  /** One row per record, or one row per line of a record. */
  grain: "record" | "line";
  /** The column that identifies a row. */
  key: string;
  columns: RecordColumn[];
  /** For a line table: the record table each line belongs to. */
  parent?: string;
  /**
   * The columns that put rows in their natural order (a record's lines as
   * they were written). Rows that tie on what a page sorts by come out in
   * this order. Default: the key.
   */
  order?: string[];
  /** How rows are ordered when a page asks for no order. Default: `order`. */
  defaultSort?: { column: string; direction: "asc" | "desc" };
}

export type RecordValue = string | number | boolean | null;
export type RecordRow = Record<string, RecordValue>;

/**
 * What one record contributes to the tables, as of now.
 *
 * `signature` identifies the contribution: the same record with the same
 * signature would produce the same rows, so nothing needs writing. An empty
 * signature means the record contributes nothing (never counted, withdrawn).
 */
export interface RecordProjection {
  id: string;
  signature: string;
  /** Rows by table name. A table not named gets none from this record. */
  rows: Record<string, RecordRow[]>;
  /**
   * What the record holds that no column shows: a value under a key its form
   * no longer has, lines of a table that is gone. Each entry names one such
   * place. Nothing is lost (the record still holds it), but nothing shows it
   * either, so it is counted and said at startup.
   */
  unplaced?: string[];
}

/** One change to what a record contributes. Each record appears once, as it stands now. */
export interface RecordChangeStamp {
  /** Larger for every later change. Not consecutive. */
  seq: number;
  at: string;
  id: string;
  /** The record no longer contributes anything (it was withdrawn after it had counted). */
  removed: boolean;
}

/** What a kind supplies so its records can be kept as tables and copied elsewhere. */
export interface RecordsSource {
  /** The tables, worked out from the app's configuration. */
  tables: RecordTable[];
  /**
   * Changes whenever a record might contribute different rows than before
   * for a reason that is not in the record itself and not in the shape of
   * the tables (a field said what it used to be called). A copy made under
   * another value starts again.
   */
  version: string;
  /** What the tables hold and when a record counts, in a sentence or two, for the assistant. */
  about: string;
  /** What one row of a record table is called when rows are counted for a person. */
  noun: { one: string; many: string };
  /** An id kept with the records for as long as they exist. A different id means a different set of records. */
  identity(): string;
  /** Every record that contributes, with the signature of its contribution, without opening one. */
  expected(): { id: string; signature: string }[] | Promise<{ id: string; signature: string }[]>;
  /** One record's signature as of now, without opening it. Empty when it contributes nothing. */
  signature(id: string): string;
  /** One record's contribution, read from the record itself. Null when the record no longer exists. */
  project(id: string): Promise<RecordProjection | null>;
  /** When what the records contribute last changed. */
  changedAt(): string;
  /** Changes after a place in the list (from the beginning when null), oldest first, at most `limit`. */
  changes(after: ChangePoint | null, limit: number): RecordChangeStamp[];
  /** Where the records stand now, to be handed back with the next request. */
  mark(): ChangeMark;
  /**
   * Whether someone told the changes up to `mark` can carry on from there.
   * Not after the records were put back from an older copy: what they were
   * told since that copy was taken no longer holds, wherever in the list
   * they had got to.
   */
  continues(mark: ChangeMark): boolean;
}

/** A place in the list of changes: the last change that was handed out. */
export interface ChangePoint {
  seq: number;
  id: string;
}

/** Where a set of records stood when changes were last handed out (see the store's `mark`). */
export interface ChangeMark {
  run: string;
  high: number;
}

/** The prefixes only the platform's own columns may use; a client's field can never be named like one. */
export const RESERVED_COLUMN_PREFIXES = ["record_", "line_"] as const;
/** A name a client's field or form may use: it becomes a column or table name as it is. */
export const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
/**
 * What a page sends beside its filters. A column named like one of these
 * could never be filtered: `?page=3` is the third page, not a value.
 */
export const REQUEST_KEYS = ["page", "sort", "selection", "columns", "q"] as const;

/**
 * Words the query language keeps for itself. A table or column named like
 * one has to be quoted in every query anyone writes, by hand or by the
 * assistant, for as long as it exists; so none may be. (Every keyword DuckDB
 * will not take unquoted as a table or column name; a test asks the engine
 * about each of its keywords and compares.)
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create default deferrable desc describe " +
    "distinct do else end except false fetch for foreign from group having in initially intersect into lambda lateral leading limit not null offset " +
    "on only or order pivot pivot_longer pivot_wider placing primary qualify references returning select show some summarize symmetric table then to " +
    "trailing true union unique unpivot using variadic when where window with " +
    // Not reserved outright, but not usable as a bare name either.
    "anti asof at authorization binary by collation concurrently cross freeze full glob ilike inner is isnull join left like natural notnull outer " +
    "overlaps positional right semi similar tablesample unpack verbose"
  ).split(" "),
);

/**
 * A table the query database keeps for every kind: each value that was put
 * in a number or date column and is not one. Such a value is left empty in
 * its column, so it drops out of totals; here it is, as written, so that is
 * never silent. No kind may name a table of its own this.
 */
export const UNFIT_TABLE = "unfit_values";

/** A form or table key as a SQL name: "delivery-receipt" → "delivery_receipt". */
export function sqlName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}
