/**
 * Compile-time + runtime type checks for StandardActionResponse.open_next
 * (added in @toolplex/app-server 0.6.3).
 *
 * Run with: npx tsx test/open-next.ts
 */

import type { StandardActionResponse } from "../src/types.js";

// ---------------------------------------------------------------------------
// 1. Type-level checks (these cause a TypeScript compiler error if the
//    shape is wrong — no runner needed, `tsc --noEmit` on this file is
//    sufficient to validate the contract).
// ---------------------------------------------------------------------------

// open_next is optional — a plain response still satisfies the type
const _plain: StandardActionResponse = { affected: 1 };

// open_next with string id
const _stringId: StandardActionResponse = {
  affected: 1,
  message: "Approved.",
  open_next: { row_id: "customer_42" },
};

// open_next with numeric id and optional section field
const _numericId: StandardActionResponse = {
  affected: 1,
  open_next: { row_id: 99, section: "decisions" },
};

// null / undefined — must NOT be assignable to row_id (string | number only)
// Uncomment to confirm this is a compile error:
// const _bad: StandardActionResponse = { affected: 1, open_next: { row_id: null } };

// Reference the type-assertion locals so noUnusedLocals doesn't trip.
// These are intentionally unused at runtime — their value is in the
// compiler accepting their declarations above.
void _plain; void _stringId; void _numericId;

// ---------------------------------------------------------------------------
// 2. Lightweight runtime assertions — no framework, no network.
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`PASS: ${msg}`);
}

// open_next present with string id
const resp1: StandardActionResponse = { affected: 1, open_next: { row_id: "c_42" } };
assert(resp1.open_next?.row_id === "c_42", "string row_id round-trips");
assert(resp1.open_next?.section === undefined, "section is optional");

// open_next present with numeric id
const resp2: StandardActionResponse = { affected: 2, open_next: { row_id: 7, section: "batch" } };
assert(resp2.open_next?.row_id === 7, "numeric row_id round-trips");
assert(resp2.open_next?.section === "batch", "section round-trips");

// open_next absent — existing behavior unaffected
const resp3: StandardActionResponse = { affected: 0, message: "Nothing to do." };
assert(resp3.open_next === undefined, "open_next absent when not set");
assert(resp3.message === "Nothing to do.", "message unaffected");

// Handler that returns the next row (simulates wizard advance)
function simulateApprove(currentId: string, nextId: string | null): StandardActionResponse {
  if (nextId !== null) {
    return { affected: 1, message: `Approved ${currentId}.`, open_next: { row_id: nextId } };
  }
  return { affected: 1, message: `Approved ${currentId}. No more rows.` };
}

const advance = simulateApprove("c_1", "c_2");
assert(advance.open_next?.row_id === "c_2", "handler returns next row id");

const last = simulateApprove("c_3", null);
assert(last.open_next === undefined, "handler returns no open_next at end of batch");

console.log("\nAll open_next type checks passed.");
