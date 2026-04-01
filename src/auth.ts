import type { FastifyRequest, FastifyReply } from "fastify";

export function createAuthHook(expectedToken: string) {
  return async function verifyBearerToken(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      reply
        .code(401)
        .send({ error: "Missing or malformed Authorization header" });
      return reply;
    }

    const token = header.slice(7);

    if (token !== expectedToken) {
      reply.code(401).send({ error: "Invalid token" });
      return reply;
    }
  };
}
