# @toolplex/app-server

Fastify plugin for serving [ToolPlex](https://toolplex.ai) App Pages and Apps. Define page layouts, data handlers, and actions — the plugin generates the HTTP endpoints that power interactive pages in the ToolPlex desktop and mobile apps. Declare [Apps](#apps) beside them for work people do, such as turning paper documents into records.

## Install

```bash
npm install @toolplex/app-server
```

Requires Fastify 5+.

## Quick Start

```typescript
import Fastify from 'fastify';
import { registerAppPages } from '@toolplex/app-server';

const server = Fastify();

await server.register(registerAppPages, {
  authToken: process.env.TOOLPLEX_APP_TOKEN,

  pages: {
    'production-report': {
      title: 'Production Report',
      filters: [
        { key: 'month', type: 'dropdown', options: ['2026-01', '2026-02', '2026-03'] },
        { key: 'department', type: 'dropdown', options: ['socks', 'accessories'] },
      ],
      sections: [
        { type: 'card-row', source: 'kpis' },
        { type: 'table', source: 'production', rowKey: 'id', columns: [
          { key: 'department', label: 'Department' },
          { key: 'units', label: 'Units', format: 'integer' },
          { key: 'rate', label: 'Fulfillment', format: 'percent' },
          { key: 'status', label: 'Status', format: { type: 'status', colors: { on_track: 'green', behind: 'yellow' } } },
        ]},
      ],
    },
  },

  resources: {
    production: {
      fetch: async ({ page, pageSize, sort, filters }) => {
        const rows = await db.query('SELECT * FROM production WHERE ...', filters);
        const total = await db.count('production');
        return { rows, total };
      },
    },
    kpis: {
      fetch: async () => ({
        rows: [
          { label: 'Fulfillment', value: 0.87, format: 'percent' },
          { label: 'Units', value: 12400, format: 'integer' },
        ],
        total: 2,
      }),
    },
  },

  actions: {},
});

await server.listen({ port: 3100 });
```

## Generated Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/pages` | GET | List all page definitions |
| `/pages/:pageId` | GET | Single page definition |
| `/data/:resource` | GET | Paginated data (query params: `page`, `pageSize`, `sort`, filters) |
| `/actions/:action` | POST | Execute an action (`{ ids, params, filters }`) |
| `/context/:resource` | GET | Agent context for a resource |
| `/context/page/:pageId` | GET | Agent context for an entire page |

All routes require `Authorization: Bearer <token>` matching the configured `authToken`.

## Page Definition

```typescript
{
  title: string;
  filters?: Filter[];         // Dropdown, text, or date filters
  actions?: Action[];         // Toolbar or inline row actions
  suggestions?: string[];     // Ghost suggestions for the agent sidebar
  sections: (Section | Section[])[];  // Layout — single = full width, array = side-by-side grid
}
```

### Sections

Sections render top-to-bottom. Wrap sections in an array for side-by-side layout using a 12-column grid:

```typescript
sections: [
  { type: 'card-row', source: 'kpis' },                    // Full width
  [                                                          // Side by side
    { type: 'table', source: 'data', rowKey: 'id', span: 8, columns: [...] },
    { type: 'card-column', source: 'detail', span: 4 },
  ],
]
```

**Section types:**
- `card-row` — Horizontal row of metric cards
- `card-column` — Vertical stack of cards (useful as a sidebar)
- `table` — Paginated, sortable data grid with row selection
- `text` — Free-form prose block (no data source; not selectable)

Tables support a `detail` field for a slide-out drawer, plus optional
`title` / `description` headings:

```typescript
{ type: 'table', source: 'orders', rowKey: 'id', columns: [...],
  title: 'Orders',
  description: 'All orders placed this month. Amounts are net of returns.',
  detail: { source: 'order_detail' } }
```

Text sections render explanatory prose directly on the page — use them for
definitions, caveats, or a short narrative between data sections. They fetch
nothing and aren't selectable, but the agent still reads their content:

```typescript
{ type: 'text', title: 'How to read this',
  text: 'Non-moving = no sales in 90 days. Figures exclude in-transit stock.' }
```

### Column Formatting

Simple formats as strings, rich formats as objects:

```typescript
{ key: 'amount', label: 'Amount', format: 'currency' }            // $1,234.00
{ key: 'rate', label: 'Rate', format: 'percent' }                 // 87.5%
{ key: 'active', label: 'Active', format: 'boolean' }             // ✓ / ✗
{ key: 'status', label: 'Status', format: { type: 'status',       // Colored badge
    colors: { active: 'green', pending: 'yellow' } } }
{ key: 'change', label: 'YoY', format: { type: 'delta',           // +12.3% / -5.1%
    format: 'percent' } }
{ key: 'done', label: 'Done', format: { type: 'progress' } }      // Progress bar
{ key: 'url', label: 'Link', format: { type: 'link' } }           // Clickable URL
{ key: 'photo', label: '', format: { type: 'image', width: 32 } } // Thumbnail
```

### Actions

```typescript
actions: [
  // Inline — button on each row
  { label: 'Approve', action: 'approve', placement: 'inline' },

  // Toolbar — operates on checkbox-selected rows
  { label: 'Export', action: 'export_csv', placement: 'toolbar', selection_required: true },

  // Global — no row selection needed
  { label: 'Refresh', action: 'refresh_data', placement: 'toolbar' },
]
```

### Detail Drawer

When a table has `detail: { source: 'order_detail' }`, clicking a row opens a slide-out panel. The detail resource returns typed blocks:

```typescript
order_detail: {
  fetch: async ({ selection }) => ({
    rows: [
      { type: 'header', value: 'Order #1234' },
      { type: 'field', label: 'Customer', value: 'Acme Corp' },
      { type: 'field', label: 'Total', value: 1250, format: 'currency' },
      { type: 'list', label: 'Notes', items: [{ label: 'Rush delivery requested' }] },
      { type: 'table', label: 'Line Items', columns: [...], rows: [...] },
      { type: 'image', label: 'Receipt', url: 'https://...' },
    ],
    total: 1,
  }),
}
```

## Handler Contracts

**Fetch** — receives `{ page, pageSize, sort?, filters?, selection? }`, returns `{ rows, total }`. The plugin wraps the response with pagination metadata.

**Action** — receives `{ ids, params, filters }`, returns `{ affected, message?, data? }`. `ids` can be empty for global actions.

**Context** — receives `{ filters?, selection? }`, returns `{ summary, selection?, suggestions? }`. Used by the ToolPlex agent to understand what's on screen.

## File Attachments (smart CSV/XLSX handling)

Large tabular attachments (CSV, TSV, XLSX) are token-heavy and
hallucination-prone when dumped raw into the agent's context. Enable the
`files` feature to ingest an uploaded file into an **isolated, read-only
DuckDB database** instead: the agent receives a compact *manifest* (tables,
columns + inferred types, row counts, a few sample rows) and pulls exactly
what it needs on demand via **read-only SQL**.

File handling is **on by default** (since 0.8.14): a server that omits `files`
still gets uploads, snapshots, alerts and history under the default store
directory. Pass `files: { enabled: false }` to run without DuckDB. Everything
below is optional tuning.

```typescript
await server.register(registerAppPages, {
  authToken: process.env.TOOLPLEX_APP_TOKEN,
  pages: { /* … */ },
  resources: { /* … */ },
  actions: {},
  files: {
    // on by default; `enabled: false` turns file handling off
    // dir defaults to ~/.toolplex-app-files (never the OS temp dir)
    ttlMinutes: 10080,      // sweeps only files uploaded with pinned=false (uploads are durable by default since 0.8.0)
    maxUploadBytes: 100 * 1024 * 1024,
    maxQueryRows: 1000,     // hard cap per query
    maxResultBytes: 512 * 1024,
    queryTimeoutMs: 15000,
  },
});
```

Requires `@fastify/multipart` (auto-registered when `files.enabled`). Adds
`@duckdb/node-api` and `exceljs` as runtime dependencies.

### Generated endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/files` | POST | Multipart upload → ingest → returns `{ manifest }` |
| `/files` | GET | List the caller's manifests |
| `/files/:id/manifest` | GET | Re-fetch a single manifest |
| `/files/:id/query` | POST | `{ sql }` → read-only query result (capped) |
| `/files/:id` | DELETE | Remove an upload (idempotent) |

### Isolation & safety

Each upload becomes its **own** DuckDB database. Queries run on a connection
opened with `access_mode: READ_ONLY`, `enable_external_access: false`, and
`lock_configuration: true` — so a query can reach **neither** the host
filesystem (`read_csv('/etc/passwd')`), the app's own reporting database
(`ATTACH`), nor another upload's data, and cannot re-enable any of it via
`SET`. A light statement guard additionally rejects multi-statement payloads
and non-`SELECT` leading keywords before the SQL reaches DuckDB. Results are
capped by row count and serialized byte size; queries have a wall-clock
timeout.

### Manifest shape

```typescript
{
  fileId: string;
  filename: string;
  kind: "csv" | "tsv" | "xlsx";
  sizeBytes: number;
  tables: {
    name: string;        // SQL table name (CSV → "data"; XLSX → sanitized sheet name)
    sheetName?: string;  // original worksheet name (XLSX)
    rowCount: number;
    columns: { name: string; type: string }[];
    sampleRows: Record<string, unknown>[];
  }[];
  createdAt: string;
  notes?: string[];      // non-fatal ingestion notes (e.g. inferred-as-text)
}
```

## Apps

A page shows data. An app is where people do a piece of work. You declare
which apps exist and how each behaves; ToolPlex supplies the engine and the
interface for the app's `kind`. One kind exists today:

- `document-encoding` — staff give it scans or photos of paper documents; it
  reads them, fills in the values it is sure of, asks a person about the
  rest, and hands you each approved record.

```typescript
await server.register(registerAppPages, {
  authToken: process.env.TOOLPLEX_APP_TOKEN,

  // An organization API key. Reading documents runs on ToolPlex and is
  // metered to the organization.
  platform: { apiKey: process.env.TOOLPLEX_API_KEY },

  apps: {
    receiving: {
      kind: 'document-encoding',
      title: 'Receiving documents',
      config: {
        // Background for the readers. Stays on this server.
        context: 'We are a food distributor. "DR" means delivery receipt.',
        intake: [{ via: 'files' }],
        group_by: 'dr_no',
        documents: {
          'delivery-receipt': {
            title: 'Delivery receipt',
            recognise: 'Headed "Delivery Receipt", with a numbered item table.',
            fields: [
              { key: 'dr_no', label: 'D.R. number', type: 'code', required: true },
              { key: 'date', label: 'Date', type: 'date', required: true },
              { key: 'customer', label: 'Customer', type: 'name', candidates: 'customers' },
              { key: 'total_qty', label: 'Total quantity', type: 'number' },
            ],
            tables: [
              { key: 'items', label: 'Items', columns: [
                { key: 'product', label: 'Product', type: 'name', candidates: 'products' },
                { key: 'qty', label: 'Quantity', type: 'number' },
              ]},
            ],
            checks: [
              { type: 'sum', table: 'items', column: 'qty', equals: 'total_qty' },
              { type: 'recent', field: 'date', days: 90 },
            ],
          },
        },
        lists: {
          customers: async () => db.customerNames(),
          products: async () => db.productNames(),
        },
        onApproved: async ({ record, user }) => {
          await db.saveReceipt(record.values, record.tables.items, user);
        },
      },
    },
  },
});
```

### What you configure

| Setting | What it does |
|---|---|
| `documents` | The forms you handle. Each has the `fields` and `tables` you want, how to `recognise` it, optional `notes` on how it is filled in, and `checks`. The readers never invent a field. |
| `context` | Short background about your paperwork, given to the readers with every read. |
| `intake` | How documents come in: `files` (drop PDFs or images) or `camera`. |
| `group_by` | A field that ties documents together (a shipment or dispatch number). Related documents are compared with each other. |
| `checks` | Rules a finished document must pass: `sum`, `range`, `recent`, `same-in-group`. A failure becomes a question for a person. |
| `lists` | Your valid values (customers, products). They offer choices and back up a reading. They never overwrite what was read. |
| `expected` | Values you already hold for a document, so the readers confirm the paper against them. |
| `review` | `question_cap` (default 8) and `approve_every_document` (default on). |

### Instructions for the people using it

An app can carry your own words for the people who work in it: what belongs
here, how your paperwork is handled, who to ask. They are declared beside
`config`, by the place they are shown. A `document-encoding` app has three
places, one per tab: `capture`, `review` and `records`.

```typescript
receiving: {
  kind: 'document-encoding',
  title: 'Receiving documents',
  sections: {
    capture: [
      { type: 'text', title: 'Before you scan', text: '- One slip per sheet\n- The whole sheet must show, stamps included' },
    ],
    review: [
      { type: 'text', text: 'Type what the paper says, **even if it looks wrong**.' },
    ],
  },
  config: { /* ... */ },
},
```

- A section is `{ type: 'text', title?, text }`, the same shape as a text
  section on a page. `text` takes light markdown: paragraphs, bold, lists,
  links.
- Keep it short. At most 6 sections in a place and 2,000 characters in one;
  a place the kind does not have fails at startup.
- Changing the wording never changes `config_version`: sections are not part
  of what a record was read under.
- The assistant is told the same instructions (the first 1,500 characters),
  so "how do I scan these?" in chat gets your answer.

### How a value is decided

Two independent readers look at each document. A value both agree on, and
that passes your checks, is accepted. Anything else is put to a person, who
picks a reading or types the value. Handwritten values are shown for a
person to confirm. Nothing counts until a person approves the record.

### Hooks

All run on your server and are never sent to a client.

- `onApproved({ record, user })` — a person approved a record, or a later
  version of it. Turn it into your own data here.
- `onDocument({ document, change, user })` — a document changed state
  (`read`, `values`, `approved`, `discarded`, `failed`). Use it to keep your
  own pages in step.
- `onReady(handle)` — called once at startup with a handle to list the
  app's documents or approve one on a person's behalf.
- `pending({ user, abilities })` — on the app itself; overrides the count
  shown on the app's card.

### Who can do what

A `document-encoding` app defines three abilities: `capture`, `review` and
`approve`. An organization's admins grant them per role and per app in
ToolPlex. ToolPlex checks them and tells this server which ones the caller
has; the server enforces them on every route.

### What is kept, and where

Everything stays on your server, under `files.dir` (default
`~/.toolplex-app-files`) in `apps/<app id>/`: the untouched original of
every upload, the images that were read, every version of every record with
who changed it and when, and the names the app has learned from approved
records. `context`, `notes`, `recognise` and field `hint`s go to the readers
and are never served to a client.

An upload needs `@fastify/multipart` installed, as file attachments do.
Types are exported: `DocumentEncodingApp`, `DocumentEncodingConfig`,
`EncodingDocumentType`, `EncodingField`, `EncodingCheck`, `EncodingRecord`,
`EncodingHandle`, `AppSection`.

## Validation

The plugin validates configuration at startup. Misconfigurations throw immediately with descriptive errors:

```
@toolplex/app-server configuration errors:
  - Page "orders": table section with source "orders" is missing required "rowKey"
  - Page "orders": references action "approve" but no action handler is defined
```

Fetch and action handler responses are validated at runtime — missing `rows`, wrong `total` type, etc.

## License

See [LICENSE](./LICENSE) for details.
