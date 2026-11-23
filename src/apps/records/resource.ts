// ---------------------------------------------------------------------------
// An app's records as a page's data.
//
//   resources: {
//     receipts:      appRecords("receiving", { form: "delivery-receipt" }),
//     receipt_lines: appRecords("receiving", { form: "delivery-receipt", lines: "items" }),
//     by_customer:   appRecords("receiving", { sql: "select customer, sum(total_qty) as qty from delivery_receipt group by 1" }),
//   }
//
// The page reads the app's query database (see ./types.ts): its filters,
// column filters and sort are run by the database over every row, and the
// page reports when the records last changed, so alerts on it are checked
// when something is approved. A query of the client's own is kept as a view
// named after the resource and read exactly like a table.
//
// Pages only read. A record is changed in the app, under the app's
// permissions. And putting records on a page shows them to everyone who may
// see that page, whether or not their role can open the app: that is what
// publishing them on a page means, and it is the only way they are shown.
// ---------------------------------------------------------------------------

import type { ContextRequest, ContextResponse, PageDefinition, ResourceDefinition, Section } from "../../types.js";
import { RecordsError, type Relation } from "./database.js";
import { isRecordsQuery, recordRelation, type AppRecordsOptions } from "./kinds.js";
import type { RecordsRuntime } from "./runtime.js";
import type { RecordColumnType } from "./types.js";
import type { AppDefinition } from "../types.js";

const MARK = Symbol.for("toolplex.app-records");

interface Made {
  appId: string;
  options: AppRecordsOptions;
}

/** The app and options a resource was made with, or null for any other resource. */
export function appRecordsOf(resource: unknown): Made | null {
  return resource && typeof resource === "object" && MARK in resource ? ((resource as Record<symbol, Made>)[MARK] ?? null) : null;
}

/**
 * A resource that reads an app's records: one of its tables, or a query of
 * your own over them. The app must have `records: true`. See the note at the
 * top of this file.
 */
export function appRecords(appId: string, options: AppRecordsOptions = {}): ResourceDefinition {
  const made: Made = Object.freeze({ appId, options: Object.freeze({ ...options }) });
  const unbound = async (): Promise<never> => {
    throw new Error(`appRecords("${appId}") can only be used as a resource of the server that declares the app`);
  };
  return Object.assign({ fetch: unbound }, { [MARK]: made }) as ResourceDefinition;
}

/** A running app's records, and how its kind names its tables. */
export interface RunningRecords {
  title: string;
  /** What one row of a record table is called when rows are counted for a person. */
  noun: { one: string; many: string };
  runtime: RecordsRuntime;
  /** One of the kind's own tables or views, from a page's options. */
  relation(options: AppRecordsOptions): Relation | { error: string };
}

/** The table or view a resource reads: a client's query is a view named after the resource. */
function relationOf(app: RunningRecords, name: string, made: Made): Relation | { error: string } {
  if (!isRecordsQuery(made.options)) return app.relation(made.options);
  return app.runtime.database?.relation(name) ?? { error: `the query of "${name}" is not available` };
}

const SNAPSHOT_TYPE: Record<RecordColumnType, string> = {
  text: "VARCHAR",
  number: "DOUBLE",
  integer: "BIGINT",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMP WITH TIME ZONE",
  date: "DATE",
};

/**
 * The resources as the server serves them: each `appRecords` entry given the
 * running app it reads. The app is looked up when a request arrives, so apps
 * may start after the routes are registered.
 */
