// A document-encoding app's records as tables (see ../records/types.ts).
//
// What counts is what a person approved. A record contributes the values of
// its LAST APPROVED VERSION from the moment it is first approved until it is
// discarded. While someone is correcting it, it goes on counting with the
// values that were approved, marked `record_correcting`: a typo being fixed
// must not take a delivery out of the month's total for an afternoon, and
// the correction counts only once somebody has approved it.
//
// Tables:
//   records                 every record, with the columns all records have
//   <form>                  one row per record of that form, its fields as columns
//   <form>_<table>          one row per line of that table
//   <form>_<table>_with_record   the same lines, each with its record's columns
//                                (a view, made by the database)
//
// Number fields are numbers and date fields are dates: the readers are asked
// for both in one form (digits; year-month-day), and a value a person keyed
// some other way is left empty in the tables and counted at startup.

import type { DocumentEncodingApp, EncodingDocumentType, EncodingField, EncodingTable } from "../types.js";
import { FIELD_KEY, REQUEST_KEYS, RESERVED_COLUMN_PREFIXES, RESERVED_WORDS, UNFIT_TABLE, sqlName } from "../records/types.js";
import type { RecordColumn, RecordProjection, RecordRow, RecordsSource, RecordTable } from "../records/types.js";
import { withRecord } from "../records/database.js";
import type { EncodingStore, IndexEntry, Scalar, StoredDocument } from "./store.js";

/** Which of an app's tables a page reads. */
export interface EncodingRecordsOptions {
  /**
   * One form: a row per record of that form, with its fields as columns.
   * Omit for every record of every form, with the columns all records have.
   */
  form?: string;
  /**
   * One row per line of this table of the form, each carrying its record's
   * columns too. Needs `form`.
   */
  lines?: string;
}

/** The columns every record row carries, whatever the form. */
const RECORD_COLUMNS: RecordColumn[] = [
  { name: "record_id", type: "text", label: "Record", system: true },
  { name: "record_name", type: "text", label: "File name", system: true, searchable: true },
  { name: "record_group", type: "text", label: "Group", system: true, searchable: true },
  { name: "record_version", type: "integer", label: "Approved version", system: true },
  { name: "record_first_approved_at", type: "timestamp", label: "First approved", system: true },
  { name: "record_approved_at", type: "timestamp", label: "Last approved", system: true },
  { name: "record_captured_at", type: "timestamp", label: "Brought in", system: true },
  { name: "record_correcting", type: "boolean", label: "Being corrected", system: true },
];
const FORM_COLUMNS: RecordColumn[] = [
  { name: "record_form", type: "text", label: "Form", system: true },
  { name: "record_form_title", type: "text", label: "Form name", system: true, searchable: true },
];
const LINE_COLUMNS: RecordColumn[] = [
  { name: "line_id", type: "text", label: "Line", system: true },
  { name: "record_id", type: "text", label: "Record", system: true },
  { name: "line_no", type: "integer", label: "Line number", system: true },
];
const SYSTEM_NAMES = new Set([...RECORD_COLUMNS, ...FORM_COLUMNS, ...LINE_COLUMNS].map((c) => c.name));
/** New work at the top; a correction approved later does not move its record. */
const NEWEST_FIRST = { column: "record_first_approved_at", direction: "desc" } as const;

