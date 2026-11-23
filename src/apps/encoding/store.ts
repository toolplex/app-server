// ---------------------------------------------------------------------------
// Document encoding — what is kept, and where.
//
// Everything lives under one directory per app, as plain files:
//
//   originals/<sha256>        the untouched file as it arrived, stored once
//   originals/<sha256>.json   its name, type and size
//   pages/<docId>-<n>         the working copy of each page (what is read)
//   docs/<docId>.json         the record: reading, values, answers, versions
//   uploads/<uploadId>.json   which documents an upload produced (retries)
//   store.json                this store's id, made once and kept for good
//   configs/<version>.json    each configuration records were approved under
//
// Plain files on purpose: the nightly backup already mirrors this directory
// tree, a record can be opened and read by a person, and there is no native
// database to install on a client's server. Writes go to a temp file and are
// renamed into place, so a crash never leaves half a record.
//
// What is held in memory is an index: one small entry per document (status,
// form, group, header values, counts), enough to list, search and count
// without opening a record. Full records are read from disk when one is
// opened, and a few recently used ones are kept. The index is itself kept in
// a file (index.jsonl, one line per change), so starting up reads one file
// and checks each record's modification time against it; only records that
// changed without the index knowing (a crash, a restore) are read again.
// The record files stay the truth: delete index.jsonl and it is rebuilt.
//
// This sits behind the functions below, so moving to a database or to object
// storage later touches nothing else.
//
// Originals are never modified or deleted by anything here.
//
// CHANGE STAMPS. Some of what a record holds counts outside the app (an
// approved version feeds the app's tables, and any copy kept elsewhere). The
// kind says what counts as one piece of text (`counted`); whenever storing a
// record changes that text, the record is stamped with a number larger than
// any before it and the time. The stamp is written in the record's own file,
// in the same write as the change, so there is no second list that a crash
// could leave disagreeing with the records. "What changed since number N" is
// then a question the index answers, and each record appears once, as it
// stands now.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Scalar = string | number;
export type ValueStatus = "accepted" | "confirm" | "ask" | "blank";

/** One value as the platform's readers decided it. Never edited after the read. */
export interface ReadValue {
  value: Scalar | null;
  status: ValueStatus;
  reason?: string;
  candidates: Scalar[];
  written: "printed" | "hand" | "unknown";
  box?: { page: number; x: number; y: number; w: number; h: number };
}

export interface Reading {
  document_type: string | null;
  document_type_agreed: boolean;
  fields: Record<string, ReadValue>;
  tables: Record<string, Record<string, ReadValue>[]>;
  checks: { type: string; ok: boolean; message: string; values: string[] }[];
  counts: Record<ValueStatus, number>;
  readers: { model: string; ok: boolean; ms: number; error?: string; usage?: unknown }[];
}

/** A person's decision on one value. */
export interface Resolution {
  /** choice: picked a candidate. typed: keyed it. confirmed: agreed with the pre-filled value. */
  how: "choice" | "typed" | "confirmed";
  from: Scalar | null;
  to: Scalar | null;
  by: string;
  at: string;
}

/** A question raised after the read, by the client's own knowledge. */
export interface Flag {
  reason: string;
  candidates: Scalar[];
}

export interface Version {
  version: number;
  at: string;
  by: string;
  documentType: string;
  group: string | null;
  configVersion: string;
  values: Record<string, Scalar | null>;
  tables: Record<string, Record<string, Scalar | null>[]>;
}

export type DocumentStatus = "queued" | "reading" | "review" | "approved" | "discarded" | "failed";

export interface StoredDocument {
  id: string;
  appId: string;
  status: DocumentStatus;
  error?: string;
  createdAt: string;
  createdBy: string | null;
  /** Documents captured together. */
  batch: string | null;
  /** File-store id, when the document arrived as a chat attachment. */
  sourceFileId?: string | null;
  name: string;
  /** Untouched originals this document came from, and the page within each. */
  originals: { sha256: string; name: string; mime: string; size: number; page: number | null }[];
  pages: { file: string; mime: string }[];
  /** The configuration the current reading was made under. */
  configVersion: string;
  documentType: string | null;
  group: string | null;
  reading: Reading | null;
  values: Record<string, Scalar | null>;
  tables: Record<string, Record<string, Scalar | null>[]>;
  /** Keyed by value path: "field" or "table[row].column". */
  resolved: Record<string, Resolution>;
  flags: Record<string, Flag>;
  versions: Version[];
  history: { at: string; by: string | null; action: string; detail?: string }[];
  /** The names this record's approval added to the learned lists, so a correction can take them back. */
  learned?: { list: string; value: string }[];
  /**
   * The number and time of the last change to what this record counts for
   * outside the app (see "change stamps" above). Absent while it never has.
   */
  counted?: { seq: number; at: string };
}

