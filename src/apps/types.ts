// ---------------------------------------------------------------------------
// Apps — operational interfaces a client declares next to its pages.
//
// The split of work:
//   - ToolPlex (platform) owns the engines: reading a document image, proposing
//     candidate values, agreement between independent readers, and the client
//     interfaces that run an app of a given `kind`.
//   - The client's server (this config) says WHICH apps exist and how each one
//     behaves: what a person captures, what is asked of them, what the records
//     look like, and what happens with a finished record.
//   - The device the person is on supplies capabilities (dropping files, a
//     camera, location). A kind's configuration says which ones each way of
//     working uses; a client that lacks one leaves that way out. What a device
//     can do never decides whether an app is listed, and neither decides what a
//     person is allowed to do — those are three separate questions.
//
// An app's `kind` names the platform capability it is built on. New kinds are
// added by the platform; a client configures them, it does not implement them.
// ---------------------------------------------------------------------------

import type { UserIdentity } from "../types.js";

/** Something the person's device contributes to an app. */
export type DeviceCapability =
  /** Choosing or dropping files from disk (desktop; phones via the file picker). */
  | "files"
  /** Taking photos with the device camera. */
  | "camera"
  /** The device's location at the moment of capture. */
  | "location";

/** Which ToolPlex clients list an app. */
export type AppClient = "desktop" | "mobile";

/**
 * The universal part of an app: everything ToolPlex needs to list it, decide
 * who may open it and hand it to the interface for its kind. Deliberately
 * small. Whatever is particular to one kind lives in that kind's `config`
 * and nowhere else, so a new kind never changes this shape.
 *
 * The key an app is registered under is its id. Several apps may share a
 * kind (receiving, delivery receipts, invoices); each has its own id,
 * configuration and permissions.
 */
export interface AppBase<Kind extends string, Config, Ability extends string, Place extends string = string> {
  kind: Kind;
  title: string;
  description?: string;
  /** Order in the catalogue; lower first. */
  nav_order?: number;
  /**
   * Clients that list this app. Default: every client that can run the kind.
   * This is about where the app belongs, not what the device can do: a
   * desktop with no camera still opens an app whose documents are captured
   * on phones, to review them. Ways of working a device cannot support are
   * left out by the client, per the kind's own configuration.
   */
  clients?: AppClient[];
  /**
   * Oldest desktop that can run this app. Older desktops show the card with
   * "Update required" instead of opening it.
   */
  min_desktop_version?: string;
  /**
   * Words for the people using the app, written by the client: what belongs
   * here, how their own paperwork is handled, who to ask. Keyed by where it
   * is shown; each kind names its places (APP_PLACES). The kind's interface
   * decides how each place presents them. The app works the same with none.
   *
   * Kept here and not in `config` on purpose. `config` is what shapes a
   * record, and every record keeps a fingerprint of it; wording is not part
   * of that, so correcting a sentence never changes `config_version`.
   */
  sections?: Partial<Record<Place, AppSection[]>>;
  /**
   * Keep a query database of this app's records.
   *
   * An app's records are the truth and live in its own store. With this on,
   * the server also keeps a database built from them (in memory, built anew
   * each time the server starts and kept level from then on), so the records
   * can be used like any other data: pages and their alerts read them with
   * `appRecords`, the assistant can query them, and your own code can with
   * `handle.query`. Off by default; nothing is created and `appRecords`
   * refuses an app that has it off.
   */
  records?: boolean;
  /** Everything particular to the kind. */
  config: Config;
  /**
   * Open work waiting on a person, shown as a count on the app's card and on
   * the Apps entry. Server-side only. Omit for no count.
   */
  pending?: (req: { user?: UserIdentity; abilities: Ability[] }) => Promise<number> | number;
}

// ---------------------------------------------------------------------------
// Sections — what a client may put in front of the people using an app.
//
// Text only, today. It has no data behind it and fetches nothing, which is
// what makes it safe to allow in every kind: anything with data or actions
// is a page, and anything a person works through is the kind itself.
// ---------------------------------------------------------------------------

/** A block of prose. The same shape as a text section on a page. */
export interface AppTextSection {
  type: "text";
  /** A short heading above the text. */
  title?: string;
  /** Light markdown: paragraphs, bold, lists and links. */
  text: string;
}

export type AppSection = AppTextSection;

