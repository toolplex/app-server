import { createReadStream, existsSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActionResponse,
  AppServerConfig,
  FileActionResponse,
  UploadedFile,
} from "../types.js";
import { validateActionResponse } from "../validation.js";
import { readUserHeaders } from "../user.js";

interface JsonActionBody {
  ids?: (string | number)[];
  params?: Record<string, unknown>;
  filters?: Record<string, string>;
}

export function registerActionRoutes(
  fastify: FastifyInstance,
  config: AppServerConfig,
): void {
  fastify.post<{
    Params: { action: string };
    Body: unknown;
  }>("/actions/:action", async (request, reply) => {
    const { action } = request.params;
    const handler = config.actions[action];

    if (!handler) {
      return reply.code(404).send({ error: `Action "${action}" not found` });
    }

    const contentType = request.headers["content-type"] ?? "";
    const isMultipart = contentType.startsWith("multipart/form-data");

    let ids: (string | number)[] = [];
    let params: Record<string, unknown> = {};
    let filters: Record<string, string> = {};
    let files: Record<string, UploadedFile[]> | undefined;

    if (isMultipart) {
      const parsed = await parseMultipart(request);
      ids = parsed.ids;
      params = parsed.params;
      filters = parsed.filters;
      files = parsed.files;
    } else {
      const body = (request.body as JsonActionBody) ?? {};
      ids = Array.isArray(body.ids) ? body.ids : [];
      params = body.params ?? {};
      filters = body.filters ?? {};
    }

    const user = readUserHeaders(request);
    const response = await handler({ ids, params, filters, files, user });

    // File responses are streamed; everything else goes through standard
    // JSON validation + send. The handler tags file responses with
    // `type: "file"` so the route can disambiguate the union.
    if (isFileResponse(response)) {
      return sendFileResponse(reply, response, action);
    }

    validateActionResponse(action, response);

    return reply.send(response);
  });
}

// --------------------------------------------------------------------------
// File response handling
// --------------------------------------------------------------------------

function isFileResponse(r: ActionResponse): r is FileActionResponse {
  return (
    typeof r === "object" &&
    r !== null &&
    (r as { type?: string }).type === "file"
  );
}

function sendFileResponse(
  reply: FastifyReply,
  response: FileActionResponse,
  actionName: string,
): unknown {
  // Validate the payload: must have exactly one of path or buffer.
  if (!response.path && !response.buffer) {
    throw new Error(
      `action "${actionName}" returned a file response with neither path nor buffer set`,
    );
  }
  if (response.path && response.buffer) {
    throw new Error(
      `action "${actionName}" returned a file response with both path and buffer; pick one`,
    );
  }

  const mimetype = response.mimetype ?? "application/octet-stream";
  const filename =
    response.filename ??
    (response.path ? basename(response.path) : "download.bin");
  // Sanitise filename for Content-Disposition (must be ASCII-safe; quotes
  // escaped). Non-ASCII chars are replaced with underscores so the
  // header itself is safe; the desktop can apply its own UTF-8 handling.
  const safeFilename = filename.replace(/[\x00-\x1f"\\]/g, "_");

  reply
    .header("Content-Type", mimetype)
    .header(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`,
    );

  if (response.buffer) {
    reply.header("Content-Length", String(response.buffer.length));
    return reply.send(response.buffer);
  }

  // Path-based response. The handler is responsible for path safety
  // (allowlisting, traversal checks) — the route just streams.
  const filePath = response.path!;
  if (!existsSync(filePath)) {
    throw new Error(
      `action "${actionName}" returned a file response pointing at a missing path: ${filePath}`,
    );
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(
      `action "${actionName}" returned a file response that is not a file: ${filePath}`,
    );
  }
  reply.header("Content-Length", String(st.size));
  return reply.send(createReadStream(filePath));
}

/**
 * Multipart action body convention:
 *   - `_ids`     — JSON-encoded array of row IDs (optional; defaults to [])
 *   - `_filters` — JSON-encoded filter object (optional; defaults to {})
 *   - `_params`  — JSON-encoded extra params (optional; merged with form fields)
 *   - Any non-file form field becomes params[key] (string value).
 *   - Any file field becomes files[key] (UploadedFile[] — single-element array
 *     for single-file inputs, multi-element for `multiple: true`).
 *
 * Why this shape: lets the desktop send a single FormData with files as
 * top-level parts (so the browser/native picker integrates cleanly) while
 * still carrying the structured ids/filters that JSON actions use.
 */
async function parseMultipart(request: FastifyRequest): Promise<{
  ids: (string | number)[];
  params: Record<string, unknown>;
  filters: Record<string, string>;
  files: Record<string, UploadedFile[]>;
}> {
  // The host server registers @fastify/multipart on plugin init when any
  // action declares file inputs. If not registered here, it's a misconfig.
  type WithMultipart = FastifyRequest & {
    parts?: () => AsyncIterable<MultipartPart>;
  };
  const reqWithParts = request as WithMultipart;
  if (typeof reqWithParts.parts !== "function") {
    throw new Error(
      "multipart request received but @fastify/multipart is not registered. " +
        "registerAppPages must be called with at least one action that has type:'file' inputs.",
    );
  }

  const params: Record<string, unknown> = {};
  const files: Record<string, UploadedFile[]> = {};
  let ids: (string | number)[] = [];
  let filters: Record<string, string> = {};

  for await (const part of reqWithParts.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      const upload: UploadedFile = {
        filename: part.filename ?? "",
        mimetype: part.mimetype ?? "application/octet-stream",
        size: buffer.length,
        buffer,
      };
      const existing = files[part.fieldname];
      if (existing) existing.push(upload);
      else files[part.fieldname] = [upload];
    } else {
      const fieldname = part.fieldname;
      const value = String(part.value ?? "");
      if (fieldname === "_ids") {
        ids = parseJsonArray(value, []) as (string | number)[];
      } else if (fieldname === "_filters") {
        const parsed = parseJsonObject(value);
        filters = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)]),
        );
      } else if (fieldname === "_params") {
        const parsed = parseJsonObject(value);
        Object.assign(params, parsed);
      } else {
        // Arbitrary text inputs end up as string params.
        params[fieldname] = value;
      }
    }
  }

  return { ids, params, filters, files };
}

interface MultipartPart {
  type: "file" | "field";
  fieldname: string;
  filename?: string;
  mimetype?: string;
  value?: unknown;
  toBuffer(): Promise<Buffer>;
}

function parseJsonArray(s: string, fallback: unknown[]): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
