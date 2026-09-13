// ---------------------------------------------------------------------------
// Atlas Orchestrator — Governance Wiring Tests
//
// Verifies the phase requirement: material actions executed through the Atlas
// Workforce orchestrator MUST pass through the governance gate, and the
// decision must be surfaced on the result and recorded as evidence.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  getAtlasWorkforce,
  createPrepareSupplementRequest,
  createDraftCommunicationRequest,
} from "./index";
import type { ClaimSnapshot } from "../insurance/logic";

const claim: ClaimSnapshot = {
  _id: "claim-1",
  claimNumber: "CLM-1001",
  dateOfLoss: new Date("2026-02-01T00:00:00Z").getTime(),
  property: "123 Main St, Miami, FL 33101",
  customer: "Jane Doe",
  carrier: "State Farm",
  status: "open",
  estimateAmount: 24500,
  paymentAmount: 12000,
  invoicedAmount: 24500,
  approvedAmount: 15000,
  evidenceSummary: ["estimate", "invoice"],
};

function governanceEvidence(result: { evidenceGenerated: Array<{ rule?: string }> }) {
  return result.evidenceGenerated.filter((e) => e.rule === "governance_gate");
}

describe("orchestrator governance wiring", () => {
  it("evaluates the governance gate on claim review", async () => {
    const workforce = getAtlasWorkforce();
    const request = {
      id: "req-review-test",
      type: "review_claim" as const,
      claimId: "claim-1",
      tenantId: "test-tenant",
      input: { claim, documents: [], supplements: [], findings: [] },
      source: "ui" as const,
      timestamp: Date.now(),
    };
    const result = await workforce.processRequest(request);

    expect(result.status).toBe("completed");
    expect(result.governance).toBeDefined();
    expect(result.governance!.evaluated).toBe(true);
    expect(result.governance!.actionType).toBe("claim_analysis");
    expect(result.governance!.decision).toBe("ALLOW");
    expect(governanceEvidence(result).length).toBe(1);
    // Jurisdiction resolved from the property address, and surfaced structured.
    expect(result.governance!.jurisdiction).toBe("United States > Florida");
    expect(result.governance!.evaluationTrace.some((t) => t.includes("Florida"))).toBe(true);
    // No authenticated session in tests → decision is not persisted, but the
    // failure is recorded on the summary (never silently swallowed).
    expect(result.governance!.persisted).toBe(false);
    expect(result.governance!.evaluationTrace.some((t) => t.includes("GOVERNANCE-PERSIST"))).toBe(true);
  });

  it("supplement preparation passes through the gate as REVIEW_REQUIRED", async () => {
    const workforce = getAtlasWorkforce();
    const request = createPrepareSupplementRequest("claim-1", "test-tenant", claim, {
      source: "ui",
    });
    const result = await workforce.processRequest(request);

    expect(result.status).toBe("completed");
    expect(result.governance).toBeDefined();
    expect(result.governance!.evaluated).toBe(true);
    expect(result.governance!.actionType).toBe("supplement_preparation");
    expect(result.governance!.decision).toBe("REVIEW_REQUIRED");
    expect(result.governance!.riskLevel).toBe("medium");
    expect(result.governance!.requiredApprovals).toContain("human_review");
    expect(governanceEvidence(result).length).toBe(1);
    expect(result.governance!.persisted).toBe(false);
  });

  it("external communication drafting is gated as REVIEW_REQUIRED", async () => {
    const workforce = getAtlasWorkforce();
    const request = createDraftCommunicationRequest(
      "claim-1",
      "test-tenant",
      claim,
      "carrier_correspondence",
      { source: "ui" },
    );
    const result = await workforce.processRequest(request);

    expect(result.status).toBe("completed");
    expect(result.governance).toBeDefined();
    expect(result.governance!.actionType).toBe("communication_sending");
    expect(result.governance!.decision).toBe("REVIEW_REQUIRED");
    expect(governanceEvidence(result).length).toBe(1);
    expect(result.governance!.persisted).toBe(false);
  });

  it("internal drafting is allowed by the gate", async () => {
    const workforce = getAtlasWorkforce();
    const request = createDraftCommunicationRequest(
      "claim-1",
      "test-tenant",
      claim,
      "internal_note",
      { source: "ui" },
    );
    const result = await workforce.processRequest(request);

    expect(result.status).toBe("completed");
    expect(result.governance).toBeDefined();
    expect(result.governance!.actionType).toBe("communication_drafting");
    expect(result.governance!.decision).toBe("ALLOW");
    expect(result.governance!.persisted).toBe(false);
  });

  it("financial calculations are gated as ALLOW with evidence recorded", async () => {
    const workforce = getAtlasWorkforce();
    const request = {
      id: "req-recovery-test",
      type: "calculate_recovery" as const,
      claimId: "claim-1",
      tenantId: "test-tenant",
      input: { claim },
      source: "ui" as const,
      timestamp: Date.now(),
    };
    const result = await workforce.processRequest(request);

    expect(result.status).toBe("completed");
    expect(result.governance).toBeDefined();
    expect(result.governance!.actionType).toBe("financial_calculation");
    expect(result.governance!.decision).toBe("ALLOW");
    expect(governanceEvidence(result).length).toBe(1);
    expect(result.governance!.persisted).toBe(false);
  });
});