/** Bounds on what is shown: instructions longer than this are not read. */
export const APP_SECTION_LIMITS = {
  /** Blocks in one place. */
  perPlace: 6,
  /** Characters in one block's text. */
  text: 2000,
  /** Characters in a heading. */
  title: 80,
} as const;

// ---------------------------------------------------------------------------
// kind: "document-encoding" — paper documents into records
// ---------------------------------------------------------------------------

/** The kind of value a field holds; decides how strictly a reading is checked. */
export type EncodingFieldType =
  /** Free text: a remark, an address. */
  | "text"
  /** A person, company or product name. Matched against `candidates` if given. */
  | "name"
  /** An identifier whose every character matters: a receipt number, a plate. */
  | "code"
  | "number"
  | "date"
  | "time";

export interface EncodingField {
  key: string;
  label: string;
  type: EncodingFieldType;
  /** A document missing this value cannot be approved. */
  required?: boolean;
  /**
   * Keys this value was stored under before it was renamed. A field's key is
   * its identity: records approved under an old key are found through this,
   * so a rename does not empty the column on every record that came before.
   * An old key must not be one that is in use now, and no two may claim the
   * same one; both are refused at startup.
   */
  was?: string[];
  /** Told to the reader: where the value sits or how it is written on this form. */
  hint?: string;
  /**
   * Name of a list in `lists` holding the valid values (customers, products).
   * The list offers choices and backs up an agreed reading. It never replaces
   * what was read.
   */
  candidates?: string;
}

/** A repeating block on a document: line items, pallets, weights. */
export interface EncodingTable {
  key: string;
  label: string;
  /** Keys this table was stored under before it was renamed (see EncodingField.was). */
  was?: string[];
  columns: EncodingField[];
}

/** A rule a finished document must satisfy; a failure becomes a question. */
export type EncodingCheck =
  /** The values of one table column add up to a field. */
  | { type: "sum"; table: string; column: string; equals: string; tolerance?: number }
  /** A number lies inside a range. */
  | { type: "range"; field: string; min?: number; max?: number }
  /** A date lies within so many days of the day the document was captured. */
  | { type: "recent"; field: string; days: number }
  /** A field agrees with the same field on the other documents in its group. */
  | { type: "same-in-group"; field: string };

export interface EncodingDocumentType {
  title: string;
  /**
   * Keys this form was stored under before it was renamed. Records approved
   * as the old form are found through this, in the app and in its tables.
   */
  was?: string[];
  /** How to recognise this form, told to the reader that sorts incoming pages. */
  recognise: string;
  /**
   * How this form is always filled in, when that is known: a typed chat
   * message is "printed", a slip always filled by pen is "hand". Leave unset
   * for forms that mix both. It overrides the readers' own judgement of each
   * value, which is not stable from one read to the next.
   */
  written?: "printed" | "hand";
  /**
   * How this form is filled in, for the readers: where things sit, how dates
   * and quantities are written on it, what is usually by hand. Background
   * only, never a value. Kept short (1,500 characters at most): it goes with
   * every read of this form.
   */
  notes?: string;
  fields: EncodingField[];
  tables?: EncodingTable[];
  checks?: EncodingCheck[];
  /** Ids of stored example scans of this form, with their correct values. */
  examples?: string[];
}

/** A way of getting documents into the app, and what the device must supply. */
export type EncodingIntake =
  | {
      via: "files";
      /** MIME types accepted. Default: PDF and common image types. */
      accept?: string[];
    }
  | {
      via: "camera";
      /**
       * Checks the device runs on each shot before accepting it, so a bad
       * capture is retaken on the spot. Default: all three.
       */
      checks?: ("sharp" | "complete" | "single")[];
      /** Also record where the shot was taken. */
      location?: boolean;
    };

export interface EncodingRecord {
  id: string;
  documentType: string;
  group: string | null;
  values: Record<string, string | number | null>;
  tables: Record<string, Record<string, string | number | null>[]>;
  /** Fingerprints of the untouched originals this record was read from. */
  originals: string[];
  version: number;
  /**
   * The configuration this record was read under (SerializableApp.config_version).
   * Kept on every version of every record, so a later change to a document
   * type never makes an old record uninterpretable.
   */
  configVersion: string;
}

/**
 * What a person may do in a document-encoding app. Opening the app is one
 * permission; each of these is another, granted per role and per app.
 */
