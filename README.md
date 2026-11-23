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

**A process of its own.** None of that can make a database safe from a
query written to break it: ordinary functions can take all the memory there
is, run without end, or stop the process they run in. So SQL the assistant
wrote is not run in your server. It is run in a child process the server
starts for the purpose, one query to a process at a time. A process is
handed the path of a database file to open read-only and the statement to
run, and keeps nothing afterwards. This covers queries over an uploaded
file, over a page's snapshots (what alerts are checked with), and over an
app's records.

What becomes of a query that misbehaves:

- one that has not answered a little after its time limit has its process
  stopped, and is told it took too long;
- one whose process holds more memory than it may is stopped the same way;
- one that brings its process down is told it cannot be run, and the same
  statement over the same file or app is refused without being run for the
  next ten minutes;
- a process stopped by something else (the system short of memory, the
  server being restarted) answers "try again", and is not counted against
  the query.

Each is said in the server's log, with whose query it was and how it
began. The server goes on answering throughout, and the next query starts
another process, which takes about a tenth of a second. A small machine
runs one such query at a time and a large one up to four. A file made from
a query, which may take minutes, takes a turn apart from those (one on a
small machine, two on a large one), so questions are answered meanwhile. A
process with nothing to do is let go after a minute.

A query's answer is all of its rows or a refusal with the reason. A
statement that fails on a late row (a value that will not convert) never
comes back as the rows before it, whether it was asked as a query, saved as
a file, or read for a download or an alert.

This is there so that a query cannot take your server down. It is not a
wall around your data: the process runs as the same user as the server,
on the same disk. It is started with none of the server's environment (no
tokens, no keys) and none of the flags the server itself was started with.

It is on by default. `isolateQueries: false` turns it off, for a host that
may not start another process; such queries then run in the server itself.
On a host where a process cannot be started or cannot load the database
(it is found out as the server starts), the server says so once in its
log, at the level of an error, and runs these queries itself rather than
refuse them. If the package has been bundled into a single file, that is
what happens: the worker has to be a file of its own beside the server's.
Once a process has started on a host, a later start that fails is taken
for a bad moment: the query is refused with "try again", and is not run in
the server.

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

### An app's records as data

An app's approved records are the truth, and they live in the app's own
store on your server. Turn on `records` and the server also keeps a
**query database** built from them: ordinary tables that pages, alerts, the
assistant and your own code can read. It is always a copy. It is held in
memory, built from the records each time the server starts (a few seconds
for fifty thousand records) and kept level with them from then on. The
server starts at once; a page asked for while the tables are being built
waits for them, and after twenty seconds is told how far the build has got.
There is nothing of it to back up, repair or migrate.

```typescript
import { appRecords, registerAppPages } from '@toolplex/app-server';

await server.register(registerAppPages, {
  // The organization's zone: which day an approval falls on. Required with
  // `records: true`; the machine's own zone is never assumed.
  timezone: 'Asia/Singapore',
  apps: {
    receiving: { kind: 'document-encoding', records: true, /* ... */ },
  },
  resources: {
    // One row per approved delivery receipt, its fields as columns.
    receipts: appRecords('receiving', { form: 'delivery-receipt' }),
    // One row per line item, each with its receipt's columns beside it.
    receipt_lines: appRecords('receiving', { form: 'delivery-receipt', lines: 'items' }),
    // A query of your own over the same tables, read like any table.
    by_customer: appRecords('receiving', {
      sql: 'select customer, sum(total_qty) as quantity, count(*) as receipts from delivery_receipt group by customer',
    }),
  },
  pages: {
    receipts: {
      title: 'Delivery receipts',
      sections: [
        { type: 'table', source: 'receipts', rowKey: 'record_id', columns: [
          { key: 'dr_no', label: 'D.R. number' },
          { key: 'customer', label: 'Customer' },
          { key: 'total_qty', label: 'Quantity', format: 'integer' },
          { key: 'record_first_approved_at', label: 'Approved', format: 'date' },
        ]},
        { type: 'table', source: 'by_customer', rowKey: 'customer', columns: [
          { key: 'customer', label: 'Customer' },
          { key: 'quantity', label: 'Quantity', format: 'integer' },
        ]},
      ],
    },
  },
});
```

**What counts.** A record counts from its first approval until it is
discarded, with the values of its last approved version. While someone is
correcting it, it goes on counting with what was approved and
`record_correcting` is true; the correction counts once it is approved.
Discarding a record that has been approved takes it out of every total, so
it needs the right to approve, and such a record cannot be joined into
another.

**Tables.** For a `document-encoding` app:

| Table | Rows | `appRecords` |
|---|---|---|
| `records` | every record, any form | `appRecords(app)` |
| `<form>` (`delivery_receipt`) | one per record of the form, fields as columns | `{ form }` |
| `<form>_<table>` (`delivery_receipt_items`) | one per line | |
| `<form>_<table>_with_record` | the same lines, each with its record's columns | `{ form, lines }` |
| the resource's own name | whatever your query returns | `{ sql }` |

