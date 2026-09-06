// ---------------------------------------------------------------------------
// Tests: Knowledge-gap normalization + governance-row normalization.
//
// Guards the production crash:
//   TypeError: a.knowledge_gaps.map is not a function
//   (ClaimDetail / AtlasReviewPanel / WorkQueue)
// against every shape a persisted JSONB value or RPC response could actually
// return. The UI must never call `.map/.filter/.length` on a non-array.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  normalizeKnowledgeGaps,
  type KnowledgeGapRow,
  normalizeGovernanceDecisionRow,
} from "./normalize-knowledge-gaps";

// ---------------------------------------------------------------------------
// normalizeKnowledgeGaps — canonical shape contract
// ---------------------------------------------------------------------------

describe("normalizeKnowledgeGaps", () => {
  it("returns [] for null / undefined / missing", () => {
    expect(normalizeKnowledgeGaps(null)).toEqual([]);
    expect(normalizeKnowledgeGaps(undefined)).toEqual([]);
    expect(normalizeKnowledgeGaps()).toEqual([]);
  });

  it("returns the normalized array for a valid array of gap references", () => {
    const input: Array<Record<string, unknown>> = [
      {
        description: "Policy limit not on file",
        severity: "high",
        impact: "Cannot assess recoverable value",
        requiresHumanReview: true,
      },
      { description: "Deductible unclear", severity: "low" },
    ];
    expect(normalizeKnowledgeGaps(input)).toEqual([
      {
        description: "Policy limit not on file",
        severity: "high",
        impact: "Cannot assess recoverable value",
        requiresHumanReview: true,
      },
      { description: "Deductible unclear", severity: "low", requiresHumanReview: undefined },
    ]);
  });

  it("coerces string fields and drops non-object entries without throwing", () => {
    const input = [null, "not an object", { description: 123, severity: null as unknown }, { foo: "bar" }];
    expect(normalizeKnowledgeGaps(input)).toEqual([
      { description: "123", severity: "unknown", requiresHumanReview: undefined },
      { description: "Unspecified knowledge gap", severity: "unknown", requiresHumanReview: undefined },
    ]);
  });

  it("parses a JSON string containing a valid array", () => {
    expect(normalizeKnowledgeGaps('[{ "description": "A", "severity": "medium" }]')).toEqual([
      { description: "A", severity: "medium", requiresHumanReview: undefined },
    ]);
  });

  it("returns [] for a malformed JSON string (logged in dev)", () => {
    expect(normalizeKnowledgeGaps("{not valid json")).toEqual([]);
    expect(normalizeKnowledgeGaps("[]")).toEqual([]);
  });

  it("returns [] for an unexpected object (logged in dev)", () => {
    expect(normalizeKnowledgeGaps({ foo: "bar" })).toEqual([]);
  });

  it("returns [] for unexpected primitives (logged in dev)", () => {
    expect(normalizeKnowledgeGaps(42)).toEqual([]);
    expect(normalizeKnowledgeGaps("just a string")).toEqual([]);
    expect(normalizeKnowledgeGaps(true)).toEqual([]);
  });

  it("handles a JSON string that parses to a non-array by returning []", () => {
    expect(normalizeKnowledgeGaps('{"description":"x"}')).toEqual([]);
  });

  it("honors requiresHumanReview only when it is a real boolean", () => {
    expect(
      normalizeKnowledgeGaps([{ description: "x", severity: "low", requiresHumanReview: 1 }]),
    ).toEqual([{ description: "x", severity: "low", requiresHumanReview: undefined }]);
    expect(
      normalizeKnowledgeGaps([{ description: "x", severity: "low", requiresHumanReview: false }]),
    ).toEqual([{ description: "x", severity: "low", requiresHumanReview: false }]);
  });
});

// ---------------------------------------------------------------------------
// Regression: a malformed persisted governance row cannot crash the panel
// ---------------------------------------------------------------------------