export type EncodingAbility =
  /** Bring documents in. */
  | "capture"
  /** Answer questions and correct values. */
  | "review"
  /** Approve a record, which is what makes it count. */
  | "approve";

export const ENCODING_ABILITIES: readonly EncodingAbility[] = ["capture", "review", "approve"];

/** Where a document-encoding app shows a client's sections: its three tabs. */
export type EncodingPlace =
  /** Where documents are brought in. Seen by people who may capture. */
  | "capture"
  /** Where questions are answered and records approved. */
  | "review"
  /** Where approved records are kept. */
  | "records";

export const ENCODING_PLACES: readonly EncodingPlace[] = ["capture", "review", "records"];

export interface DocumentEncodingConfig {
  /**
   * Background for the readers about this client's documents as a whole:
   * what the organization does, its vocabulary and abbreviations, how its
   * paperwork is generally written. Maintained with the client, the way an
   * agent prompt is. Background only, never a value, and short (2,000
   * characters at most): it goes with every read. Each form may add its own
   * `notes`; a reader is given this plus the notes of the one form it reads.
   */
  context?: string;
  /** Ways a person can bring documents in. At least one. */
  intake: EncodingIntake[];
  /** The forms this client handles, keyed by a stable id. */
  documents: Record<string, EncodingDocumentType>;
  /**
   * Field key (present on the document types that share it) whose value ties
   * documents into one group: a shipment number, a dispatch reference.
   */
  group_by?: string;
  review?: {
    /** Questions on one document before it goes to the keying screen. Default 8. */
    question_cap?: number;
    /**
     * A person opens and approves every document, including values accepted
     * without a question. On by default; turn off per client once their own
     * numbers justify it.
     */
    approve_every_document?: boolean;
  };
  /**
   * Valid values per list name (see EncodingField.candidates). Server-side
   * only; called when a batch is read, not per keystroke.
   */
  lists?: Record<string, (req: { user?: UserIdentity }) => Promise<string[]> | string[]>;
  /**
   * Values the paper is expected to show, when the client already holds them
   * (from its own system, or from another document in the group). The readers
   * are then asked whether the paper matches. Server-side only.
   */
  expected?: (req: {
    documentType: string;
    group: string | null;
    values: Record<string, string | number | null>;
  }) => Promise<Record<string, string | number> | null> | Record<string, string | number> | null;
  /**
   * Called once a person approves a record, and again for each later version.
   * This is where the client turns it into its own data. Server-side only.
   */
  onApproved?: (req: { record: EncodingRecord; user?: UserIdentity }) => Promise<void> | void;
  /**
   * Called whenever a document changes state: read, values changed, approved,
   * discarded, failed, or sent to be read again. This is how the client's own pages and data follow the
   * app (a "Received documents" page, a reconciliation). Server-side only; a
   * failure here is logged and never undoes the change.
   */
  onDocument?: (event: { document: EncodingDocumentSnapshot; change: EncodingChange; user?: UserIdentity }) => Promise<void> | void;
  /**
   * Called once at startup with a handle to the running app, so the client's
   * own code can list what the app holds (to rebuild its pages after a
   * restart) or approve on a person's behalf from one of its pages.
   */
  onReady?: (handle: EncodingHandle) => Promise<void> | void;
}

export type EncodingChange =
  /** A reading arrived. */
  | "read"
  | "failed"
  | "values"
  | "approved"
  | "discarded"
  /** Sent to be read again: its values, and any approval, no longer stand. */
  | "reading";

