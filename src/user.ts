import type { FastifyRequest } from "fastify";
import type { UserIdentity } from "./types.js";

/**
 * Read user identity from the three X-Toolplex-User-* headers the
 * toolplex-api proxy injects. Returns undefined when any of the
 * mandatory fields (id, email) is missing — system / out-of-band
 * callers don't carry user identity, and handlers must decide how to
 * react to that on a case-by-case basis.
 *
 * No verification happens here: trust flows from the connection-level
 * bearer token (createAuthHook) — once we've accepted that the caller
 * IS the proxy, we accept what the proxy attests about who is behind
 * the request. See UserIdentity for the full rationale.
 */
export function readUserHeaders(request: FastifyRequest): UserIdentity | undefined {
  const id = headerString(request, "x-toolplex-user-id");
  const email = headerString(request, "x-toolplex-user-email");
  if (!id || !email) return undefined;
  const orgId = headerString(request, "x-toolplex-org-id");
  return orgId ? { id, email, orgId } : { id, email };
}

/**
 * The org attestation alone. Org is the ISOLATION boundary; user id/email
 * are attribution — and org-only callers exist (toolplex-api's artifact
 * retention sweep sends no user identity). Reading org only through
 * readUserHeaders dropped it for those callers, leaving their requests
 * un-scoped and quietly dependent on the ownership check's fail-open rows.
 */
export function readOrgHeader(request: FastifyRequest): string | undefined {
  return headerString(request, "x-toolplex-org-id");
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (raw == null) return undefined;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}
