import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { AppServerConfig } from "./types.js";
import { validateConfig } from "./validation.js";
import { createAuthHook } from "./auth.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerActionRoutes } from "./routes/actions.js";
import { aggregateContext, registerContextRoutes } from "./routes/context.js";
import { registerDownloadRoutes } from "./routes/download.js";
import { registerAnalyticsRoutes } from "./analytics/lookups.js";
import { appRecordsOf, bindAppRecords, checkQueryPages, recordSourcesByPage, withRecordFreshness, type RunningRecords } from "./apps/records/resource.js";
import { isRecordsQuery } from "./apps/records/kinds.js";
import { registerAppRoutes } from "./routes/apps.js";
import type { FileStore } from "./files/store.js";
import { createRequire } from "node:module";

const PKG_VERSION: string = (() => {
  try {
    return String(createRequire(import.meta.url)("../package.json").version ?? "");
  } catch {
    return "";
  }
})();

/**
 * What this server can do, for ToolPlex to gate features on. A server that
 * predates a capability simply 404s this route, which reads as "none".
 */
const CAPABILITIES = {
  /** POST /snapshots — page-wide pinned DuckDB files for alerts. */
  snapshots: true,
  /** Alerts (ToolPlex feature) can run against this server's pages. */
  alerts: true,
  /** GET /pages/freshness?fresh=1 bypasses the freshness cache. */
  freshFreshness: true,
  /** POST /snapshots/query — SQL across a page's album (history.<table>). */
  history: true,
  /** storage numbers are reported alongside capabilities. */
  storage: true,
} as const;

