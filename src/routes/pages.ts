import type { FastifyInstance } from "fastify";
import type { PageDefinition, AppServerConfig } from "../types.js";
import { readUserHeaders } from "../user.js";

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

  /**
   * Freshness for EVERY page in one call.
   *
   * The page list itself is precomputed and free, but freshness comes from each
   * page's context handler, which is a live query. Fetching it per card would
   * be N round trips from the desktop; running it inline on /pages would make
   * the list as slow as its slowest handler and defeat that route's caching.
   *
   * So: one route, handlers run in PARALLEL, and the result cached briefly —
   * freshness moves on the order of minutes, and the pill it feeds rounds to
   * minutes anyway. A handler that throws or omits lastSync simply has no
   * entry, and the card renders without a pill rather than failing.
   */
  const FRESHNESS_TTL_MS = 60_000;
  let freshnessCache: { at: number; data: Record<string, string> } | null = null;

  fastify.get("/pages/freshness", async (request, reply) => {
    const now = Date.now();
    if (freshnessCache && now - freshnessCache.at < FRESHNESS_TTL_MS) {
      return reply.send(freshnessCache.data);
    }

    const user = readUserHeaders(request);
    const entries = await Promise.all(
      Object.entries(config.pages).map(async ([id, page]) => {
        if (!page.context) return null;
        try {
          // `sections` is required by the contract; empty means "page level
          // only", which is all the freshness timestamp needs.
          const ctx = await page.context({ sections: [], user });
          return ctx?.lastSync ? ([id, ctx.lastSync] as const) : null;
        } catch {
          // One page's handler failing must not cost every other page its
          // freshness — this whole response is decorative.
          return null;
        }
      }),
    );

    const data: Record<string, string> = {};
    for (const e of entries) if (e) data[e[0]] = e[1];
    freshnessCache = { at: now, data };
    return reply.send(data);
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
