import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { AppServerConfig } from "./types.js";
import { validateConfig } from "./validation.js";
import { createAuthHook } from "./auth.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerContextRoutes } from "./routes/context.js";

async function appServerPlugin(
  fastify: FastifyInstance,
  config: AppServerConfig,
): Promise<void> {
  // Validate everything at startup — fail fast on misconfiguration
  validateConfig(config);

  // Apply bearer token auth to all routes in this plugin scope
  const authHook = createAuthHook(config.authToken);
  fastify.addHook("onRequest", authHook);

  // Register route groups
  registerPageRoutes(fastify, config);
  registerDataRoutes(fastify, config);
  registerActionRoutes(fastify, config);
  registerContextRoutes(fastify, config);

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

export const registerAppPages = fp(appServerPlugin, {
  name: "@toolplex/app-server",
  fastify: ">=5.0.0",
});
