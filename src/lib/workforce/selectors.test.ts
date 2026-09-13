// ---------------------------------------------------------------------------
// Workforce selectors — pure logic tests (no React, no Supabase).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildClaimView,
  buildDeadlineView,
  buildEstimateReview,
  buildRecoveryMetrics,
  filterBySearch,
  filterWorkItemsByWorker,
  governanceForWorker,
  groupByKey,
  paginate,
  pendingGovernanceForWorker,
  tagClaimAttention,
  topFolder,
  totalPages,
  workerGovernanceActions,
} from "./selectors";
import { WORKERS_BY_SLUG } from "./worker-defs";
import type { WorkItem } from "@/lib/work-queue/service";
import type { GovernanceDecisionRow } from "@/lib/governance/persistence";
import type { ClaimSnapshot } from "@/lib/insurance/logic";

function makeItem(partial: Partial<WorkItem>): WorkItem {
  return {
    id: "w1",
    claimId: "c1",
    claimNumber: "C-1",
    customer: "Jane",
    property: null,
    category: "missing_evidence",
    priority: "medium",
    actionable: "human_action_required",
    title: "Missing: Estimate",
    description: "Estimate documentation is missing",
    atlasHasDone: [],
    atlasRecommends: [],
    humanNeedsTo: [],
    financialImpact: null,
    confidence: 1,
    evidenceUsed: [],
    deadline: null,
    createdAt: 0,
    ...partial,
  };
}

function makeDecision(partial: Partial<GovernanceDecisionRow>): GovernanceDecisionRow {
  return {
    id: "d1",
    tenant_id: "t1",
    claim_id: "C-1",
    entity_type: "claim",
    entity_id: "C-1",
    action_type: "claim_analysis",
    decision: "ALLOW",
    risk_level: "none",
    jurisdiction: null,
    actor_role: "atlas",
    evaluated_at: "2026-09-01T00:00:00Z",
    knowledge_reference_date: null,
    loss_date: null,
    policy_period_start: null,
    policy_period_end: null,
    applicable_rules: [],
    applicable_standards: [],
    required_approvals: [],
    knowledge_gaps: [],
    citations: [],
    evidence_references: [],
    decision_rationale: "",
    governance_engine: "e1",
    knowledge_corpus_version: "1",
    orchestration_id: null,
    action_id: null,
    dedup_key: "x",
    execution_status: "not_executed",
    approval_status: "not_required",
    approved_by: null,
    approved_at: null,
    approved_notes: null,
    override_decision: null,
    override_reason: null,
    override_by: null,
    overridden_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function makeClaim(partial: Partial<ClaimSnapshot>): ClaimSnapshot {
  return {
    _id: "c1",
    claimNumber: "C-1",
    dateOfLoss: Date.now() - 30 * 86_400_000,
    property: "123 Main St",
    causeOfLoss: "hail",
    lossDescription: "Roof damage",
    customer: "Jane",
    carrier: "ACME",
    policy: "P-1",
    adjuster: null,
    status: "open",
    estimateAmount: 25000,
    estimateLineItemCount: 40,
    invoicedAmount: null,
    paymentAmount: 5000,
    approvedAmount: null,
    collectedAmount: 0,
    openBalance: 20000,
    deductible: 2500,
    policyLimits: null,
    scopeItems: null,
    expectedScope: ["roofing_shingles", "gutters", "tarping"],
    actualScope: ["roofing_shingles"],
    evidenceSummary: ["Invoice", "Estimate"],
    evidenceDocumentIds: [],
    provenance: "test",
    createdAt: Date.now() - 40 * 86_400_000,
    updatedAt: Date.now() - 5 * 86_400_000,
    ...partial,
  };
}

describe("filterWorkItemsByWorker", () => {
  it("keeps only the worker's attention categories, priority-sorted, capped", () => {
    const worker = WORKERS_BY_SLUG["claims"]!;
    const items = [
      makeItem({ id: "a", category: "supplement_opportunity", priority: "critical" }),
      makeItem({ id: "b", category: "missing_evidence", priority: "low" }),
      makeItem({ id: "c", category: "missing_evidence", priority: "critical" }),
      makeItem({ id: "d", category: "financial_discrepancy", priority: "high" }),
    ];
    const out = filterWorkItemsByWorker(items, worker, 10);
    expect(out.map((i) => i.id)).toEqual(["c", "b"]); // critical first, then low; others excluded
  });

  it("respects the limit", () => {
    const worker = WORKERS_BY_SLUG["claims"]!;
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `m${i}`, category: "missing_evidence", priority: "medium" }),
    );
    expect(filterWorkItemsByWorker(items, worker, 5)).toHaveLength(5);
  });
});

