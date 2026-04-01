import type { FastifyInstance } from "fastify";
import type { PageDefinition, AppServerConfig } from "../types.js";

/**
 * Serves page definitions. Context handlers are stripped since they're
 * server-side functions that can't be serialized to JSON.
 */
export function registerPageRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  const serialized = buildSerializablePages(config);

  fastify.get("/pages", async (_request, reply) => {
    return reply.send(serialized);
  });

  fastify.get<{ Params: { pageId: string } }>(
    "/pages/:pageId",
    async (request, reply) => {
      const page = serialized.find((p) => p.id === request.params.pageId);
      if (!page) {
        return reply.code(404).send({ error: "Page not found" });
      }
      return reply.send(page);
    },
  );
}

// ---------------------------------------------------------------------------
// Strip non-serializable fields and inject the id from the config key
// ---------------------------------------------------------------------------

type SerializablePage = Omit<PageDefinition, "context">;

function buildSerializablePages(
  config: AppServerConfig,
): SerializablePage[] {
  return Object.entries(config.pages).map(([id, page]) => {
    const { context: _context, ...rest } = page;
    return { id, ...rest };
  });
}
