// ---------------------------------------------------------------------------
// Document encoding — what the chat agent can do with this app.
//
// An app exists to get one job done by people, so the agent's part in it is
// deliberately narrow: it can FIND and EXPLAIN what the app holds, and it can
// bring in files a person attached in chat. It cannot answer a value
// question, correct a value or approve. Those decisions are the check on the
// machine's own reading, and a model deciding them would be checking itself.
//
// Every kind of app serves the same two routes, so ToolPlex never needs to
// know what a kind's tools are:
//   GET  <app>/agent         what the tools are (name, description, input)
//   POST <app>/agent/<tool>  run one, as the person who is asking
//
// A result may carry `cards`: small summaries the chat shows with a button
// that opens the app at the right place. The agent describes; the person
// goes and does.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DocumentEncodingApp, EncodingAbility } from "../types.js";
import { readAbilities } from "../../routes/apps.js";
import type { EncodingStore, IndexEntry, StoredDocument } from "./store.js";
import { calibration, type Question } from "./logic.js";

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Where a card's button takes the person inside the app. */
export interface AgentCard {
  title: string;
  subtitle?: string;
  lines?: string[];
  /**
   * A picture to show in the card, as a path under this app's own address.
   * The chat fetches it as the person, so it is only ever shown to someone
   * who may open the app.
   */
  image?: { path: string; alt: string };
  open: { tab: "capture" | "review" | "records"; document_id?: string };
}

interface Summary {
  id: string;
  name: string;
  status: string;
  document_type_title: string | null;
  group: string | null;
  created_at: string;
  ask: number;
  confirm: number;
  version: number;
  approved_at: string | null;
}

export interface EncodingAgentContext {
  prefix: string;
  appId: string;
  app: DocumentEncodingApp;
  store: EncodingStore;
  summarise: (doc: IndexEntry) => Summary;
  /** Resolves once the store is open. */
  ready: Promise<void>;
  questionsOf: (doc: StoredDocument) => Question[];
  addFiles: (request: FastifyRequest, fileIds: string[]) => Promise<{ documents: Summary[]; skipped: { file_id: string; reason: string }[] }>;
}

