// ---------------------------------------------------------------------------
// Multi-state regression tests. The 10 priority states have materially
// different regulatory structures (common-law vs civil-law roots, different
// DOI names, different portal URLs). These tests assert the registry treats
// every jurisdiction as first-class and never fabricates state law.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { PRIORITY_STATES, JURISDICTIONS, getJurisdiction } from "./jurisdictions";
import { SEED_ALL_SOURCES, sourcesForJurisdiction, jurisdictionSourceSummary } from "./seed";
import { computeJurisdictionCoverage } from "./completeness";
import { SUPPLEMENT_TOPICS } from "./taxonomy";

const PRIORITY = ["FL", "TX", "CA", "NY", "CO", "LA", "MD", "WA", "AZ", "GA"];

describe("10-state regression", () => {
  it("all priority states are first-class jurisdictions", () => {
    for (const code of PRIORITY) {
      const j = getJurisdiction(code);
      expect(j, code).toBeDefined();
      expect(j!.name.length, code).toBeGreaterThan(0);
    }
  });

  it("every priority state has department, code, and admin-code registry sources", () => {
    for (const code of PRIORITY) {
      const j = getJurisdiction(code)!;
      const list = sourcesForJurisdiction(j.jurisdictionId, SEED_ALL_SOURCES);
      expect(list.some((s) => s.sourceType === "regulator_guidance"), code).toBe(true);
      expect(list.some((s) => s.sourceType === "statute"), code).toBe(true);
      expect(list.some((s) => s.sourceType === "administrative_code"), code).toBe(true);
    }
  });

  it("department names and URLs differ across states (no copy-paste collisions)", () => {
    const urls = PRIORITY.map((code) => getJurisdiction(code)!.officialInsuranceDepartmentUrl);
    expect(new Set(urls).size).toBe(PRIORITY.length);
    const publishers = PRIORITY.map((code) =>
      sourcesForJurisdiction(getJurisdiction(code)!.jurisdictionId, SEED_ALL_SOURCES).find(
        (s) => s.sourceType === "regulator_guidance",
      )?.publisher,
    );
    expect(new Set(publishers).size).toBe(PRIORITY.length);
  });

  it("no priority state has verified propositions at seed — honest research-incomplete state", () => {
    for (const code of PRIORITY) {
      const summary = jurisdictionSourceSummary(code, SEED_ALL_SOURCES);
      expect(summary.verified, code).toBe(0);
      expect(summary.registered, code).toBeGreaterThan(0);
    }
  });

  it("coverage scoring reflects zero state coverage without crashing", () => {
    for (const code of PRIORITY) {
      const j = getJurisdiction(code)!;
      const cov = computeJurisdictionCoverage({
        jurisdiction: j,
        sources: sourcesForJurisdiction(j.jurisdictionId, SEED_ALL_SOURCES),
        propositions: [],
        contradictionCount: 0,
        configuredTargetTopics: SUPPLEMENT_TOPICS,
      });
      expect(cov.regulatoryIntelligenceCoverageScore).toBeGreaterThanOrEqual(0);
      expect(cov.regulatoryIntelligenceCoverageScore).toBeLessThan(100);
      expect(["READY", "PARTIAL", "NEEDS_REVIEW", "RESEARCH_INCOMPLETE"]).toContain(cov.status);
      expect(cov.supplementState).toBe("research_incomplete");
    }
  });
});

describe("all 51 states sanity", () => {
  it("every jurisdiction resolves through the registry", () => {
    expect(JURISDICTIONS).toHaveLength(51);
    const codes = JURISDICTIONS.map((j) => j.stateCode);
    expect(codes).toContain("DC");
    expect(new Set(codes).size).toBe(51);
  });

  it("each non-federal seed source maps to a real jurisdiction", () => {
    for (const s of SEED_ALL_SOURCES) {
      if (s.jurisdictionId === "us") continue;
      const j = JURISDICTIONS.find((x) => x.jurisdictionId === s.jurisdictionId);
      expect(j, s.sourceId).toBeDefined();
    }
  });
});

describe("priority-state list consistency", () => {
  it("PRIORITY_STATES matches the regression list", () => {
    expect(PRIORITY_STATES).toEqual(PRIORITY);
  });
});