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

async function appServerPlugin(
  fastify: FastifyInstance,
  config: AppServerConfig,
): Promise<void> {
  // Validate everything at startup — fail fast on misconfiguration
  validateConfig(config);

  // Apply bearer token auth to all routes in this plugin scope
  const authHook = createAuthHook(config.authToken);
  fastify.addHook("onRequest", authHook);

  // If any action declares a file input, register @fastify/multipart so
  // /actions/:action can parse multipart bodies. Lazy-imported so plugin
  // consumers that don't use file inputs don't need the dependency.
  if (hasFileInputs(config)) {
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

function flattenSections<T>(sections: (T | T[])[]): T[] {
  return sections.flatMap((s) => (Array.isArray(s) ? s : [s]));
}

export const registerAppPages = fp(appServerPlugin, {
  name: "@toolplex/app-server",
  fastify: ">=5.0.0",
});
