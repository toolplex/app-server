# @toolplex/app-server

Fastify plugin for serving [ToolPlex](https://toolplex.ai) App Pages. Define page layouts, data handlers, and actions — the plugin generates the HTTP endpoints that power interactive pages in the ToolPlex desktop and mobile apps.

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

Tables support a `detail` field for a slide-out drawer:

```typescript
{ type: 'table', source: 'orders', rowKey: 'id', columns: [...],
  detail: { source: 'order_detail' } }
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
