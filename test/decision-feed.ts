/**
 * Compile-time + runtime type checks for DecisionFeedSection / DecisionCard
 * (added in @toolplex/app-server 0.6.3).
 *
 * Run with: npx tsx test/decision-feed.ts
 */

import type {
  DecisionFeedSection,
  DecisionCard,
  Section,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// 1. Type-level checks — compiler errors if the shape is wrong.
// ---------------------------------------------------------------------------

// Minimal DecisionFeedSection
const _minimalFeed: DecisionFeedSection = {
  type: "decision-feed",
  source: "pending_decisions",
};

// Full DecisionFeedSection
const _fullFeed: DecisionFeedSection = {
  type: "decision-feed",
  source: "pending_decisions",
  actions: [
    { label: "Approve", action: "approve_decision", variant: "success" },
    { label: "Reject",  action: "reject_decision",  variant: "danger" },
    { label: "Defer",   action: "defer_decision",   variant: "warning" },
  ],
  empty_message: "Inbox zero! No pending decisions.",
  span: 12,
};

// DecisionCard — minimal
const _minCard: DecisionCard = {
  id: 1,
  title: "Limac · Identity decision",
  question: "Should we merge these two master entries?",
  evidence: [
    { type: "field", label: "Raw name", value: "LIMAC SALES CORP." },
  ],
};

// DecisionCard — full
const _fullCard: DecisionCard = {
  id: "dec_42",
  title: "Calapan Traders · Duplicate",
  subtitle: "Workflow: calapan_dedup · 2 entries",
  badge: "₱8.3M",
  badge_variant: "warning",
  question: "These two store entries look like the same outlet. Merge?",
  evidence: [
    { type: "header", value: "Master candidates" },
    {
      type: "table",
      label: "Matching entries",
      columns: [
        { key: "name", label: "Name" },
        { key: "score", label: "Score", format: "percent" },
      ],
      rows: [
        { name: "Calapan Traders Inc.", score: 0.94 },
        { name: "Calapan Trading",      score: 0.88 },
      ],
    },
  ],
  consequences: [
    { label: "Transactions re-mapped", value: "1,204" },
    { label: "Revenue impact",          value: "₱8.3M" },
  ],
  status: "pending",
};

// DecisionFeedSection must satisfy the Section union
const _asSection: Section = _fullFeed;

// Status variants type-check (all four)
const _variants: DecisionCard["status"][] = [
  "pending", "decided_yes", "decided_no", "deferred",
];

// Badge variants
const _badgeVariants: DecisionCard["badge_variant"][] = [
  "default", "success", "warning", "danger", "info",
];

void _minimalFeed; void _fullFeed; void _minCard; void _fullCard;
void _asSection; void _variants; void _badgeVariants;

// ---------------------------------------------------------------------------
// 2. Lightweight runtime assertions.
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`PASS: ${msg}`);
}

assert(_minimalFeed.type === "decision-feed", "section type is 'decision-feed'");
assert(_minimalFeed.source === "pending_decisions", "source round-trips");
assert(_fullFeed.actions?.length === 3, "actions array length");
assert(_fullFeed.empty_message === "Inbox zero! No pending decisions.", "empty_message round-trips");
assert(_fullFeed.span === 12, "span round-trips");

assert(_minCard.id === 1, "numeric id round-trips");
assert(_fullCard.id === "dec_42", "string id round-trips");
assert(_fullCard.badge === "₱8.3M", "badge round-trips");
assert(_fullCard.badge_variant === "warning", "badge_variant round-trips");
assert(_fullCard.evidence.length === 2, "evidence block count");
assert(_fullCard.consequences?.length === 2, "consequences count");
assert(_fullCard.status === "pending", "status round-trips");

console.log("\nAll DecisionFeedSection type checks passed.");
