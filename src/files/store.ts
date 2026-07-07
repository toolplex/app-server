import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import ExcelJS from "exceljs";

import type {
  FileColumn,
  FileManifest,
  FileQueryResult,
  FilesConfig,
  FileTableManifest,
  ResolvedFilesConfig,
} from "./types.js";
import { validateReadOnlySql } from "./sqlGuard.js";

// ---------------------------------------------------------------------------
// Errors — carry an HTTP status so the route can map them directly.
// ---------------------------------------------------------------------------

export class FileStoreError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "FileStoreError";
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Sidecar record — persisted next to each upload so the store survives a
// process restart and the cleanup sweep can find abandoned files.
// ---------------------------------------------------------------------------

interface FileRecord {
  manifest: FileManifest;
  uploadPath: string;
  dbPath: string;
  ownerUserId?: string;
  ownerOrgId?: string;
  createdAtMs: number;
  // Durable snapshots (artifacts) are pinned — never removed by the TTL sweep.
  pinned?: boolean;
}

export interface Requester {
  userId?: string;
  orgId?: string;
}

const DEFAULTS = {
  // 7 days. Attachments are ephemeral, but a 24h TTL expired files mid-thread
  // for multi-day engagements. Combined with refresh-on-use (querying a file
  // bumps its clock), an actively-used file effectively never expires while the
  // conversation is alive; abandoned files still get swept within a week.
  ttlMinutes: 10080,
  maxUploadBytes: 100 * 1024 * 1024,
  maxQueryRows: 1000,
  maxResultBytes: 512 * 1024,
  queryTimeoutMs: 15_000,
  manifestSampleRows: 5,
  maxConcurrentIngests: 4,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxIngestRows: 2_000_000,
};

// Query-instance sandbox: read-only + no host filesystem access + config
// locked so the agent's SQL can't re-enable any of it. Verified to block
// read_csv on arbitrary paths, ATTACH, COPY, glob, and SET.
const QUERY_INSTANCE_CONFIG = {
  access_mode: "READ_ONLY",
  enable_external_access: "false",
  lock_configuration: "true",
} as const;

export class FileStore {
  private cfg: ResolvedFilesConfig;
  private sweepTimer?: NodeJS.Timeout;
  /** Ingests currently in flight in this process (concurrency guard). */
  private activeIngests = 0;

  constructor(config: FilesConfig) {
    this.cfg = {
      // One persistent, app-controlled store for everything (attachments AND
      // durable artifacts). Never the OS temp dir — the OS must not delete our
      // data out from under us (macOS clears $TMPDIR on reboot and prunes it
      // after ~3 days). Lifecycle is ours alone: the TTL sweep below and
      // explicit deletes. Default under the home dir (not cwd — cwd sits in the
      // deploy/repo tree and a clean redeploy could wipe it; home survives both
      // redeploys and reboots).
      dir: resolvePath(config.dir ?? join(homedir(), ".toolplex-app-files")),
      ttlMinutes: config.ttlMinutes ?? DEFAULTS.ttlMinutes,
      maxUploadBytes: config.maxUploadBytes ?? DEFAULTS.maxUploadBytes,
      maxQueryRows: config.maxQueryRows ?? DEFAULTS.maxQueryRows,
      maxResultBytes: config.maxResultBytes ?? DEFAULTS.maxResultBytes,
      queryTimeoutMs: config.queryTimeoutMs ?? DEFAULTS.queryTimeoutMs,
      manifestSampleRows: config.manifestSampleRows ?? DEFAULTS.manifestSampleRows,
      maxConcurrentIngests: config.maxConcurrentIngests ?? DEFAULTS.maxConcurrentIngests,
      maxTotalBytes: config.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
      maxIngestRows: config.maxIngestRows ?? DEFAULTS.maxIngestRows,
      // Canonicalize allowlist roots up front. Symlinked roots are re-resolved
      // in init() (realpath needs the path to exist).
      reportDirs: (config.reportDirs ?? []).map((d) => resolvePath(d)),
    };
  }

  get config(): ResolvedFilesConfig {
    return this.cfg;
  }

