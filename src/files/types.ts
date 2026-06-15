// ---------------------------------------------------------------------------
// File attachments — smart handling for tabular uploads (CSV / XLSX)
//
// Instead of dumping a file's raw text into the agent's context (which is
// token-heavy and hallucination-prone for tabular data), an uploaded file is
// ingested into an isolated, read-only DuckDB database. The agent receives a
// compact MANIFEST (sheets/tables · columns + inferred types · row counts ·
// a few sample rows) and pulls exactly what it needs on demand via read-only
// SQL against that one file.
//
// Isolation: one DuckDB database per upload, opened for queries with external
// filesystem access disabled and configuration locked — so a query can reach
// neither the host filesystem, the app's own reporting DB, nor another
// upload's data. See store.ts for the sandbox config.
// ---------------------------------------------------------------------------

export interface FilesConfig {
  /** Master switch. When false/absent, no file routes are registered. */
  enabled: boolean;
  /**
   * Drop-zone directory holding uploaded files, their per-file DuckDB
   * databases, and sidecar manifests. Created on demand. Default:
   * `<os.tmpdir>/toolplex-app-files`.
   */
  dir?: string;
  /**
   * Auto-delete an uploaded file (and its DuckDB db) this many minutes after
   * upload. The desktop treats files as session-scoped; this is the
   * backstop sweep for abandoned uploads. Default: 1440 (24 hours).
   */
  ttlMinutes?: number;
  /** Reject uploads larger than this. Default: 100 MB. */
  maxUploadBytes?: number;
  /** Hard cap on rows returned by a single query. Default: 1000. */
  maxQueryRows?: number;
  /**
   * Hard cap on the serialized byte size of a query result. Rows are dropped
   * (and `truncated` set) until the payload fits. Default: 512 KB.
   */
  maxResultBytes?: number;
  /** Per-query wall-clock timeout in ms. Default: 15000. */
  queryTimeoutMs?: number;
  /** Sample rows embedded per table in the manifest. Default: 5. */
  manifestSampleRows?: number;
}

/** Resolved config with defaults applied — what the store actually uses. */
export interface ResolvedFilesConfig {
  dir: string;
  ttlMinutes: number;
  maxUploadBytes: number;
  maxQueryRows: number;
  maxResultBytes: number;
  queryTimeoutMs: number;
  manifestSampleRows: number;
}

export interface FileColumn {
  /** Column name — the identifier the agent uses in SQL. */
  name: string;
  /** DuckDB-inferred type, e.g. "BIGINT", "VARCHAR", "DATE", "DOUBLE". */
  type: string;
}

export interface FileTableManifest {
  /**
   * SQL table name the agent queries. For CSV this is always `data`; for
   * XLSX it is the sanitized sheet name (or `sheet1`, `sheet2`, … on
   * collision / empty names — see `sheetName` for the original label).
   */
  name: string;
  /** Original worksheet name (XLSX only). */
  sheetName?: string;
  rowCount: number;
  columns: FileColumn[];
  /** First N rows, value-normalized and length-capped for compactness. */
  sampleRows: Record<string, unknown>[];
}

export interface FileManifest {
  fileId: string;
  filename: string;
  kind: "csv" | "tsv" | "xlsx";
  sizeBytes: number;
  tables: FileTableManifest[];
  /** ISO timestamp of ingestion. */
  createdAt: string;
  /**
   * Non-fatal ingestion notes surfaced to the agent — e.g. "types could not
   * be inferred; all columns are text" or "skipped empty sheet 'Notes'".
   */
  notes?: string[];
}

export interface FileQueryResult {
  columns: FileColumn[];
  rows: Record<string, unknown>[];
  /** Rows returned after caps applied. */
  rowCount: number;
  /** True when the result was capped by row count or byte size. */
  truncated: boolean;
}
