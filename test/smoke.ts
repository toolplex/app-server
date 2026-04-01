import Fastify from "fastify";
import { registerAppPages } from "../src/index.js";

const server = Fastify({ logger: true });

await server.register(registerAppPages, {
  authToken: "test-token-123",

  pages: {
    "exception-review": {
      title: "Exception Review",
      filters: [
        { key: "month", type: "dropdown", options_source: "months" },
        {
          key: "status",
          type: "dropdown",
          options: ["open", "resolved"],
          default: "open",
        },
      ],
      actions: [
        {
          label: "Resolve",
          action: "resolve_issue",
          confirm: "Resolve selected issues?",
          selection_required: true,
        },
      ],
      suggestions: ["Resolve all high-confidence matches"],
      sections: [
        { type: "card-row", source: "summary" },
        {
          type: "table",
          source: "issues",
          rowKey: "id",
          columns: [
            { key: "distributor", label: "Distributor" },
            { key: "summary", label: "Issue" },
            { key: "score", label: "Score", format: "percent" },
          ],
        },
      ],
    },
  },

  resources: {
    issues: {
      fetch: async ({ page, pageSize, filters }) => {
        const allRows = [
          { id: 1, distributor: "ACJDM", summary: "Column mapping", score: 0.92, status: "open" },
          { id: 2, distributor: "TRADESURE", summary: "Unmatched customer", score: 0.85, status: "open" },
          { id: 3, distributor: "JS TRADICO", summary: "Data warning", score: 0.71, status: "resolved" },
        ];

        let filtered = allRows;
        if (filters?.status) {
          filtered = filtered.filter((r) => r.status === filters.status);
        }

        const start = (page - 1) * pageSize;
        return {
          rows: filtered.slice(start, start + pageSize),
          total: filtered.length,
        };
      },
      context: async ({ filters, selection }) => {
        const status = filters?.status || "all";
        return {
          summary: `Showing ${status} issues. 3 total.`,
          selection: selection?.ids?.length
            ? `${selection.ids.length} selected.`
            : undefined,
        };
      },
    },

    summary: {
      fetch: async () => ({
        rows: [
          { label: "Open", value: 2, format: "integer" },
          { label: "Resolved", value: 1, format: "integer" },
          { label: "Completion", value: 0.333, format: "percent" },
        ],
        total: 3,
      }),
    },

    months: {
      fetch: async () => ({
        rows: [
          { value: "2026-03", label: "March 2026" },
          { value: "2026-02", label: "February 2026" },
        ],
        total: 2,
      }),
    },
  },

  actions: {
    resolve_issue: async ({ ids }) => ({
      affected: ids.length,
      message: `${ids.length} issues resolved.`,
    }),
  },
});

await server.listen({ port: 3099 });
console.log("\nSmoke test server running on http://localhost:3099");
console.log("Try:");
console.log('  curl -H "Authorization: Bearer test-token-123" http://localhost:3099/pages');
console.log('  curl -H "Authorization: Bearer test-token-123" http://localhost:3099/data/issues?status=open');
console.log('  curl -H "Authorization: Bearer test-token-123" http://localhost:3099/context/issues');
console.log('  curl -H "Authorization: Bearer test-token-123" http://localhost:3099/context/page/exception-review');
console.log('  curl -X POST -H "Authorization: Bearer test-token-123" -H "Content-Type: application/json" -d \'{"ids":[1,2]}\' http://localhost:3099/actions/resolve_issue');
