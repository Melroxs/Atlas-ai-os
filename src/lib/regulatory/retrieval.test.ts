import { describe, expect, it } from "vitest";
import {
  retrieveRegulatoryRules,
  buildRegulatoryAnswer,
  formatRegulatoryAnswer,
} from "./retrieval";
import { buildRegulatoryProposition, versionProposition } from "./propositions";
import { detectRegulatoryContradictions } from "./contradictions";
import type { RegulatorySource } from "./types";

const now = Date.now();

function source(id: string, jurisdictionId: string, title: string, tier: 1 | 2 | 3 | 4 = 1): RegulatorySource {
  return {
    sourceId: id,
    jurisdictionId,
    sourceType: tier === 1 ? "statute" : tier === 4 ? "secondary_reference" : "regulator_guidance",
    authorityTier: tier,
    publisher: "Test Publisher",
    title,
    canonicalUrl: `https://official.example/${id}`,
    status: "VERIFIED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

function prop(
  source: RegulatorySource,
  ruleText: string,
  opts: { topic?: string; actor?: "insurer" | "restoration_contractor" | "public_adjuster"; verificationStatus?: "VERIFIED" | "UNVERIFIED" | "INSUFFICIENT_EVIDENCE"; effectiveFrom?: number; confidence?: number; jurisdictionId?: string } = {},
) {
  return buildRegulatoryProposition({
    jurisdictionId: opts.jurisdictionId ?? source.jurisdictionId!,
    source,
    topic: opts.topic ?? "response_deadlines",
    ruleText,
    effectiveFrom: opts.effectiveFrom,
    confidence: opts.confidence,
    verificationStatus: opts.verificationStatus,
  });
}

describe("regulatory retrieval", () => {
  const flStat = source("fl-stat", "fl", "Fla. Stat. ch. 627");
  const txStat = source("tx-stat", "tx", "Tex. Ins. Code");
  const flGuidance = source("fl-guide", "fl", "FL OIR Guidance", 2);

  it("filters by jurisdiction", () => {
    const flRule = prop(flStat, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const txRule = prop(txStat, "Insurer must respond within 15 days.", { verificationStatus: "VERIFIED" });
    const results = retrieveRegulatoryRules([flRule, txRule], [flStat, txStat], {
      jurisdictionId: "fl",
    });
    expect(results).toHaveLength(1);
    expect(results[0].proposition.sourceId).toBe("fl-stat");
  });

  it("filters by actor, topic, and authority tier", () => {
    const ack = prop(flStat, "Insurer must acknowledge claims within 5 days.", {
      topic: "acknowledgment",
      verificationStatus: "VERIFIED",
    });
    const pa = prop(flGuidance, "A public adjuster must be licensed.", {
      topic: "pa_licensing",
      actor: "public_adjuster",
      verificationStatus: "VERIFIED",
    });
    const all = [ack, pa];

    expect(retrieveRegulatoryRules(all, [flStat, flGuidance], { jurisdictionId: "fl", actors: ["public_adjuster"] })).toHaveLength(1);
    expect(retrieveRegulatoryRules(all, [flStat, flGuidance], { jurisdictionId: "fl", topics: ["acknowledgment"] })).toHaveLength(1);
    expect(retrieveRegulatoryRules(all, [flStat, flGuidance], { jurisdictionId: "fl", minAuthorityTier: 1 })).toHaveLength(1);
  });

  it("excludes low-confidence and unverified rules when asked", () => {
    const verified = prop(flStat, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED", confidence: 0.9 });
    const unverified = prop(flGuidance, "Insurer must respond within 20 days.", { verificationStatus: "UNVERIFIED", confidence: 0.3 });
    const all = [verified, unverified];

    expect(retrieveRegulatoryRules(all, [flStat, flGuidance], { jurisdictionId: "fl", verifiedOnly: true })).toHaveLength(1);
    expect(retrieveRegulatoryRules(all, [flStat, flGuidance], { jurisdictionId: "fl", minConfidence: 0.8 })).toHaveLength(1);
  });

  it("applies temporal filtering: a 2024 claim never sees a 2026 rule", () => {
    const t2024 = Date.UTC(2024, 0, 1);
    const t2026 = Date.UTC(2026, 0, 1);
    const old = prop(flStat, "Insurer must respond within 60 days.", {
      verificationStatus: "VERIFIED",
      effectiveFrom: t2024,
    });
    const { previous, next } = versionProposition(old, {
      ruleText: "Insurer must respond within 10 days.",
      effectiveFrom: t2026,
      verificationStatus: "VERIFIED",
    });

    const claim2024 = retrieveRegulatoryRules([previous, next], [flStat], {
      jurisdictionId: "fl",
      asOfDate: Date.UTC(2024, 6, 1),
    });
    expect(claim2024).toHaveLength(1);
    expect(claim2024[0].proposition.deadline).toBe(60);

    const claim2026 = retrieveRegulatoryRules([previous, next], [flStat], {
      jurisdictionId: "fl",
      asOfDate: Date.UTC(2026, 6, 1),
    });
    expect(claim2026).toHaveLength(1);
    expect(claim2026[0].proposition.deadline).toBe(10);
  });

  it("ranks primary over interpretive and verified over unverified", () => {
    const primary = prop(flStat, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const interpretive = prop(flGuidance, "Carriers should respond promptly.", { verificationStatus: "UNVERIFIED" });
    const results = retrieveRegulatoryRules([interpretive, primary], [flStat, flGuidance], {
      jurisdictionId: "fl",
    });
    expect(results[0].proposition.sourceId).toBe("fl-stat");
  });
});

describe("regulatory answer contract", () => {
  it("builds an answer with rules, exceptions, uncertainties, and source trace", () => {
    const flStat = source("fl-stat", "fl", "Fla. Stat. ch. 627");
    const rule = prop(
      flStat,
      "Insurer must respond within 14 days unless the insured fails to provide requested information.",
      { verificationStatus: "VERIFIED" },
    );
    const results = retrieveRegulatoryRules([rule], [flStat], { jurisdictionId: "fl" });
    const answer = buildRegulatoryAnswer({
      jurisdictionId: "fl",
      question: "How long does the carrier have to respond?",
      results,
      allPropositions: [rule],
      contradictions: [],
      asOfDate: Date.UTC(2026, 0, 1),
    });

    expect(answer.rules).toHaveLength(1);
    expect(answer.exceptions.some((e) => e.exception?.includes("unless"))).toBe(true);
    expect(answer.sourceTrace).toHaveLength(1);
    expect(answer.sourceTrace[0].canonicalUrl).toBeDefined();
    expect(answer.caveat).toBeUndefined(); // no contradictions, results present
  });

  it("adds a caveat when nothing is returned — never claims absence", () => {
    const answer = buildRegulatoryAnswer({
      jurisdictionId: "fl",
      results: [],
      allPropositions: [],
      contradictions: [],
      asOfDate: Date.UTC(2026, 0, 1),
    });
    expect(answer.rules).toHaveLength(0);
    expect(answer.uncertainties.some((u) => u.includes("does not mean no rule exists"))).toBe(true);
    expect(answer.caveat).toBeDefined();
  });

  it("surfaces contradictions in the answer", () => {
    const a = source("a", "fl", "Fla. Stat.");
    const b = source("b", "fl", "Fla. Admin. Code");
    const pa = prop(a, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const pb = prop(b, "Insurer must respond within 30 days.", { verificationStatus: "VERIFIED" });
    const contradictions = detectRegulatoryContradictions({ propositions: [pa, pb], sources: [a, b] });

    const answer = buildRegulatoryAnswer({
      jurisdictionId: "fl",
      results: retrieveRegulatoryRules([pa, pb], [a, b], { jurisdictionId: "fl" }),
      allPropositions: [pa, pb],
      contradictions,
      asOfDate: Date.UTC(2026, 0, 1),
    });
    expect(answer.contradictions.length).toBeGreaterThan(0);
    expect(answer.caveat).toBeDefined();
  });

  it("formats the answer in the QUESTION → RULES → EXCEPTIONS → SOURCE TRACE shape", () => {
    const flStat = source("fl-stat", "fl", "Fla. Stat. ch. 627");
    const rule = prop(flStat, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const answer = buildRegulatoryAnswer({
      jurisdictionId: "fl",
      question: "Response deadline?",
      results: retrieveRegulatoryRules([rule], [flStat], { jurisdictionId: "fl" }),
      allPropositions: [rule],
      contradictions: [],
      asOfDate: Date.UTC(2026, 0, 1),
    });
    const formatted = formatRegulatoryAnswer(answer);
    expect(formatted).toContain("QUESTION:");
    expect(formatted).toContain("JURISDICTION: FL");
    expect(formatted).toContain("APPLICABLE RULES");
    expect(formatted).toContain("SOURCE TRACE");
    expect(formatted).toContain("Fla. Stat. ch. 627");
  });
});