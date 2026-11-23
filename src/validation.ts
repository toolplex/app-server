import type {
  AppServerConfig,
  Section,
  FetchResponse,
  ActionResponse,
} from "./types.js";
import { APP_PLACES, APP_SECTION_LIMITS } from "./apps/types.js";
import type { AppKind } from "./apps/types.js";
import { validateEncodingKeys } from "./apps/encoding/records.js";
import { isRecordsQuery, recordRelation } from "./apps/records/kinds.js";
import { FIELD_KEY, RESERVED_WORDS } from "./apps/records/types.js";
import { appRecordsOf, sectionsOf } from "./apps/records/resource.js";

// ---------------------------------------------------------------------------
// Startup validation — fail fast with descriptive errors
// ---------------------------------------------------------------------------

export function validateConfig(config: AppServerConfig): void {
  const errors: string[] = [];

  for (const [pageId, page] of Object.entries(config.pages)) {
    const sections = flattenSections(page.sections);

    for (const section of sections) {
      // Every section source must have a resource handler
      if (!config.resources[section.source]) {
        errors.push(
          `Page "${pageId}": section references resource "${section.source}" but no fetch handler is defined`,
        );
      }

      // Table sections must have rowKey
      if (section.type === "table" && !section.rowKey) {
        errors.push(
          `Page "${pageId}": table section with source "${section.source}" is missing required "rowKey"`,
        );
      }

      // Table detail source must reference a resource
      if (section.type === "table" && section.detail) {
        if (!config.resources[section.detail.source]) {
          errors.push(
            `Page "${pageId}": table detail references resource "${section.detail.source}" but no fetch handler is defined`,
          );
        }
      }
    }

    // Every action must have a handler
    for (const action of page.actions ?? []) {
      if (!config.actions[action.action]) {
        errors.push(
          `Page "${pageId}": references action "${action.action}" but no action handler is defined`,
        );
      }
      validateActionInputs(pageId, action, errors);
    }
    for (const section of sections) {
      if (section.type === "table") {
        for (const action of section.actions ?? []) {
          if (!config.actions[action.action]) {
            errors.push(
              `Page "${pageId}": table action "${action.action}" has no handler`,
            );
          }
          validateActionInputs(pageId, action, errors);
        }
      }
    }

    // Filter options_source must reference a resource
    for (const filter of page.filters ?? []) {
      if (filter.options_source && !config.resources[filter.options_source]) {
        errors.push(
          `Page "${pageId}": filter "${filter.key}" has options_source "${filter.options_source}" but no resource handler is defined`,
        );
      }
    }
  }

  if (config.timezone !== undefined) {
    try {
      // A name, as the database knows zones: "+08:00" is an offset, not a
      // zone, and has no summer time or history to it.
      if (typeof config.timezone !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(config.timezone)) throw new Error("not a name");
      new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
    } catch {
      errors.push(`timezone: "${String(config.timezone)}" is not a time zone; use an IANA name such as "Asia/Singapore"`);
    }
  }
  // Tables of records are counted by day, and a day needs a zone. The
  // machine's own would do the counting differently on a laptop and on a
  // server for the same organization, so it is never assumed.
  const tabled = Object.entries(config.apps ?? {}).filter(([, app]) => app?.records === true).map(([id]) => id);
  if (tabled.length > 0 && config.timezone === undefined) {
    errors.push(`timezone: app "${tabled[0]}" keeps tables of its records (records: true), which are counted by day; say which zone the organization's days are in, such as timezone: "Europe/Paris"`);
  }
  validateApps(config, errors);
  validateAppRecords(config, errors);

  if (errors.length > 0) {
    throw new Error(
      `@toolplex/app-server configuration errors:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime response validation
// ---------------------------------------------------------------------------

export function validateFetchResponse(
  resource: string,
  response: unknown,
): asserts response is FetchResponse {
  if (!response || typeof response !== "object") {
    throw new ResponseValidationError(
      resource,
      "fetch handler must return an object",
    );
  }

  const r = response as Record<string, unknown>;

  if (!Array.isArray(r.rows)) {
    throw new ResponseValidationError(
      resource,
      'fetch handler must return "rows" as an array',
    );
  }

  if (typeof r.total !== "number" || r.total < 0) {
    throw new ResponseValidationError(
      resource,
      'fetch handler must return "total" as a non-negative number',
    );
  }
}

export function validateActionResponse(
  action: string,
  response: unknown,
): asserts response is ActionResponse {
  if (!response || typeof response !== "object") {
    throw new ResponseValidationError(
      action,
      "action handler must return an object",
    );
  }

  const r = response as Record<string, unknown>;

  if (typeof r.affected !== "number") {
    throw new ResponseValidationError(
      action,
      'action handler must return "affected" as a number',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A section that has a `source` — anything except SectionGroup (a
 *  container) and TextSection (inline prose, no source/handler). */
type LeafSection = Exclude<Section, { type: "group" } | { type: "text" }>;

/**
 * Flatten a page's sections to leaf sections — i.e. non-group sections
 * that have a `source` and can register resource handlers / be validated.
 * Recursively descends through SectionGroup containers. Text sections are
 * dropped: they have no source or handler, so there's nothing to validate.
 */
function flattenSections(
  sections: (Section | Section[])[],
): LeafSection[] {
  const result: LeafSection[] = [];
  for (const entry of sections) {
    const items = Array.isArray(entry) ? entry : [entry];
    for (const section of items) {
      if (section.type === "group") {
        result.push(...flattenSections(section.sections));
      } else if (section.type === "text") {
        // Inline prose — no source/handler to validate.
      } else {
        result.push(section);
      }
    }
  }
  return result;
}

function validateActionInputs(
  pageId: string,
  action: {
    action: string;
    inputs?: {
      key: string;
      type: string;
      multiple?: boolean;
      accept?: string;
      condition?: { key?: unknown; eq?: unknown; neq?: unknown };
    }[];
  },
  errors: string[],
): void {
  for (const input of action.inputs ?? []) {
    if (input.type === "file" && input.multiple !== undefined && typeof input.multiple !== "boolean") {
      errors.push(
        `Page "${pageId}", action "${action.action}", input "${input.key}": "multiple" must be boolean`,
      );
    }
    if (input.type !== "file" && (input.multiple !== undefined || input.accept !== undefined)) {
      errors.push(
        `Page "${pageId}", action "${action.action}", input "${input.key}": "multiple" / "accept" only valid on type:"file"`,
      );
    }
    if (input.condition !== undefined) {
      if (typeof input.condition.key !== "string" || !input.condition.key) {
        errors.push(
          `Page "${pageId}", action "${action.action}", input "${input.key}": "condition.key" must be a non-empty string`,
        );
      }
      if (input.condition.eq === undefined && input.condition.neq === undefined) {
        errors.push(
          `Page "${pageId}", action "${action.action}", input "${input.key}": "condition" must specify "eq" or "neq"`,
        );
      }
    }
  }
}

class ResponseValidationError extends Error {
  constructor(name: string, detail: string) {
    super(`@toolplex/app-server [${name}]: ${detail}`);
    this.name = "ResponseValidationError";
  }
}

// ---------------------------------------------------------------------------
// Apps — every reference inside an app must resolve, so a typo fails at
// startup instead of as a question nobody can answer.
// ---------------------------------------------------------------------------

function validateApps(config: AppServerConfig, errors: string[]): void {
  for (const [appId, app] of Object.entries(config.apps ?? {})) {
    const at = `App "${appId}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
      errors.push(`${at}: id must be lowercase letters, digits and hyphens`);
    }
    if (app.kind !== "document-encoding") {
      errors.push(`${at}: unknown kind "${String((app as { kind?: unknown }).kind)}"`);
      continue;
    }
    validateSections(at, app.kind, app.sections, errors);
    validateDocumentEncoding(at, app.config, errors);
    validateEncodingKeys(at, app, errors);
  }
}