/** A file already written under this store's directory (an upload received to disk). */
export interface ReceivedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface OriginalMeta {
  sha256: string;
  name: string;
  mime: string;
  size: number;
  firstSeen: string;
}

/**
 * What is kept in memory for every document: enough to list, search, count
 * and compare without opening the record.
 */
export interface IndexEntry {
  id: string;
  name: string;
  status: DocumentStatus;
  error?: string;
  documentType: string | null;
  group: string | null;
  batch: string | null;
  sourceFileId: string | null;
  createdAt: string;
  createdBy: string | null;
  pages: number;
  /** Values still waiting on a person. */
  ask: number;
  confirm: number;
  version: number;
  approvedAt: string | null;
  approvedBy: string | null;
  /** When it was first approved. Corrections approved later do not move it. */
  firstApprovedAt: string | null;
  /** The form its last approved version was approved as; a later re-read may have changed `documentType`. */
  approvedForm: string | null;
  /** The header values (not the table lines). */
  values: Record<string, Scalar | null>;
  /** Number of lines in each table. */
  lines: Record<string, number>;
  /** Lower-cased text to search: name, group, values and table cells, capped. */
  text: string;
  /** This document's share of the calibration counts, once approved. */
  cal: number[] | null;
  /** What of this record counts right now, as the kind puts it; null when nothing does. */
  sig: string | null;
  /** The number of the last change to that; null while it has never counted. */
  seq: number | null;
  /** When that change was. */
  countedAt: string | null;
  /** Modification time and size of the record file this entry was made from. */
  mtime: number;
  size?: number;
}

/** What only the app's configuration can say about a record. */
export type Describe = (doc: StoredDocument) => { ask: number; confirm: number; cal: number[] | null };

export interface StoreOptions {
  describe?: Describe;
  /** Changes whenever `describe` would answer differently; a change rebuilds the index. */
  version?: string;
  /** Full records kept in memory. */
  cacheSize?: number;
  log?: (message: string, level?: "info" | "error") => void;
  /**
   * Called with every record once it is stored. This is how anything built
   * from the records (the query database) follows them: there is one place a
   * record is written, so there is one place to be told. It must not throw;
   * the record is already stored when it runs.
   */
  onSaved?: (doc: StoredDocument) => Promise<void> | void;
  /**
   * What of a record counts outside the app, as one piece of text; null when
   * nothing does. A record is stamped whenever storing it changes this.
   */
  counted?: (doc: StoredDocument) => string | null;
  /**
   * Applied to every record as it is read from its file, before anything
   * else sees it. For what the app's configuration says about records written
   * before it changed (a field that was renamed). It changes the record in
   * hand only; the file is rewritten the next time the record is stored.
   */
  migrate?: (doc: StoredDocument) => void;
}

const INDEX_FORMAT = 4;
const TEXT_CAP = 4000;

const ID = /^[a-z0-9-]{1,64}$/i;
const SHA = /^[0-9a-f]{64}$/;

export class EncodingStore {
  private index = new Map<string, IndexEntry>();
  /** Recently used full records, oldest first. */
  private cache = new Map<string, StoredDocument>();
  private locks = new Map<string, Promise<unknown>>();
  private indexWrites: Promise<unknown> = Promise.resolve();
  private indexLines = 0;
  private readonly describe: Describe;
  private readonly version: string;
  private readonly cacheSize: number;
  private readonly log: (message: string, level?: "info" | "error") => void;
  private readonly onSaved: (doc: StoredDocument) => Promise<void> | void;
  private readonly migrate: (doc: StoredDocument) => void;
  private readonly counted: (doc: StoredDocument) => string | null;
  /** The highest change number given so far. */
  private seq = 0;
  /** The highest number carried by a record that is safely stored (never one still being written). */
  private storedMax = 0;
  /**
   * Every time the records were opened: an id for that run, and the highest
   * stamp there was when it began. Kept in store.json. It is how a place in
   * the list of changes is recognised as one this store really handed out.
   */
  private runs: { id: string; from: number }[] = [];
  private run = "";
  /** Numbers given to records that are still being written. Nothing at or above the lowest is handed out as a change yet. */
  private stamping = new Set<number>();
  private lastCounted = "";
  private id = "";
  private created = "";
  /** Stamped entries by number, made when first asked for and dropped when a stamp is given. */
  private stamped: IndexEntry[] | null = null;

