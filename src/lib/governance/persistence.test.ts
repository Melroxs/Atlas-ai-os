// ---------------------------------------------------------------------------
// Atlas Governance Persistence — Unit Tests
//
// Tests the pure mapping layer of the persistence service (no database):
//   - deterministic dedup keys (no duplicate work items on re-evaluation)
//   - governance summary → durable record mapping
//   - temporal separation: loss date is never conflated with the knowledge
//     reference (evaluation) date
//   - best-effort persistence outcomes without an authenticated session
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  buildGovernanceRecord,
  persistGovernanceDecision,
  decideGovernanceDecision,
  listGovernanceDecisions,
  type GovernanceRecordInput,
} from "./persistence";
import type { GovernanceSummary } from "../orchestrator/types";

const NOW = 1780000000000; // 2026-05-28 evaluation time
const LOSS = 1767000000000; // 2026-01-01 loss date

function makeSummary(overrides: Partial<GovernanceSummary> = {}): GovernanceSummary {
  return {
    evaluated: true,
    actionType: "supplement_preparation",
    decision: "REVIEW_REQUIRED",
    riskLevel: "medium",
    jurisdiction: "United States > Florida",
    knowledgeReferenceDate: NOW,
    reason: "Supplement documentation must be reviewed before any submission.",
    applicableRules: [
      {
        id: "rule-1",
        title: "EPA Lead Renovation, Repair & Painting Rule",
        authorityLevel: "binding_regulation",
        authorityBasis: "regulation",
        citation: "40 CFR 745",
        effectiveFrom: 1600000000000,
        jurisdiction: "United States",
        confidence: 0.95,
      },
    ],
    applicableStandards: [
      {
        id: "std-1",
        title: "IICRC S500",
        authorityLevel: "industry_standard",
        authorityBasis: "standard promulgated",
        citation: "S500",
        effectiveFrom: 1600000000000,
        jurisdiction: "United States",
        confidence: 0.8,
      },
    ],
    applicableRuleCount: 1,
    applicableStandardsCount: 1,
    requiredApprovals: ["human_review"],
    requiredEvidence: ["estimate", "invoice"],
    knowledgeGaps: [
      {
        description: "No verified jurisdiction-specific rule for Florida.",
        severity: "medium",
        impact: "Cannot assert a Florida-specific requirement.",
        requiresHumanReview: true,
      },
    ],
    knowledgeGapCount: 1,
    citations: ["40 CFR 745"],
    evidenceChain: [],
    evaluationTrace: ["[COMPLIANCE] Evaluating: supplement_preparation"],
    evaluationTimeMs: 14,
    persisted: false,
    ...overrides,
  };
}

describe("buildDedupKey", () => {
  it("is deterministic for the same action + entity", () => {
    const a = buildDedupKey("supplement_preparation", "supplement", "claim-1");
    const b = buildDedupKey("supplement_preparation", "supplement", "claim-1");
    expect(a).toBe(b);
  });

  it("differs across actions and entities", () => {
    expect(buildDedupKey("supplement_preparation", "supplement", "claim-1")).not.toBe(
      buildDedupKey("claim_analysis", "claim", "claim-1"),
    );
    expect(buildDedupKey("supplement_preparation", "supplement", "claim-1")).not.toBe(
      buildDedupKey("supplement_preparation", "supplement", "claim-2"),
    );
  });
});

describe("buildGovernanceRecord", () => {
  it("maps every summary field into the durable record shape", () => {
    const summary = makeSummary();
    const record = buildGovernanceRecord(summary, {
      claimId: "claim-1",
      entityType: "supplement",
      entityId: "claim-1",
      orchestrationId: "req-abc",
      actionId: "supplement:claim-1",
      lossDate: LOSS,
    });

    expect(record.claimId).toBe("claim-1");
    expect(record.entityType).toBe("supplement");
    expect(record.entityId).toBe("claim-1");
    expect(record.actionType).toBe("supplement_preparation");
    expect(record.decision).toBe("REVIEW_REQUIRED");
    expect(record.riskLevel).toBe("medium");
    expect(record.jurisdiction).toBe("United States > Florida");
    expect(record.requiredApprovals).toEqual(["human_review"]);
    expect(record.citations).toEqual(["40 CFR 745"]);
    expect(record.orchestrationId).toBe("req-abc");
    expect(record.actionId).toBe("supplement:claim-1");
    expect(record.governanceEngine).toBe("atlas-governance-engine-1");
    expect(record.knowledgeCorpusVersion).toBe("1.0.0");
    expect(record.dedupKey).toBe("supplement_preparation|supplement|claim-1");
  });

  it("retains structured rule provenance (id, authority, citation, effective date)", () => {
    const record = buildGovernanceRecord(makeSummary(), {
      entityType: "supplement",
      entityId: "claim-1",
    });

    expect(record.applicableRules).toEqual([
      {
        id: "rule-1",
        title: "EPA Lead Renovation, Repair & Painting Rule",
        authorityLevel: "binding_regulation",
        authorityBasis: "regulation",
        citation: "40 CFR 745",
        effectiveFrom: 1600000000000,
        jurisdiction: "United States",
        confidence: 0.95,
      },
    ]);
    expect(record.applicableStandards[0]).toMatchObject({
      id: "std-1",
      authorityLevel: "industry_standard",
    });
  });

  it("persists knowledge gaps and evidence references as structured lists", () => {
    const record = buildGovernanceRecord(makeSummary(), {
      entityType: "supplement",
      entityId: "claim-1",
    });

    expect(record.knowledgeGaps).toEqual([
      {
        description: "No verified jurisdiction-specific rule for Florida.",
        severity: "medium",
        impact: "Cannot assert a Florida-specific requirement.",
        requiresHumanReview: true,
      },
    ]);
    expect(record.evidenceReferences).toEqual([{ ref: "estimate" }, { ref: "invoice" }]);
  });

  // Phase 10 regression: loss date and knowledge reference date are distinct.
  it("keeps the loss date separate from the knowledge reference (evaluation) date", () => {
    const record = buildGovernanceRecord(makeSummary(), {
      entityType: "supplement",
      entityId: "claim-1",
      lossDate: LOSS,
    });

    expect(record.lossDate).toBe(LOSS);
    expect(record.knowledgeReferenceDate).toBe(NOW);
    expect(record.lossDate).not.toBe(record.knowledgeReferenceDate);
  });
});

describe("persistence best-effort behavior (no authenticated session)", () => {
  it("persistGovernanceDecision reports not persisted without crashing", async () => {
    const record = buildGovernanceRecord(makeSummary(), {
      entityType: "supplement",
      entityId: "claim-1",
    }) as GovernanceRecordInput;

    const outcome = await persistGovernanceDecision(record);
    expect(outcome.persisted).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it("decideGovernanceDecision fails safely without a session", async () => {
    const outcome = await decideGovernanceDecision("00000000-0000-0000-0000-000000000000", "approved");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it("listGovernanceDecisions returns an empty list without a session", async () => {
    const rows = await listGovernanceDecisions({ claimId: "claim-1" });
    expect(rows).toEqual([]);
  });
});