describe("normalizeGovernanceDecisionRow — knowledge_gaps never crashes the UI", () => {
  /**
   * This is the exact regression the production crash report describes:
   * a governance decision row whose `knowledge_gaps` is not an array must not
   * reach the UI as a non-array. After normalization, `knowledgeGaps` is
   * always `KnowledgeGapRow[]`, so the panel/WorkQueue can safely iterate it.
   */
  it("never produces a non-array knowledgeGaps, for any input shape", () => {
    const badInputs: Array<Record<string, unknown>> = [
      { id: "d1", tenant_id: "t1", entity_type: "claim", entity_id: "c1", action_type: "analyze",
        decision: "ALLOW", risk_level: "low", actor_role: "atlas", evaluated_at: "2026-01-01T00:00:00Z",
        knowledge_reference_date: null, loss_date: null, policy_period_start: null, policy_period_end: null,
        applicable_rules: "{}", applicable_standards: "[]", required_approvals: "[]",
        knowledge_gaps: { description: "boom", severity: "high" }, // object, not array
        evidence_references: "not-json", decision_rationale: "", governance_engine: "v1",
        knowledge_corpus_version: "1.0.0", orchestration_id: null, action_id: null, dedup_key: "k",
        execution_status: "executed", approval_status: "not_required", approved_by: null, approved_at: null,
        approved_notes: null, override_decision: null, override_reason: null, override_by: null,
        overridden_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "d2", tenant_id: "t1", entity_type: "claim", entity_id: "c2", action_type: "analyze",
        decision: "ALLOW", risk_level: "low", actor_role: "atlas", evaluated_at: "2026-01-01T00:00:00Z",
        knowledge_reference_date: null, loss_date: null, policy_period_start: null, policy_period_end: null,
        applicable_rules: null, applicable_standards: null, required_approvals: null,
        knowledge_gaps: "not a json array", evidence_references: null, decision_rationale: "",
        governance_engine: "v1", knowledge_corpus_version: "1.0.0", orchestration_id: null, action_id: null,
        dedup_key: "k", execution_status: "executed", approval_status: "not_required",
        approved_by: null, approved_at: null, approved_notes: null, override_decision: null,
        override_reason: null, override_by: null, overridden_at: null,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "d3", tenant_id: "t1", entity_type: "claim", entity_id: "c3", action_type: "analyze",
        decision: "UNKNOWN", risk_level: "low", actor_role: "atlas", evaluated_at: "2026-01-01T00:00:00Z",
        knowledge_reference_date: null, loss_date: null, policy_period_start: null, policy_period_end: null,
        applicable_rules: [], applicable_standards: [], required_approvals: [],
        knowledge_gaps: [null, "string", 7, { description: "real", severity: "critical", requiresHumanReview: true }],
        evidence_references: [], decision_rationale: "", governance_engine: "v1", knowledge_corpus_version: "1.0.0",
        orchestration_id: null, action_id: null, dedup_key: "k", execution_status: "executed",
        approval_status: "not_required", approved_by: null, approved_at: null, approved_notes: null,
        override_decision: null, override_reason: null, override_by: null, overridden_at: null,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ];

    for (const raw of badInputs) {
      const row = normalizeGovernanceDecisionRow(raw);

      // The crash site is gone: knowledgeGaps is always a real array.
      expect(Array.isArray(row.knowledgeGaps)).toBe(true);

      // Iteration must never throw.
      let joined = "";
      expect(() => {
        for (const g of row.knowledgeGaps) {
          joined += `${g.description}; `;
        }
      }).not.toThrow();

      // Existing bad data is preserved where it is usable — never silently
      // destroyed into nothing for the good entries.
      if (raw.id === "d3") {
        expect(row.knowledgeGaps.length).toBe(1);
        expect(row.knowledgeGaps[0].description).toBe("real");
        expect(row.knowledgeGaps[0].severity).toBe("critical");
        expect(row.knowledgeGaps[0].requiresHumanReview).toBe(true);
      }
    }
  });

  it("renders the exact JSX pattern from AtlasReviewPanel / WorkQueue safely", () => {
    const row = normalizeGovernanceDecisionRow({
      id: "d1", tenant_id: "t1", entity_type: "claim", entity_id: "c1", action_type: "analyze",
      decision: "REVIEW_REQUIRED", risk_level: "medium", actor_role: "atlas", evaluated_at: "2026-01-01T00:00:00Z",
      knowledge_reference_date: null, loss_date: null, policy_period_start: null, policy_period_end: null,
      applicable_rules: [], applicable_standards: [], required_approvals: [],
      knowledge_gaps: [{ description: "Policy limit not on file", severity: "high", impact: "Cannot assess value", requiresHumanReview: true }],
      evidence_references: [], decision_rationale: "needs review", governance_engine: "v1",
      knowledge_corpus_version: "1.0.0", orchestration_id: null, action_id: null, dedup_key: "k",
      execution_status: "awaiting_approval", approval_status: "required", approved_by: null, approved_at: null,
      approved_notes: null, override_decision: null, override_reason: null, override_by: null, overridden_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });

    // Replicates the production render pattern — must never throw.
    const gapsText =
      row.knowledgeGaps.length > 0
        ? row.knowledgeGaps.map((g) => g.description).join("; ")
        : "";

    expect(gapsText).toBe("Policy limit not on file");

    // Zero gaps must also render safely (the `length > 0` guard + empty join).
    const empty = normalizeGovernanceDecisionRow({
      id: "d2", tenant_id: "t1", entity_type: "claim", entity_id: "c2", action_type: "analyze",
      decision: "ALLOW", risk_level: "low", actor_role: "atlas", evaluated_at: "2026-01-01T00:00:00Z",
      knowledge_reference_date: null, loss_date: null, policy_period_start: null, policy_period_end: null,
      applicable_rules: [], applicable_standards: [], required_approvals: [],
      knowledge_gaps: null as unknown, evidence_references: [], decision_rationale: "",
      governance_engine: "v1", knowledge_corpus_version: "1.0.0", orchestration_id: null, action_id: null,
      dedup_key: "k", execution_status: "executed", approval_status: "not_required",
      approved_by: null, approved_at: null, approved_notes: null, override_decision: null,
      override_reason: null, override_by: null, overridden_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    expect(empty.knowledgeGaps).toEqual([]);
    expect(empty.knowledgeGaps.length > 0 ? empty.knowledgeGaps.map((g) => g.description).join("; ") : "").toBe("");
  });

  it("keeps the full KnowledgeGap type available for workflow-facing consumers", () => {
    // Re-exported token is the real governance KnowledgeGap, not the persisted row.
    const g: KnowledgeGapRow = { description: "x", severity: "low" };
    expect(g.description).toBe("x");
  });
});
