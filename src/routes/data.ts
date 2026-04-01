import type { FastifyInstance } from "fastify";
import type { AppServerConfig, PaginatedResponse } from "../types.js";
import { parseFetchParams } from "../parsing.js";
import { validateFetchResponse } from "../validation.js";

export function registerDataRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  fastify.get<{
    Params: { resource: string };
    Querystring: Record<string, string>;
  }>("/data/:resource", async (request, reply) => {
    const { resource } = request.params;
    const definition = config.resources[resource];

    if (!definition) {
      return reply.code(404).send({ error: `Resource "${resource}" not found` });
    }

    const params = parseFetchParams(request.query);
    const response = await definition.fetch(params);

    validateFetchResponse(resource, response);

    const result: PaginatedResponse = {
      rows: response.rows,
      total: response.total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.ceil(response.total / params.pageSize),
    };

    return reply.send(result);
  });
}