  async init(): Promise<void> {
    // The store must never live under the OS temp dir: macOS clears $TMPDIR on
    // reboot and prunes it after ~3 days, which would silently delete our data
    // (both durable artifacts and in-use attachments) even though the TTL sweep
    // spares pinned ones. We control lifecycle, not the OS — fail fast at
    // startup rather than lose data quietly later.
    if (await isUnderTmp(this.cfg.dir)) {
      throw new Error(
        `[app-server] files.dir must be on durable storage, not the OS temp dir ` +
          `(resolved: ${this.cfg.dir}). Data under the temp dir is wiped on reboot/tmp-clean, ` +
          `silently losing saved reports, charts, and in-use attachments. Set files.dir to a ` +
          `persistent path.`,
      );
    }
    await mkdir(this.cfg.dir, { recursive: true });
    // Resolve symlinks in the allowlist roots so the containment check below
    // compares realpaths on both sides. Roots that don't exist are dropped —
    // they can't be an ancestor of any real file anyway.
    if (this.cfg.reportDirs.length > 0) {
      const resolved: string[] = [];
      for (const root of this.cfg.reportDirs) {
        try {
          resolved.push(await realpath(root));
        } catch {
          /* non-existent root — drop it */
        }
      }
      this.cfg.reportDirs = resolved;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup sweep
  // -------------------------------------------------------------------------

  startCleanup(log: (msg: string) => void): void {
    // Sweep at a quarter of the TTL, clamped to [1min, 30min].
    const intervalMs = Math.min(
      30 * 60_000,
      Math.max(60_000, (this.cfg.ttlMinutes * 60_000) / 4),
    );
    this.sweepTimer = setInterval(() => {
      this.sweepExpired(log).catch((err) => {
        log(`file cleanup sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    // Don't keep the event loop alive for the sweep alone.
    this.sweepTimer.unref?.();
  }

  stopCleanup(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async sweepExpired(log: (msg: string) => void): Promise<void> {
    const cutoff = Date.now() - this.cfg.ttlMinutes * 60_000;
    let entries: string[];
    try {
      entries = await readdir(this.cfg.dir);
    } catch {
      return;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fileId = entry.slice(0, -5);
      const record = await this.readRecord(fileId).catch(() => null);
      if (!record) continue;
      // Pinned records (durable artifacts) are never swept.
      if (!record.pinned && record.createdAtMs < cutoff) {
        await this.removeFiles(fileId, record);
        removed++;
      }
    }
    if (removed > 0) log(`file cleanup: removed ${removed} expired upload(s)`);
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  async ingest(
    filename: string,
    buffer: Buffer,
    requester: Requester,
    opts: { pinned?: boolean } = {},
  ): Promise<FileManifest> {
    if (buffer.length === 0) {
      throw new FileStoreError(400, "Uploaded file is empty.");
    }
    if (buffer.length > this.cfg.maxUploadBytes) {
      throw new FileStoreError(
        413,
        `File too large (${mb(buffer.length)} MB). Maximum is ${mb(this.cfg.maxUploadBytes)} MB.`,
      );
    }

    const kind = detectKind(filename);
    if (!kind) {
      throw new FileStoreError(
        415,
        `Unsupported file type "${extname(filename) || filename}". Supported: .csv, .tsv, .xlsx.`,
      );
    }

    // Concurrency guard — bound peak memory. Reject (rather than queue) when
    // the process is already at capacity, so a burst of large/zip-bomb uploads
    // can't pile up in memory at once.
    if (this.activeIngests >= this.cfg.maxConcurrentIngests) {
      throw new FileStoreError(
        503,
        "Server is busy processing other uploads. Please retry in a moment.",
      );
    }
    this.activeIngests++;
    try {
      // Disk cap: if this upload would push the drop dir over the limit, run an
      // eager sweep of expired files; if still over, reject.
      if ((await this.dirSizeBytes()) + buffer.length > this.cfg.maxTotalBytes) {
        await this.sweepExpired(() => {});
        if ((await this.dirSizeBytes()) + buffer.length > this.cfg.maxTotalBytes) {
          throw new FileStoreError(
            507,
            "File storage is temporarily full. Please try again shortly.",
          );
        }
      }

      const fileId = randomUUID();
      const uploadPath = join(this.cfg.dir, `${fileId}${extname(filename) || `.${kind}`}`);
      const dbPath = join(this.cfg.dir, `${fileId}.duckdb`);
      const notes: string[] = [];

      await mkdir(this.cfg.dir, { recursive: true });
      // CSV/TSV may be UTF-16 (Excel's "Unicode Text" export) or carry a BOM —
      // DuckDB's read_csv_auto assumes UTF-8 and would otherwise ingest garbage
      // (null-byte-laden column names). Transcode to clean UTF-8 first. XLSX is
      // a binary zip handled by ExcelJS, so leave it untouched.
      if (kind === "xlsx") {
        await writeFile(uploadPath, buffer);
      } else {
        const { data, reencoded } = decodeTextBufferToUtf8(buffer);
        await writeFile(uploadPath, data);
        if (reencoded) notes.push(`Converted ${reencoded} text to UTF-8 for parsing.`);
      }

      let tables: FileTableManifest[];
      try {
        if (kind === "xlsx") {
          tables = await this.ingestXlsx(uploadPath, dbPath, fileId, notes);
        } else {
          tables = await this.ingestDelimited(uploadPath, dbPath, kind, notes);
        }
      } catch (err) {
        // Ingestion failed — leave nothing behind.
        await this.removeFiles(fileId, { uploadPath, dbPath } as FileRecord);
        throw new FileStoreError(
          422,
          `Could not process file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (tables.length === 0) {
        await this.removeFiles(fileId, { uploadPath, dbPath } as FileRecord);
        throw new FileStoreError(422, "File contained no readable tabular data.");
      }

      // Row cap: refuse absurdly large tables before they reach the query layer.
      const oversized = tables.find((t) => t.rowCount > this.cfg.maxIngestRows);
      if (oversized) {
        await this.removeFiles(fileId, { uploadPath, dbPath } as FileRecord);
        throw new FileStoreError(
          413,
          `File has too many rows (${oversized.rowCount.toLocaleString()}). Maximum is ${this.cfg.maxIngestRows.toLocaleString()}.`,
        );
      }

      const manifest: FileManifest = {
        fileId,
        filename,
        kind,
        sizeBytes: buffer.length,
        tables,
        createdAt: new Date().toISOString(),
        notes: notes.length > 0 ? notes : undefined,
      };

      const record: FileRecord = {
        manifest,
        uploadPath,
        dbPath,
        ownerUserId: requester.userId,
        ownerOrgId: requester.orgId,
        createdAtMs: Date.now(),
        // Pinned (durable artifact from a resolved report) → never TTL-swept.
        ...(opts.pinned ? { pinned: true } : {}),
      };
      await writeFile(this.recordPath(fileId), JSON.stringify(record), "utf8");

      return manifest;
    } finally {
      this.activeIngests--;
    }
  }

  /**
   * Resolve a report-generator's file pointer into a PINNED DuckDB snapshot.
   * The path is canonicalized (symlinks resolved) and MUST live under one of
   * the configured `reportDirs` roots — otherwise resolution is refused. This
   * is the report → artifact "pull" entry point: the MCP tool triggers the
   * report and returns a path the app-server can read; we read it here and
   * materialize it exactly like an uploaded smart file, but durable.
   */
  async resolveFromPath(ref: string, requester: Requester): Promise<FileManifest> {
    if (this.cfg.reportDirs.length === 0) {
      throw new FileStoreError(403, "Report path resolution is not enabled on this server.");
    }
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw new FileStoreError(400, "pointer.ref must be a non-empty path.");
    }

    // Resolve to an absolute realpath, THEN check containment — so a symlink
    // inside an allowed dir can't point out, and traversal (../) can't escape.
    // A relative ref is joined under each allowed root (the common case: the
    // report API returns a path relative to its export dir); an absolute ref is
    // taken as-is and must land under a root. realpath resolves symlinks and
    // throws if the file is missing.
    const candidates = isAbsolute(ref)
      ? [ref]
      : this.cfg.reportDirs.map((root) => join(root, ref));
    let abs: string | null = null;
    for (const cand of candidates) {
      try {
        const real = await realpath(cand);
        if (this.isUnderReportDirs(real)) {
          abs = real;
          break;
        }
      } catch {
        /* try the next root */
      }
    }
    if (!abs) {
      throw new FileStoreError(404, "Report file not found in the allowed directories.");
    }

    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new FileStoreError(404, "Report path is not a readable file.");
    }
    if (st.size > this.cfg.maxUploadBytes) {
      throw new FileStoreError(
        413,
        `Report too large (${mb(st.size)} MB). Maximum is ${mb(this.cfg.maxUploadBytes)} MB.`,
      );
    }
    if (!detectKind(abs)) {
      throw new FileStoreError(
        415,
        `Unsupported report type "${extname(abs) || abs}". Supported: .csv, .tsv, .xlsx.`,
      );
    }

    const buffer = await readFile(abs);
    // Reuse the full ingest pipeline (transcode, type inference, row caps),
    // pinned so it's a durable artifact snapshot.
    return this.ingest(basename(abs), buffer, requester, { pinned: true });
  }

  /** True when `abs` (a realpath) is at or under one of the allowlist roots. */
  private isUnderReportDirs(abs: string): boolean {
    return this.cfg.reportDirs.some((root) => {
      const rel = relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }

  /**
   * Materialize JSON rows into a fresh, PINNED DuckDB snapshot (an artifact —
   * durable, never TTL-swept). Reuses the same DuckDB + manifest machinery as
   * file ingest, so the resulting snapshot is queryable exactly like a smart
   * file. Rows are written to a temp JSON file and loaded via read_json_auto so
   * types are preserved.
   */
  async materialize(
    tableName: string,
    rows: Record<string, unknown>[],
    requester: Requester,
  ): Promise<FileManifest> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new FileStoreError(400, "Artifact has no rows.");
    }
    if (rows.length > this.cfg.maxIngestRows) {
      throw new FileStoreError(
        413,
        `Artifact has too many rows (${rows.length.toLocaleString()}). Maximum is ${this.cfg.maxIngestRows.toLocaleString()}.`,
      );
    }
    // SQL-safe table name (identifier) — fall back to "data".
    const safeTable = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(tableName) ? tableName : "data";

    const fileId = randomUUID();
    const jsonPath = join(this.cfg.dir, `${fileId}.rows.json`);
    const dbPath = join(this.cfg.dir, `${fileId}.duckdb`);

    await mkdir(this.cfg.dir, { recursive: true });
    try {
      await writeFile(jsonPath, JSON.stringify(rows), "utf8");

      let tables: FileTableManifest[];
      const inst = await DuckDBInstance.create(dbPath);
      try {
        const conn = await inst.connect();
        await conn.run(
          `CREATE TABLE ${safeTable} AS SELECT * FROM read_json_auto(${sqlString(jsonPath)})`,
        );
        const table = await this.describeTable(conn, safeTable);
        conn.disconnectSync();
        tables = [table];
      } finally {
        inst.closeSync();
      }

      // Drop the temp source — the DuckDB is the source of truth.
      await rm(jsonPath, { force: true }).catch(() => {});

      const manifest: FileManifest = {
        fileId,
        filename: `${safeTable}.artifact`,
        kind: "csv",
        sizeBytes: 0,
        tables,
        createdAt: new Date().toISOString(),
      };
      const record: FileRecord = {
        manifest,
        uploadPath: jsonPath,
        dbPath,
        ownerUserId: requester.userId,
        ownerOrgId: requester.orgId,
        createdAtMs: Date.now(),
        pinned: true,
      };
      await writeFile(this.recordPath(fileId), JSON.stringify(record), "utf8");
      return manifest;
    } catch (err) {
      await rm(jsonPath, { force: true }).catch(() => {});
      await this.removeFiles(fileId, { uploadPath: jsonPath, dbPath } as FileRecord).catch(() => {});
      if (err instanceof FileStoreError) throw err;
      throw new FileStoreError(
        422,
        `Could not create artifact: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Total bytes currently held in the drop dir (best-effort). */
  private async dirSizeBytes(): Promise<number> {
    let total = 0;
    let entries: string[];
    try {
      entries = await readdir(this.cfg.dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      try {
        total += (await stat(join(this.cfg.dir, entry))).size;
      } catch {
        /* file vanished mid-scan */
      }
    }
    return total;
  }

  /** CSV / TSV → a single table named `data`, types inferred by DuckDB. */
  private async ingestDelimited(
    uploadPath: string,
    dbPath: string,
    kind: "csv" | "tsv",
    notes: string[],
  ): Promise<FileTableManifest[]> {
    const inst = await DuckDBInstance.create(dbPath);
    try {
      const conn = await inst.connect();
      const path = sqlString(uploadPath);
      const delim = kind === "tsv" ? ", delim='\\t'" : "";
      try {
        await conn.run(
          `CREATE TABLE data AS SELECT * FROM read_csv_auto(${path}, sample_size=-1${delim})`,
        );
      } catch {
        // Messy/irregular file — fall back to all-text so ingestion still
        // succeeds and the agent can at least inspect the raw values.
        await conn.run(`DROP TABLE IF EXISTS data`);
        await conn.run(
          `CREATE TABLE data AS SELECT * FROM read_csv_auto(${path}, all_varchar=true, ignore_errors=true${delim})`,
        );
        notes.push(
          "Column types could not be inferred cleanly; all columns are treated as text.",
        );
      }
      const table = await this.describeTable(conn, "data");
      conn.disconnectSync();
      return [table];
    } finally {
      inst.closeSync();
    }
  }

  /** XLSX → one table per non-empty worksheet, via per-sheet CSV + DuckDB. */
  private async ingestXlsx(
    uploadPath: string,
    dbPath: string,
    fileId: string,
    notes: string[],
  ): Promise<FileTableManifest[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(uploadPath);

    const inst = await DuckDBInstance.create(dbPath);
    const usedNames = new Set<string>();
    const tempCsvs: string[] = [];
    try {
      const conn = await inst.connect();
      const tables: FileTableManifest[] = [];

      for (const ws of wb.worksheets) {
        if (ws.rowCount <= 0 || ws.actualRowCount <= 0) {
          notes.push(`Skipped empty sheet "${ws.name}".`);
          continue;
        }
        const tableName = uniqueIdent(ws.name || `sheet${tables.length + 1}`, usedNames);
        const csvPath = join(this.cfg.dir, `${fileId}__${tableName}.csv`);
        tempCsvs.push(csvPath);

        // ExcelJS writes a single worksheet to CSV with correct quoting; let
        // DuckDB do the type inference uniformly with the delimited path.
        await wb.csv.writeFile(csvPath, { sheetName: ws.name });

        const path = sqlString(csvPath);
        try {
          await conn.run(
            `CREATE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_csv_auto(${path}, sample_size=-1)`,
          );
        } catch {
          await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
          await conn.run(
            `CREATE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_csv_auto(${path}, all_varchar=true, ignore_errors=true)`,
          );
          notes.push(
            `Sheet "${ws.name}": types could not be inferred; columns treated as text.`,
          );
        }
        const table = await this.describeTable(conn, tableName, ws.name);
        if (table.rowCount === 0 && table.columns.length === 0) {
          await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
          notes.push(`Skipped empty sheet "${ws.name}".`);
          continue;
        }
        tables.push(table);
      }

      conn.disconnectSync();
      return tables;
    } finally {
      inst.closeSync();
      // Per-sheet CSVs were only scratch space for DuckDB ingestion.
      await Promise.all(tempCsvs.map((p) => rm(p, { force: true }).catch(() => {})));
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  async query(
    fileId: string,
    sql: string,
    requester: Requester,
  ): Promise<FileQueryResult> {
    const record = await this.getOwnedRecord(fileId, requester);

    const guard = validateReadOnlySql(sql);
    if (!guard.ok) throw new FileStoreError(400, guard.error!);

    const inst = await DuckDBInstance.create(record.dbPath, QUERY_INSTANCE_CONFIG);
    try {
      const conn = await inst.connect();
      try {
        const reader = await withTimeout(
          conn.runAndReadUntil(sql, this.cfg.maxQueryRows + 1),
          this.cfg.queryTimeoutMs,
          () => inst.closeSync(),
        );

        const columns: FileColumn[] = reader
          .columnNames()
          .map((name, i) => ({ name, type: String(reader.columnTypes()[i]) }));

        const all = reader.getRowObjects();
        let truncated = all.length > this.cfg.maxQueryRows;
        let rows = all.slice(0, this.cfg.maxQueryRows).map((r) => normalizeRow(r));

        // Byte cap — drop rows until the serialized payload fits.
        if (byteLen(rows) > this.cfg.maxResultBytes) {
          truncated = true;
          while (rows.length > 0 && byteLen(rows) > this.cfg.maxResultBytes) {
            rows = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.8)) - 1);
          }
        }

        return { columns, rows, rowCount: rows.length, truncated };
      } catch (err) {
        // Surface DuckDB's message — it's the most useful feedback for the
        // agent to fix its SQL (unknown column, syntax error, etc.).
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        throw new FileStoreError(400, `Query failed: ${msg}`);
      } finally {
        try {
          conn.disconnectSync();
        } catch {
          /* instance may already be closed by the timeout path */
        }
      }
    } finally {
      try {
        inst.closeSync();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Server-side paginated / sorted / filtered read of a snapshot — the engine
   * behind arbitrary-size artifact tables. Builds a bounded SQL query against
   * the pinned DuckDB (columns validated against the table's real schema, values
   * single-quote-escaped) and runs it in the read-only sandbox. Returns one page
   * of rows plus the total count for the current filter, so the client never
   * loads more than a page regardless of report size.
   */
  async queryRows(
    fileId: string,
    requester: Requester,
    opts: {
      page: number;
      pageSize: number;
      sort?: { key: string; direction: "asc" | "desc" };
      filters?: { column: string; operator: string; value: string }[];
    },
  ): Promise<{ rows: Record<string, unknown>[]; total: number; columns: FileColumn[] }> {
    const record = await this.getOwnedRecord(fileId, requester);
    const table = record.manifest.tables[0];
    if (!table) throw new FileStoreError(404, "Artifact has no data table.");
    const validCols = new Set(table.columns.map((c) => c.name));
    const tbl = quoteIdent(table.name);

    // WHERE — only recognized columns/operators; values are escaped. Semantics
    // mirror the client's inline filters (case-insensitive contains/equals,
    // numeric gt/lt, empty/not_empty).
    const clauses: string[] = [];
    for (const f of opts.filters ?? []) {
      if (!validCols.has(f.column)) continue;
      const col = quoteIdent(f.column);
      const val = sqlString(f.value ?? "");
      switch (f.operator) {
        case "contains":
          clauses.push(`strpos(lower(CAST(${col} AS VARCHAR)), lower(${val})) > 0`);
          break;
        case "equals":
          clauses.push(`lower(CAST(${col} AS VARCHAR)) = lower(${val})`);
          break;
        case "gt":
          clauses.push(`TRY_CAST(${col} AS DOUBLE) > TRY_CAST(${val} AS DOUBLE)`);
          break;
        case "lt":
          clauses.push(`TRY_CAST(${col} AS DOUBLE) < TRY_CAST(${val} AS DOUBLE)`);
          break;
        case "empty":
          clauses.push(`(${col} IS NULL OR CAST(${col} AS VARCHAR) = '')`);
          break;
        case "not_empty":
          clauses.push(`(${col} IS NOT NULL AND CAST(${col} AS VARCHAR) <> '')`);
          break;
        default:
          break;
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    let orderBy = "";
    if (opts.sort && validCols.has(opts.sort.key)) {
      const dir = opts.sort.direction === "desc" ? "DESC" : "ASC";
      orderBy = `ORDER BY ${quoteIdent(opts.sort.key)} ${dir} NULLS LAST`;
    }

    const pageSize = Math.min(Math.max(Math.floor(opts.pageSize) || 100, 1), 1000);
    const page = Math.max(1, Math.floor(opts.page) || 1);
    const offset = (page - 1) * pageSize;

    const inst = await DuckDBInstance.create(record.dbPath, QUERY_INSTANCE_CONFIG);
    try {
      const conn = await inst.connect();
      try {
        const countReader = await withTimeout(
          conn.runAndReadAll(`SELECT count(*) AS c FROM ${tbl} ${where}`),
          this.cfg.queryTimeoutMs,
          () => inst.closeSync(),
        );
        const total = Number(countReader.getRowObjects()[0]?.c ?? 0);

        // `rowid` gives a stable per-row key for the client (the snapshot is
        // immutable). It's added as `_id` and isn't in the manifest columns, so
        // it never renders as a data column.
        const reader = await withTimeout(
          conn.runAndReadUntil(
            `SELECT *, rowid AS _id FROM ${tbl} ${where} ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`,
            pageSize + 1,
          ),
          this.cfg.queryTimeoutMs,
          () => inst.closeSync(),
        );
        const columns: FileColumn[] = reader
          .columnNames()
          .map((name, i) => ({ name, type: String(reader.columnTypes()[i]) }))
          .filter((c) => c.name !== "_id");
        let rows = reader.getRowObjects().map((r) => normalizeRow(r));
        if (byteLen(rows) > this.cfg.maxResultBytes) {
          while (rows.length > 0 && byteLen(rows) > this.cfg.maxResultBytes) {
            rows = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.8)) - 1);
          }
        }
        conn.disconnectSync();
        return { rows, total, columns };
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        throw new FileStoreError(400, `Query failed: ${msg}`);
      } finally {
        try {
          conn.disconnectSync();
        } catch {
          /* instance may already be closed by the timeout path */
        }
      }
    } finally {
      try {
        inst.closeSync();
      } catch {
        /* already closed */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lookup / delete
  // -------------------------------------------------------------------------

  async getManifest(fileId: string, requester: Requester): Promise<FileManifest> {
    const record = await this.getOwnedRecord(fileId, requester);
    return record.manifest;
  }

  async list(requester: Requester): Promise<FileManifest[]> {
    let entries: string[];
    try {
      entries = await readdir(this.cfg.dir);
    } catch {
      return [];
    }
    const out: FileManifest[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.readRecord(entry.slice(0, -5)).catch(() => null);
      if (record && this.ownsRecord(record, requester)) out.push(record.manifest);
    }
    return out;
  }

  /** Idempotent — deleting an unknown / already-gone file is a no-op success. */
  async delete(fileId: string, requester: Requester): Promise<void> {
    const record = await this.readRecord(fileId).catch(() => null);
    if (!record) return;
    if (!this.ownsRecord(record, requester)) {
      throw new FileStoreError(404, "File not found.");
    }
    await this.removeFiles(fileId, record);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async describeTable(
    conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
    tableName: string,
    sheetName?: string,
  ): Promise<FileTableManifest> {
    const descReader = await conn.runAndReadAll(`DESCRIBE ${quoteIdent(tableName)}`);
    const columns: FileColumn[] = descReader.getRowObjects().map((r) => ({
      name: stripNulls(String(r.column_name)),
      type: String(r.column_type),
    }));

    const countReader = await conn.runAndReadAll(
      `SELECT count(*) AS c FROM ${quoteIdent(tableName)}`,
    );
    const rowCount = Number(countReader.getRowObjects()[0]?.c ?? 0);

    const sampleReader = await conn.runAndReadAll(
      `SELECT * FROM ${quoteIdent(tableName)} LIMIT ${this.cfg.manifestSampleRows}`,
    );
    const sampleRows = sampleReader.getRowObjects().map((r) => normalizeRow(r, 200));

    return {
      name: tableName,
      ...(sheetName && sheetName !== tableName ? { sheetName } : {}),
      rowCount,
      columns,
      sampleRows,
    };
  }

  private recordPath(fileId: string): string {
    return join(this.cfg.dir, `${fileId}.json`);
  }

  private async readRecord(fileId: string): Promise<FileRecord> {
    if (!isSafeId(fileId)) throw new FileStoreError(400, "Invalid file id.");
    const raw = await readFile(this.recordPath(fileId), "utf8");
    return JSON.parse(raw) as FileRecord;
  }

  private async getOwnedRecord(
    fileId: string,
    requester: Requester,
  ): Promise<FileRecord> {
    let record: FileRecord;
    try {
      record = await this.readRecord(fileId);
    } catch (err) {
      if (err instanceof FileStoreError) throw err;
      throw new FileStoreError(404, "File not found. It may have expired.");
    }
    if (!this.ownsRecord(record, requester)) {
      // Don't leak existence to a non-owner.
      throw new FileStoreError(404, "File not found.");
    }
    // Refresh-on-use: bump the TTL clock so a file that's still being queried in
    // an active conversation doesn't get swept out from under it. Best-effort —
    // never fail a read because the touch couldn't be persisted.
    record.createdAtMs = Date.now();
    writeFile(this.recordPath(fileId), JSON.stringify(record), "utf8").catch(() => {});
    return record;
  }

  /**
   * Ownership: enforced only when both sides carry the identity field. The
   * connection-level bearer token already proves the caller is the trusted
   * proxy; this is org/user-scoped defense-in-depth for shared app-servers.
   * System / out-of-band callers (no identity) are allowed, matching the
   * rest of app-server's trust model.
   */
  private ownsRecord(record: FileRecord, requester: Requester): boolean {
    // Org is the hard boundary. Within an org, attachments are shared (no
    // per-user scoping) — tighten here if strict per-user isolation is ever
    // needed.
    if (record.ownerOrgId && requester.orgId && record.ownerOrgId !== requester.orgId) {
      return false;
    }
    return true;
  }

  private async removeFiles(fileId: string, record: Partial<FileRecord>): Promise<void> {
    const targets = [
      record.uploadPath,
      record.dbPath,
      isSafeId(fileId) ? this.recordPath(fileId) : undefined,
    ].filter(Boolean) as string[];
    await Promise.all(targets.map((p) => rm(p, { force: true }).catch(() => {})));
    // Sweep any leftover per-sheet scratch CSVs (xlsx ingestion).
    if (isSafeId(fileId)) {
      try {
        const entries = await readdir(this.cfg.dir);
        await Promise.all(
          entries
            .filter((e) => e.startsWith(`${fileId}__`) && e.endsWith(".csv"))
            .map((e) => rm(join(this.cfg.dir, e), { force: true }).catch(() => {})),
        );
      } catch {
        /* dir gone */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `dir` resolves at or under the OS temp dir. Checks both the raw
 * temp path and its realpath (on macOS `/tmp` → `/private/tmp`, and `$TMPDIR`
 * lives under `/var/folders/...`) so a symlinked or canonical form is caught
 * either way. Used to reject a store dir that the OS would wipe on reboot.
 */
async function isUnderTmp(dir: string): Promise<boolean> {
  const target = resolvePath(dir);
  const roots = new Set<string>([resolvePath(tmpdir())]);
  try {
    roots.add(await realpath(tmpdir()));
  } catch {
    /* tmpdir always exists in practice; ignore */
  }
  for (const root of roots) {
    const rel = relative(root, target);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Decode an uploaded text file (CSV/TSV) to a clean UTF-8 buffer. Excel often
 * exports CSV as UTF-16 (LE/BE, usually with a BOM) or UTF-8-with-BOM; DuckDB's
 * read_csv_auto assumes UTF-8 and produces garbage (null-byte-laden column
 * names) otherwise. Detect the encoding and transcode, stripping any BOM.
 * Returns the (possibly unchanged) buffer plus a label when re-encoded.
 */
function decodeTextBufferToUtf8(buffer: Buffer): { data: Buffer; reencoded?: string } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { data: Buffer.from(new TextDecoder("utf-16le").decode(buffer), "utf8"), reencoded: "UTF-16" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { data: Buffer.from(new TextDecoder("utf-16be").decode(buffer), "utf8"), reencoded: "UTF-16" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { data: buffer.subarray(3), reencoded: "UTF-8 (BOM stripped)" }; // strip UTF-8 BOM
  }
  // No BOM: sniff for UTF-16 by null-byte density. ASCII text in UTF-16 has a
  // null byte for (almost) every character — a strong, cheap signal.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let nullCount = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0x00) nullCount++;
  if (sample.length > 0 && nullCount / sample.length > 0.2) {
    // Guess LE vs BE: UTF-16LE puts the null in odd byte positions for ASCII.
    let oddNulls = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0x00) oddNulls++;
    const enc = oddNulls > nullCount / 2 ? "utf-16le" : "utf-16be";
    return { data: Buffer.from(new TextDecoder(enc).decode(buffer), "utf8"), reencoded: "UTF-16" };
  }
  return { data: buffer };
}

/** Strip NUL bytes — they corrupt manifests and are rejected by some LLM APIs. */
function stripNulls(s: string): string {
  const NUL = String.fromCharCode(0);
  return s.indexOf(NUL) === -1 ? s : s.split(NUL).join("");
}

function detectKind(filename: string): "csv" | "tsv" | "xlsx" | null {
  const ext = extname(filename).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".tsv" || ext === ".tab") return "tsv";
  if (ext === ".xlsx") return "xlsx";
  return null;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Single-quote a string for inline SQL (paths). Doubles embedded quotes. */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Double-quote a SQL identifier, escaping embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Derive a SQL-friendly table name from a sheet name and ensure uniqueness
 * within a workbook. Lowercases, replaces non-alphanumerics with `_`,
 * ensures it doesn't start with a digit, and de-duplicates with a suffix.
 */
function uniqueIdent(raw: string, used: Set<string>): string {
  let base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length === 0) base = "sheet";
  if (/^[0-9]/.test(base)) base = `s_${base}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/** fileIds are UUIDs we generate — reject anything that isn't, to keep paths safe. */
function isSafeId(id: string): boolean {
  return /^[0-9a-fA-F-]{8,64}$/.test(id);
}

function byteLen(rows: unknown): number {
  return Buffer.byteLength(JSON.stringify(rows ?? []), "utf8");
}

function normalizeRow(
  row: Record<string, unknown>,
  maxStringLen?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = normalizeValue(v, maxStringLen);
  }
  return out;
}

/**
 * DuckDB's neo client returns native JS values for primitives but typed
 * wrapper objects for temporal/decimal/nested types (e.g. DATE → {days},
 * DECIMAL → {width,scale,value}). Their `toString()` yields the canonical
 * SQL rendering ("2026-01-02", "3.14"), so we stringify wrappers and fall
 * back to a BigInt-safe JSON for anything without a useful toString.
 */
function normalizeValue(v: unknown, maxStringLen?: number): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : (v as bigint).toString();
  }
  if (t === "number" || t === "boolean") return v;
  if (t === "string") return capStr(stripNulls(v as string), maxStringLen);
  if (v instanceof Date) return v.toISOString();
  if (t === "object") {
    const s = safeToString(v);
    if (s !== null) return capStr(stripNulls(s), maxStringLen);
    try {
      return JSON.parse(
        JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)),
      );
    } catch {
      return String(v);
    }
  }
  return v;
}

function safeToString(v: unknown): string | null {
  try {
    const s = (v as { toString(): string }).toString();
    return s === "[object Object]" ? null : s;
  } catch {
    return null;
  }
}

function capStr(s: string, maxLen?: number): string {
  if (!maxLen || s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

/**
 * Race a promise against a timeout. On timeout, run `onTimeout` (closes the
 * DuckDB instance to abort the in-flight query) and reject.
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
      reject(new FileStoreError(408, `Query exceeded the ${ms / 1000}s time limit.`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
