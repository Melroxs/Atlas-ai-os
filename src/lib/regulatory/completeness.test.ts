import { describe, expect, it } from "vitest";
import { computeJurisdictionCoverage, COVERAGE_DIMENSIONS } from "./completeness";
import { buildRegulatoryProposition } from "./propositions";
import type { Jurisdiction, RegulatorySource } from "./types";

const now = Date.now();

const FL: Jurisdiction = {
  jurisdictionId: "fl",
  jurisdictionType: "state",
  stateCode: "FL",
  name: "Florida",
  active: true,
  officialInsuranceDepartmentUrl: "https://www.floir.com",
  createdAt: now,
  updatedAt: now,
};

function src(id: string, type: RegulatorySource["sourceType"], tier: 1 | 2 | 3 | 4): RegulatorySource {
  return {
    sourceId: id,
    jurisdictionId: "fl",
    sourceType: type,
    authorityTier: tier,
    publisher: "p",
    title: id,
    status: "VERIFIED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
  };
}

function prop(source: RegulatorySource, topic: string, ruleText: string, status: "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED") {
  return buildRegulatoryProposition({
    jurisdictionId: "fl",
    source,
    topic,
    ruleText,
    verificationStatus: status,
  });
}

describe("completeness scoring", () => {
  it("scores zero for a jurisdiction with only registered sources and no propositions", () => {
    const cov = computeJurisdictionCoverage({
      jurisdiction: FL,
      sources: [src("a", "regulator_guidance", 2)],
      propositions: [],
      contradictionCount: 0,
      configuredTargetTopics: ["acknowledgment", "payment"],
    });
    expect(cov.regulatoryIntelligenceCoverageScore).toBeLessThan(30);
    expect(cov.status).toBe("RESEARCH_INCOMPLETE");
    expect(cov.gaps).toContain("acknowledgment");
    expect(cov.supplementState).toBe("research_incomplete");
  });

  it("gaps list is honest: only topics with no verified coverage", () => {
    const verifiedSrc = src("stat", "statute", 1);
    const rules = [
      prop(verifiedSrc, "acknowledgment", "Insurer must acknowledge within 5 days.", "VERIFIED"),
      prop(verifiedSrc, "payment", "Insurer must pay within 30 days.", "VERIFIED"),
    ];
    const cov = computeJurisdictionCoverage({
      jurisdiction: FL,
      sources: [verifiedSrc, src("d", "regulator_guidance", 2)],
      propositions: rules,
      contradictionCount: 0,
      configuredTargetTopics: ["acknowledgment", "payment", "denial"],
    });
    expect(cov.verifiedPropositionCount).toBe(2);
    expect(cov.gaps).toEqual(["denial"]);
    expect(cov.regulatoryIntelligenceCoverageScore).toBeGreaterThan(0);
  });

  it("partially-verified propositions count as partial coverage", () => {
    const verifiedSrc = src("stat", "statute", 1);
    const rules = [
      prop(verifiedSrc, "acknowledgment", "Insurer must acknowledge within 5 days.", "PARTIALLY_VERIFIED"),
    ];
    const cov = computeJurisdictionCoverage({
      jurisdiction: FL,
      sources: [verifiedSrc],
      propositions: rules,
      contradictionCount: 0,
      configuredTargetTopics: ["acknowledgment"],
    });
    expect(cov.verifiedPropositionCount).toBe(1); // counts partial as verified-ish
  });

  it("coverage dimension weights sum to 1", () => {
    const total = Object.values(COVERAGE_DIMENSIONS).reduce((s, d) => s + d.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("never reports 100 for partial data — 100 means targets met, not 'all law known'", () => {
    const verifiedSrc = src("stat", "statute", 1);
    const rules = [
      prop(verifiedSrc, "acknowledgment", "Insurer must acknowledge within 5 days.", "VERIFIED"),
      prop(verifiedSrc, "payment", "Insurer must pay within 30 days.", "VERIFIED"),
      prop(verifiedSrc, "response_deadlines", "Insurer must respond within 14 days.", "VERIFIED"),
    ];
    const cov = computeJurisdictionCoverage({
      jurisdiction: FL,
      sources: [verifiedSrc],
      propositions: rules,
      contradictionCount: 0,
      configuredTargetTopics: ["acknowledgment", "payment", "response_deadlines"],
    });
    expect(cov.regulatoryIntelligenceCoverageScore).toBeLessThan(100);
  });
});