const STATUS_WORDS: Record<string, string> = {
  queued: "waiting to be read",
  reading: "being read",
  review: "waiting for a person",
  approved: "approved",
  discarded: "discarded",
  failed: "could not be read",
};

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function registerEncodingAgentTools(fastify: FastifyInstance, ctx: EncodingAgentContext): void {
  const { store, app, summarise, questionsOf } = ctx;
  const forms = Object.entries(app.config.documents).map(([id, d]) => `${id} (${d.title})`).join(", ");

  const tools: AgentToolDefinition[] = [
    {
      name: "overview",
      description:
        `How "${app.title}" stands right now: how many documents are waiting to be read, waiting for a person, approved or failed; the documents waiting for a person and why; and how often the readers' values were later corrected. Start here when asked what is pending or how the app is doing.`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "find_documents",
      description:
        `Search the documents in "${app.title}" and return their recorded values. Use it to answer questions from the documents themselves (a delivery number, a customer, quantities on a date). Forms: ${forms}.`,
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Matches the file name, the group, or any recorded value." },
          status: { type: "string", enum: ["review", "approved", "failed", "discarded", "queued", "reading"], description: "Omit for everything except discarded." },
          form: { type: "string", description: "A form id from the list in this tool's description." },
          group: { type: "string", description: `Exact group value${app.config.group_by ? ` (the documents' "${app.config.group_by}")` : ""}.` },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_document",
      description:
        "One document in full: every recorded value and table line, what still waits on a person and why, its history (who captured, changed and approved it), and the other documents in its group. Values marked as waiting are the readers' best reading, not yet settled by a person: say so when you quote one.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "A document id from overview or find_documents." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "show_document",
      description:
        "Show the person the scan of a document, right in the conversation. Use it when they ask to see a document, or when looking at the paper would answer their question better than the recorded values. You do not receive the image yourself; the person sees it.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "A document id from overview or find_documents." },
          sheet: { type: "integer", minimum: 1, description: "Which sheet, for a document of several. Default 1." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "compare_group",
      description:
        "The documents that belong together in one group, side by side: which forms are present, and every value that appears on more than one of them with whether they agree. Use it for questions like 'does the acceptance match the dispatch?'.",
      input_schema: {
        type: "object",
        properties: { group: { type: "string", description: "The group value, for example a delivery receipt number." } },
        required: ["group"],
        additionalProperties: false,
      },
    },
    {
      name: "add_attachments",
      description:
        `Bring photos the person attached in THIS conversation into "${app.title}" to be read. Pass the attachments' fileIds. Reading takes about a minute per document and happens in the background; afterwards a person answers any questions and approves in the app. Photos only: a PDF has to be dropped into the app's Capture screen, so tell the person that if one is skipped.`,
      input_schema: {
        type: "object",
        properties: { file_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 } },
        required: ["file_ids"],
        additionalProperties: false,
      },
    },
  ];

  const about =
    `"${app.title}" is an app where people bring in scanned documents, answer the questions the readers could not settle, and approve the records. ` +
    "You can look things up in it and bring attached photos into it. You cannot answer its questions, change a value or approve: " +
    "when the person needs to do one of those, tell them what is waiting and let the card open the app for them. " +
    "Never present a value that is still waiting on a person as settled.";

  fastify.get(`${ctx.prefix}/agent`, async (request) => {
    const abilities = readAbilities<EncodingAbility>(request, app);
    return {
      about,
      // A tool the person could not use is not offered at all.
      tools: tools.filter((t) => t.name !== "add_attachments" || abilities.includes("capture")),
    };
  });

  const line = (s: Summary): string =>
    [s.document_type_title ?? "Form not recognised", s.group ? `group ${s.group}` : null, statusLine(s)].filter(Boolean).join(" · ");
  const statusLine = (s: Summary): string =>
    s.status === "review"
      ? s.ask > 0
        ? `${s.ask} to decide`
        : s.confirm > 0
          ? `${s.confirm} to confirm`
          : "ready to approve"
      : (STATUS_WORDS[s.status] ?? s.status);
  const tabFor = (status: string): AgentCard["open"]["tab"] => (status === "approved" || status === "discarded" ? "records" : "review");

  fastify.post<{ Params: { tool: string }; Body: Record<string, unknown> }>(`${ctx.prefix}/agent/:tool`, async (request) => {
    const input = (request.body ?? {}) as Record<string, unknown>;
    await ctx.ready;
    const docs = store.entries();
    const full = async (id: unknown) => (typeof id === "string" && (await store.load(id))) || fail(404, "Document not found");

    switch (request.params.tool) {
      case "overview": {
        const counts: Record<string, number> = {};
        for (const d of docs) counts[STATUS_WORDS[d.status] ?? d.status] = (counts[STATUS_WORDS[d.status] ?? d.status] ?? 0) + 1;
        const waiting = docs
          .filter((d) => d.status === "review" || d.status === "failed")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(summarise);
        const c = calibration(docs.map((d) => d.cal));
        const cards: AgentCard[] =
          waiting.length > 0
            ? [
                {
                  title: app.title,
                  subtitle: `${waiting.length} document${waiting.length === 1 ? "" : "s"} waiting for a person`,
                  lines: waiting.slice(0, 4).map((s) => `${s.name}: ${statusLine(s)}`),
                  open: { tab: "review" },
                },
              ]
            : [];
        return {
          counts,
          waiting_for_a_person: waiting.slice(0, 30).map((s) => ({ id: s.id, name: s.name, form: s.document_type_title, group: s.group, why: statusLine(s) })),
          waiting_total: waiting.length,
          accuracy_on_approved_documents: {
            approved_documents: c.documents,
            values_recorded_without_a_question: c.accepted,
            of_those_later_corrected_by_a_person: c.acceptedThenChanged,
            handwritten_values_confirmed: c.confirmed,
            of_those_corrected: c.confirmedChanged,
            questions_asked: c.asked,
            answered_by_picking_an_offered_choice: c.askedAnsweredByChoice,
          },
          cards,
        };
      }

      case "find_documents": {
        const text = typeof input.text === "string" ? input.text.trim().toLowerCase() : "";
        const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
        let found = docs.filter((d) => (typeof input.status === "string" ? d.status === input.status : d.status !== "discarded"));
        if (typeof input.form === "string") found = found.filter((d) => d.documentType === input.form);
        if (typeof input.group === "string") found = found.filter((d) => d.group === input.group);
        if (text) {
          found = found.filter((d) => d.text.includes(text));
        }
        found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const shown = found.slice(0, limit);
        return {
          total: found.length,
          documents: shown.map((d) => {
            const s = summarise(d);
            return {
              id: d.id,
              name: d.name,
              form: s.document_type_title,
              status: STATUS_WORDS[d.status] ?? d.status,
              settled: d.status === "approved",
              group: d.group,
              captured: d.createdAt,
              approved: s.approved_at,
              values: d.values,
              lines: d.lines,
            };
          }),
          cards: shown.slice(0, 3).map((d): AgentCard => {
            const s = summarise(d);
            return { title: d.name, subtitle: line(s), open: { tab: tabFor(d.status), document_id: d.id } };
          }),
        };
      }

      case "get_document": {
        const doc = await full(input.id);
        const s = summarise(store.entry(doc.id)!);
        const questions = questionsOf(doc);
        return {
          id: doc.id,
          name: doc.name,
          form: s.document_type_title,
          status: STATUS_WORDS[doc.status] ?? doc.status,
          settled: doc.status === "approved",
          group: doc.group,
          values: doc.values,
          tables: doc.tables,
          waiting_on_a_person: questions.map((q) => ({ value: q.label, why: q.reason, best_reading_so_far: q.value })),
          checks: doc.reading?.checks ?? [],
          versions: doc.versions.map((v) => ({ version: v.version, approved_by: v.by, at: v.at })),
          history: doc.history,
          originals: doc.originals.map((o) => ({ name: o.name, sheet: o.page })),
          same_group: docs.filter((o) => o.id !== doc.id && doc.group && o.group === doc.group && o.status !== "discarded").map((o) => ({ id: o.id, name: o.name, form: summarise(o).document_type_title, status: STATUS_WORDS[o.status] ?? o.status })),
          cards: [{ title: doc.name, subtitle: line(s), open: { tab: tabFor(doc.status), document_id: doc.id } } satisfies AgentCard],
        };
      }

      case "show_document": {
        const doc = await full(input.id);
        const sheet = Math.min(doc.pages.length, Math.max(1, Math.floor(Number(input.sheet) || 1)));
        const s = summarise(store.entry(doc.id)!);
        return {
          shown: doc.name,
          sheet,
          sheets: doc.pages.length,
          form: s.document_type_title,
          status: STATUS_WORDS[doc.status] ?? doc.status,
          note: "The scan is now on the person's screen. You have not seen it; rely on get_document for its values.",
          cards: [
            {
              title: doc.name,
              subtitle: doc.pages.length > 1 ? `${line(s)} · sheet ${sheet} of ${doc.pages.length}` : line(s),
              image: { path: `documents/${doc.id}/pages/${sheet - 1}`, alt: doc.name },
              open: { tab: tabFor(doc.status), document_id: doc.id },
            } satisfies AgentCard,
          ],
        };
      }

      case "compare_group": {
        const group = typeof input.group === "string" ? input.group.trim() : "";
        if (!group) fail(400, "group is required");
        const members = docs.filter((d) => d.group === group && d.status !== "discarded");
        if (members.length === 0) return { group, documents: [], note: "No documents carry this group value." };
        const keys = new Map<string, { document: string; value: string | number | null; settled: boolean }[]>();
        for (const d of members) {
          for (const [k, v] of Object.entries(d.values)) {
            if (v === null) continue;
            (keys.get(k) ?? keys.set(k, []).get(k)!).push({ document: d.name, value: v, settled: d.status === "approved" });
          }
        }
        const shared = [...keys.entries()].filter(([, seen]) => seen.length > 1);
        const same = (seen: { value: string | number | null }[]) => new Set(seen.map((x) => String(x.value).trim().toLowerCase())).size === 1;
        return {
          group,
          documents: members.map((d) => ({ id: d.id, name: d.name, form: summarise(d).document_type_title, status: STATUS_WORDS[d.status] ?? d.status })),
          forms_present: [...new Set(members.map((d) => summarise(d).document_type_title).filter(Boolean))],
          values_that_differ: shared.filter(([, seen]) => !same(seen)).map(([field, seen]) => ({ field, seen })),
          values_that_agree: shared.filter(([, seen]) => same(seen)).map(([field, seen]) => ({ field, value: seen[0].value })),
          cards: members.slice(0, 3).map((d): AgentCard => ({ title: d.name, subtitle: line(summarise(d)), open: { tab: tabFor(d.status), document_id: d.id } })),
        };
      }

      case "add_attachments": {
        if (!readAbilities<EncodingAbility>(request, app).includes("capture")) fail(403, "This person's role does not allow bringing documents into this app");
        const ids = Array.isArray(input.file_ids) ? input.file_ids.filter((x): x is string => typeof x === "string") : [];
        const result = await ctx.addFiles(request, ids);
        return {
          brought_in: result.documents.map((s) => ({ id: s.id, name: s.name, status: STATUS_WORDS[s.status] ?? s.status })),
          skipped: result.skipped,
          next: "The documents are read in the background. A person then answers any questions and approves them in the app.",
          cards:
            result.documents.length > 0
              ? [
                  {
                    title: app.title,
                    subtitle: `${result.documents.length} document${result.documents.length === 1 ? "" : "s"} brought in`,
                    lines: result.documents.slice(0, 4).map((s) => s.name),
                    open: { tab: "review" },
                  } satisfies AgentCard,
                ]
              : [],
        };
      }

      default:
        return fail(404, "Unknown tool");
    }
  });
}
