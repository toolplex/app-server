import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";

const server = Fastify({ logger: true });

await server.register(registerAppPages, {
  authToken: "test-token-123",

  pages: {
    // Read-only report — no actions, no detail
    "production-report": {
      title: "Production Report",
      filters: [
        { key: "month", type: "dropdown", options_source: "months" },
        { key: "department", type: "dropdown", options: ["socks", "accessories", "outerwear"] },
      ],
      suggestions: [
        "Which departments are behind?",
        "Compare to last month",
      ],
      sections: [
        { type: "card-row", source: "production_kpis" },
        { type: "table", source: "production_data", rowKey: "id", columns: [
          { key: "department", label: "Department" },
          { key: "sku_count", label: "SKUs", format: "integer" },
          { key: "fulfillment_rate", label: "Fulfillment", format: "percent" },
          { key: "status", label: "Status", format: { type: "status", colors: { on_track: "green", behind: "yellow", critical: "red" } } },
          { key: "yoy_change", label: "YoY", format: { type: "delta", format: "percent" } },
        ]},
      ],
    },

    // Workflow page — inline + toolbar actions, detail drawer
    "order-review": {
      title: "Order Review",
      filters: [
        { key: "week", type: "dropdown", options_source: "weeks" },
        { key: "status", type: "dropdown", options: ["pending", "approved", "exported"], default: "pending" },
      ],
      actions: [
        { label: "Approve", action: "approve_orders", placement: "inline" },
        { label: "Reject", action: "reject_orders", placement: "inline", confirm: "Reject this order?" },
        { label: "Approve Selected", action: "approve_orders", placement: "toolbar", selection_required: true, confirm: "Approve all selected?" },
        { label: "Export CSV", action: "export_csv", placement: "toolbar" },
      ],
      suggestions: [
        "Approve all A-tier stores",
        "Export pending orders",
      ],
      sections: [
        { type: "card-row", source: "order_kpis" },
        [
          { type: "table", source: "orders", rowKey: "order_id", span: 8, columns: [
            { key: "store", label: "Store" },
            { key: "sku", label: "SKU" },
            { key: "qty", label: "Qty", format: "integer" },
            { key: "status", label: "Status", format: { type: "status", colors: { pending: "yellow", approved: "green", exported: "blue" } } },
          ], detail: { source: "order_detail" } },
          { type: "card-column", source: "selected_order_summary", span: 4 },
        ],
      ],
    },
  },

  resources: {
    // -- Production report resources --
    production_data: {
      fetch: async ({ page, pageSize, filters }) => {
        const all = [
          { id: 1, department: "Socks", sku_count: 420, fulfillment_rate: 0.91, status: "on_track", yoy_change: 0.12 },
          { id: 2, department: "Accessories", sku_count: 310, fulfillment_rate: 0.78, status: "behind", yoy_change: -0.05 },
          { id: 3, department: "Outerwear", sku_count: 510, fulfillment_rate: 0.89, status: "on_track", yoy_change: 0.03 },
        ];
        let rows = all;
        if (filters?.department) rows = rows.filter(r => r.department.toLowerCase() === filters.department);
        const start = (page - 1) * pageSize;
        return { rows: rows.slice(start, start + pageSize), total: rows.length };
      },
      context: async ({ filters }) => ({
        summary: `Production report${filters?.month ? ` for ${filters.month}` : ""}. 3 departments tracked.`,
      }),
    },
    production_kpis: {
      fetch: async () => ({
        rows: [
          { label: "Fulfillment", value: 0.87, format: "percent" },
          { label: "SKUs Tracked", value: 1240, format: "integer" },
          { label: "Avg Lead Time", value: 14, format: "integer" },
        ],
        total: 3,
      }),
    },

    // -- Order review resources --
    orders: {
      fetch: async ({ page, pageSize, filters }) => {
        const all = [
          { order_id: "ORD-001", store: "Store A", sku: "SKU-100", qty: 24, status: "pending", tier: "A" },
          { order_id: "ORD-002", store: "Store B", sku: "SKU-200", qty: 12, status: "pending", tier: "B" },
          { order_id: "ORD-003", store: "Store C", sku: "SKU-100", qty: 48, status: "approved", tier: "A" },
        ];
        let rows = all;
        if (filters?.status) rows = rows.filter(r => r.status === filters.status);
        const start = (page - 1) * pageSize;
        return { rows: rows.slice(start, start + pageSize), total: rows.length };
      },
      context: async ({ selection }) => ({
        summary: "3 orders total. 2 pending, 1 approved.",
        selection: selection?.ids?.length ? `${selection.ids.length} orders selected.` : undefined,
      }),
    },
    order_detail: {
      fetch: async ({ selection }) => {
        const id = selection?.ids?.[0];
        return {
          rows: [
            { type: "header", value: `Order ${id || "N/A"}` },
            { type: "field", label: "Store", value: "Store A" },
            { type: "field", label: "Tier", value: "A" },
            { type: "field", label: "Quantity", value: 24, format: "integer" },
            { type: "field", label: "Status", value: "pending", format: { type: "status", colors: { pending: "yellow", approved: "green" } } },
            { type: "list", label: "Recent Orders", items: [
              { label: "2026-W10", value: 20, format: "integer" },
              { label: "2026-W09", value: 18, format: "integer" },
              { label: "2026-W08", value: 22, format: "integer" },
            ]},
            { type: "image", label: "Product Photo", url: "https://example.com/product.jpg", alt: "SKU-100" },
            { type: "table", label: "Line Items", columns: [
              { key: "sku", label: "SKU" },
              { key: "qty", label: "Qty", format: "integer" },
              { key: "price", label: "Price", format: "currency" },
            ], rows: [
              { sku: "SKU-100", qty: 24, price: 12.50 },
            ]},
          ],
          total: 1,
        };
      },
    },
    order_kpis: {
      fetch: async () => ({
        rows: [
          { label: "Pending", value: 2, format: "integer" },
          { label: "Approved", value: 1, format: "integer" },
          { label: "Total Value", value: 1050, format: "currency" },
        ],
        total: 3,
      }),
    },
    selected_order_summary: {
      fetch: async ({ selection }) => {
        if (!selection?.ids?.length) {
          return { rows: [{ label: "Select an order", value: "—" }], total: 1 };
        }
        return {
          rows: [
            { label: "Selected", value: selection.ids.length, format: "integer" },
            { label: "Total Qty", value: 24, format: "integer" },
          ],
          total: 2,
        };
      },
    },

    // -- Shared filter option resources --
    months: {
      fetch: async () => ({
        rows: [{ value: "2026-03", label: "March 2026" }, { value: "2026-02", label: "February 2026" }],
        total: 2,
      }),
    },
    weeks: {
      fetch: async () => ({
        rows: [{ value: "2026-W13", label: "Week 13" }, { value: "2026-W12", label: "Week 12" }],
        total: 2,
      }),
    },
  },

  actions: {
    approve_orders: async ({ ids }) => ({
      affected: ids.length,
      message: `${ids.length} order(s) approved.`,
    }),
    reject_orders: async ({ ids }) => ({
      affected: ids.length,
      message: `${ids.length} order(s) rejected.`,
    }),
    export_csv: async ({ filters }) => ({
      affected: 0,
      message: "CSV exported.",
      data: { url: `/downloads/orders_${filters.week || "all"}.csv` },
    }),
  },
});

await server.listen({ port: 3099 });
console.log("\nSmoke test server running on http://localhost:3099");
console.log("\nRead-only report:");
console.log('  curl -s -H "Authorization: Bearer test-token-123" http://localhost:3099/pages | jq .');
console.log('  curl -s -H "Authorization: Bearer test-token-123" http://localhost:3099/data/production_data | jq .');
console.log('  curl -s -H "Authorization: Bearer test-token-123" http://localhost:3099/context/page/production-report | jq .');
console.log("\nWorkflow page:");
console.log('  curl -s -H "Authorization: Bearer test-token-123" "http://localhost:3099/data/orders?status=pending" | jq .');
console.log('  curl -s -H "Authorization: Bearer test-token-123" "http://localhost:3099/data/order_detail?selection=%7B%22type%22:%22row%22,%22ids%22:[%22ORD-001%22]%7D" | jq .');
console.log("\nActions:");
console.log('  curl -s -X POST -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d \'{"ids":["ORD-001"]}\' http://localhost:3099/actions/approve_orders | jq .');
console.log('  curl -s -X POST -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d \'{"filters":{"week":"2026-W13"}}\' http://localhost:3099/actions/export_csv | jq .');