async function appServerPlugin(
  fastify: FastifyInstance,
  config: AppServerConfig,
): Promise<void> {
  // Validate everything at startup — fail fast on misconfiguration
  validateConfig(config);

  // Resources that read an app's records (appRecords) are given the running
  // app's query database, looked up per request so apps may start after the
  // routes. Pages that show such records report when the records changed.
  const running = new Map<string, RunningRecords>();
  const declared = config;
  const resources = bindAppRecords(config.resources, (appId) => running.get(appId));
  const changedAt = async (resource: string): Promise<string | null> => {
    const made = appRecordsOf(resources[resource]);
    const app = made ? running.get(made.appId) : undefined;
    return app ? app.runtime.changedAt() : null;
  };
  // A page with no context handler of its own still says what its sources say.
  const bound = { ...config, resources };
  config = { ...bound, pages: withRecordFreshness(config.pages, resources, changedAt, (sources, req) => aggregateContext(bound, sources, req)) };
  // The zone an app's records are counted by day in. Checked at startup: a
  // server with an app that keeps tables always has one (see validation).
  const timezone = declared.timezone ?? "UTC";
  /** The client's own queries over one app's records, by resource name (each becomes a view of that name). */
  const viewsOf = (appId: string): Record<string, { sql: string; label: string }> => {
    const views: Record<string, { sql: string; label: string }> = {};
    for (const [name, resource] of Object.entries(declared.resources)) {
      const made = appRecordsOf(resource);
      if (made && made.appId === appId && isRecordsQuery(made.options)) {
        views[name] = { sql: made.options.sql, label: made.options.label ?? `"${name}", a query of the client's own over these tables` };
      }
    }
    return views;
  };

  // Apply bearer token auth to all routes in this plugin scope
  const authHook = createAuthHook(config.authToken);
  fastify.addHook("onRequest", authHook);

  // File handling is on unless the host turned it off explicitly.
  const filesEnabled = config.files?.enabled !== false;

  // Register @fastify/multipart when either an action declares a file input
  // OR file handling is on — both parse multipart bodies. Lazy-imported so a
  // server that has turned both off doesn't need the dep.
  const hasApps = Object.keys(config.apps ?? {}).length > 0;
  if (hasFileInputs(config) || filesEnabled || hasApps) {
    const multipartModule = await import("@fastify/multipart").catch(() => {
      throw new Error(
        "@toolplex/app-server: @fastify/multipart is not installed. File handling is on by default " +
          "(and an action may declare a file input). Run `npm install @fastify/multipart`, " +
          "or pass `files: { enabled: false }` to run without it.",
      );
    });
    await fastify.register(multipartModule.default, {
      limits: {
        // Action file inputs keep their 100 MB; smart-file uploads apply the
        // store's own cap per request (routes/files.ts readFirstFile).
        fileSize: Math.max(100 * 1024 * 1024, config.files?.maxUploadBytes ?? 0),
        files: 50,
      },
    });
  }

  // Register route groups
  registerPageRoutes(fastify, config, () => recordSourcesByPage(declared, (appId) => running.get(appId)));
  registerDataRoutes(fastify, config);
  registerActionRoutes(fastify, config);
  registerContextRoutes(fastify, config);
  registerDownloadRoutes(fastify, config);
  // Analytics lookups for the ToolPlex analytics engine — only when the host configured them.
  if (config.analytics) registerAnalyticsRoutes(fastify, config.analytics);
  // Apps — the catalogue is served even when empty, so ToolPlex can tell
  // "no apps" from "a server that predates apps" (which 404s).
  // The file store, once created below. Apps reach chat attachments through it.
  let storeForStats: FileStore | null = null;

  // Each app's own routes come from its kind. They are registered first so
  // the catalogue can report open work the kind itself counts.
  const kindPending: Record<string, (abilities: string[]) => number> = {};
  // The processes that run SQL someone else wrote (see sandbox/supervisor.ts):
  // a few for the whole server, shared by the apps that keep tables and by
  // the file tool, and made when the first of those is set up.
  let processes: import("./sandbox/supervisor.js").QueryProcesses | null = null;
  const queryProcesses = async (wanted: boolean): Promise<typeof processes> => {
    if (!wanted || declared.isolateQueries === false) return null;
    if (!processes) {
      const { QueryProcesses } = await import("./sandbox/supervisor.js");
      const made = new QueryProcesses({ log: (level, message) => fastify.log[level](message) });
      processes = made;
      fastify.addHook("onClose", async () => {
        await made.close();
      });
    }
    return processes;
  };
  for (const [appId, app] of Object.entries(config.apps ?? {})) {
    if (app.kind === "document-encoding") {
      const { registerEncodingApp } = await import("./apps/encoding/routes.js");
      const runtime = await registerEncodingApp(fastify, config, appId, app, () => storeForStats, { timezone, views: viewsOf(appId), processes: await queryProcesses(app.records === true) });
      kindPending[appId] = (abilities) => runtime.pending(abilities as never);
      if (runtime.records) running.set(appId, runtime.records);
    }
  }
  // What could only be checked with the apps running: that the tables on a
  // page ask a client's own query for columns it returns.
  const wrong = checkQueryPages(declared, (appId) => running.get(appId));
  if (wrong.length > 0) throw new Error(`@toolplex/app-server configuration errors:\n  - ${wrong.join("\n  - ")}`);
  registerAppRoutes(fastify, config, kindPending);

  // File handling — ingest CSV/XLSX/documents into an isolated, read-only
  // DuckDB db and expose manifest + read-only SQL. Encapsulated in its own
  // scope so its FileStoreError → HTTP-status error handler doesn't shadow
  // the plugin-level one for the other route groups.
  // Alerts, snapshots and history all live in the file store: a server that
  // turned it off reports none of them, and ToolPlex hides the alerts UI.
  const capabilities = {
    ...(filesEnabled ? CAPABILITIES : { ...CAPABILITIES, snapshots: false, alerts: false, history: false, storage: false }),
    /** GET /analytics/schema, POST /analytics/distinct, /analytics/repeats, /analytics/latest. */
    analytics: !!config.analytics,
    /** GET /apps — this server declares at least one app. */
    apps: Object.keys(config.apps ?? {}).length > 0,
  };
  fastify.get("/capabilities", async () => ({
    version: PKG_VERSION,
    capabilities,
    // The zone this server counts days in, when it was told one: so ToolPlex
    // can compare it with the organization's own.
    ...(declared.timezone ? { timezone: declared.timezone } : {}),
    ...(storeForStats
      ? {
          storage: await storeForStats.storage(),
          // What a client may send, so it can refuse an oversized file before
          // transferring it instead of learning the limit from a 413.
          limits: {
            maxUploadBytes: storeForStats.config.maxUploadBytes,
            maxIngestRows: storeForStats.config.maxIngestRows,
            maxQueryRows: storeForStats.config.maxQueryRows,
          },
        }
      : {}),
  }));

  if (filesEnabled) {
    // The file store pulls in DuckDB (a ~70 MB native library) and ExcelJS.
    // Loaded here, only when files are on, so a server that turned them off
    // starts light and the cost shows up where it belongs.
    const [{ FileStore }, { registerFileRoutes }, { registerSnapshotRoutes }] = await Promise.all([
      import("./files/store.js"),
      import("./routes/files.js"),
      import("./routes/snapshots.js"),
    ]);
    const store = new FileStore(config.files ?? {}, {
      timezone: declared.timezone,
      isolate: declared.isolateQueries !== false,
      processes: await queryProcesses(true),
      log: (level, message) => fastify.log[level](message),
    });
    await store.init();
    storeForStats = store;
    await fastify.register(async (filesScope) => {
      registerFileRoutes(filesScope, config, store);
      // Page snapshots for ToolPlex alerts (whole page → one pinned file).
      registerSnapshotRoutes(filesScope, config, store);
    });
    store.startCleanup((msg) => fastify.log.info(msg));
    fastify.addHook("onClose", async () => {
      store.stopCleanup();
      await store.close();
    });
  }

  // One started now, so the first query does not wait for it, and a host
  // that cannot start one is known, and said, as the server starts.
  (processes as import("./sandbox/supervisor.js").QueryProcesses | null)?.warm();

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