describe("workerGovernanceActions", () => {
  it("maps each worker to its orchestrator action types", () => {
    expect(workerGovernanceActions(WORKERS_BY_SLUG["claims"]!)).toContain("claim_analysis");
    expect(workerGovernanceActions(WORKERS_BY_SLUG["supplements"]!)).toEqual(["supplement_preparation"]);
    expect(workerGovernanceActions(WORKERS_BY_SLUG["recovery"]!)).toEqual(["financial_calculation"]);
    expect(workerGovernanceActions(WORKERS_BY_SLUG["customers"]!)).toContain("communication_drafting");
  });
});

describe("governanceForWorker / pendingGovernanceForWorker", () => {
  it("filters by action type and newest first", () => {
    const worker = WORKERS_BY_SLUG["claims"]!;
    const rows = [
      makeDecision({ id: "old", action_type: "claim_analysis", evaluated_at: "2026-08-01T00:00:00Z" }),
      makeDecision({ id: "new", action_type: "claim_analysis", evaluated_at: "2026-09-02T00:00:00Z" }),
      makeDecision({ id: "other", action_type: "supplement_preparation" }),
    ];
    const out = governanceForWorker(rows, worker);
    expect(out.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("pending only returns actionable rows", () => {
    const worker = WORKERS_BY_SLUG["claims"]!;
    const rows = [
      makeDecision({ id: "blocked", action_type: "claim_analysis", execution_status: "blocked", approval_status: "required" }),
      makeDecision({ id: "awaiting", action_type: "claim_analysis", execution_status: "awaiting_approval", approval_status: "required" }),
      makeDecision({ id: "done", action_type: "claim_analysis", execution_status: "approved", approval_status: "approved" }),
    ];
    expect(pendingGovernanceForWorker(rows, worker).map((r) => r.id)).toEqual(["blocked", "awaiting"]);
  });
});

describe("buildRecoveryMetrics", () => {
  it("maps the real claim-counts fields", () => {
    const m = buildRecoveryMetrics({
      activeClaims: 12,
      attentionClaims: 3,
      openFindings: 7,
      drafts: 2,
      readyForSubmission: 1,
      submitted: 4,
      requestedAmount: 100000,
      approvedAmount: 40000,
      deniedAmount: 10000,
      paidAmount: 25000,
      outstanding: 15000,
      potential: 50000,
    });
    expect(m.activeClaims).toBe(12);
    expect(m.attentionClaims).toBe(3);
    expect(m.supplementsDrafted).toBe(2);
    expect(m.potential).toBe(50000);
    expect(m.outstanding).toBe(15000);
  });

  it("zero-shape for missing/null input", () => {
    const m = buildRecoveryMetrics(null);
    expect(m.activeClaims).toBe(0);
    expect(m.potential).toBe(0);
    expect(m.paidAmount).toBe(0);
  });
});

describe("buildDeadlineView", () => {
  it("buckets critical/warning/info and counts overdue", () => {
    const now = Date.now();
    const view = buildDeadlineView([
      { id: "crit", claimId: "c1", type: "sol", title: "SOL", dueDate: now + 1000, daysUntilDue: 0, severity: "critical", requiresAction: true, suggestedAction: "File" },
      { id: "warn", claimId: "c1", type: "followup", title: "Follow up", dueDate: now + 86_400_000, daysUntilDue: 1, severity: "warning", requiresAction: true, suggestedAction: "Call" },
      { id: "info", claimId: "c1", type: "review", title: "Review", dueDate: now + 5 * 86_400_000, daysUntilDue: 5, severity: "info", requiresAction: false, suggestedAction: "" },
      { id: "over", claimId: "c1", type: "x", title: "Overdue", dueDate: now - 86_400_000, daysUntilDue: -1, severity: "warning", requiresAction: true, suggestedAction: "" },
    ]);
    expect(view.critical).toHaveLength(1);
    expect(view.warning).toHaveLength(2);
    expect(view.upcoming).toHaveLength(1);
    expect(view.overdue).toBe(1);
  });
});

describe("buildEstimateReview", () => {
  it("runs the real estimator engine over claims with estimate data", () => {
    const rows = buildEstimateReview([makeClaim({})], 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].claimNumber).toBe("C-1");
    expect(rows[0].summary.claimId).toBe("c1");
    expect(rows[0].lineItemCount).toBeGreaterThan(0);
    expect(rows[0].summary.disclaimer).toMatch(/Xactimate/i);
  });

  it("skips claims with no estimate data at all", () => {
    const rows = buildEstimateReview([makeClaim({ estimateAmount: null, scopeItems: null, expectedScope: null, actualScope: null })], 10);
    expect(rows).toHaveLength(0);
  });
});

describe("tagClaimAttention / buildClaimView", () => {
  it("flags stale claims", () => {
    const stale = makeClaim({ updatedAt: Date.now() - 70 * 86_400_000 });
    expect(tagClaimAttention(stale)).toBe("stalled");
  });

  it("flags unknown statuses as at risk", () => {
    expect(tagClaimAttention(makeClaim({ status: "weird_state" }))).toBe("at_risk");
  });

  it("sorts attention first in the claim view", () => {
    const rows = buildClaimView([
      makeClaim({ _id: "ok", updatedAt: Date.now() - 1000, status: "open" }),
      makeClaim({ _id: "risk", updatedAt: Date.now() - 50 * 86_400_000, status: "open" }),
    ]);
    expect(rows[0].claim._id).toBe("risk");
    expect(rows[0].attention).toBe("at_risk");
  });
});

describe("scalable collection helpers", () => {
  it("groupByKey groups by derived key preserving order", () => {
    const groups = groupByKey(
      [
        { p: "claim_a/letter.pdf", n: 1 },
        { p: "claim_b/estimate.pdf", n: 2 },
        { p: "claim_a/policy.pdf", n: 3 },
      ],
      (x) => topFolder(x.p),
    );
    expect(groups.map((g) => g.key)).toEqual(["claim_a", "claim_b"]);
    expect(groups[0].count).toBe(2);
  });

  it("topFolder handles root and nesting", () => {
    expect(topFolder("claim_1/file.pdf")).toBe("claim_1");
    expect(topFolder("single.pdf")).toBe("single.pdf");
    expect(topFolder("")).toBe("(root)");
    expect(topFolder(null)).toBe("(root)");
  });

  it("filterBySearch matches any field, case-insensitive", () => {
    const items = [{ t: "Estimate for C-42", c: "roofing" }, { t: "Invoice", c: "contents" }];
    expect(filterBySearch(items, "c-42", [(x) => x.t, (x) => x.c])).toHaveLength(1);
    expect(filterBySearch(items, "ROOFING", [(x) => x.t, (x) => x.c])).toHaveLength(1);
    expect(filterBySearch(items, "", [(x) => x.t])).toHaveLength(2);
  });

  it("paginate and totalPages are deterministic", () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 1, 2)).toEqual([1, 2]);
    expect(paginate(items, 3, 2)).toEqual([5]);
    expect(totalPages(5, 2)).toBe(3);
    expect(totalPages(0, 10)).toBe(1);
  });
});