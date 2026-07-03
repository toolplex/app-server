import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppServerConfig, UploadedFile } from "../types.js";
import { readUserHeaders } from "../user.js";
import { FileStore, FileStoreError, type Requester } from "../files/store.js";

// ---------------------------------------------------------------------------
// File routes — upload, manifest, read-only query, delete.
//
// Mounted only when config.files?.enabled. All routes inherit the plugin's
// bearer-token auth hook. The FileStore owns ingestion, the DuckDB sandbox,
// and TTL cleanup. See src/files/ for the implementation.
// ---------------------------------------------------------------------------

export function registerFileRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
  store: FileStore,
): void {
  // POST /files — multipart upload. Field name is flexible: the first file
  // part wins. Returns the manifest the desktop injects into chat context.
  fastify.post("/files", async (request, reply) => {
    const file = await readFirstFile(request);
    if (!file) {
      return reply.code(400).send({ error: "No file found in the upload." });
    }
    const manifest = await store.ingest(file.filename, file.buffer, requesterOf(request));
    return reply.send({ manifest });
  });

  // GET /files — list the caller's uploaded files (manifests).
  fastify.get("/files", async (request, reply) => {
    const files = await store.list(requesterOf(request));
    return reply.send({ files });
  });

  // GET /files/:id/manifest — re-fetch a single manifest.
  fastify.get<{ Params: { id: string } }>(
    "/files/:id/manifest",
    async (request, reply) => {
      const manifest = await store.getManifest(request.params.id, requesterOf(request));
      return reply.send({ manifest });
    },
  );

  // POST /files/:id/query — run one read-only SQL statement against the file.
  fastify.post<{ Params: { id: string }; Body: { sql?: string } }>(
    "/files/:id/query",
    async (request, reply) => {
      const sql = request.body?.sql;
      if (typeof sql !== "string") {
        return reply.code(400).send({ error: "Body must include a 'sql' string." });
      }
      const result = await store.query(request.params.id, sql, requesterOf(request));
      return reply.send(result);
    },
  );

  // DELETE /files/:id — remove an upload (powers the desktop's cancel/remove).
  // Idempotent: deleting an unknown / expired file is a success.
  fastify.delete<{ Params: { id: string } }>(
    "/files/:id",
    async (request, reply) => {
      await store.delete(request.params.id, requesterOf(request));
      return reply.send({ deleted: true });
    },
  );

  // -------------------------------------------------------------------------
  // Artifacts — durable, pinned snapshots (never TTL-swept). Same DuckDB store
  // as files, so an artifact is queryable exactly like a smart file.
  // -------------------------------------------------------------------------

  // POST /artifacts — materialize JSON rows into a pinned DuckDB snapshot.
  fastify.post<{ Body: { tableName?: string; rows?: Record<string, unknown>[] } }>(
    "/artifacts",
    async (request, reply) => {
      const rows = request.body?.rows;
      if (!Array.isArray(rows)) {
        return reply.code(400).send({ error: "Body must include a 'rows' array." });
      }
      const manifest = await store.materialize(
        request.body?.tableName || "data",
        rows,
        requesterOf(request),
      );
      return reply.send({ manifest });
    },
  );

  // POST /artifacts/:id/query — run one read-only SQL statement (ask follow-ups).
  fastify.post<{ Params: { id: string }; Body: { sql?: string } }>(
    "/artifacts/:id/query",
    async (request, reply) => {
      const sql = request.body?.sql;
      if (typeof sql !== "string") {
        return reply.code(400).send({ error: "Body must include a 'sql' string." });
      }
      const result = await store.query(request.params.id, sql, requesterOf(request));
      return reply.send(result);
    },
  );

  // GET /artifacts/:id/data — the artifact's rows for the viewer (SELECT * LIMIT).
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/artifacts/:id/data",
    async (request, reply) => {
      const manifest = await store.getManifest(request.params.id, requesterOf(request));
      const table = manifest.tables[0];
      if (!table) {
        return reply.code(404).send({ error: "Artifact has no data table." });
      }
      const limit = Math.min(Math.max(Number(request.query.limit) || 1000, 1), 5000);
      const result = await store.query(
        request.params.id,
        `SELECT * FROM "${table.name}" LIMIT ${limit}`,
        requesterOf(request),
      );
      return reply.send({ manifest, ...result });
    },
  );

  // DELETE /artifacts/:id — remove a pinned snapshot. Idempotent.
  fastify.delete<{ Params: { id: string } }>(
    "/artifacts/:id",
    async (request, reply) => {
      await store.delete(request.params.id, requesterOf(request));
      return reply.send({ deleted: true });
    },
  );

  // GET /artifacts/:id/rows — server-side paginated/sorted/filtered page of an
  // artifact, so tables of any size stream a page at a time. Query params match
  // the desktop's page-data contract: page, pageSize, sort=key,dir, and column
  // filters as _cf_<col>__<op>=value. Returns { rows, total, page, pageSize,
  // totalPages, columns }.
  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    "/artifacts/:id/rows",
    async (request, reply) => {
      const q = request.query;
      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(Math.max(Number(q.pageSize) || 100, 1), 1000);

      let sort: { key: string; direction: "asc" | "desc" } | undefined;
      if (typeof q.sort === "string" && q.sort.includes(",")) {
        const [key, dir] = q.sort.split(",");
        if (key) sort = { key, direction: dir === "desc" ? "desc" : "asc" };
      }

      const filters: { column: string; operator: string; value: string }[] = [];
      for (const [k, v] of Object.entries(q)) {
        if (!k.startsWith("_cf_") || typeof v !== "string") continue;
        const rest = k.slice(4);
        const idx = rest.indexOf("__");
        if (idx === -1) continue;
        const operator = rest.slice(idx + 2);
        // empty / not_empty carry no value; the rest need one.
        if (v === "" && operator !== "empty" && operator !== "not_empty") continue;
        filters.push({ column: rest.slice(0, idx), operator, value: v });
      }

      const result = await store.queryRows(request.params.id, requesterOf(request), {
        page,
        pageSize,
        sort,
        filters,
      });
      const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
      return reply.send({
        rows: result.rows,
        total: result.total,
        page,
        pageSize,
        totalPages,
        columns: result.columns,
      });
    },
  );

  // POST /datasets/resolve — materialize a PINNED snapshot from a report file
  // the app-server can read (the report → artifact "pull" path). The pointer
  // path is allowlisted against config.reportDirs. Returns the same manifest
  // shape as an upload, so downstream it's queryable exactly like a smart file.
  fastify.post<{ Body: { pointer?: { source?: string; ref?: string } } }>(
    "/datasets/resolve",
    async (request, reply) => {
      const pointer = request.body?.pointer;
      if (!pointer || pointer.source !== "path" || typeof pointer.ref !== "string") {
        return reply
          .code(400)
          .send({ error: "Body must include pointer { source: 'path', ref: '<path>' }." });
      }
      const manifest = await store.resolveFromPath(pointer.ref, requesterOf(request));
      return reply.send({ manifest });
    },
  );

  // Map FileStoreError → its HTTP status. Other errors fall through to the
  // plugin-level handler (500). Scoped to this encapsulated route context.
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _req, reply: FastifyReply) => {
    if (error instanceof FileStoreError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    fastify.log.error({ err: error }, "app-server file route error");
    const status = error.statusCode ?? 500;
    return reply
      .code(status)
      .send({ error: status >= 500 ? "Internal server error" : error.message });
  });

  void config;
}

function requesterOf(request: FastifyRequest): Requester {
  const user = readUserHeaders(request);
  return { userId: user?.id, orgId: user?.orgId };
}

/**
 * Pull the first file part out of a multipart request. Mirrors the actions
 * route's parsing but only cares about the file — ids/filters/params aren't
 * meaningful for a raw attachment upload.
 */
async function readFirstFile(request: FastifyRequest): Promise<UploadedFile | null> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new FileStoreError(
      400,
      "Upload must be multipart/form-data with a file part.",
    );
  }

  type WithParts = FastifyRequest & {
    parts?: () => AsyncIterable<MultipartPart>;
  };
  const reqWithParts = request as WithParts;
  if (typeof reqWithParts.parts !== "function") {
    throw new FileStoreError(
      500,
      "multipart not registered — files feature requires @fastify/multipart.",
    );
  }

  for await (const part of reqWithParts.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      return {
        filename: part.filename ?? "upload",
        mimetype: part.mimetype ?? "application/octet-stream",
        size: buffer.length,
        buffer,
      };
    }
  }
  return null;
}

interface MultipartPart {
  type: "file" | "field";
  fieldname: string;
  filename?: string;
  mimetype?: string;
  value?: unknown;
  toBuffer(): Promise<Buffer>;
}
