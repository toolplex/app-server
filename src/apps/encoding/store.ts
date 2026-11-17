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
  /** The header values (not the table lines). */
  values: Record<string, Scalar | null>;
  /** Number of lines in each table. */
  lines: Record<string, number>;
  /** Lower-cased text to search: name, group, values and table cells, capped. */
  text: string;
  /** This document's share of the calibration counts, once approved. */
  cal: number[] | null;
  /** Modification time of the record file this entry was made from. */
  mtime: number;
}

/** What only the app's configuration can say about a record. */
export type Describe = (doc: StoredDocument) => { ask: number; confirm: number; cal: number[] | null };

export interface StoreOptions {
  describe?: Describe;
  /** Changes whenever `describe` would answer differently; a change rebuilds the index. */
  version?: string;
  /** Full records kept in memory. */
  cacheSize?: number;
  log?: (message: string) => void;
}

const INDEX_FORMAT = 2;
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
  private readonly log: (message: string) => void;

  constructor(
    readonly dir: string,
    readonly appId: string,
    options: StoreOptions = {},
  ) {
    this.describe = options.describe ?? (() => ({ ask: 0, confirm: 0, cal: null }));
    this.version = `${INDEX_FORMAT}:${options.version ?? ""}`;
    this.cacheSize = options.cacheSize ?? 200;
    this.log = options.log ?? (() => {});
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async init(): Promise<void> {
    for (const sub of ["originals", "pages", "docs", "uploads"]) {
      await mkdir(this.path(sub), { recursive: true });
    }
    // Uploads that never finished leave their part-files behind.
    for (const file of await readdir(this.path("uploads"))) {
      if (file.endsWith(".part")) await rm(this.path("uploads", file), { force: true });
    }
    const kept = await this.readIndexFile();
    const files = (await readdir(this.path("docs"))).filter((f) => f.endsWith(".json"));
    let reread = 0;
    const started = Date.now();
    await inParallel(files, 32, async (file) => {
      const id = file.slice(0, -5);
      const path = this.path("docs", file);
      let mtime: number;
      try {
        mtime = (await stat(path)).mtimeMs;
      } catch {
        return;
      }
      const entry = kept?.get(id);
      if (entry && entry.mtime === mtime) {
        this.index.set(id, entry);
        return;
      }
      try {
        const doc = JSON.parse(await readFile(path, "utf8")) as StoredDocument;
        if (doc?.id === id) this.index.set(id, this.entryOf(doc, mtime));
      } catch {
        // A record that will not parse is left on disk for a person to look
        // at; it must not stop every other record from loading.
      }
      if (++reread % 5000 === 0) this.log(`indexing records: ${reread} read`);
    });
    if (reread > 0) this.log(`indexed ${reread} record${reread === 1 ? "" : "s"} from disk in ${Date.now() - started} ms`);
    if (!kept || reread > 0 || kept.size !== this.index.size || this.indexLines > this.index.size) await this.compact();
  }

  // ── The index ────────────────────────────────────────────────────────────

  private entryOf(doc: StoredDocument, mtime: number): IndexEntry {
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
      values,
      lines: Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows?.length ?? 0])),
      text: parts.join("\n").toLowerCase().slice(0, TEXT_CAP),
      cal: described.cal,
      mtime,
    };
  }

  /** The index as last written, or null when it is missing or was made under another configuration. */
  private async readIndexFile(): Promise<Map<string, IndexEntry> | null> {
    let raw: string;
    try {
      raw = await readFile(this.path("index.jsonl"), "utf8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    try {
      if ((JSON.parse(lines[0]) as { index?: string }).index !== this.version) return null;
    } catch {
      return null;
    }
    const kept = new Map<string, IndexEntry>();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]) as IndexEntry;
        // Later lines win: each change to a record appends one.
        if (entry?.id) kept.set(entry.id, entry);
        this.indexLines++;
      } catch {
        // A line cut short by a crash; that record's file time will not match and it is read again.
      }
    }
    return kept;
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
      const doc = JSON.parse(await readFile(this.path("docs", `${id}.json`), "utf8")) as StoredDocument;
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
    await this.writeJson(path, doc);
    const entry = this.entryOf(doc, (await stat(path)).mtimeMs);
    this.index.set(doc.id, entry);
    this.remember(doc);
    await this.noteInIndex(entry);
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
