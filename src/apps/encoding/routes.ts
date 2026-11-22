// ---------------------------------------------------------------------------
// Document encoding — the routes an app's interface calls, and the queue
// that sends new documents to the platform to be read.
//
// Every route sits under /apps/:appId/document-encoding and checks what the caller may
// do there (capture, review, approve), as ToolPlex reports it. Looking needs
// no ability beyond being able to open the app, which ToolPlex has already
// decided before the request reaches this server.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppServerConfig, UserIdentity } from "../../types.js";
import type {
  DocumentEncodingApp,
  DocumentEncodingConfig,
  EncodingAbility,
  EncodingChange,
  EncodingDocumentSnapshot,
  EncodingHandle,
  EncodingRecord,
} from "../types.js";
import type { FileStore } from "../../files/store.js";
import { registerEncodingAgentTools } from "./agent.js";
import { readAbilities, configVersion, withoutFunctions } from "../../routes/apps.js";
import { readOrgHeader, readUserHeaders } from "../../user.js";
import { EncodingStore, type IndexEntry, type Reading, type ReceivedFile, type Scalar, type StoredDocument } from "./store.js";
import {
  applyReading,
  calibration,
  calibrationOf,
  checkedReading,
  coerce,
  currentChecks,
  groupOf,
  openQuestions,
  raiseFlags,
  readValueAt,
  same,
  setValueAt,
  valueAt,
  valuePaths,
} from "./logic.js";

/** What the platform is asked for one document. */
export interface ReadDocumentRequest {
  pages: { mime: string; data: string }[];
  documents: DocumentEncodingConfig["documents"];
  document_type?: string;
  /** Background for the readers (see DocumentEncodingConfig.context). */
  context?: string;
  lists: Record<string, string[]>;
  today: string;
}

export type ReadDocument = (req: ReadDocumentRequest) => Promise<Reading>;

const PAGE_MIME = /^image\/(jpeg|png|webp)$/;
const DEFAULT_ACCEPT = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"];
const MAX_PAGES_PER_UPLOAD = 200;
/** A name joins a list once this many approved records carry it: one or two could be the same slip. */
const LEARN_AFTER = 3;
/** How long a client's own hook may take before the app stops waiting for it. */
/** Set on the reply to a request that changed what an app holds. */
export const APP_CHANGED_HEADER = "x-toolplex-app-changed";

const HOOK_TIMEOUT_MS = 30_000;

/** Wait for a client's hook, but not for ever: one that never returns must not hold up everyone's documents. */
function within<T>(work: Promise<T> | T, what: string, ms = HOOK_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(work),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} seconds`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
/** The list a name field with no configured list learns into. */
const learnedListFor = (docType: string, path: string) => `~${docType}.${path}`;
const READ_CONCURRENCY = 2;

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

/** The platform's reader, over HTTP. */
function platformReader(config: AppServerConfig): ReadDocument {
  return async (req) => {
    const apiKey = config.platform?.apiKey;
    if (!apiKey) throw new Error("No ToolPlex API key is configured for reading documents (platform.apiKey)");
    const base = (config.platform?.baseUrl ?? "https://api.toolplex.ai").replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch(`${base}/ai/documents/read`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(req),
      });
      const body = (await res.json().catch(() => null)) as (Reading & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Reading failed (${res.status})`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

function summary(doc: IndexEntry, config: DocumentEncodingConfig) {
  const spec = doc.documentType ? config.documents[doc.documentType] : undefined;
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    error: doc.error,
    document_type: doc.documentType,
    document_type_title: spec?.title ?? null,
    group: doc.group,
    batch: doc.batch,
    created_at: doc.createdAt,
    created_by: doc.createdBy,
    pages: doc.pages,
    ask: doc.ask,
    confirm: doc.confirm,
    version: doc.version,
    approved_at: doc.approvedAt,
  };
}

