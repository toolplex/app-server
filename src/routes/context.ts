import type { FastifyInstance } from "fastify";
import type { AppServerConfig, ContextResponse, Section } from "../types.js";
import { parseContextParams } from "../parsing.js";

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
    const response = await definition.context(params);
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
    const sectionSources = uniqueSources(page.sections);

    // If page has a dedicated context handler, use it
    if (page.context) {
      const response = await page.context({ ...params, sections: sectionSources });
      return reply.send(response);
    }

    // Fallback: aggregate resource-level context handlers
    const response = await aggregateContext(config, sectionSources, params);
    return reply.send(response);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSources(sections: (Section | Section[])[]): string[] {
  const sources = new Set<string>();
  for (const entry of sections) {
    const items = Array.isArray(entry) ? entry : [entry];
    for (const section of items) {
      sources.add(section.source);
    }
  }
  return [...sources];
}

async function aggregateContext(
  config: AppServerConfig,
  sources: string[],
  params: { filters?: Record<string, string>; selection?: { type: "row" | "rows"; ids?: (string | number)[] } },
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
