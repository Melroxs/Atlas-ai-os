// ---------------------------------------------------------------------------
// Atlas Governance Engine — Knowledge Source & Gate Tests
//
// Verifies that:
//   1. Corpus records convert into normalized, machine-queryable
//      KnowledgeObjects with explicit authority levels.
//   2. Placeholder/unverified records never rank as authoritative.
//   3. The corpus-backed KnowledgeSource feeds the governance gate, and the
//      gate produces the expected decisions for material actions.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  corpusToKnowledgeObjects,
  seedToKnowledgeObjects,
  createCorpusKnowledgeSource,
  buildDefaultGovernanceKnowledgeSource,
} from "./knowledge-source";
import { FEDERAL_REGULATIONS, JURISDICTION_PROFILES } from "../knowledge/corpus";
import { AUTHORITATIVE_KNOWLEDGE_SEEDS } from "../atlas-data/authority";
import { executeGovernanceGate } from "./governance-gate";
import {
  buildTemporalContext,
  filterEffectiveAt,
  resolveApplicableKnowledge,
  sortByAuthority,
} from "./authority";
import type { ComplianceContext, KnowledgeObject } from "./types";

function temporalContext() {
  return buildTemporalContext({
    lossDate: new Date("2026-01-01T00:00:00Z").getTime(),
  });
}

function baseContext(actionType: string): ComplianceContext {
  return {
    actionType,
    actionDescription: `Test action: ${actionType}`,
    tenantId: "test-tenant",
    performingRole: "atlas",
    temporalContext: temporalContext(),
  };
}

describe("corpusToKnowledgeObjects", () => {
  it("maps REGULATORY records to binding_regulation with an explicit basis", () => {
    const objects = corpusToKnowledgeObjects(FEDERAL_REGULATIONS);
    const osha = objects.find((o) => o.id.includes("osha_fall_protection"));

    expect(osha).toBeDefined();
    expect(osha!.authorityLevel).toBe("binding_regulation");
    expect(osha!.authorityBasis).toBe("regulation");
    expect(osha!.jurisdictionType).toBe("federal");
    expect(osha!.jurisdiction).toBe("United States");
    expect(osha!.verificationStatus).toBe("verified");
    expect(osha!.citation).toBeTruthy();
  });

  it("never lets placeholder jurisdiction profiles rank as authoritative", () => {
    const objects = corpusToKnowledgeObjects(JURISDICTION_PROFILES.slice(0, 5));
    expect(objects.length).toBeGreaterThan(0);
    for (const obj of objects) {
      expect(obj.authorityLevel).toBe("general_ai_knowledge");
      expect(obj.verificationStatus).toBe("unverified");
    }
  });

  it("produces a non-empty, machine-queryable set from the corpus", () => {
    const objects = corpusToKnowledgeObjects(FEDERAL_REGULATIONS);
    expect(objects.length).toBe(FEDERAL_REGULATIONS.length);
    for (const obj of objects) {
      expect(obj.id).toBeTruthy();
      expect(obj.requirement).toBeTruthy();
      expect(obj.effectiveFrom).toBeGreaterThan(0);
      expect(obj.confidence).toBeGreaterThan(0);
    }
  });
});

describe("seedToKnowledgeObjects", () => {
  it("maps tier1_primary sources to binding_regulation", () => {
    const objects = seedToKnowledgeObjects(AUTHORITATIVE_KNOWLEDGE_SEEDS);
    const oshaSeed = objects.find((o) => o.id.includes("osha-1910-134"));
    expect(oshaSeed!.authorityLevel).toBe("binding_regulation");
    expect(oshaSeed!.authorityBasis).toBe("regulation");
  });

  it("maps standards (IICRC) to industry_standard", () => {
    const objects = seedToKnowledgeObjects(AUTHORITATIVE_KNOWLEDGE_SEEDS);
    const s500 = objects.find((o) => o.id.includes("iicrc-s500"));
    expect(s500!.authorityLevel).toBe("industry_standard");
    expect(s500!.sourceName).toContain("IICRC");
  });

  it("marks seeds unverified until reviewed", () => {
    const objects = seedToKnowledgeObjects(AUTHORITATIVE_KNOWLEDGE_SEEDS);
    for (const obj of objects) {
      expect(obj.verificationStatus).toBe("unverified");
    }
  });
});

describe("corpus-backed knowledge source", () => {
  it("returns knowledge for every material action (never falsely empty)", async () => {
    const source = createCorpusKnowledgeSource();
    const actions = [
      "claim_analysis",
      "supplement_preparation",
      "communication_drafting",
      "communication_sending",
      "financial_calculation",
      "carrier_submission",
      "coverage_determination",
    ];
    for (const action of actions) {
      const items = await source.getKnowledgeObjects({ domain: action });
      expect(items.length, `action ${action}`).toBeGreaterThan(0);
    }
  });

  it("filters by jurisdiction but keeps federal overlay", async () => {
    const source = createCorpusKnowledgeSource();
    const fl = await source.getKnowledgeObjects({
      jurisdiction: "United States > Florida",
    });
    expect(fl.length).toBeGreaterThan(0);
    for (const obj of fl) {
      expect(
        obj.jurisdiction === "United States > Florida" ||
          obj.jurisdiction === "United States" ||
          obj.jurisdictionType === "federal",
      ).toBe(true);
    }
  });
});