/**
 * A resource that reads an app's records (appRecords) must be able to work,
 * and must be on a page.
 *
 * On a page, because that is the grant: records are shown to the people who
 * may see the page they are on. A records resource on no page would be
 * readable by name by everyone in the organization, including people whose
 * role cannot open the app.
 */
function validateAppRecords(config: AppServerConfig, errors: string[]): void {
  const used = new Map<string, { pageId: string; section: Section }[]>();
  for (const [pageId, page] of Object.entries(config.pages ?? {})) {
    for (const section of sectionsOf(page.sections ?? [])) {
      const source = (section as { source?: unknown }).source;
      if (typeof source !== "string") continue;
      if (!used.has(source)) used.set(source, []);
      used.get(source)!.push({ pageId, section });
    }
  }
  for (const [name, resource] of Object.entries(config.resources ?? {})) {
    const made = appRecordsOf(resource);
    if (!made) continue;
    const at = `Resource "${name}"`;
    const app = Object.hasOwn(config.apps ?? {}, made.appId) ? config.apps![made.appId] : undefined;
    if (!app) {
      errors.push(`${at}: reads app "${made.appId}", which this server does not declare`);
      continue;
    }
    if (app.records !== true) {
      errors.push(`${at}: app "${made.appId}" keeps no query database; add \`records: true\` to the app`);
      continue;
    }
    // Built by appRecords and nothing else: a handler added beside it would
    // be replaced without a word when the resource is given its app.
    const extra = Object.keys(resource).filter((k) => k !== "fetch");
    if (extra.length > 0) {
      errors.push(`${at}: an appRecords resource cannot carry its own ${extra.join(", ")}; to work the records yourself, query them in a resource of your own (handle.query)`);
    }
    const users = used.get(name) ?? [];
    if (users.length === 0) {
      errors.push(`${at}: is not shown on any page. Records are shown to the people who may see the page they are on, so one on no page would be open to everyone; put it on a page or remove it`);
    }
    if (isRecordsQuery(made.options)) {
      // A query of the client's own. It is kept as a view named after the
      // resource; what it returns is checked once the app is running.
      const extra = Object.keys(made.options).filter((k) => k !== "sql" && k !== "label");
      if (typeof made.options.sql !== "string" || made.options.sql.trim() === "") errors.push(`${at}: "sql" must be one SELECT statement`);
      if (extra.length > 0) errors.push(`${at}: a query takes "sql" and "label" only (found ${extra.join(", ")}); to read one of the app's own tables, leave "sql" out`);
      if (!FIELD_KEY.test(name) || RESERVED_WORDS.has(name)) {
        errors.push(`${at}: a resource that is a query over an app's records is kept as a view of the same name, so its name must be lower case letters, digits and underscores, starting with a letter, and not a word the query language keeps for itself`);
      }
      continue;
    }
    const relation = recordRelation(app, made.options);
    if ("error" in relation) {
      errors.push(`${at}: ${relation.error}`);
      continue;
    }
    const columns = new Set(relation.columns.map((c) => c.name));
    for (const { pageId, section } of users) {
      if (section.type !== "table") continue;
      const where = `Page "${pageId}", table on "${name}"`;
      if (section.rowKey !== relation.key) errors.push(`${where}: rowKey must be "${relation.key}", the column that identifies a row of this table`);
      for (const c of section.columns ?? []) {
        if (!columns.has(c.key)) errors.push(`${where}: column "${c.key}" is not a column of this table (${[...columns].join(", ")})`);
      }
    }
  }
}

