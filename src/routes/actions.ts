import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppServerConfig, UploadedFile } from "../types.js";
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

    validateActionResponse(action, response);

    return reply.send(response);
  });
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
