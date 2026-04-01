import type { FastifyInstance } from "fastify";
import type { AppServerConfig } from "../types.js";
import { validateActionResponse } from "../validation.js";

export function registerActionRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  fastify.post<{
    Params: { action: string };
    Body: { ids?: (string | number)[]; params?: Record<string, unknown>; filters?: Record<string, string> };
  }>("/actions/:action", async (request, reply) => {
    const { action } = request.params;
    const handler = config.actions[action];

    if (!handler) {
      return reply.code(404).send({ error: `Action "${action}" not found` });
    }

    const { ids, params, filters } = request.body ?? {};

    const response = await handler({
      ids: Array.isArray(ids) ? ids : [],
      params: params ?? {},
      filters: filters ?? {},
    });

    validateActionResponse(action, response);

    return reply.send(response);
  });
}