/**
 * A section in a place the kind does not have would never be shown, and
 * nobody would know why; one that is too long would not be read. Both are
 * said at startup.
 */
function validateSections(at: string, kind: AppKind, sections: unknown, errors: string[]): void {
  if (sections === undefined) return;
  const places = APP_PLACES[kind];
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    errors.push(`${at}: sections must be an object keyed by place (${places.join(", ")})`);
    return;
  }
  for (const [place, blocks] of Object.entries(sections as Record<string, unknown>)) {
    const where = `${at}, sections "${place}"`;
    if (!places.includes(place)) {
      errors.push(`${where}: not a place in a ${kind} app (${places.join(", ")})`);
      continue;
    }
    if (!Array.isArray(blocks)) {
      errors.push(`${where}: must be a list of sections`);
      continue;
    }
    if (blocks.length > APP_SECTION_LIMITS.perPlace) {
      errors.push(`${where}: has ${blocks.length} sections; keep it to ${APP_SECTION_LIMITS.perPlace}, or people stop reading`);
    }
    blocks.forEach((raw, i) => {
      const n = `${where}, section ${i + 1}`;
      const b = raw as { type?: unknown; title?: unknown; text?: unknown } | null;
      if (!b || typeof b !== "object" || b.type !== "text") {
        errors.push(`${n}: type must be "text"`);
        return;
      }
      if (typeof b.text !== "string" || b.text.trim() === "") {
        errors.push(`${n}: text is empty`);
      } else if (b.text.length > APP_SECTION_LIMITS.text) {
        errors.push(`${n}: text is ${b.text.length} characters; keep it to ${APP_SECTION_LIMITS.text.toLocaleString("en-US")}`);
      }
      if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > APP_SECTION_LIMITS.title)) {
        errors.push(`${n}: title must be text of at most ${APP_SECTION_LIMITS.title} characters`);
      }
    });
  }
}

