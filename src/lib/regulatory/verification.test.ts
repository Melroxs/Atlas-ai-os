import { describe, expect, it } from "vitest";
import {
  decideVerification,
  capVerificationForSource,
  canCiteAsPrimary,
  statusForAbsence,
  type VerificationChecklist,
} from "./verification";
import type { RegulatorySource } from "./types";

const now = Date.now();

function source(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    sourceId: "s1",
    jurisdictionId: "fl",
    sourceType: "statute",
    authorityTier: 1,
    publisher: "Florida Legislature",
    title: "Florida Statutes",
    status: "FETCHED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const FULL_CHECKLIST: VerificationChecklist = {
  sourceExists: true,
  urlResolves: true,
  authorityMatches: true,
  citationExists: true,
  textSupported: true,
  jurisdictionMatches: true,
  effectiveDateConsidered: true,
  notSuperseded: true,
  noContradictions: true,
};

describe("verification decisions", () => {
  it("verifies a fully-supported primary source", () => {
    expect(decideVerification(source(), FULL_CHECKLIST)).toBe("VERIFIED");
  });

  it("never verifies a source whose URL does not resolve", () => {
    expect(decideVerification(source(), { ...FULL_CHECKLIST, urlResolves: false })).toBe("FAILED");
  });

  it("never verifies when the text is unsupported or citation missing", () => {
    expect(
      decideVerification(source(), { ...FULL_CHECKLIST, textSupported: false, citationExists: false }),
    ).toBe("NEEDS_HUMAN_REVIEW");
    // Text confirmed but no citation anchor → UNVERIFIED, not PARTIALLY_VERIFIED.
    expect(decideVerification(source(), { ...FULL_CHECKLIST, citationExists: false })).toBe("UNVERIFIED");
  });

  it("blocks verification on an open contradiction", () => {
    expect(decideVerification(source(), { ...FULL_CHECKLIST, noContradictions: false })).toBe("CONTRADICTED");
  });

  it("requires jurisdiction match", () => {
    expect(decideVerification(source(), { ...FULL_CHECKLIST, jurisdictionMatches: false })).toBe("FAILED");
  });
});

describe("tier caps — the core anti-hallucination invariants", () => {
  it("a secondary source can never reach VERIFIED", () => {
    const secondary = source({ sourceType: "secondary_reference", authorityTier: 4 });
    const decision = decideVerification(secondary, FULL_CHECKLIST);
    expect(decision).not.toBe("VERIFIED");
    expect(capVerificationForSource("VERIFIED", secondary)).toBe("UNVERIFIED");
  });

  it("an industry/standards source can be verified as to its own content but never as controlling law", () => {
    const industry = source({ sourceType: "industry_standard", authorityTier: 3 });
    const capped = capVerificationForSource("VERIFIED", industry);
    expect(capped).toBe("PARTIALLY_VERIFIED");
  });

  it("only primary sources can be cited as controlling", () => {
    expect(canCiteAsPrimary(source({ sourceType: "statute" }))).toBe(true);
    expect(canCiteAsPrimary(source({ sourceType: "federal_regulation" }))).toBe(true);
    expect(canCiteAsPrimary(source({ sourceType: "regulator_guidance", authorityTier: 2 }))).toBe(false);
    expect(canCiteAsPrimary(source({ sourceType: "secondary_reference", authorityTier: 4 }))).toBe(false);
  });
});

describe("absence semantics — never convert not-found into does-not-exist", () => {
  it("maps research-complete absence to INSUFFICIENT_EVIDENCE", () => {
    expect(statusForAbsence(true)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("maps incomplete research to UNVERIFIED (not 'does not exist')", () => {
    expect(statusForAbsence(false)).toBe("UNVERIFIED");
  });

  it("INSUFFICIENT_EVIDENCE is never equal to a negative finding", () => {
    const s = statusForAbsence(true);
    expect(s === "INSUFFICIENT_EVIDENCE").toBe(true);
    expect(s === "VERIFIED").toBe(false);
  });
});