describe("governance gate with corpus knowledge", () => {
  it("ALLOWs claim analysis for Atlas", async () => {
    const gate = await executeGovernanceGate(
      baseContext("claim_analysis"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.compliance.decision).toBe("ALLOW");
    expect(gate.evidenceChain.length).toBeGreaterThan(0);
  });

  it("REVIEW_REQUIRED for supplement preparation", async () => {
    const gate = await executeGovernanceGate(
      baseContext("supplement_preparation"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.compliance.decision).toBe("REVIEW_REQUIRED");
    expect(gate.requiredApprovals).toContain("human_review");
  });

  it("BLOCKs legal conclusions — Atlas must never practice law", async () => {
    const gate = await executeGovernanceGate(
      baseContext("legal_conclusion"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.compliance.decision).toBe("BLOCK");
    expect(gate.compliance.riskLevel).toBe("critical");
  });

  it("BLOCKs contract execution without authorization", async () => {
    const gate = await executeGovernanceGate(
      baseContext("contract_execution"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.compliance.decision).toBe("BLOCK");
  });

  it("professional boundary: coverage determinations require a licensed professional", async () => {
    const gate = await executeGovernanceGate(
      baseContext("coverage_determination"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.compliance.decision).toBe("REVIEW_REQUIRED");
    expect(gate.compliance.requiredApproval).toBe("insurance_adjuster_or_public_adjuster");
    expect(gate.requiredApprovals).toContain("insurance_adjuster_or_public_adjuster");
  });

  it("professional boundary: engineering determinations are blocked", async () => {
    const gate = await executeGovernanceGate(
      baseContext("engineering_determination"),
      buildDefaultGovernanceKnowledgeSource(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.compliance.decision).toBe("BLOCK");
  });
});

describe("authority + temporal helpers", () => {
  it("sorts law above standards", () => {
    const law: KnowledgeObject = {
      id: "law",
      title: "Statute",
      domain: "test",
      authorityLevel: "applicable_law",
      authorityBasis: "statute",
      sourceType: "statute",
      sourceName: "test",
      citation: "test",
      jurisdiction: "United States",
      jurisdictionType: "federal",
      effectiveFrom: 0,
      version: "1",
      applicability: [],
      requirement: "x",
      verificationStatus: "verified",
      retrievedAt: 0,
      confidence: 1,
    };
    const standard: KnowledgeObject = { ...law, id: "std", title: "Standard", authorityLevel: "industry_standard" };
    const sorted = sortByAuthority([standard, law]);
    expect(sorted[0].id).toBe("law");
  });

  it("filters rules not yet effective", () => {
    const now = Date.now();
    const future: KnowledgeObject = {
      id: "future",
      title: "Future rule",
      domain: "test",
      authorityLevel: "binding_regulation",
      authorityBasis: "regulation",
      sourceType: "regulation",
      sourceName: "test",
      citation: "test",
      jurisdiction: "United States",
      jurisdictionType: "federal",
      effectiveFrom: now + 100_000,
      version: "1",
      applicability: [],
      requirement: "x",
      verificationStatus: "verified",
      retrievedAt: now,
      confidence: 1,
    };
    const active: KnowledgeObject = { ...future, id: "active", effectiveFrom: now - 100_000 };
    const result = filterEffectiveAt([future, active], now);
    expect(result.map((r) => r.id)).toEqual(["active"]);
  });

  // Phase 10 regression: a rule that became effective AFTER the loss date must
  // still be evaluated — knowledge validity is anchored to the EVALUATION date,
  // not the loss date (loss-date deadlines are tracked separately).
  it("evaluates rules effective after the loss date (evaluation-date reference)", () => {
    const now = Date.now();
    const lossDate = now - 200 * 86_400_000; // ~200 days before today
    const rule: KnowledgeObject = {
      id: "rule-post-loss",
      title: "Rule effective after the loss",
      domain: "test",
      authorityLevel: "binding_regulation",
      authorityBasis: "regulation",
      sourceType: "regulation",
      sourceName: "test",
      citation: "test",
      jurisdiction: "United States",
      jurisdictionType: "federal",
      effectiveFrom: lossDate + 50 * 86_400_000, // effective 50 days after loss
      version: "1",
      applicability: [],
      requirement: "x",
      verificationStatus: "verified",
      retrievedAt: now,
      confidence: 1,
    };

    const { applicable, gaps } = resolveApplicableKnowledge([rule], {
      temporalContext: buildTemporalContext({ lossDate }),
    });

    // The rule is in effect at evaluation time → applicable despite post-dating
    // the loss. No critical knowledge gap is produced.
    expect(applicable.map((r) => r.id)).toEqual(["rule-post-loss"]);
    expect(gaps.filter((g) => g.severity === "critical")).toEqual([]);
  });
});