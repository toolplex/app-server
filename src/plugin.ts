import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { AppServerConfig } from "./types.js";
import { validateConfig } from "./validation.js";
import { createAuthHook } from "./auth.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerDownloadRoutes } from "./routes/download.js";
import { registerFileRoutes } from "./routes/files.js";
import { FileStore } from "./files/store.js";

async function appServerPlugin(
  fastify: FastifyInstance,
  config: AppServerConfig,
): Promise<void> {
  // Validate everything at startup — fail fast on misconfiguration
  validateConfig(config);

  // Apply bearer token auth to all routes in this plugin scope
  const authHook = createAuthHook(config.authToken);
  fastify.addHook("onRequest", authHook);

  // Register @fastify/multipart when either an action declares a file input
  // OR the smart file-attachment feature is enabled — both parse multipart
  // bodies. Lazy-imported so consumers that use neither don't need the dep.
  if (hasFileInputs(config) || config.files?.enabled) {
    const multipartModule = await import("@fastify/multipart").catch(() => {
      throw new Error(
        "@toolplex/app-server: an action declares a file input but " +
          "@fastify/multipart is not installed. Run `npm install @fastify/multipart`.",
      );
    });
    await fastify.register(multipartModule.default, {
      limits: {
        // 100MB per file is plenty for distributor Excel uploads.
        fileSize: 100 * 1024 * 1024,
        files: 50,
      },
    });
  }

  // Register route groups
  registerPageRoutes(fastify, config);
  registerDataRoutes(fastify, config);
  registerActionRoutes(fastify, config);
  registerContextRoutes(fastify, config);
  registerDownloadRoutes(fastify, config);

  // Smart file-attachment feature — ingest CSV/XLSX into an isolated,
  // read-only DuckDB db and expose manifest + read-only SQL. Encapsulated in
  // its own scope so its FileStoreError → HTTP-status error handler doesn't
  // shadow the plugin-level one for the other route groups.
  if (config.files?.enabled) {
    const store = new FileStore(config.files);
    await store.init();
    await fastify.register(async (filesScope) => {
      registerFileRoutes(filesScope, config, store);
    });
    store.startCleanup((msg) => fastify.log.info(msg));
    fastify.addHook("onClose", async () => {
      store.stopCleanup();
    });
  }

  // Catch handler errors and return structured responses
  fastify.setErrorHandler(async (error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    const message =
      status >= 500
        ? "Internal server error in app-server handler"
        : error.message;

    fastify.log.error(
      { err: error, statusCode: status },
      "app-server handler error",
    );

    return reply.code(status).send({ error: message });
  });
}

function hasFileInputs(config: AppServerConfig): boolean {
  for (const page of Object.values(config.pages)) {
    for (const action of page.actions ?? []) {
      for (const input of action.inputs ?? []) {
        if (input.type === "file") return true;
      }
    }
    for (const section of flattenSections(page.sections)) {
      if (section.type !== "table") continue;
      for (const action of section.actions ?? []) {
        for (const input of action.inputs ?? []) {
          if (input.type === "file") return true;
        }
      }
    }
  }
  return false;
}

/**
 * Flatten a page's sections to leaf sections — recursively descends
 * through SectionGroup containers so callers always get non-group
 * sections back. Generic so it can be used for any section-like type
 * that may have a "group" variant with a nested `sections` field.
 */
function flattenSections<T extends { type?: string }>(
  sections: (T | T[])[],
): T[] {
  const result: T[] = [];
  for (const entry of sections) {
    const items = Array.isArray(entry) ? entry : [entry];
    for (const section of items) {
      if (
        section?.type === "group" &&
        "sections" in section &&
        Array.isArray((section as { sections?: unknown }).sections)
      ) {
        result.push(
          ...flattenSections<T>(
            (section as unknown as { sections: (T | T[])[] }).sections,
          ),
        );
      } else {
        result.push(section);
      }
    }
  }
  return result;
}

export const registerAppPages = fp(appServerPlugin, {
  name: "@toolplex/app-server",
  fastify: ">=5.0.0",
});
