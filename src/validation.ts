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

function flattenSections(sections: (Section | Section[])[]): Section[] {
  return sections.flatMap((s) => (Array.isArray(s) ? s : [s]));
}

class ResponseValidationError extends Error {
  constructor(name: string, detail: string) {
    super(`@toolplex/app-server [${name}]: ${detail}`);
    this.name = "ResponseValidationError";
  }
}
