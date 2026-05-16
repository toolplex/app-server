import type { FastifyInstance } from "fastify";
import type { AppServerConfig, ContextResponse, Section } from "../types.js";
import { parseContextParams } from "../parsing.js";
import { readUserHeaders } from "../user.js";

export function registerContextRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  // Resource-level context
  fastify.get<{
    Params: { resource: string };
    Querystring: Record<string, string>;
  }>("/context/:resource", async (request, reply) => {
    const { resource } = request.params;
    const definition = config.resources[resource];

    if (!definition?.context) {
      return reply
        .code(404)
        .send({ error: `No context handler for resource "${resource}"` });
    }

    const params = parseContextParams(request.query);
    const user = readUserHeaders(request);
    const response = await definition.context({ ...params, user });
    return reply.send(response);
  });

  // Page-level context
  fastify.get<{
    Params: { pageId: string };
    Querystring: Record<string, string>;
  }>("/context/page/:pageId", async (request, reply) => {
    const { pageId } = request.params;
    const page = config.pages[pageId];

    if (!page) {
      return reply.code(404).send({ error: `Page "${pageId}" not found` });
    }

    const params = parseContextParams(request.query);
    const user = readUserHeaders(request);
    const sectionSources = uniqueSources(page.sections);

    // If page has a dedicated context handler, use it
    if (page.context) {
      const response = await page.context({ ...params, sections: sectionSources, user });
      return reply.send(response);
    }

    // Fallback: aggregate resource-level context handlers
    const response = await aggregateContext(config, sectionSources, { ...params, user });
    return reply.send(response);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect unique `source` strings from a page's sections.
 *  Descends through SectionGroup containers, which themselves don't
 *  have a source. */
function uniqueSources(sections: (Section | Section[])[]): string[] {
  const sources = new Set<string>();
  const walk = (items: (Section | Section[])[]) => {
    for (const entry of items) {
      const list = Array.isArray(entry) ? entry : [entry];
      for (const section of list) {
        if (section.type === "group") {
          walk(section.sections);
        } else {
          sources.add(section.source);
        }
      }
    }
  };
  walk(sections);
  return [...sources];
}

async function aggregateContext(
  config: AppServerConfig,
  sources: string[],
  params: {
    filters?: Record<string, string>;
    selection?: { type: "row" | "rows"; ids?: (string | number)[] };
    user?: import("../types.js").UserIdentity;
  },
): Promise<ContextResponse> {
  const summaries: string[] = [];
  let selectionText: string | undefined;
  const suggestions: string[] = [];

  for (const source of sources) {
    const handler = config.resources[source]?.context;
    if (!handler) continue;

    const result = await handler(params);
    if (result.summary) summaries.push(result.summary);
    if (result.selection && !selectionText) selectionText = result.selection;
    if (result.suggestions) suggestions.push(...result.suggestions);
  }

  return {
    summary: summaries.join(" "),
    selection: selectionText,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}
