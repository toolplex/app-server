import type {
  AppServerConfig,
  Section,
  FetchResponse,
  ActionResponse,
} from "./types.js";

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

  validateApps(config, errors);

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
    validateDocumentEncoding(at, app.config, errors);
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