function validateDocumentEncoding(
  at: string,
  app: import("./apps/types.js").DocumentEncodingConfig,
  errors: string[],
): void {
  {
    if (app?.context && app.context.length > 2000) {
      errors.push(`${at}: context is ${app.context.length} characters; keep it to 2,000 so it stays worth reading on every document`);
    }
    if (!app?.intake?.length) errors.push(`${at}: needs at least one way to bring documents in ("intake")`);
    const docTypes = Object.entries(app.documents ?? {});
    if (docTypes.length === 0) errors.push(`${at}: declares no document types`);

    let groupFieldSeen = false;
    for (const [docId, doc] of docTypes) {
      const where = `${at}, document "${docId}"`;
      if (doc.notes && doc.notes.length > 1500) {
        errors.push(`${where}: notes are ${doc.notes.length} characters; keep them to 1,500`);
      }
      const fieldKeys = new Set<string>();
      for (const field of doc.fields) {
        if (fieldKeys.has(field.key)) errors.push(`${where}: field "${field.key}" is declared twice`);
        fieldKeys.add(field.key);
        if (field.candidates && !app.lists?.[field.candidates]) {
          errors.push(`${where}: field "${field.key}" names list "${field.candidates}" but no such list is defined`);
        }
      }
      if (app.group_by && fieldKeys.has(app.group_by)) groupFieldSeen = true;

      const tables = new Map<string, Set<string>>();
      for (const table of doc.tables ?? []) {
        if (tables.has(table.key)) errors.push(`${where}: table "${table.key}" is declared twice`);
        tables.set(table.key, new Set(table.columns.map((c) => c.key)));
        for (const column of table.columns) {
          if (column.candidates && !app.lists?.[column.candidates]) {
            errors.push(`${where}: column "${table.key}.${column.key}" names list "${column.candidates}" but no such list is defined`);
          }
        }
      }

      for (const check of doc.checks ?? []) {
        if (check.type === "sum") {
          if (!tables.get(check.table)?.has(check.column)) {
            errors.push(`${where}: sum check refers to "${check.table}.${check.column}", which is not declared`);
          }
          if (!fieldKeys.has(check.equals)) {
            errors.push(`${where}: sum check compares against field "${check.equals}", which is not declared`);
          }
        } else if (!fieldKeys.has(check.field)) {
          errors.push(`${where}: ${check.type} check refers to field "${check.field}", which is not declared`);
        }
      }
    }
    if (app.group_by && !groupFieldSeen) {
      errors.push(`${at}: group_by "${app.group_by}" is not a field of any document type`);
    }
    const cap = app.review?.question_cap;
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
      errors.push(`${at}: review.question_cap must be a whole number of 1 or more`);
    }
  }
}