/** A document as the client's own code sees it. Paths are on this server. */
export interface EncodingDocumentSnapshot {
  id: string;
  name: string;
  status: "queued" | "reading" | "review" | "approved" | "discarded" | "failed";
  documentType: string | null;
  group: string | null;
  values: Record<string, string | number | null>;
  tables: Record<string, Record<string, string | number | null>[]>;
  /** Values still waiting on a person. */
  open: { ask: number; confirm: number };
  /** The images that were read, in order. */
  sheets: { path: string; mime: string }[];
  /** The untouched files this document came from. */
  originals: { sha256: string; name: string; mime: string; size: number; path: string }[];
  /** File-store id, when the document arrived as a chat attachment. */
  sourceFileId: string | null;
  createdAt: string;
  createdBy: string | null;
  version: number;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface EncodingHandle {
  /**
   * The documents the app holds, one at a time, read from disk as they are
   * asked for. An app may hold years of documents: take what you need from
   * each rather than keeping them all. Discarded ones are included unless
   * `status` says otherwise.
   */
  documents(filter?: { status?: EncodingDocumentSnapshot["status"][] }): AsyncIterable<EncodingDocumentSnapshot>;
  document(id: string): Promise<EncodingDocumentSnapshot | null>;
  /**
   * Approve on behalf of a person acting from the client's own page. The
   * same rule applies as in the app: refused while any value is undecided.
   */
  approve(id: string, user: UserIdentity): Promise<void>;
  /**
   * One read-only SQL query over the app's approved records (needs
   * `records: true` on the app), for what your own code works out from them.
   * The tables are the ones `appRecords` reads: one per form named after its
   * key (`delivery_receipt`), one per table of a form
   * (`delivery_receipt_items`), and `records` for every record.
   *
   * Values that vary go in `params` and are written `$1`, `$2` in the SQL,
   * never pasted into it. At most 5,000 rows come back and `truncated` says
   * when there were more: add up or filter in the query. Moments are ISO
   * text, days are "YYYY-MM-DD".
   *
   * For a total, a card or a chart on a page, declare the query as a
   * resource instead (`appRecords(app, { sql })`): it then reports its
   * freshness and feeds alerts like any table.
   */
  query(sql: string, params?: (string | number | boolean | null)[]): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }>;
  /**
   * What changed in the app's approved records since you last asked. For
   * keeping a copy of them somewhere of your own, such as a database you
   * join them in.
   *
   * Hand back the `cursor` you were given as `after`; leave it out the first
   * time. Each record that changed is there once, as it stands now: with its
   * rows by table (the same tables and typed values `appRecords` reads), or
   * `removed` when it no longer counts. Replace what your copy holds for
   * that `record_id`. When `reset` is true the cursor could not be continued
   * from (the tables changed shape, or the records were restored): empty
   * your copy first; the changes then start from the beginning. Ask again
   * while `more` is true.
   *
   * Nothing is missed however long you were away, and a change is never
   * handed out before it is safely stored. Works whether or not the app has
   * `records: true`.
   */
  changes(options?: { after?: string | null; limit?: number }): Promise<{
    changes: ({ record_id: string; at: string; removed: true } | { record_id: string; at: string; removed: false; rows: Record<string, Record<string, string | number | boolean | null>[]> })[];
    cursor: string;
    reset: boolean;
    more: boolean;
  }>;
  /**
   * When what the app's approved records count for last changed (an ISO
   * time). For a page whose data you work out yourself from `query`: report
   * it as `lastSync` from the page's own `context` handler, and alerts on
   * the page are checked when something is approved. (A page's freshness
   * comes from the page's handler, not from a resource's.)
   */
  changedAt(): Promise<string>;
  /** One record's rows by table, as `changes` gives them; null when it does not count (never approved, or discarded). */
  record(id: string): Promise<{ record_id: string; rows: Record<string, Record<string, string | number | boolean | null>[]> } | null>;
}

export type DocumentEncodingApp = AppBase<"document-encoding", DocumentEncodingConfig, EncodingAbility, EncodingPlace>;

/** Every app kind the platform can run. */
export type AppDefinition = DocumentEncodingApp;

export type AppKind = AppDefinition["kind"];

/** The abilities each kind defines. A role is granted a subset per app. */
export const APP_ABILITIES: Record<AppKind, readonly string[]> = {
  "document-encoding": ENCODING_ABILITIES,
};

/** The places each kind has for a client's sections. */
export const APP_PLACES: Record<AppKind, readonly string[]> = {
  "document-encoding": ENCODING_PLACES,
};

/** What a client learns about an app: the definition without its server-side functions. */
export interface SerializableApp {
  id: string;
  kind: AppKind;
  title: string;
  description?: string;
  nav_order?: number;
  clients?: AppClient[];
  min_desktop_version?: string;
  /** Everything a person could be allowed to do in this app. */
  abilities: string[];
  /** The client's own words for the people using the app, by place. */
  sections?: Record<string, AppSection[]>;
  /** A query database of this app's records is kept (see AppBase.records). */
  records?: boolean;
  /**
   * Fingerprint of `config`. Changes whenever the configuration does; every
   * record keeps the one it was created under. `sections` are not part of it.
   */
  config_version: string;
  /** The kind's configuration, with its server-side functions removed. */
  config: unknown;
}