export function bindAppRecords(
  resources: Record<string, ResourceDefinition>,
  running: (appId: string) => RunningRecords | undefined,
): Record<string, ResourceDefinition> {
  const out: Record<string, ResourceDefinition> = {};
  for (const [name, resource] of Object.entries(resources)) {
    const made = appRecordsOf(resource);
    if (!made) {
      out[name] = resource;
      continue;
    }
    const target = (): { app: RunningRecords; relation: Relation } => {
      const app = running(made.appId);
      if (!app || !app.runtime.database) throw new RecordsError(503, `The app "${made.appId}" is not running on this server.`);
      const relation = relationOf(app, name, made);
      if ("error" in relation) throw new RecordsError(500, relation.error);
      return { app, relation };
    };
    const bound: ResourceDefinition = {
      fetch: async (req) => {
        const { app, relation } = target();
        return app.runtime.database!.page(relation.name, req);
      },
      context: async (req) => {
        const { app, relation } = target();
        const n = await app.runtime.database!.count(relation.name, req.filters, req.columnFilters, req.selection);
        const what = relation.grain === "record" ? (n.rows === 1 ? app.noun.one : app.noun.many) : n.rows === 1 ? "row" : "rows";
        const correcting = n.correcting > 0 ? ` (${n.correcting.toLocaleString("en-US")} of them with a correction waiting for approval, counted with the values last approved)` : "";
        // Never silent: a value that is not a number where a number belongs
        // is out of every total, and whoever reads the total must know.
        const unfit =
          n.unfit === 0
            ? ""
            : n.unfitAnywhere
              ? ` ${n.unfit.toLocaleString("en-US")} of this app's records hold a value that is not a number or a date where one belongs; such a value is left empty, so a figure here that adds it up is short until it is corrected in the app.`
              : ` ${n.unfit.toLocaleString("en-US")} of the records here hold a value that is not a number or a date where one belongs; such a value is left empty, so totals over it are short until it is corrected in the app.`;
        return {
          summary: `${n.rows.toLocaleString("en-US")} ${what}${correcting}: ${relation.label}. Read from the "${app.title}" app, where records are changed.${unfit}`,
          lastSync: await app.runtime.changedAt(),
        };
      },
      // The columns are known exactly; a snapshot must not guess them from
      // whichever rows happen to be there (or from none).
      columnTypes: () => {
        const app = running(made.appId);
        const relation = app?.runtime.database ? relationOf(app, name, made) : undefined;
        return relation && !("error" in relation) ? Object.fromEntries(relation.columns.map((c) => [c.name, SNAPSHOT_TYPE[c.type]])) : undefined;
      },
    };
    // Still recognisable after binding, for what is told to clients about a page's sources.
    out[name] = Object.assign(bound, { [MARK]: made });
  }
  return out;
}

/** Every section of a page, however it is nested in rows and groups. */
export function* sectionsOf(entries: (Section | Section[])[]): Generator<Section> {
  for (const entry of entries ?? []) {
    for (const section of Array.isArray(entry) ? entry : [entry]) {
      if (!section) continue;
      yield section;
      if (section.type === "group") yield* sectionsOf(section.sections);
    }
  }
}

/** The names of the app-record resources a page's sections read. */
export function recordSourcesOf(page: Pick<PageDefinition, "sections">, resources: Record<string, ResourceDefinition>): string[] {
  const names = new Set<string>();
  for (const section of sectionsOf(page.sections)) {
    const source = (section as { source?: unknown }).source;
    if (typeof source === "string" && appRecordsOf(resources[source])) names.add(source);
  }
  return [...names];
}

/** What a client is told about one of a page's sources that reads an app's records. */
export interface RecordSourceInfo {
  /** The app the rows come from. */
  app: string;
  /** The table or view. */
  table: string;
  /** One row per record, one per line of a record, or the rows of a query of the client's own. */
  grain: "record" | "line" | "query";
  /** The column that identifies a row; null when the rows have none. */
  key: string | null;
  /** The column that holds the record's id (what the app is opened at); null when the rows are not of one record. */
  record: string | null;
}

type Declared = { pages: Record<string, Pick<PageDefinition, "sections">>; resources: Record<string, ResourceDefinition>; apps?: Record<string, AppDefinition> };

/** The table or view a declared resource reads, from the configuration and, for a client's query, the running app. */
function declaredRelation(config: Declared, name: string, running?: (appId: string) => RunningRecords | undefined): Relation | null {
  const made = appRecordsOf(config.resources[name]);
  const app = made ? config.apps?.[made.appId] : undefined;
  if (!made || !app) return null;
  if (isRecordsQuery(made.options)) return running?.(made.appId)?.runtime.database?.relation(name) ?? null;
  const relation = recordRelation(app, made.options);
  return "error" in relation ? null : relation;
}

/**
 * For each page, which of its sources read an app's records. Served with the
 * page so a client can tell: a row can be opened in its app at that record,
 * and the page is worth reading again when that app changes.
 */