const ALL = "records";
const formTable = (form: string): string => sqlName(form);
const lineTable = (form: string, table: string): string => `${sqlName(form)}_${sqlName(table)}`;
const column = (f: EncodingField): RecordColumn => ({ name: f.key, type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text", label: f.label });

export function encodingTables(app: DocumentEncodingApp): RecordTable[] {
  const tables: RecordTable[] = [
    { name: ALL, label: `Every approved record in "${app.title}", of any form`, grain: "record", key: "record_id", columns: [...RECORD_COLUMNS, ...FORM_COLUMNS], defaultSort: NEWEST_FIRST },
  ];
  for (const [form, spec] of Object.entries(app.config.documents)) {
    tables.push({
      name: formTable(form),
      label: `Approved records of the form "${spec.title}"`,
      grain: "record",
      key: "record_id",
      columns: [...RECORD_COLUMNS, ...spec.fields.map(column)],
      defaultSort: NEWEST_FIRST,
    });
    for (const t of spec.tables ?? []) {
      tables.push({
        name: lineTable(form, t.key),
        label: `"${t.label}" lines of the form "${spec.title}"`,
        grain: "line",
        key: "line_id",
        parent: formTable(form),
        columns: [...LINE_COLUMNS, ...t.columns.map(column)],
        // A record's lines in the order they were written, not "1, 10, 11, 2".
        order: ["record_id", "line_no"],
      });
    }
  }
  return tables;
}

/** The table or view a page's options name, or why they name none. */
export function encodingRelation(app: DocumentEncodingApp, options: EncodingRecordsOptions): { name: string } | { error: string } {
  const { form, lines } = options ?? {};
  if (lines !== undefined && form === undefined) return { error: `lines "${String(lines)}" needs the form they belong to ("form")` };
  if (form === undefined) return { name: ALL };
  const spec = Object.hasOwn(app.config.documents, form) ? app.config.documents[form] : undefined;
  if (!spec) return { error: `the app has no form "${String(form)}"` };
  if (lines === undefined) return { name: formTable(form) };
  if (!spec.tables?.some((t) => t.key === lines)) return { error: `form "${form}" has no table "${String(lines)}"` };
  return { name: withRecord(lineTable(form, lines)) };
}

/**
 * What must hold for an app's forms and fields to be tables and columns.
 * Checked for every document-encoding app, whether or not it keeps a query
 * database today: a key that could not be a column would have to be renamed
 * on the day it is turned on, and a rename is the one change that costs
 * something.
 */
export function validateEncodingKeys(at: string, app: DocumentEncodingApp, errors: string[]): void {
  const names = new Map<string, string>([
    [ALL, "the table of every record"],
    [UNFIT_TABLE, "the table of values that did not fit their column"],
  ]);
  const claim = (name: string, what: string): void => {
    const taken = names.get(name);
    if (taken) errors.push(`${at}: ${what} and ${taken} would both be the table "${name}"; rename one`);
    else names.set(name, what);
    if (RESERVED_WORDS.has(name)) errors.push(`${at}: ${what} would be the table "${name}", a word the query language keeps for itself; use another key (its title can still say what you like)`);
  };
  const usable = (where: string, key: string): void => {
    if (!FIELD_KEY.test(key)) errors.push(`${where}: key "${key}" must be lower case letters, digits and underscores, starting with a letter`);
    else if (RESERVED_COLUMN_PREFIXES.some((p) => key.startsWith(p))) errors.push(`${where}: key "${key}" starts with "${RESERVED_COLUMN_PREFIXES.find((p) => key.startsWith(p))}", which is kept for the columns every record has`);
    else if ((REQUEST_KEYS as readonly string[]).includes(key)) errors.push(`${where}: key "${key}" is something a page sends with every request, so a column of that name could never be filtered; name the field something else`);
    else if (RESERVED_WORDS.has(key)) errors.push(`${where}: key "${key}" is a word the query language keeps for itself; use another key (the label can still say "${key}")`);
  };
  /** What a key was once called: a list of names, none of them in use now, none claimed twice. */
  const renames = (where: string, things: { key: string; was?: unknown }[], what: string): void => {
    const live = new Set(things.map((t) => t.key));
    const claimed = new Map<string, string>();
    for (const t of things) {
      if (t.was === undefined) continue;
      if (!Array.isArray(t.was) || !t.was.every((w) => typeof w === "string" && w.trim() !== "")) {
        errors.push(`${where}: "was" of ${what} "${t.key}" must be a list of the keys it used to have, such as was: ["old_key"]`);
        continue;
      }
      for (const old of t.was as string[]) {
        if (old === t.key) errors.push(`${where}: ${what} "${t.key}" says it was called "${old}", which is what it is called now`);
        else if (live.has(old)) errors.push(`${where}: ${what} "${t.key}" says it was called "${old}", but there is a ${what} "${old}" now. A key that is in use cannot also be an old name: values kept under it would belong to both`);
        else if (claimed.has(old)) errors.push(`${where}: ${what}s "${claimed.get(old)}" and "${t.key}" both say they were called "${old}"`);
        else claimed.set(old, t.key);
      }
    }
  };
  const documents = Object.entries(app.config?.documents ?? {});
  renames(at, documents.map(([key, spec]) => ({ key, was: (spec as { was?: unknown }).was })), "form");
  for (const [form, spec] of documents) {
    const where = `${at}, document "${form}"`;
    if (sqlName(form) === "" || /^[0-9]/.test(sqlName(form))) errors.push(`${where}: the form's key must contain a letter and not start with a digit`);
    claim(formTable(form), `form "${form}"`);
    const fields = new Set<string>();
    for (const f of spec.fields ?? []) {
      usable(`${where}, field "${f.key}"`, f.key);
      fields.add(f.key);
    }
    renames(where, spec.fields ?? [], "field");
    renames(where, spec.tables ?? [], "table");
    const everything = new Set<string>([...SYSTEM_NAMES, ...fields]);
    for (const t of spec.tables ?? []) {
      if (sqlName(t.key) === "") errors.push(`${where}: table key "${t.key}" must contain a letter or digit`);
      claim(lineTable(form, t.key), `table "${t.key}" of form "${form}"`);
      claim(withRecord(lineTable(form, t.key)), `table "${t.key}" of form "${form}" shown with its records`);
      const seen = new Set<string>();
      for (const c of t.columns ?? []) {
        usable(`${where}, column "${t.key}.${c.key}"`, c.key);
        if (seen.has(c.key)) errors.push(`${where}: column "${t.key}.${c.key}" is declared twice`);
        seen.add(c.key);
        everything.add(c.key);
        // A line is shown with its record's values beside it; one name cannot be both.
        if (fields.has(c.key)) errors.push(`${where}: column "${t.key}.${c.key}" has the same key as a field of the form; a line is shown beside its record's fields, so the two need different keys`);
      }
      renames(`${where}, table "${t.key}"`, t.columns ?? [], "column");
    }
    // A page bounds a column with <key>_from and <key>_to. A column that is
    // itself called that would be mistaken for one end of the other's range.
    for (const key of everything) {
      const m = /^(.+)_(from|to)$/.exec(key);
      if (m && everything.has(m[1])) errors.push(`${where}: keys "${m[1]}" and "${key}" cannot both exist: a page asks for a range of "${m[1]}" as "${m[1]}_from" and "${m[1]}_to"; rename one`);
    }
  }
}

/** The form a stored key means today: itself, the form that says it was called that, or still itself when no form claims it. */
export function currentForm(app: DocumentEncodingApp, key: string): string {
  if (Object.hasOwn(app.config.documents, key)) return key;
  for (const [form, spec] of Object.entries(app.config.documents)) if (spec.was?.includes(key)) return form;
  return key;
}

const empty = (v: unknown): boolean => v === undefined || v === null;

/**
 * Bring a record written before a rename up to the keys its app has now.
 *
 * A form, field, table or column declared `was: ["old"]` takes over whatever
 * the record holds under "old": its values, the readers' reading of them,
 * any question still open and how it was settled. Only the record as it
 * stands is touched. The versions that were approved stay exactly as they
 * were approved (they are read through the same `was` when turned into
 * rows), so nothing that was signed off is ever rewritten.
 *
 * Nothing is ever overwritten: where the record holds a value under both the
 * old key and the new one, both stay, and the old one is reported at startup.
 */
export function renameKeys(doc: StoredDocument, app: DocumentEncodingApp): void {
  if (doc.documentType) doc.documentType = currentForm(app, doc.documentType);
  if (doc.reading?.document_type) doc.reading.document_type = currentForm(app, doc.reading.document_type);
  const spec = doc.documentType && Object.hasOwn(app.config.documents, doc.documentType) ? app.config.documents[doc.documentType] : undefined;
  if (!spec) return;
  const move = (bag: Record<string, unknown> | undefined | null, from: string, to: string): void => {
    if (!bag || !Object.hasOwn(bag, from)) return;
    if (empty(bag[to])) bag[to] = bag[from];
    else if (!empty(bag[from])) return;
    delete bag[from];
  };
  /** Decisions and questions are kept by path: "table[3].column". */
  const repath = (from: (path: string) => string | null): void => {
    for (const bag of [doc.resolved, doc.flags] as (Record<string, unknown> | undefined)[]) {
      for (const path of Object.keys(bag ?? {})) {
        const to = from(path);
        if (to !== null && to !== path) move(bag, path, to);
      }
    }
  };
  for (const f of spec.fields) {
    for (const old of f.was ?? []) {
      for (const bag of [doc.values, doc.resolved, doc.flags, doc.reading?.fields]) move(bag as Record<string, unknown> | undefined, old, f.key);
    }
  }
  for (const t of spec.tables ?? []) {
    for (const old of t.was ?? []) {
      for (const bag of [doc.tables, doc.reading?.tables] as (Record<string, unknown[]> | undefined)[]) {
        if (!bag || !Object.hasOwn(bag, old)) continue;
        if ((bag[t.key]?.length ?? 0) === 0) bag[t.key] = bag[old];
        else if ((bag[old]?.length ?? 0) > 0) continue;
        delete bag[old];
      }
      if (!Object.hasOwn(doc.tables ?? {}, old)) repath((path) => (path.startsWith(`${old}[`) ? `${t.key}${path.slice(old.length)}` : null));
    }
    const renamed = t.columns.filter((c) => (c.was ?? []).length > 0);
    if (renamed.length === 0) continue;
    const rows = Math.max(doc.tables?.[t.key]?.length ?? 0, doc.reading?.tables?.[t.key]?.length ?? 0);
    for (let i = 0; i < rows; i++) {
      for (const c of renamed) {
        for (const old of c.was ?? []) {
          move(doc.tables?.[t.key]?.[i] as Record<string, unknown> | undefined, old, c.key);
          move(doc.reading?.tables?.[t.key]?.[i] as Record<string, unknown> | undefined, old, c.key);
          for (const bag of [doc.resolved, doc.flags]) move(bag as Record<string, unknown> | undefined, `${t.key}[${i}].${old}`, `${t.key}[${i}].${c.key}`);
        }
      }
    }
  }
}

/**
 * Values that records hold under a key their form no longer has, and no
 * field claims with `was`: the sign of a rename that was not declared. They
 * are not lost (the records still hold them) but no screen, page or query
 * shows them, so it is said at startup, with how many records are affected.
 * Looks at each record as it stands, from the index; what approved versions
 * hold in their lines is counted when the tables are built.
 */
export function orphanedKeys(app: DocumentEncodingApp, entries: IndexEntry[]): { form: string; key: string; records: number }[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const form = e.documentType ? currentForm(app, e.documentType) : null;
    if (!form || e.status === "discarded" || !Object.hasOwn(app.config.documents, form)) continue;
    const known = new Set(app.config.documents[form].fields.flatMap((f) => [f.key, ...(f.was ?? [])]));
    for (const [key, value] of Object.entries(e.values ?? {})) {
      if (value === null || value === undefined || known.has(key)) continue;
      counts.set(`${form}\n${key}`, (counts.get(`${form}\n${key}`) ?? 0) + 1);
    }
  }
  return [...counts].map(([k, records]) => ({ form: k.split("\n")[0], key: k.split("\n")[1], records })).sort((a, b) => b.records - a.records);
}

/** A value by its field's key, or by a key it was stored under before a rename. */
function valueOf(values: Record<string, Scalar | null> | undefined, f: EncodingField): Scalar | null {
  if (!values) return null;
  if (!empty(values[f.key])) return values[f.key];
  for (const old of f.was ?? []) if (!empty(values[old])) return values[old];
  return null;
}

function pick(fields: EncodingField[], values: Record<string, Scalar | null> | undefined): RecordRow {
  const out: RecordRow = {};
  for (const f of fields) out[f.key] = valueOf(values, f);
  return out;
}

/** A table's lines by its key, or by a key it was stored under before a rename. */
function linesOf(tables: Record<string, Record<string, Scalar | null>[]> | undefined, t: EncodingTable): Record<string, Scalar | null>[] {
  for (const key of [t.key, ...(t.was ?? [])]) if ((tables?.[key]?.length ?? 0) > 0) return tables![key];
  return [];
}

/**
 * What of a record counts right now, as one piece of text; null when nothing
 * of it does (never approved, or discarded). This is the one place the rule
 * is written: the store stamps a record whenever this changes, the tables
 * are rewritten for it, and a copy elsewhere is told.
 */
export function countedSignature(app: DocumentEncodingApp, doc: StoredDocument): string | null {
  const last = doc.versions?.at(-1);
  if (!last || doc.status === "discarded") return null;
  return `${last.version}:${doc.status !== "approved" ? 1 : 0}:${currentForm(app, last.documentType)}`;
}

export interface EncodingRecordsSource extends RecordsSource {
  /** What a record contributes, from the record in hand. */
  projectDoc(doc: StoredDocument): RecordProjection;
}

export function encodingRecordsSource(app: DocumentEncodingApp, store: EncodingStore): EncodingRecordsSource {
  const cfg = app.config;
  const specOf = (form: string): EncodingDocumentType | undefined => (Object.hasOwn(cfg.documents, form) ? cfg.documents[form] : undefined);

  const projectDoc = (doc: StoredDocument): RecordProjection => {
    const signature = countedSignature(app, doc);
    const last = doc.versions?.at(-1);
    if (signature === null || !last) return { id: doc.id, signature: "", rows: {} };
    const form = currentForm(app, last.documentType);
    const spec = specOf(form);
    const unplaced: string[] = [];
    const common: RecordRow = {
      record_id: doc.id,
      record_name: doc.name,
      record_group: last.group ?? null,
      record_version: last.version,
      record_first_approved_at: doc.versions[0].at,
      record_approved_at: last.at,
      record_captured_at: doc.createdAt,
      record_correcting: doc.status !== "approved",
    };
    const rows: Record<string, RecordRow[]> = {
      [ALL]: [{ ...common, record_form: form, record_form_title: spec?.title ?? null }],
    };
    if (!spec) {
      // A form the app no longer has: the record is still a record, with no
      // table of its own to appear in.
      unplaced.push(`the form "${form}"`);
    } else {
      rows[formTable(form)] = [{ ...pick(spec.fields, last.values), ...common }];
      const claimed = new Set((spec.tables ?? []).flatMap((t) => [t.key, ...(t.was ?? [])]));
      for (const [key, lines] of Object.entries(last.tables ?? {})) {
        if ((lines?.length ?? 0) > 0 && !claimed.has(key)) unplaced.push(`lines of a table "${key}" (form "${form}")`);
      }
      for (const t of spec.tables ?? []) {
        const lines = linesOf(last.tables, t);
        const columns = new Set(t.columns.flatMap((c) => [c.key, ...(c.was ?? [])]));
        const strays = new Set<string>();
        rows[lineTable(form, t.key)] = lines.map((cells, i) => {
          for (const [key, value] of Object.entries(cells ?? {})) if (!empty(value) && !columns.has(key)) strays.add(key);
          return { ...pick(t.columns, cells), line_id: `${doc.id}:${i + 1}`, record_id: doc.id, line_no: i + 1 };
        });
        for (const key of strays) unplaced.push(`a value under "${t.key}.${key}" (form "${form}")`);
      }
    }
    return { id: doc.id, signature, rows, ...(unplaced.length > 0 ? { unplaced } : {}) };
  };

  return {
    tables: encodingTables(app),
    // Besides the tables themselves, what changes a record's rows is a
    // rename and a form's title (which every row of `records` carries). The
    // readers' background and notes do not.
    version: JSON.stringify(
      Object.entries(cfg.documents).map(([form, spec]) => [form, spec.title, spec.was ?? [], spec.fields.map((f) => [f.key, f.was ?? []]), (spec.tables ?? []).map((t) => [t.key, t.was ?? [], t.columns.map((c) => [c.key, c.was ?? []])])]),
    ),
    about:
      `the approved records of "${app.title}". A record counts from its first approval until it is discarded, with the values of its last approved version; ` +
      "record_correcting is true while a correction to it is waiting for approval. Number fields are numbers and date fields are dates (a value that was neither is NULL)",
    noun: { one: "approved record", many: "approved records" },
    identity: () => store.identity(),
    expected: () =>
      store
        .entries()
        .filter((e) => e.sig !== null)
        .map((e) => ({ id: e.id, signature: e.sig! })),
    signature: (id) => store.entry(id)?.sig ?? "",
    project: async (id) => {
      const doc = await store.read(id);
      return doc ? projectDoc(doc) : null;
    },
    changedAt: () => store.changedAt(),
    changes: (after, limit) => store.changes(after, limit),
    mark: () => store.mark(),
    continues: (mark) => store.continues(mark),
    projectDoc,
  };
}
