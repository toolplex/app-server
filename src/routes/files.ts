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