export function recordSourcesByPage(config: Declared, running?: (appId: string) => RunningRecords | undefined): Record<string, Record<string, RecordSourceInfo>> {
  const out: Record<string, Record<string, RecordSourceInfo>> = {};
  for (const [pageId, page] of Object.entries(config.pages ?? {})) {
    for (const name of recordSourcesOf(page, config.resources ?? {})) {
      const relation = declaredRelation(config, name, running);
      if (!relation) continue;
      const record = relation.columns.some((c) => c.name === "record_id") ? "record_id" : null;
      (out[pageId] ??= {})[name] = { app: appRecordsOf(config.resources[name])!.appId, table: relation.name, grain: relation.grain, key: relation.key, record };
    }
  }
  return out;
}

/**
 * What can only be checked once an app is running: that the tables on a page
 * which read a client's own query ask for columns the query returns. Returns
 * what is wrong, in words; the server does not start with any of it.
 */
export function checkQueryPages(config: Declared, running: (appId: string) => RunningRecords | undefined): string[] {
  const errors: string[] = [];
  for (const [pageId, page] of Object.entries(config.pages ?? {})) {
    for (const section of sectionsOf(page.sections)) {
      const source = (section as { source?: unknown }).source;
      const made = typeof source === "string" ? appRecordsOf(config.resources[source]) : null;
      if (typeof source !== "string" || !made || !isRecordsQuery(made.options) || section.type !== "table") continue;
      const relation = declaredRelation(config, source, running);
      if (!relation) continue;
      const columns = new Set(relation.columns.map((c) => c.name));
      const where = `Page "${pageId}", table on "${source}"`;
      if (section.rowKey && !columns.has(section.rowKey)) errors.push(`${where}: rowKey "${section.rowKey}" is not a column the query returns (${[...columns].join(", ")})`);
      for (const c of section.columns ?? []) {
        if (!columns.has(c.key)) errors.push(`${where}: column "${c.key}" is not a column the query returns (${[...columns].join(", ")})`);
      }
    }
  }
  return errors;
}

const later = (a: string | undefined, b: string | undefined): string | undefined => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);

/** Longer than anyone will look at a page: records are current by construction, never "stale". */
const NEVER_STALE_HOURS = 100 * 365 * 24;

/**
 * Pages that show app records report when those records last changed.
 *
 * A page's freshness is what tells the platform to look at it again: alerts
 * on a page are checked when its `lastSync` moves, and refused on a page that
 * reports none. For records there is nothing for the client to write: the
 * time is when what the records count for last changed. Everything else a
 * page says about itself is kept: its own context handler if it has one, and
 * otherwise what its sources say, exactly as for any page. A page whose own
 * handler reports a time keeps that time: it is the page's word on data it
 * copies from elsewhere, and the records' time is used only when it has none.
 */
export function withRecordFreshness<P extends Omit<PageDefinition, "id">>(
  pages: Record<string, P>,
  resources: Record<string, ResourceDefinition>,
  changedAt: (resource: string) => Promise<string | null>,
  /** What a page with no handler of its own says: its sources' contexts put together. */
  aggregate: (sources: string[], req: ContextRequest) => Promise<ContextResponse>,
): Record<string, P> {
  const out: Record<string, P> = {};
  for (const [id, page] of Object.entries(pages)) {
    const sources = recordSourcesOf(page, resources);
    if (sources.length === 0) {
      out[id] = page;
      continue;
    }
    const own = page.context;
    const latest = async (): Promise<string | undefined> => {
      let at: string | undefined;
      for (const name of sources) at = later(at, (await changedAt(name)) ?? undefined);
      return at;
    };
    out[id] = {
      ...page,
      context: async (req): Promise<ContextResponse> => {
        const said = own ? await own(req) : await aggregate(req.sections ?? [], req);
        // A page that says for itself how fresh it is keeps saying it: it
        // also shows data copied from somewhere, and a copy that has stopped
        // arriving must not be hidden by approvals going on beside it.
        if (said.lastSync) return said;
        const at = await latest();
        if (!at) return said;
        // A quiet weekend is not stale data: nothing was approved, and the page says exactly that.
        const quiet = !said.freshness ? { freshness: { warningAfterHours: NEVER_STALE_HOURS, criticalAfterHours: NEVER_STALE_HOURS } } : {};
        return { ...said, lastSync: at, ...quiet };
      },
    };
  }
  return out;
}