export async function registerEncodingApp(
  fastify: FastifyInstance,
  config: AppServerConfig,
  appId: string,
  app: DocumentEncodingApp,
  /** The file store chat attachments live in, once it exists. */
  fileStore: () => FileStore | null,
): Promise<{ pending: (abilities: EncodingAbility[]) => number }> {
  const cfg = app.config;
  // What a client was served; records keep this to stay interpretable.
  const version = configVersion(withoutFunctions(cfg));
  const root = resolve(config.files?.dir ?? join(homedir(), ".toolplex-app-files"), "apps", appId);
  const store = new EncodingStore(root, appId, {
    // What the index keeps per document that only this configuration can say.
    describe: (doc) => {
      const questions = openQuestions(doc, doc.documentType ? cfg.documents[doc.documentType] : undefined);
      return {
        ask: questions.filter((q) => q.kind === "ask").length,
        confirm: questions.filter((q) => q.kind === "confirm").length,
        cal: calibrationOf(doc),
      };
    },
    version,
    log: (message) => fastify.log.info({ appId }, `document-encoding: ${message}`),
  });
  // Reading the index is quick; rebuilding it (first start after an upgrade,
  // a restore) can take a while with years of documents. Either way the
  // server starts at once and this app's requests wait for it.
  let isReady = false;
  const ready = store.init().then(() => {
    isReady = true;
  });
  ready.catch((err) => fastify.log.error({ err, appId }, "document-encoding: could not open the document store"));
  const summaryOf = (id: string) => summary(store.entry(id)!, cfg);
  const mates = (id: string, group: string | null, statuses?: string[]) =>
    group ? store.entries().filter((o) => o.id !== id && o.group === group && (statuses ? statuses.includes(o.status) : o.status !== "discarded")) : [];
  const read: ReadDocument = config.platform?.readDocument ?? platformReader(config);
  const accept = new Set(cfg.intake.flatMap((i) => (i.via === "files" ? (i.accept ?? DEFAULT_ACCEPT) : ["image/jpeg", "image/png"])));
  const questionCap = cfg.review?.question_cap ?? 8;

  const who = (user?: UserIdentity) => user?.email ?? user?.id ?? "system";
  const note = (doc: StoredDocument, user: UserIdentity | undefined, action: string, detail?: string) => {
    doc.history.push({ at: new Date().toISOString(), by: user ? who(user) : null, action, ...(detail ? { detail } : {}) });
  };
  const specOf = (doc: StoredDocument) => (doc.documentType ? cfg.documents[doc.documentType] : undefined);

  const snapshot = (doc: StoredDocument): EncodingDocumentSnapshot => {
    const questions = openQuestions(doc, specOf(doc));
    const last = doc.versions.at(-1);
    return {
      id: doc.id,
      name: doc.name,
      status: doc.status,
      documentType: doc.documentType,
      group: doc.group,
      values: structuredClone(doc.values),
      tables: structuredClone(doc.tables),
      open: {
        ask: questions.filter((q) => q.kind === "ask").length,
        confirm: questions.filter((q) => q.kind === "confirm").length,
      },
      sheets: doc.pages.map((p) => ({ path: store.pagePath(p.file)!, mime: p.mime })),
      originals: doc.originals.map((o) => ({ sha256: o.sha256, name: o.name, mime: o.mime, size: o.size, path: store.originalPath(o.sha256)! })),
      sourceFileId: doc.sourceFileId ?? null,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy,
      version: doc.versions.length,
      approvedBy: doc.status === "approved" ? (last?.by ?? null) : null,
      approvedAt: doc.status === "approved" ? (last?.at ?? null) : null,
    };
  };

  /** Tell the client's own code a document changed. Never fails the change itself. */
  /**
   * Tell the client's own code a document changed.
   *
   * Notices for one document are delivered one after another, in the order
   * the changes happened. The client typically keeps its own view in step by
   * applying each notice; two of them running at once for the same document
   * (a slow "sent to be read again" finishing after the "read" that followed
   * it) would leave that view on the older state for good. Other documents
   * are not held up, and neither is the work itself: callers that must not
   * wait (the reading queue) simply do not await the result.
   */
  const told = new Map<string, Promise<void>>();
  const emit = (id: string, change: EncodingChange, user?: UserIdentity): Promise<void> => {
    if (!cfg.onDocument) return Promise.resolve();
    const hook = cfg.onDocument;
    const next = (told.get(id) ?? Promise.resolve()).then(async () => {
      const doc = await store.load(id);
      if (!doc) return;
      try {
        await within(hook({ document: snapshot(doc), change, ...(user ? { user } : {}) }), "onDocument");
      } catch (err) {
        fastify.log.error({ err, appId, id, change }, "document-encoding: onDocument failed");
      }
    });
    told.set(id, next);
    void next.finally(() => {
      if (told.get(id) === next) told.delete(id);
    });
    return next;
  };

  // ── The reading queue ────────────────────────────────────────────────────

  const waiting: string[] = [];
  let running = 0;

  /**
   * The lists a reading is checked against: the client's own, plus the names
   * people have approved in this app. A learned name is one approved at least
   * twice, so a single typo never becomes a "known" value.
   */
  async function lists(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [name, load] of Object.entries(cfg.lists ?? {})) {
      try {
        const values = await within(load({}), `list "${name}"`);
        out[name] = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
      } catch (err) {
        // A list that will not load weakens the checks; it must not stop reading.
        fastify.log.warn({ err, appId, list: name }, "document-encoding: could not load list");
        out[name] = [];
      }
    }
    for (const name of await store.learnedLists()) {
      const known = new Set((out[name] ?? []).map((v) => v.trim().toLowerCase()));
      const extra = (await store.learnedValues(name, LEARN_AFTER)).filter((v) => !known.has(v.trim().toLowerCase()));
      if (extra.length > 0 || out[name]) out[name] = [...(out[name] ?? []), ...extra];
    }
    return out;
  }

  /**
   * The forms as the readers' results are decided against them: a name field
   * with no list of its own is pointed at what approvals have taught for it,
   * once there is anything to point at.
   */
  function formsFor(known: Record<string, string[]>): DocumentEncodingConfig["documents"] {
    const withList = <F extends { key: string; type: string; candidates?: string }>(docType: string, path: string, f: F): F =>
      f.type === "name" && !f.candidates && (known[learnedListFor(docType, path)]?.length ?? 0) > 0
        ? { ...f, candidates: learnedListFor(docType, path) }
        : f;
    return Object.fromEntries(
      Object.entries(cfg.documents).map(([id, d]) => [
        id,
        {
          ...d,
          fields: d.fields.map((f) => withList(id, f.key, f)),
          tables: d.tables?.map((t) => ({ ...t, columns: t.columns.map((c) => withList(id, `${t.key}.${c.key}`, c)) })),
        },
      ]),
    );
  }

  /** Every approved name, under the list it belongs to. Counted once, on a record's first approval. */
  function namesIn(doc: StoredDocument): { list: string; value: string }[] {
    const spec = specOf(doc);
    if (!spec || !doc.documentType) return [];
    const seen: { list: string; value: string }[] = [];
    const add = (f: { type: string; candidates?: string }, path: string, v: Scalar | null | undefined) => {
      if (f.type === "name" && typeof v === "string" && v.trim()) seen.push({ list: f.candidates ?? learnedListFor(doc.documentType!, path), value: v });
    };
    for (const f of spec.fields) add(f, f.key, doc.values[f.key]);
    for (const t of spec.tables ?? []) {
      for (const row of doc.tables[t.key] ?? []) for (const c of t.columns) add(c, `${t.key}.${c.key}`, row[c.key]);
    }
    return seen;
  }

  /**
   * Look again at the values that must agree across a group, for this
   * document and the others in its group still under review. Run after
   * anything that can change a group or a value, so the outcome does not
   * depend on which document happened to be read first.
   */
  async function recheckGroup(id: string): Promise<void> {
    const me = store.entry(id);
    if (!me?.group) return;
    for (const one of [me, ...mates(id, me.group, ["review"])]) {
      if (one.status !== "review" || !one.documentType) continue;
      const spec = cfg.documents[one.documentType];
      const fields = (spec?.checks ?? []).flatMap((c) => (c.type === "same-in-group" ? [c.field] : []));
      if (fields.length === 0) continue;
      const others = mates(one.id, one.group, ["review", "approved"]);
      // Only open the record when the index already shows a difference.
      const differs = fields.some((f) => {
        const mine = one.values[f] ?? null;
        return mine !== null && others.some((o) => (o.values[f] ?? null) !== null && !same(mine, o.values[f] ?? null));
      });
      if (!differs) continue;
      try {
        const raised = await store.update(one.id, (d) => {
          if (d.status !== "review") return false;
          const before = Object.keys(d.flags).length;
          raiseFlags(d, spec, null, others);
          return Object.keys(d.flags).length > before;
        }, (raised) => raised);
        if (raised && one.id !== id) await emit(one.id, "values");
      } catch (err) {
        fastify.log.warn({ err, appId, id: one.id }, "document-encoding: group check failed");
      }
    }
  }

  async function readOne(id: string): Promise<void> {
    const doc = await store.load(id);
    if (!doc || (doc.status !== "queued" && doc.status !== "reading")) return;
    const mine = await store.update(id, (d) => {
      if (d.status !== "queued" && d.status !== "reading") return false;
      d.status = "reading";
      delete d.error;
      return true;
    });
    if (!mine) return;
    try {
      const pages = await Promise.all(
        doc.pages.map(async (p) => ({ mime: p.mime, data: (await store.readPage(p.file)).toString("base64") })),
      );
      const known = await lists();
      const reading = checkedReading(await read({
        pages,
        documents: formsFor(known),
        ...(doc.documentType && cfg.documents[doc.documentType] ? { document_type: doc.documentType } : {}),
        ...(cfg.context ? { context: cfg.context } : {}),
        lists: known,
        today: new Date().toISOString().slice(0, 10),
      }));
      let expected: Record<string, Scalar> | null = null;
      const landed = await store.update(id, async (d) => {
        // Discarded (or sent to be read again) while this read was out: its result is not wanted.
        if (d.status !== "reading") return false;
        d.reading = reading;
        d.documentType = reading.document_type;
        d.configVersion = version;
        applyReading(d);
        d.group = groupOf(d, cfg);
        const spec = specOf(d);
        if (spec) {
          try {
            expected = cfg.expected
              ? ((await within(cfg.expected({ documentType: d.documentType!, group: d.group, values: d.values }), "expected", 15_000)) ?? null)
              : null;
          } catch (err) {
            fastify.log.warn({ err, appId }, "document-encoding: expected-values hook failed");
          }
          raiseFlags(d, spec, expected, mates(d.id, d.group, ["review", "approved"]));
        }
        d.status = "review";
        note(d, undefined, "read", reading.document_type ?? "form not recognised");
        return true;
      });
      if (!landed) return;
      await recheckGroup(id);
      await emit(id, "read");
    } catch (err) {
      const failed = await store.update(id, (d) => {
        if (d.status !== "reading") return false;
        d.status = "failed";
        d.error = err instanceof Error ? err.message : "Reading failed";
        note(d, undefined, "read-failed", d.error);
        return true;
      });
      if (failed) await emit(id, "failed");
    }
  }

  let closing = false;
  const reads = new Set<Promise<void>>();

  function pump(): void {
    while (!closing && running < READ_CONCURRENCY && waiting.length > 0) {
      const id = waiting.shift()!;
      running++;
      const read = readOne(id)
        .catch((err) => fastify.log.error({ err, appId, id }, "document-encoding: read crashed"))
        .finally(() => {
          running--;
          reads.delete(read);
          pump();
        });
      reads.add(read);
    }
  }

  // On the way down: start nothing new, and give reads that are nearly done
  // a moment to be stored. Whatever is still out is read again at next start.
  fastify.addHook("onClose", async () => {
    closing = true;
    await Promise.race([Promise.allSettled([...reads]), new Promise((r) => setTimeout(r, 10_000).unref())]);
  });

  function enqueue(id: string): void {
    if (!waiting.includes(id)) waiting.push(id);
    pump();
  }

  // Anything that was waiting or mid-read when the server stopped starts again.
  void ready
    .then(() => {
      for (const doc of store.entries()) {
        if (doc.status === "queued" || doc.status === "reading") waiting.push(doc.id);
      }
      pump();
    })
    .catch(() => {});

  // ── Helpers for routes ───────────────────────────────────────────────────

  const need = (request: FastifyRequest, ability: EncodingAbility) => {
    if (!readAbilities<EncodingAbility>(request, app).includes(ability)) {
      fail(403, "Your role does not allow this here");
    }
  };
  const docOr404 = async (id: string) => (await store.load(id)) ?? fail(404, "Document not found");
  const editable = (doc: StoredDocument) => {
    if (doc.status !== "review" && doc.status !== "approved") fail(409, "This document cannot be changed right now");
  };

  /** Change values; an approved record goes back to review until re-approved. */
  function applyChanges(
    doc: StoredDocument,
    changes: { path: string; value: unknown; how?: string }[],
    user: UserIdentity | undefined,
  ): void {
    const spec = specOf(doc) ?? fail(409, "Choose the form type first");
    const known = new Map(valuePaths(doc, spec).map((v) => [v.path, v.field]));
    for (const change of changes) {
      const field = known.get(change.path) ?? fail(400, `Unknown value "${change.path}"`);
      const from = valueAt(doc, change.path);
      const to = coerce(field.type, change.value);
      const read = readValueAt(doc, change.path);
      const offered = [...(read?.candidates ?? []), ...(doc.flags[change.path]?.candidates ?? [])];
      const how =
        change.how === "confirmed" && String(from ?? "") === String(to ?? "")
          ? "confirmed"
          : offered.some((c) => String(c) === String(to ?? ""))
            ? "choice"
            : "typed";
      setValueAt(doc, change.path, to);
      doc.resolved[change.path] = { how, from: read ? read.value : from, to, by: who(user), at: new Date().toISOString() };
      delete doc.flags[change.path];
    }
    doc.group = groupOf(doc, cfg);
    if (doc.status === "approved") {
      doc.status = "review";
      note(doc, user, "reopened", "Changed after approval");
    }
  }

  /**
   * Turn one arrival into documents: the original stored once, one document
   * per sheet, each queued for reading. Shared by every way in (the app's
   * Capture screen, a chat attachment).
   */
  async function createDocuments(arrival: {
    original: { data: Buffer | ReceivedFile; name: string; mime: string } | null;
    sheets: { data: Buffer | ReceivedFile; name: string; mime: string }[];
    name?: string;
    batch?: string | null;
    sourceFileId?: string | null;
    user: UserIdentity | undefined;
  }): Promise<StoredDocument[]> {
    const created: StoredDocument[] = [];
    const whole = arrival.original ? await store.putOriginal(arrival.original.data, arrival.original.name, arrival.original.mime) : null;
    const baseName = (arrival.name ?? arrival.original?.name ?? arrival.sheets[0].name).slice(0, 200);
    for (let i = 0; i < arrival.sheets.length; i++) {
      const sheet = arrival.sheets[i];
      // With no separate original, the sheet as sent is the original.
      // (An original that is a received file is copied in, since the working copy takes the file itself.)
      const source =
        whole ?? (await store.putOriginal(Buffer.isBuffer(sheet.data) ? sheet.data : await readFile(sheet.data.path), sheet.name, sheet.mime));
      const id = store.newId();
      const file = await store.putPage(id, 0, sheet.data);
      const doc: StoredDocument = {
        id,
        appId,
        status: "queued",
        createdAt: new Date().toISOString(),
        createdBy: arrival.user ? who(arrival.user) : null,
        batch: arrival.batch ?? null,
        sourceFileId: arrival.sourceFileId ?? null,
        name: arrival.sheets.length > 1 ? `${baseName}, sheet ${i + 1}` : baseName,
        originals: [{ sha256: source.sha256, name: source.name, mime: source.mime, size: source.size, page: whole ? i + 1 : null }],
        pages: [{ file, mime: sheet.mime }],
        configVersion: version,
        documentType: null,
        group: null,
        reading: null,
        values: {},
        tables: {},
        resolved: {},
        flags: {},
        versions: [],
        history: [],
      };
      note(doc, arrival.user, "captured");
      await store.save(doc);
      created.push(doc);
    }
    for (const d of created) enqueue(d.id);
    return created;
  }

  /** Approve: this is what makes a record count. Refused while questions are open. */
  async function approveDocument(id: string, user: UserIdentity): Promise<{ handoff?: "failed" }> {
    let record: EncodingRecord | null = null;
    let taught: { add: { list: string; value: string }[]; remove: { list: string; value: string }[] } = { add: [], remove: [] };
    await store.update(id, (doc) => {
      if (doc.status !== "review") fail(409, "This document is not waiting for approval");
      const spec = specOf(doc) ?? fail(409, "Choose the form type first");
      const open = openQuestions(doc, spec);
      if (open.length > 0) fail(409, `${open.length} value${open.length === 1 ? "" : "s"} still need a decision`);
      const snap = {
        version: doc.versions.length + 1,
        at: new Date().toISOString(),
        by: who(user),
        documentType: doc.documentType!,
        group: doc.group,
        configVersion: doc.configVersion,
        values: structuredClone(doc.values),
        tables: structuredClone(doc.tables),
      };
      doc.versions.push(snap);
      doc.status = "approved";
      note(doc, user, "approved", `version ${snap.version}`);
      // What a person has just vouched for teaches the lists. A record
      // counts each name once: approving it again adds only what changed,
      // and takes back a name that was corrected away.
      const now = namesIn(doc);
      const before = doc.learned ?? [];
      const key = (n: { list: string; value: string }) => `${n.list}\u0000${n.value.trim().toLowerCase()}`;
      const had = new Set(before.map(key));
      const has = new Set(now.map(key));
      taught = { add: now.filter((n) => !had.has(key(n))), remove: before.filter((n) => !has.has(key(n))) };
      doc.learned = now;
      record = {
        id: doc.id,
        documentType: snap.documentType,
        group: snap.group,
        values: snap.values,
        tables: snap.tables,
        originals: [...new Set(doc.originals.map((o) => o.sha256))],
        version: snap.version,
        configVersion: snap.configVersion,
      };
    });
    try {
      await store.learn(taught.add, taught.remove);
    } catch (err) {
      fastify.log.warn({ err, appId, id }, "document-encoding: could not record approved names");
    }
    await emit(id, "approved", user);
    // The client's own hook runs after the approval is safely stored. If it
    // fails the record is still approved, and the failure is on the record
    // for someone to act on, not lost.
    if (record && cfg.onApproved) {
      try {
        await within(cfg.onApproved({ record, user }), "onApproved", 60_000);
      } catch (err) {
        fastify.log.error({ err, appId, id }, "document-encoding: onApproved failed");
        await store.update(id, (doc) => note(doc, undefined, "handoff-failed", err instanceof Error ? err.message : undefined));
        return { handoff: "failed" };
      }
    }
    return {};
  }

  // An app's routes live under its id and its kind. ToolPlex reaches them at
  // exactly this address (/cloud/org-apps/<id>/x/<path> → here/<path>), so
  // the kind's name is part of the contract, not a label.
  const prefix = `/apps/${appId}/${app.kind}`;

  fastify.addHook("onRequest", async (request, reply) => {
    if (isReady || !request.url.startsWith(`${prefix}/`)) return;
    try {
      await ready;
    } catch {
      return reply.code(503).send({ error: "This app's documents could not be opened. Check the server log." });
    }
  });

  // Say so when a request changed what the app holds. ToolPlex passes the
  // header on as a live "this app changed" to everyone in the organization
  // who has it open, so a queue two people share stays the same on both
  // screens. Decided here because only the kind knows which of its requests
  // change anything: the assistant's tools are all POSTs, and all but one of
  // them only look.
  //
  // Told from the route that matched, never from the address as typed: the
  // router decodes an address before matching it (%5F is an underscore to
  // it), so a rule written against the raw text can be walked around.
  fastify.addHook("onSend", async (request, reply) => {
    if (request.method !== "POST" || reply.statusCode >= 300) return;
    const route = request.routeOptions?.url ?? "";
    if (!route.startsWith(`${prefix}/`)) return;
    if (route === `${prefix}/agent/:tool` && (request.params as { tool?: string } | undefined)?.tool !== "add_attachments") return;
    void reply.header(APP_CHANGED_HEADER, "1");
  });

  // ── Intake ───────────────────────────────────────────────────────────────

  /** Uploads being turned into documents right now, by upload id. */
  const uploading = new Map<string, Promise<string[]>>();

  /**
   * One upload = one original, plus the page images to read.
   *
   * multipart parts, in any order:
   *   meta      JSON: { upload_id, batch?, name? }
   *   original  the untouched file (optional when the pages ARE the originals)
   *   page      one image per page, in order
   *
   * Each page becomes one document; pages are joined afterwards with /merge.
   * The device prepares the page images (it can render a PDF and size a
   * photo; this server deliberately has no image library to install).
   */
  fastify.post(`${prefix}/intake`, async (request) => {
    need(request, "capture");
    const user = readUserHeaders(request);
    const req = request as FastifyRequest & {
      isMultipart?: () => boolean;
      parts: (options?: { limits?: { files?: number } }) => AsyncIterable<{
        type: "file" | "field";
        fieldname: string;
        filename?: string;
        mimetype?: string;
        value?: unknown;
        file: Readable & { truncated?: boolean };
      }>;
    };
    if (!req.isMultipart?.()) fail(400, "Send the files as multipart/form-data");

    let meta: { upload_id?: unknown; batch?: unknown; name?: unknown } = {};
    type Received = { data: ReceivedFile; name: string; mime: string };
    let original: Received | null = null;
    const pages: Received[] = [];
    // Files go straight to disk as they arrive; a long scan is never held in memory.
    const written: string[] = [];
    const receive = async () => {
      for await (const part of req.parts({ limits: { files: MAX_PAGES_PER_UPLOAD + 1 } })) {
        if (part.type === "field") {
          if (part.fieldname === "meta" && typeof part.value === "string") {
            let parsed: unknown;
            try {
              parsed = JSON.parse(part.value);
            } catch {
              fail(400, "meta is not valid JSON");
            }
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as typeof meta;
          }
          continue;
        }
        const path = store.tempPath();
        written.push(path);
        const hash = createHash("sha256");
        let size = 0;
        await pipeline(
          part.file,
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              hash.update(chunk);
              size += chunk.length;
              yield chunk;
            }
          },
          createWriteStream(path),
        );
        if (part.file.truncated) fail(413, "A file in this upload is too large");
        const file: Received = {
          data: { path, sha256: hash.digest("hex"), size },
          name: (part.filename ?? "file").slice(0, 300),
          mime: part.mimetype ?? "application/octet-stream",
        };
        if (part.fieldname === "original") original = file;
        else if (part.fieldname === "page") {
          if (pages.length >= MAX_PAGES_PER_UPLOAD) fail(413, `At most ${MAX_PAGES_PER_UPLOAD} sheets per file`);
          pages.push(file);
        }
      }
      if (pages.length === 0) fail(400, "No sheets were sent");
      for (const p of pages) if (!PAGE_MIME.test(p.mime)) fail(415, "Sheets must be JPEG, PNG or WebP images");
      const whole = original as Received | null;
      if (whole && !accept.has(whole.mime)) fail(415, `This app does not accept ${whole.mime} files`);

      const uploadId = typeof meta.upload_id === "string" ? meta.upload_id : "";
      if (uploadId && !/^[a-z0-9-]{1,64}$/i.test(uploadId)) fail(400, "upload_id may hold only letters, digits and dashes");
      // The same upload arriving twice (a retry, or two at once) makes its documents once.
      const before = uploadId ? ((await store.uploadResult(uploadId)) ?? (await uploading.get(uploadId)?.catch(() => null)) ?? null) : null;
      if (before) {
        return { documents: before.filter((id) => store.has(id)).map(summaryOf), repeated: true };
      }
      const work = (async () => {
        const created = await createDocuments({
          original: whole,
          sheets: pages,
          name: typeof meta.name === "string" ? meta.name : undefined,
          batch: typeof meta.batch === "string" ? meta.batch.slice(0, 100) : null,
          user,
        });
        const ids = created.map((d) => d.id);
        if (uploadId) await store.recordUpload(uploadId, ids);
        return ids;
      })();
      if (uploadId) uploading.set(uploadId, work);
      try {
        return { documents: (await work).map(summaryOf) };
      } finally {
        if (uploadId) uploading.delete(uploadId);
      }
    };
    try {
      return await receive();
    } finally {
      // Whatever was not moved into place is removed, before the answer goes out.
      await Promise.all(written.map((path) => rm(path, { force: true })));
    }
  });

  /**
   * Bring in files a person attached in chat: { file_ids: [...] }.
   *
   * The files are already on this server, in the file store, and the caller
   * must be allowed to read each one there. Images only: turning a PDF into
   * sheets is the device's job, so a PDF goes through the app's own Capture.
   * Bringing the same attachment in twice returns the document made the
   * first time.
   */
  async function addFiles(request: FastifyRequest, ids: string[]) {
    const user = readUserHeaders(request);
    const files = fileStore() ?? fail(409, "This server has no file store for chat attachments");
    if (ids.length === 0 || ids.length > 50) fail(400, "file_ids must name between 1 and 50 files");
    const requester = { userId: user?.id, orgId: user?.orgId ?? readOrgHeader(request) };
    const documents: ReturnType<typeof summary>[] = [];
    const skipped: { file_id: string; reason: string }[] = [];
    const wanted = new Set(ids);
    const already = new Map<string, IndexEntry>();
    for (const d of store.entries()) {
      if (d.sourceFileId && wanted.has(d.sourceFileId) && d.status !== "discarded") already.set(d.sourceFileId, d);
    }
    for (const fileId of wanted) {
      const before = already.get(fileId);
      if (before) {
        documents.push(summary(before, cfg));
        continue;
      }
      try {
        const { manifest, uploadPath } = await files.getRawOrTextBytes(fileId, requester);
        const mime = manifest.mimeType || "application/octet-stream";
        if (!PAGE_MIME.test(mime)) {
          skipped.push({
            file_id: fileId,
            reason: mime === "application/pdf" ? "PDF files are brought in from the app's Capture screen" : "Only photos (JPEG, PNG, WebP) can be read",
          });
          continue;
        }
        const buffer = await readFile(uploadPath);
        const [doc] = await createDocuments({
          original: null,
          sheets: [{ data: buffer, name: manifest.filename || fileId, mime }],
          sourceFileId: fileId,
          batch: "chat",
          user,
        });
        documents.push(summaryOf(doc.id));
      } catch (err) {
        skipped.push({ file_id: fileId, reason: (err as { statusCode?: number }).statusCode === 404 ? "File not found" : "Could not read this file" });
      }
    }
    return { documents, skipped };
  }

  fastify.post<{ Body: { file_ids?: unknown } }>(`${prefix}/intake-files`, async (request) => {
    need(request, "capture");
    const ids = Array.isArray(request.body?.file_ids) ? request.body.file_ids.filter((x): x is string => typeof x === "string") : [];
    return addFiles(request, ids);
  });

  // ── Reading ──────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { status?: string; q?: string; group?: string; batch?: string; limit?: string; offset?: string } }>(
    `${prefix}/documents`,
    async (request) => {
      const { status, q, group, batch } = request.query;
      const wanted = status ? new Set(status.split(",")) : null;
      const needle = q?.trim().toLowerCase();
      let docs = store.entries().filter((d) => (wanted ? wanted.has(d.status) : d.status !== "discarded"));
      if (group) docs = docs.filter((d) => d.group === group);
      if (batch) docs = docs.filter((d) => d.batch === batch);
      if (needle) {
        docs = docs.filter((d) => d.text.includes(needle));
      }
      docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 100));
      const offset = Math.max(0, Number(request.query.offset) || 0);
      return { total: docs.length, documents: docs.slice(offset, offset + limit).map((d) => summary(d, cfg)) };
    },
  );

  fastify.get<{ Params: { id: string } }>(`${prefix}/documents/:id`, async (request) => {
    const doc = await docOr404(request.params.id);
    const spec = specOf(doc);
    const questions = openQuestions(doc, spec);
    return {
      ...summaryOf(doc.id),
      // Past the cap, questions one at a time cost more than keying the page.
      keying: questions.filter((q) => q.kind === "ask").length > questionCap,
      question_cap: questionCap,
      config_version: doc.configVersion,
      current_config_version: version,
      originals: doc.originals,
      values: doc.values,
      tables: doc.tables,
      reading: doc.reading
        ? {
            fields: doc.reading.fields,
            tables: doc.reading.tables,
            // Arithmetic and ranges are shown as they stand now, after any corrections.
            checks: [...doc.reading.checks.filter((c) => c.type !== "sum" && c.type !== "range"), ...(spec ? currentChecks(doc, spec) : [])],
            document_type_agreed: doc.reading.document_type_agreed,
          }
        : null,
      resolved: doc.resolved,
      questions,
      versions: doc.versions,
      history: doc.history,
      group_mates: mates(doc.id, doc.group).map((o) => summary(o, cfg)),
    };
  });

  fastify.get<{ Params: { id: string; n: string } }>(`${prefix}/documents/:id/pages/:n`, async (request, reply) => {
    const doc = await docOr404(request.params.id);
    const page = doc.pages[Number(request.params.n)] ?? fail(404, "Page not found");
    const path = store.pagePath(page.file) ?? fail(404, "Page not found");
    return sendFile(reply, path, page.mime, "private, max-age=86400");
  });

  fastify.get<{ Params: { sha: string } }>(`${prefix}/originals/:sha`, async (request, reply) => {
    const meta = (await store.originalMeta(request.params.sha)) ?? fail(404, "Original not found");
    reply.header("content-disposition", `attachment; filename="${meta.name.replace(/[^\w.\- ]/g, "_")}"`);
    return sendFile(reply, store.originalPath(meta.sha256)!, meta.mime, "private, max-age=86400");
  });

  fastify.get(`${prefix}/summary`, async () => {
    const docs = store.entries();
    const by: Record<string, number> = {};
    for (const d of docs) by[d.status] = (by[d.status] ?? 0) + 1;
    return { status: by, calibration: calibration(docs.map((d) => d.cal)), disk_bytes: await store.diskBytes(), config_version: version };
  });

  // ── Deciding ─────────────────────────────────────────────────────────────

  /** Answer questions or correct values: { changes: [{ path, value, how? }] }. */
  fastify.post<{ Params: { id: string }; Body: { changes?: { path: string; value: unknown; how?: string }[] } }>(
    `${prefix}/documents/:id/values`,
    async (request) => {
      need(request, "review");
      const user = readUserHeaders(request);
      const changes = Array.isArray(request.body?.changes) ? request.body.changes : fail(400, "changes is required");
      if (changes.length === 0 || changes.length > 2000) fail(400, "changes must hold between 1 and 2000 values");
      await store.update(request.params.id, (doc) => {
        editable(doc);
        applyChanges(doc, changes, user);
        note(doc, user, "values", `${changes.length} value${changes.length === 1 ? "" : "s"}`);
      });
      await recheckGroup(request.params.id);
      await emit(request.params.id, "values", user);
      return { ok: true };
    },
  );

  /** Add or remove a row of a table: { table, op: "add" | "remove", row? }. */
  fastify.post<{ Params: { id: string }; Body: { table?: string; op?: string; row?: number } }>(
    `${prefix}/documents/:id/rows`,
    async (request) => {
      need(request, "review");
      const user = readUserHeaders(request);
      await store.update(request.params.id, (doc) => {
        editable(doc);
        const spec = specOf(doc) ?? fail(409, "Choose the form type first");
        const table = spec.tables?.find((t) => t.key === request.body?.table) ?? fail(400, "Unknown table");
        const rows = (doc.tables[table.key] ??= []);
        if (request.body.op === "add") {
          rows.push(Object.fromEntries(table.columns.map((c) => [c.key, null])));
        } else if (request.body.op === "remove") {
          const i = Number(request.body.row);
          if (!Number.isInteger(i) || i < 0 || i >= rows.length) fail(400, "No such row");
          rows.splice(i, 1);
          // Decisions are stored by row number; after a removal the ones for
          // this table no longer point at the same lines, so they are dropped
          // and the lines are looked at again.
          for (const key of Object.keys(doc.resolved)) if (key.startsWith(`${table.key}[`)) delete doc.resolved[key];
          for (const key of Object.keys(doc.flags)) if (key.startsWith(`${table.key}[`)) delete doc.flags[key];
          if (doc.reading?.tables[table.key]) doc.reading.tables[table.key].splice(i, 1);
        } else fail(400, 'op must be "add" or "remove"');
        if (doc.status === "approved") doc.status = "review";
        note(doc, user, "rows", `${request.body.op} in ${table.label}`);
      });
      await emit(request.params.id, "values", user);
      return { ok: true };
    },
  );

  /** Say which form this is (when the readers could not), and read it again as that form. */
  fastify.post<{ Params: { id: string }; Body: { document_type?: string } }>(`${prefix}/documents/:id/reread`, async (request) => {
    need(request, "review");
    const user = readUserHeaders(request);
    const type = request.body?.document_type;
    if (type !== undefined && !cfg.documents[type]) fail(400, "Unknown form type");
    await store.update(request.params.id, (doc) => {
      if (doc.status === "reading" || doc.status === "discarded") fail(409, "This document cannot be read again right now");
      // Reading again throws away every answer. On an approved record that undoes an approval.
      if (doc.status === "approved" && !readAbilities<EncodingAbility>(request, app).includes("approve")) {
        fail(403, "Reading an approved record again needs the right to approve");
      }
      if (type) doc.documentType = type;
      doc.status = "queued";
      note(doc, user, "reread", type ? `as ${cfg.documents[type].title}` : undefined);
    });
    // Said before the new reading arrives. A record that was approved is not
    // approved any more from this moment, and the client's own pages must not
    // go on showing it as such for the minute the reading takes. The read is
    // queued first, so a slow hook cannot delay it; the notice for the
    // reading that follows still arrives after this one (see emit).
    const noticed = emit(request.params.id, "reading", user);
    enqueue(request.params.id);
    await noticed;
    return { ok: true };
  });

  let joining: Promise<unknown> = Promise.resolve();

  /** Join documents that are pages of one: { ids: [first, ...rest] }. */
  fastify.post<{ Body: { ids?: string[] } }>(`${prefix}/documents/merge`, async (request) => {
    need(request, "review");
    const user = readUserHeaders(request);
    const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids)] : [];
    if (ids.length < 2 || ids.length > 12) fail(400, "Choose between 2 and 12 documents to join");
    if (!ids.every((id) => typeof id === "string")) fail(400, "ids must be document ids");
    // One join at a time: two joins naming the same sheets must not both go through.
    const run = joining
      .catch(() => {})
      .then(async () => {
        const docs = await Promise.all(ids.map(docOr404));
        for (const d of docs) if (d.status === "reading" || d.status === "discarded" || d.status === "approved") {
          fail(409, `"${d.name}" cannot be joined right now`);
        }
        const [first, ...rest] = docs;
        await store.update(first.id, (doc) => {
          for (const other of rest) {
            doc.pages.push(...other.pages);
            doc.originals.push(...other.originals);
          }
          doc.documentType = null;
          doc.status = "queued";
          note(doc, user, "joined", `${rest.length + 1} sheets`);
        });
        for (const other of rest) {
          await store.update(other.id, (doc) => {
            doc.status = "discarded";
            note(doc, user, "joined-into", first.name);
          });
        }
        return { first, rest };
      });
    joining = run;
    const { first, rest } = await run;
    // The joined document is read again as one, exactly as on "read again":
    // what the client's code knew of its first sheet no longer stands.
    const noticed = emit(first.id, "reading", user);
    enqueue(first.id);
    await noticed;
    for (const other of rest) await emit(other.id, "discarded", user);
    return { ok: true, id: first.id };
  });

  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(`${prefix}/documents/:id/discard`, async (request) => {
    need(request, "review");
    const user = readUserHeaders(request);
    const reason = typeof request.body?.reason === "string" ? request.body.reason.trim().slice(0, 500) : "";
    if (!reason) fail(400, "Say why this document is being discarded");
    await store.update(request.params.id, (doc) => {
      if (doc.status === "approved") fail(409, "An approved record cannot be discarded");
      doc.status = "discarded";
      note(doc, user, "discarded", reason);
    });
    await emit(request.params.id, "discarded", user);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>(`${prefix}/documents/:id/approve`, async (request) => {
    need(request, "approve");
    const user = readUserHeaders(request) ?? fail(403, "Approval needs a signed-in person");
    return { ok: true, ...(await approveDocument(request.params.id, user)) };
  });

  // ── For the chat agent ───────────────────────────────────────────────────

  registerEncodingAgentTools(fastify, {
    prefix,
    app,
    appId,
    store,
    summarise: (doc) => summary(doc, cfg),
    ready,
    questionsOf: (doc) => openQuestions(doc, specOf(doc)),
    addFiles,
  });

  // ── For the client's own code ────────────────────────────────────────────

  const handle: EncodingHandle = {
    documents: (filter) => ({
      async *[Symbol.asyncIterator]() {
        await ready;
        const only = filter?.status ? new Set<string>(filter.status) : null;
        // Ids first, so documents arriving meanwhile do not disturb the walk.
        const ids = store.entries().filter((d) => !only || only.has(d.status)).map((d) => d.id);
        for (const id of ids) {
          const doc = await store.load(id);
          if (doc && (!only || only.has(doc.status))) yield snapshot(doc);
        }
      },
    }),
    document: async (id) => {
      await ready;
      const doc = await store.load(id);
      return doc ? snapshot(doc) : null;
    },
    approve: async (id, user) => {
      await approveDocument(id, user);
    },
  };
  // After the store is open, and without holding up the server's start.
  void ready
    .then(() => cfg.onReady?.(handle))
    .catch((err) => fastify.log.error({ err, appId }, "document-encoding: onReady failed"));

  return {
    /** Documents waiting on someone who may act on them. */
    pending: (abilities) => {
      if (!abilities.includes("review") && !abilities.includes("approve")) return 0;
      let n = 0;
      for (const d of store.entries()) if (d.status === "review" || d.status === "failed") n++;
      return n;
    },
  };
}

function sendFile(reply: FastifyReply, path: string, mime: string, cache: string): FastifyReply {
  reply.header("content-type", mime);
  reply.header("cache-control", cache);
  // Stored files are served as data, never as a page a browser would run.
  reply.header("x-content-type-options", "nosniff");
  return reply.send(createReadStream(path));
}