  constructor(
    readonly dir: string,
    readonly appId: string,
    options: StoreOptions = {},
  ) {
    this.describe = options.describe ?? (() => ({ ask: 0, confirm: 0, cal: null }));
    this.version = `${INDEX_FORMAT}:${options.version ?? ""}`;
    this.cacheSize = options.cacheSize ?? 200;
    this.log = options.log ?? (() => {});
    this.onSaved = options.onSaved ?? (() => {});
    this.migrate = options.migrate ?? (() => {});
    this.counted = options.counted ?? (() => null);
  }

  private parse(text: string): StoredDocument {
    const doc = JSON.parse(text) as StoredDocument;
    this.migrate(doc);
    return doc;
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async init(): Promise<void> {
    for (const sub of ["originals", "pages", "docs", "uploads"]) {
      await mkdir(this.path(sub), { recursive: true });
    }
    await this.readIdentity();
    // Uploads that never finished leave their part-files behind.
    for (const file of await readdir(this.path("uploads"))) {
      if (file.endsWith(".part")) await rm(this.path("uploads", file), { force: true });
    }
    const { kept, known } = await this.readIndexFile();
    // A record being written when the server was stopped dead leaves its
    // half-written file behind; the record itself is as it was before. Only
    // files this store names that way are removed, and only files.
    const leftover = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
    for (const sub of ["docs", "originals", "uploads", "configs", "."]) {
      for (const file of await readdir(this.path(sub), { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && leftover.test(file.name)) await rm(this.path(sub, file.name), { force: true }).catch(() => {});
      }
    }
    const files = (await readdir(this.path("docs"))).filter((f) => f.endsWith(".json"));
    const present = new Set(files.map((f) => f.slice(0, -5)));
    let reread = 0;
    const started = Date.now();
    await inParallel(files, 32, async (file) => {
      const id = file.slice(0, -5);
      const path = this.path("docs", file);
      let mtime: number;
      let size: number;
      try {
        const at = await stat(path);
        mtime = at.mtimeMs;
        size = at.size;
      } catch {
        return;
      }
      const entry = kept?.get(id);
      if (entry && entry.mtime === mtime && entry.size === size) {
        this.index.set(id, entry);
        return;
      }
      try {
        const doc = this.parse(await readFile(path, "utf8"));
        if (doc?.id === id) this.index.set(id, this.entryOf(doc, mtime, size));
        else this.log(`record file docs/${file} does not hold the record its name says; it is left out until that is put right`, "error");
      } catch (err) {
        // A record that will not parse is left on disk for a person to look
        // at; it must not stop every other record from loading. It is said
        // loudly: until it is put right the record is missing from every
        // list, total and table.
        this.log(`record file docs/${file} cannot be read (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); the record is left out until that is put right`, "error");
      }
      if (++reread % 5000 === 0) this.log(`indexing records: ${reread} read`);
    });
    if (reread > 0) this.log(`indexed ${reread} record${reread === 1 ? "" : "s"} from disk in ${Date.now() - started} ms`);
    for (const e of this.index.values()) {
      if (e.seq !== null && e.seq > this.seq) this.seq = e.seq;
      if (e.countedAt && e.countedAt > this.lastCounted) this.lastCounted = e.countedAt;
    }
    this.storedMax = this.seq;

    // Whether whoever copied these records can carry on from where they
    // were. They cannot when what they were told no longer matches what is
    // here, and nothing in the list of changes would ever tell them:
    //   - a record that had counted is gone (nothing here removes a record's
    //     file, so it was lost or taken away by hand);
    //   - a record is back that the last run did not have (its file was put
    //     back, or could not be read then and can now), carrying an old
    //     stamp that every copy has long gone past;
    //   - there is no index from the last run to compare with at all.
    // In each case the store takes a new id, and every copy starts again.
    const stamped = [...this.index.values()].filter((e) => e.seq !== null);
    let startAgain: string | null = null;
    if (!known) {
      if (stamped.length > 0 && this.runs.length > 0) startAgain = "the index of the last run is missing, so what changed since cannot be vouched for";
    } else {
      const lost = [...known].filter(([id]) => !present.has(id));
      for (const [id] of lost.slice(0, 20)) this.log(`record file docs/${id}.json is gone; the record is left out of every list, total and table`, "error");
      if (lost.length > 20) this.log(`${lost.length - 20} more record files are gone`, "error");
      if (lost.some(([, seq]) => seq !== null)) startAgain = "a record that had counted is gone";
      // A record the last run did not have. One made in the last run's final
      // moments (stored, the server stopped before the index heard of it)
      // carries a stamp from that run and is simply new. One whose stamp is
      // from before that run began was here once and is back.
      const lastRunBegan = this.runs.at(-1)?.from;
      const back = lastRunBegan === undefined ? [] : stamped.filter((e) => !known.has(e.id) && e.seq! <= lastRunBegan);
      for (const e of back.slice(0, 20)) this.log(`record ${e.id} ("${e.name}") is back: the last run did not have it`, "info");
      if (back.length > 0) startAgain ??= "a record is back that the last run did not have";
    }
    if (startAgain) {
      this.log(`${startAgain}: every copy kept of these records starts again`, "error");
      this.id = randomUUID();
      this.runs = [];
    }
    this.run = randomUUID().slice(0, 8);
    this.runs.push({ id: this.run, from: this.storedMax });
    this.runs = this.runs.slice(-2000);
    // The verdict first, the tidied index after: the old index is the only
    // witness to what the last run had, and must not be replaced before
    // what was concluded from it is safely written.
    await this.writeJson(this.path("store.json"), { id: this.id, created: this.created, runs: this.runs });
    if (!kept || reread > 0 || kept.size !== this.index.size || this.indexLines > this.index.size) await this.compact();
  }

  /** This store's id: made the first time it is opened, and kept. */
  private async readIdentity(): Promise<void> {
    const path = this.path("store.json");
    try {
      const kept = JSON.parse(await readFile(path, "utf8")) as { id?: unknown; created?: unknown; runs?: unknown };
      if (typeof kept.id === "string" && kept.id && typeof kept.created === "string") {
        this.id = kept.id;
        this.created = kept.created;
        this.runs = Array.isArray(kept.runs)
          ? (kept.runs as { id?: unknown; from?: unknown }[]).filter((r) => typeof r?.id === "string" && typeof r?.from === "number").map((r) => ({ id: r.id as string, from: r.from as number }))
          : [];
        return;
      }
    } catch {
      // not made yet, or unreadable: a new one is made, and every copy starts again
    }
    // Written at the end of init, with this run in it.
    this.id = randomUUID();
    this.created = new Date().toISOString();
    this.runs = [];
  }

  /**
   * Keep a configuration under its version, once. Every approved version of
   * a record says which configuration it was approved under; with the
   * configuration itself kept, what a key meant then can always be looked up,
   * however the app's forms have changed since.
   */
  async keepConfig(version: string, config: unknown): Promise<void> {
    if (!/^[0-9a-f]{8,64}$/.test(version)) return;
    await mkdir(this.path("configs"), { recursive: true });
    const path = this.path("configs", `${version}.json`);
    try {
      await stat(path);
    } catch {
      await this.writeJson(path, { version, first_used: new Date().toISOString(), config });
    }
  }

  /** An id kept with these records for as long as they exist. */
  identity(): string {
    return this.id;
  }

  /** When what the records count for last changed; the store's own beginning while nothing has. */
  changedAt(): string {
    return this.lastCounted > this.created ? this.lastCounted : this.created;
  }

  /**
   * Where this store stands right now: this run, and the highest stamp that
   * is safely stored. Handed out with every page of changes, and handed back
   * with the next request, so the store can tell whether what the asker was
   * told still holds.
   */
  mark(): { run: string; high: number } {
    return { run: this.run, high: this.storedMax };
  }

  /**
   * Whether someone who was told the changes up to `mark` can carry on from
   * there. They can when that mark is one this store gave and still stands
   * by: it names a run this store remembers, and a stamp that run really
   * reached. When the records are put back from an older copy, the runs
   * since that copy are not in it, and the run that was going when it was
   * taken never reached the later stamps: either way the mark is not one
   * this store knows, and the asker starts again. No clock is consulted.
   */
  continues(mark: { run: string; high: number }): boolean {
    if (!Number.isSafeInteger(mark.high) || mark.high < 0) return false;
    const at = this.runs.findIndex((r) => r.id === mark.run);
    if (at < 0) return false;
    // A run reached no further than where the next one began.
    return mark.high <= (at === this.runs.length - 1 ? this.storedMax : this.runs[at + 1].from);
  }

  /**
   * Records whose stamp comes after `after`, oldest change first; records
   * stamped in the same instant follow each other by id, so a place in the
   * list is a number and an id. Each record once, as it stands. A record
   * still being written is not handed out, nor anything stamped after it:
   * whoever follows this list remembers the last place it was given, and
   * must never be given an earlier one later.
   */
  changes(after: { seq: number; id: string } | null, limit: number): { seq: number; at: string; id: string; removed: boolean }[] {
    this.stamped ??= [...this.index.values()].filter((e) => e.seq !== null).sort((a, b) => a.seq! - b.seq! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let horizon = Infinity;
    for (const n of this.stamping) if (n < horizon) horizon = n;
    const seq = after?.seq ?? 0;
    const id = after?.id ?? "";
    const out: { seq: number; at: string; id: string; removed: boolean }[] = [];
    // The place to start is found by halving: the list is in order.
    let lo = 0;
    let hi = this.stamped.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = this.stamped[mid];
      if (e.seq! < seq || (e.seq === seq && e.id <= id)) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.stamped.length && out.length < limit; i++) {
      const e = this.stamped[i];
      if (e.seq! >= horizon) break;
      out.push({ seq: e.seq!, at: e.countedAt ?? this.created, id: e.id, removed: e.sig === null });
    }
    return out;
  }

  /** What of a record counts, by the kind's own rule. A record the rule cannot make sense of counts for nothing. */
  private sigOf(doc: StoredDocument): string | null {
    try {
      return this.counted(doc);
    } catch {
      return null;
    }
  }

  // ── The index ────────────────────────────────────────────────────────────

  private entryOf(doc: StoredDocument, mtime: number, fileSize?: number): IndexEntry {
    let described: ReturnType<Describe> = { ask: 0, confirm: 0, cal: null };
    try {
      described = this.describe(doc);
    } catch {
      // A record the current configuration cannot make sense of is still listed.
    }
    const values = doc.values ?? {};
    const tables = doc.tables ?? {};
    const parts: string[] = [doc.name ?? "", doc.group ?? ""];
    for (const v of Object.values(values)) if (v !== null && v !== undefined) parts.push(String(v));
    let size = parts.reduce((n, p) => n + p.length + 1, 0);
    outer: for (const rows of Object.values(tables)) {
      for (const row of rows ?? []) {
        for (const v of Object.values(row ?? {})) {
          if (v === null || v === undefined) continue;
          const text = String(v);
          if (size + text.length > TEXT_CAP) break outer;
          parts.push(text);
          size += text.length + 1;
        }
      }
    }
    const last = doc.versions?.at(-1);
    const sig = this.sigOf(doc);
    // A record from before stamps were kept gets one from what it already
    // says: the same one every time it is read, until it is next stored.
    const sinceAt = sig !== null ? last?.at : (doc.versions?.length ?? 0) > 0 ? (doc.history?.at(-1)?.at ?? last?.at) : undefined;
    const stamp = doc.counted ?? (sinceAt && Number.isFinite(Date.parse(sinceAt)) ? { seq: Date.parse(sinceAt), at: sinceAt } : null);
    return {
      id: doc.id,
      name: doc.name,
      status: doc.status,
      ...(doc.error ? { error: doc.error } : {}),
      documentType: doc.documentType ?? null,
      group: doc.group ?? null,
      batch: doc.batch ?? null,
      sourceFileId: doc.sourceFileId ?? null,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy ?? null,
      pages: doc.pages?.length ?? 0,
      ask: described.ask,
      confirm: described.confirm,
      version: doc.versions?.length ?? 0,
      approvedAt: last?.at ?? null,
      approvedBy: last?.by ?? null,
      firstApprovedAt: doc.versions?.[0]?.at ?? null,
      approvedForm: last?.documentType ?? null,
      values,
      lines: Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows?.length ?? 0])),
      text: parts.join("\n").toLowerCase().slice(0, TEXT_CAP),
      cal: described.cal,
      sig,
      seq: stamp?.seq ?? null,
      countedAt: stamp?.at ?? null,
      mtime,
      ...(fileSize !== undefined ? { size: fileSize } : {}),
    };
  }

  /**
   * The index as last written. `kept` is null when it is missing or was made
   * under another configuration, and every record is then read again.
   * `known` is which records the last run had and the stamp each carried,
   * whatever configuration it ran under; null only when there is no index
   * file to say.
   */
  private async readIndexFile(): Promise<{ kept: Map<string, IndexEntry> | null; known: Map<string, number | null> | null }> {
    let raw: string;
    try {
      raw = await readFile(this.path("index.jsonl"), "utf8");
    } catch {
      return { kept: null, known: null };
    }
    const lines = raw.split("\n");
    let usable = false;
    try {
      usable = (JSON.parse(lines[0]) as { index?: string }).index === this.version;
    } catch {
      return { kept: null, known: null };
    }
    const kept = new Map<string, IndexEntry>();
    const known = new Map<string, number | null>();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]) as IndexEntry;
        // Later lines win: each change to a record appends one.
        if (entry?.id) {
          kept.set(entry.id, entry);
          known.set(entry.id, typeof entry.seq === "number" ? entry.seq : null);
        }
        this.indexLines++;
      } catch {
        // A line cut short by a crash; that record's file time will not match and it is read again.
      }
    }
    if (!usable) this.indexLines = 0;
    return { kept: usable ? kept : null, known };
  }

  /** Rewrite the index file with one line per document. */
  private compact(): Promise<void> {
    const run = this.indexWrites
      .catch(() => {})
      .then(async () => {
        const path = this.path("index.jsonl");
        const tmp = `${path}.${randomUUID()}.tmp`;
        const lines = [JSON.stringify({ index: this.version })];
        for (const entry of this.index.values()) lines.push(JSON.stringify(entry));
        await writeFile(tmp, lines.join("\n") + "\n");
        await rename(tmp, path);
        this.indexLines = this.index.size;
      });
    this.indexWrites = run;
    return run;
  }

  private noteInIndex(entry: IndexEntry): Promise<void> {
    const run = this.indexWrites
      .catch(() => {})
      .then(async () => {
        await appendFile(this.path("index.jsonl"), JSON.stringify(entry) + "\n");
        this.indexLines++;
      });
    this.indexWrites = run;
    // The file is tidied once it holds far more lines than documents.
    if (this.indexLines > Math.max(2000, this.index.size * 3)) void this.compact().catch(() => {});
    return run;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
  }

  // ── Originals ────────────────────────────────────────────────────────────

  /** Where an upload is written while it arrives; pass it on as a ReceivedFile or remove it. */
  tempPath(): string {
    return this.path("uploads", `${randomUUID()}.part`);
  }

  /** Store an original once, by its fingerprint. A second arrival changes nothing. */
  async putOriginal(source: Buffer | ReceivedFile, name: string, mime: string): Promise<OriginalMeta> {
    const sha256 = Buffer.isBuffer(source) ? createHash("sha256").update(source).digest("hex") : source.sha256;
    const size = Buffer.isBuffer(source) ? source.length : source.size;
    const metaPath = this.path("originals", `${sha256}.json`);
    try {
      return JSON.parse(await readFile(metaPath, "utf8")) as OriginalMeta;
    } catch {
      // not stored yet
    }
    if (Buffer.isBuffer(source)) {
      const tmp = this.path("originals", `${sha256}.${randomUUID()}.tmp`);
      await writeFile(tmp, source);
      await rename(tmp, this.path("originals", sha256));
    } else {
      await rename(source.path, this.path("originals", sha256));
    }
    const meta: OriginalMeta = { sha256, name, mime, size, firstSeen: new Date().toISOString() };
    await this.writeJson(metaPath, meta);
    return meta;
  }

  async originalMeta(sha256: string): Promise<OriginalMeta | null> {
    if (!SHA.test(sha256)) return null;
    try {
      return JSON.parse(await readFile(this.path("originals", `${sha256}.json`), "utf8")) as OriginalMeta;
    } catch {
      return null;
    }
  }

  originalPath(sha256: string): string | null {
    return SHA.test(sha256) ? this.path("originals", sha256) : null;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  async putPage(docId: string, index: number, source: Buffer | ReceivedFile): Promise<string> {
    const file = `${docId}-${index}`;
    if (Buffer.isBuffer(source)) await writeFile(this.path("pages", file), source);
    else await rename(source.path, this.path("pages", file));
    return file;
  }

  pagePath(file: string): string | null {
    return /^[a-z0-9-]{1,80}$/i.test(file) ? this.path("pages", file) : null;
  }

  async readPage(file: string): Promise<Buffer> {
    const path = this.pagePath(file);
    if (!path) throw new Error("Bad page reference");
    return readFile(path);
  }

  // ── Uploads (so a retried upload does not create documents twice) ────────

  async uploadResult(uploadId: string): Promise<string[] | null> {
    if (!ID.test(uploadId)) return null;
    try {
      return JSON.parse(await readFile(this.path("uploads", `${uploadId}.json`), "utf8")) as string[];
    } catch {
      return null;
    }
  }

  async recordUpload(uploadId: string, docIds: string[]): Promise<void> {
    if (ID.test(uploadId)) await this.writeJson(this.path("uploads", `${uploadId}.json`), docIds);
  }

  // ── Documents ────────────────────────────────────────────────────────────

  newId(): string {
    return randomUUID();
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** The index entry of one document. */
  entry(id: string): IndexEntry | null {
    return this.index.get(id) ?? null;
  }

  /** The index entry of every document. Cheap: nothing is read from disk. */
  entries(): IndexEntry[] {
    return [...this.index.values()];
  }

  private remember(doc: StoredDocument): void {
    this.cache.delete(doc.id);
    this.cache.set(doc.id, doc);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  /**
   * One full record. Treat it as read-only: changes go through `update`,
   * which works on a copy and only replaces this one once it is stored.
   */
  async load(id: string): Promise<StoredDocument | null> {
    if (!this.index.has(id)) return null;
    const cached = this.cache.get(id);
    if (cached) {
      this.remember(cached);
      return cached;
    }
    try {
      const doc = this.parse(await readFile(this.path("docs", `${id}.json`), "utf8"));
      // Someone may have stored a newer one while this was being read.
      const newer = this.cache.get(id);
      if (newer) return newer;
      this.remember(doc);
      return doc;
    } catch {
      return null;
    }
  }

  async save(doc: StoredDocument): Promise<void> {
    const path = this.path("docs", `${doc.id}.json`);
    // Stamped when what it counts for changes, in the same write as the
    // change itself (see "change stamps" at the top).
    const before = this.index.get(doc.id);
    const previous = doc.counted;
    let stamp: number | null = null;
    // A record handed over without the stamp it is known to carry keeps it.
    if (!previous && before && before.seq !== null && before.countedAt) doc.counted = { seq: before.seq, at: before.countedAt };
    if (this.sigOf(doc) !== (before?.sig ?? null)) {
      stamp = this.seq = Math.max(this.seq + 1, Date.now());
      this.stamping.add(stamp);
      doc.counted = { seq: stamp, at: new Date().toISOString() };
    }
    let entry: IndexEntry;
    try {
      await this.writeJson(path, doc);
      const written = await stat(path);
      entry = this.entryOf(doc, written.mtimeMs, written.size);
      this.index.set(doc.id, entry);
      if (stamp !== null) {
        this.stamped = null;
        if (stamp > this.storedMax) this.storedMax = stamp;
        if (doc.counted!.at > this.lastCounted) this.lastCounted = doc.counted!.at;
      }
    } catch (err) {
      // Not stored, so not stamped: the record in hand goes back to what it said.
      if (stamp !== null) {
        if (previous) doc.counted = previous;
        else delete doc.counted;
      }
      throw err;
    } finally {
      if (stamp !== null) this.stamping.delete(stamp);
    }
    this.remember(doc);
    await this.noteInIndex(entry);
    try {
      await this.onSaved(doc);
    } catch (err) {
      this.log(`onSaved failed for ${doc.id}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /**
   * One full record straight from its file, without touching the few kept in
   * memory. For work that walks every record (rebuilding what is derived from
   * them): going through `load` would push out the records people have open.
   * Throws when the file cannot be read, so a failed read is never mistaken
   * for an empty record.
   */
  async read(id: string): Promise<StoredDocument | null> {
    if (!this.index.has(id)) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    return this.parse(await readFile(this.path("docs", `${id}.json`), "utf8"));
  }

  /**
   * Change one document, one change at a time. Two people answering questions
   * on the same document must not overwrite each other's answers, so changes
   * to a document queue behind each other. The change is made on a copy: if
   * it is refused part-way, nothing of it remains.
   * Pass `changed` when the change may turn out to be none at all.
   */
  async update<T>(
    id: string,
    change: (doc: StoredDocument) => T | Promise<T>,
    /** Given the change's result, whether there is anything to store. Default: always. */
    changed: (result: T) => boolean = () => true,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const current = await this.load(id);
        if (!current) throw Object.assign(new Error("Document not found"), { statusCode: 404 });
        const draft = structuredClone(current);
        const result = await change(draft);
        if (changed(result)) await this.save(draft);
        return result;
      });
    this.locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id);
    }
  }

  // ── What approvals have taught ───────────────────────────────────────────
  //
  // Names people have approved (customers, drivers, products), counted per
  // list. They grow the lists a reading is checked against, with nobody
  // maintaining anything: the corpus is the approved records themselves.

  private learned: Record<string, Record<string, number>> | null = null;

  private async loadLearned(): Promise<Record<string, Record<string, number>>> {
    if (this.learned) return this.learned;
    try {
      this.learned = JSON.parse(await readFile(this.path("learned.json"), "utf8")) as Record<string, Record<string, number>>;
    } catch {
      this.learned = {};
    }
    return this.learned;
  }

  private learning: Promise<unknown> = Promise.resolve();

  /**
   * Count one approved use of each value in `add` under its list, and take
   * one back for each in `remove` (a record corrected after approval no
   * longer vouches for the name it carried before).
   */
  learn(add: { list: string; value: string }[], remove: { list: string; value: string }[] = []): Promise<void> {
    if (add.length === 0 && remove.length === 0) return Promise.resolve();
    const run = this.learning
      .catch(() => {})
      .then(async () => {
        const learned = await this.loadLearned();
        for (const { list, value } of remove) {
          const v = value.trim();
          const counts = learned[list];
          if (!counts || !(v in counts)) continue;
          if (--counts[v] <= 0) delete counts[v];
        }
        for (const { list, value } of add) {
          const v = value.trim();
          if (!v || v.length > 200) continue;
          const counts = (learned[list] ??= {});
          // A list that has grown this large is not being helped by more names.
          if (!(v in counts) && Object.keys(counts).length >= 5000) continue;
          counts[v] = (counts[v] ?? 0) + 1;
        }
        await this.writeJson(this.path("learned.json"), learned);
      });
    this.learning = run;
    return run;
  }

  /** Values approved at least `min` times under a list. */
  async learnedValues(list: string, min: number): Promise<string[]> {
    const counts = (await this.loadLearned())[list] ?? {};
    return Object.entries(counts)
      .filter(([, n]) => n >= min)
      .map(([v]) => v);
  }

  async learnedLists(): Promise<string[]> {
    return Object.keys(await this.loadLearned());
  }

  private disk: { bytes: number; at: number; running: Promise<number> | null } = { bytes: 0, at: 0, running: null };

  /**
   * Bytes held in originals and working copies. Measuring means looking at
   * every file, so the figure is refreshed at most every ten minutes, in the
   * background; a caller gets the last one straight away (null before the first).
   */
  async diskBytes(): Promise<number | null> {
    const stale = Date.now() - this.disk.at > 600_000;
    if (stale && !this.disk.running) {
      this.disk.running = this.measureDisk()
        .then((bytes) => {
          this.disk = { bytes, at: Date.now(), running: null };
          return bytes;
        })
        .catch(() => {
          this.disk.running = null;
          return this.disk.bytes;
        });
    }
    return this.disk.at === 0 ? null : this.disk.bytes;
  }

  private async measureDisk(): Promise<number> {
    let total = 0;
    for (const sub of ["originals", "pages"]) {
      await inParallel(await readdir(this.path(sub)), 32, async (file) => {
        try {
          total += (await stat(this.path(sub, file))).size;
        } catch {
          // removed meanwhile
        }
      });
    }
    return total;
  }
}

async function inParallel<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