**Columns.** Your field keys, as you declared them, plus the same columns on
every record: `record_id`, `record_name`, `record_group`, `record_version`,
`record_first_approved_at`, `record_approved_at`, `record_captured_at`,
`record_correcting` (and `record_form`, `record_form_title` in `records`;
`line_id`, `line_no` on a line).

- A `number` field is a number and a `date` field is a date, and a record
  cannot be approved while one of them holds anything else (see "How a
  value is decided"). A record approved before that was so may still hold
  such a value ("12 pcs", "Nov 5"). It is left empty in its column, so it
  is **out of every total**, and that is never silent: the table
  `unfit_values` lists each such value as written (record, table, column,
  line), a page's context and the assistant say how many records are
  affected, and the server counts them per column at startup. Corrected in
  the app, the value counts again.
- The `record_*_at` columns are moments. Which day one falls on is decided
  by `timezone`: for a page's filters, for `current_date`, `::date` and
  `date_trunc` in a query, and for an alert's check over a snapshot of the
  page. Count a month by `record_first_approved_at` (a correction approved
  later does not move a record) or by a date field of your own. A total can
  change after the fact: a correction replaces the values it counted, and a
  discard removes them.
- The key of a field or of a table's column must be lower case letters,
  digits and underscores; must not start with `record_` or `line_`; must
  not be a word SQL will not take as a bare name (`order`, `group`, `from`,
  `left`, `by`) or something a page sends (`page`, `sort`, `q`); a table's
  column cannot share a key with one of the form's fields; and `x` and
  `x_from` cannot both exist. A form's key and a table's key may have
  hyphens (they become underscores in the table's name), and must not make
  a reserved word or the same name twice. All of it is checked at startup,
  for every app, whether or not it has `records` on, so a server that
  started on an earlier version may be asked to rename a key by this one.

**On a page.** Sorting, the table's column filters, the page's filters and
what is selected are run by the database over every row. A page filter whose
key is a column must equal it; `<column>_from` and `<column>_to` bound it
(what the date-range and month-range filters send; a day or a month means
all of it); `q` searches your own values, the file name and the record's
group. What a filter's
value cannot mean for its column matches nothing. The page reports when its
records last changed, so alerts on it are checked when something is
approved, and an alert's snapshot has the tables' own column types. A page
that also shows data copied from elsewhere, and reports that data's own
`lastSync`, keeps reporting it. A download or snapshot of many rows is read
from one view of the data, so approvals made while it runs are neither
skipped nor repeated.

**A query of your own** (`{ sql }`) is one SELECT statement over the tables.
It is kept as a view named after the resource, so it sorts, filters, pages
and feeds alerts like any table, and the assistant can read it by that
name. One query may read another. Its columns are given as text, numbers,
whole numbers, true or false, dates or moments, whatever the query made
them. A query that does not run, or a page that asks it for a column it
does not return, stops the server from starting, with the reason. One of
these is read at a time, and a read that takes more than thirty seconds
is stopped, so a slow one cannot hold up the tables beside it.

**Who sees them.** Putting records on a page shows them to everyone who may
see that page, whether or not their role can open the app. That is the only
way they are shown: an `appRecords` resource that is on no page is refused
at startup. The same care is yours to take with a resource of your own that
calls `handle.query`: put it on a page.

**For the assistant.** With `records` on, the app offers the assistant a
read-only query tool over the same tables, so "how much did we receive last
week?" is answered from approved records. It is offered to whoever may open
the app, the same people who can read every record in it. Only a single
reading statement ever runs: the database itself splits and classifies what
it is given, in a transaction that cannot write, with no access to files, a
time limit, and caps on rows, columns and text. What a query reads and
calls is checked against the database's own reading of it, before any of
it is worked out: rows come from this app's tables and a few row-making
functions (not from the database's catalogue, settings or log), and a
function that does more than compute (waits, logs, switches something on
for the whole database) is refused, however the call is written. PRAGMA is
not available. Long text is cut inside the database; lists, structures and
binary values are not returned unless the query casts them to text.

None of this makes a database safe from a query written to break it (a
pattern or a document nested tens of thousands deep, a value of hundreds of
megabytes), and nothing could. So these queries are not run in your server.
The server writes its tables to a file that nothing will change, one copy
for every query until a record changes, and a process of its own opens
that file read-only and runs the statement, under every rule above. The
copy holds everything stored when the question was asked, as a page does.
A query that breaks that process, outruns its time limit or takes too much
memory costs that process and nothing else: your server's own tables, and
the pages read from them, are no part of it. See "A process of its own"
under File Attachments.

The copies live in `.records-frozen` under the app's directory and are
removed as they are replaced and when the server stops; the server's own
database can reach that one directory and no other file. With fifty
thousand records, a question asked right after a record changed waits
about a fifth of a second for a new copy, and one asked with nothing
changed about a thirtieth.

**For your own code.** The handle given to `onReady` can query the tables,
with values handed over as parameters and never pasted into the SQL:

```typescript
let receiving: EncodingHandle;
// in the app's config: onReady: (handle) => { receiving = handle; }

const { rows, truncated } = await receiving.query(
  'select dr_no, total_qty from delivery_receipt where customer = $1 and record_first_approved_at >= $2',
  [customer, '2026-11-01'],
);
```

This is your server's code, so it reads the server's own tables, as your
pages do, under the same rules as the assistant's tool: one reading
statement, no files, fifteen seconds. Two run at a time. Never hand it SQL
that someone else wrote: what the assistant asks goes through its own tool,
which is the one run in a process apart.

A page whose data you work out yourself from `query` reports
`lastSync: await receiving.changedAt()` from the page's own `context`
handler, and alerts on it are then checked when something is approved.

**Keeping a copy elsewhere.** To have the records in a database of your own
(to join them with your other data), follow the app's changes. This needs
no `records: true`; it reads the records themselves.

```typescript
let cursor = await loadCursor();              // null the first time
for (;;) {
  const page = await receiving.changes({ after: cursor });
  await inOneTransaction(async () => {
    if (page.reset) await emptyMyCopy();      // start again from nothing
    for (const change of page.changes) {
      await deleteMyRowsOf(change.record_id); // every table
      if (!change.removed) await insert(change.rows); // { table: rows }
    }
    await saveCursor(page.cursor);
  });
  cursor = page.cursor;
  if (!page.more) break;
}
```

Each record that changed is there once, as it stands now, with its rows by
table and the same typed values the tables hold. Nothing is missed however
long you were away: every change is stamped inside the record itself, in
the same write that made it. `reset` is true when the cursor cannot be
continued from: the tables changed shape (a field added, a rename declared,
a form's title reworded), a record's file was lost or put back by hand, or
the records were put back from an older copy, so that what you were told
since no longer holds. The store recognises each of these itself: it
remembers every time it was opened, and a cursor from a time it does not
remember, or from further than that time got, is not continued. Empty the
copy and apply what follows; if others read your copy while it is rebuilt,
build the new one aside and swap it in. `handle.record(id)` gives one
record the same way.

One thing it cannot recognise is a restore that is not a clean one: a
backup taken while the server was writing, or one copied over the directory
without emptying it first, is a mixture of two moments. After any restore,
stop the server, put the backup into an empty directory, and delete
`store.json` from it before starting: every copy then starts again.

**Renaming.** A key is an identity. To rename a field, a table, one of its
columns or a whole form, say what it was, and every record approved under
the old key is found under the new one, in the app and in the tables:

```typescript
{ key: 'buyer', label: 'Buyer', type: 'name', was: ['customer'] }
```

An old name must not be a key in use now, and no two may claim the same
one; both are refused at startup. `was` stays for as long as the records
do: approved versions are never rewritten, so they are read through it for
good, and taking it away later blanks them again. A rename that is not
declared loses nothing, but the old values stop being shown; the server
says so at startup, with the key and how many records. Do not give a new
field the key a removed one had: values approved under the old meaning
would show as the new field's.

**One server per directory.** An app's records belong to one running
server. Two processes on the same `files.dir` would each keep their own
idea of them.

### How a value is decided

Two independent readers look at each document. A value both agree on, and
that passes your checks, is accepted. Anything else is put to a person, who
picks a reading or types the value. Handwritten values are shown for a
person to confirm. Nothing counts until a person approves the record.

A `number` field holds a number and a `date` field holds a day, written
year-month-day. The readers are asked for exactly that. A value written
some other way that can only mean one thing ("1,250", "Nov 5, 2026") is
taken as what it means, whoever wrote it, a reader or a person. A value
that is neither ("60 pcs", "about 40", "11/05/2026", which could be either
of two days) is a question like any other, with the number offered when the
text holds exactly one; and a record is not approved while one stands.

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
has; the server enforces them on every route. Looking needs none of them:
whoever may open the app can read its records. Discarding a record that has
been approved, and reading one again, need `approve`.

### What is kept, and where

Everything stays on your server, under `files.dir` (default
`~/.toolplex-app-files`) in `apps/<app id>/`: the untouched original of
every upload, the images that were read, every version of every record with
who changed it and when, the names the app has learned from approved
records, and each configuration records were approved under
(`configs/<version>.json`, so what a key meant at the time stays knowable).
That directory is all there is to back up: the query database of an app
with `records` on is rebuilt from it at every start (`.records-tmp` in it
is scratch space for that, emptied at each start).
`context`, `notes`, `recognise` and field `hint`s go to the
readers and are never served to a client.

An upload needs `@fastify/multipart` installed, as file attachments do.
Types are exported: `DocumentEncodingApp`, `DocumentEncodingConfig`,
`EncodingDocumentType`, `EncodingField`, `EncodingCheck`, `EncodingRecord`,
`EncodingHandle`, `AppSection`, `AppRecordsOptions`.

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
