import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppServerConfig } from "../types.js";
import { APP_ABILITIES } from "../apps/types.js";
import type { AppDefinition, SerializableApp } from "../apps/types.js";
import { readUserHeaders } from "../user.js";

/**
 * Serves the client's app catalogue. Like pages, the definitions are
 * precomputed and their server-side functions stripped; the pending counts
 * are live and come from a separate route so the catalogue itself stays free.
 */
export function registerAppRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
  /** Open-work counters supplied by each app's kind, used when the app defines none. */
  kindPending: Record<string, (abilities: string[]) => number> = {},
): void {
  const apps = config.apps ?? {};
  const serialized = buildSerializableApps(apps);

  fastify.get("/apps", async (_request, reply) => reply.send(serialized));

  fastify.get<{ Params: { appId: string } }>("/apps/:appId", async (request, reply) => {
    const app = serialized.find((a) => a.id === request.params.appId);
    if (!app) return reply.code(404).send({ error: "App not found" });
    return reply.send(app);
  });

  /**
   * Open work per app, for the count on each card. ToolPlex names the apps the
   * caller may open (?apps=a,b); with no list, every app is counted. Handlers
   * run in parallel; one that throws leaves its app without a count rather
   * than failing the rest.
   */
  fastify.get<{ Querystring: { apps?: string } }>("/apps/pending", async (request, reply) => {
    const user = readUserHeaders(request);
    const only = request.query?.apps?.split(",").filter(Boolean);
    const entries = await Promise.all(
      Object.entries(apps).map(async ([id, app]) => {
        const count = app.pending
          ? (abilities: string[]) => app.pending!({ user, abilities: abilities as never })
          : kindPending[id];
        if (!count || (only && !only.includes(id))) return null;
        try {
          const n = await count(readAbilities(request, app));
          return Number.isFinite(n) && n >= 0 ? ([id, Math.floor(n)] as const) : null;
        } catch {
          return null;
        }
      }),
    );
    const data: Record<string, number> = {};
    for (const e of entries) if (e) data[e[0]] = e[1];
    return reply.send(data);
  });
}

/**
 * What the caller may do in this app, as decided by ToolPlex from their role
 * and sent in `x-toolplex-app-abilities` ("*" or a comma-separated list).
 * Like the user headers, it is trusted as far as the bearer token is.
 *
 * A request with no header carries no person (a scheduled job, ops tooling)
 * and gets every ability; a request that names abilities gets only those the
 * kind defines.
 */
export function readAbilities<A extends string>(request: FastifyRequest, app: { kind: AppDefinition["kind"] }): A[] {
  const all = APP_ABILITIES[app.kind] as readonly string[];
  const raw = request.headers["x-toolplex-app-abilities"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === "*") return [...all] as A[];
  const asked = value.split(",").map((v) => v.trim());
  return all.filter((a) => asked.includes(a)) as A[];
}

/** Stable fingerprint of a JSON value: keys sorted, so order never changes it. */
export function configVersion(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, 16);
}

function buildSerializableApps(apps: Record<string, AppDefinition>): SerializableApp[] {
  return Object.entries(apps)
    .map(([id, app]): SerializableApp => {
      const { pending: _pending, config, sections, ...rest } = app;
      // The version covers everything that shapes a reading, including what
      // is kept on this server; what is served leaves the private parts out.
      const full = withoutFunctions(config);
      const served = withoutPrivate(full, app.kind);
      return {
        id,
        ...rest,
        abilities: [...APP_ABILITIES[app.kind]],
        // Only what a section is defined to hold, and only places that have
        // something in them. Outside the version: wording is not configuration.
        ...(servedSections(sections) ? { sections: servedSections(sections) } : {}),
        config_version: configVersion(full),
        config: served,
      };
    })
    .sort((a, b) => (a.nav_order ?? 0) - (b.nav_order ?? 0));
}

function servedSections(sections: AppDefinition["sections"]): SerializableApp["sections"] | undefined {
  const out: NonNullable<SerializableApp["sections"]> = {};
  for (const [place, blocks] of Object.entries(sections ?? {})) {
    const kept = (blocks ?? []).map((b) => ({ type: b.type, ...(b.title ? { title: b.title } : {}), text: b.text }));
    if (kept.length > 0) out[place] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A kind's configuration as a client may see it: every function removed,
 * along with any object that held nothing but functions (a map of hooks).
 * Generic on purpose, so serving an app never needs to know a kind's hook
 * names, and a hook added to a kind can never leak by being forgotten here.
 */
export function withoutFunctions(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (Array.isArray(value)) return value.map(withoutFunctions).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries
      .map(([k, v]) => [k, withoutFunctions(v)] as const)
      .filter(([, v]) => v !== undefined);
    if (entries.length > 0 && kept.length === 0) return undefined;
    return Object.fromEntries(kept);
  }
  return value;
}

/**
 * Parts of a kind's configuration that stay on this server: what the readers
 * are told (the client's background, each form's notes, how to recognise a
 * form, per-field hints). They go to the platform with each read and to
 * nobody's screen: a client app has no use for them, and they are the
 * client's working knowledge, not interface text.
 */
const PRIVATE_KEYS: Record<AppDefinition["kind"], readonly string[]> = {
  "document-encoding": ["context", "notes", "recognise", "hint"],
};

function withoutPrivate(value: unknown, kind: AppDefinition["kind"]): unknown {
  const hidden = PRIVATE_KEYS[kind];
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !hidden.includes(k))
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return strip(value);
}
