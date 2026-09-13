import { describe, expect, it } from "vitest";
import {
  detectRegulatoryContradictions,
  detectModelLawDivergence,
  assessExtractionSupport,
} from "./contradictions";
import { buildRegulatoryProposition } from "./propositions";
import type { RegulatorySource } from "./types";

const now = Date.now();

function statSource(id: string, jurisdictionId: string, title: string): RegulatorySource {
  return {
    sourceId: id,
    jurisdictionId,
    sourceType: "statute",
    authorityTier: 1,
    publisher: "Legislature",
    title,
    status: "VERIFIED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

function secondarySource(id: string, jurisdictionId: string, title: string): RegulatorySource {
  return {
    sourceId: id,
    jurisdictionId,
    sourceType: "secondary_reference",
    authorityTier: 4,
    publisher: "Industry blog",
    title,
    status: "EXTRACTED",
    reliabilityScore: 0.3,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

function prop(source: RegulatorySource, ruleText: string, extra: Partial<Parameters<typeof buildRegulatoryProposition>[0]> = {}) {
  return buildRegulatoryProposition({
    jurisdictionId: source.jurisdictionId!,
    source,
    topic: "response_deadlines",
    ruleText,
    ...extra,
  });
}

describe("contradiction detection", () => {
  it("detects conflicting deadlines from two primary sources", () => {
    const a = statSource("a", "fl", "Fla. Stat. ch. 627");
    const b = statSource("b", "fl", "Fla. Admin. Code");
    const pa = prop(a, "The insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const pb = prop(b, "The insurer must respond within 30 days.", { verificationStatus: "VERIFIED" });

    const hits = detectRegulatoryContradictions({ propositions: [pa, pb], sources: [a, b] });
    const deadline = hits.find((h) => h.kind === "primary_vs_primary");
    expect(deadline).toBeDefined();
    expect(deadline!.severity).toBe("HIGH");
    expect(deadline!.status).toBe("OPEN");
  });

  it("does not flag two versions of the same rule chain", () => {
    const a = statSource("a", "fl", "Fla. Stat. ch. 627");
    const pa = prop(a, "The insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const pb = prop(a, "The insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    // Same source + same rule text → same dedup key → no contradiction.
    const hits = detectRegulatoryContradictions({ propositions: [pa, pb], sources: [a] });
    expect(hits).toHaveLength(0);
  });

  it("flags propositions still attached to a superseded source", () => {
    const old = statSource("old", "fl", "Old rule");
    const p = prop(old, "The insurer must respond within 90 days.", { verificationStatus: "VERIFIED" });
    const superseded = { ...old, status: "SUPERSEDED", supersededBySourceId: "new" } as RegulatorySource;
    const hits = detectRegulatoryContradictions({ propositions: [p], sources: [superseded] });
    expect(hits.some((h) => h.kind === "superseded_source")).toBe(true);
  });

  it("flags secondary sources presented as primary authority", () => {
    const sec = secondarySource("blog", "fl", "Industry summary");
    const p = prop(sec, "The insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    // The proposition itself must not claim primary authority for this to be clean;
    // build with tier forced low to simulate the bug.
    const bad = { ...p, authorityTier: 1 } as typeof p;
    const hits = detectRegulatoryContradictions({ propositions: [bad], sources: [sec] });
    expect(hits.some((h) => h.kind === "secondary_vs_primary")).toBe(true);
    expect(hits.find((h) => h.kind === "secondary_vs_primary")!.severity).toBe("HIGH");
  });
});

describe("model-law divergence", () => {
  it("surfaces state-vs-model-law differences as informational", () => {
    const state = statSource("st", "fl", "Fla. Stat.");
    const model = statSource("model", "us", "NAIC Model Act");
    const ps = prop(state, "Insurer must respond within 14 days.", { verificationStatus: "VERIFIED" });
    const pm = prop(model, "Insurer must respond within 30 days.", { verificationStatus: "VERIFIED" });

    const hits = detectModelLawDivergence([ps], [pm]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("state_vs_model_law");
    expect(hits[0].severity).toBe("LOW");
  });
});

describe("extraction support", () => {
  it("confirms verbatim support", () => {
    const sourceText = "Each insurer shall acknowledge receipt of a claim within 14 days after receiving notice of loss.";
    expect(assessExtractionSupport(sourceText, sourceText).supported).toBe(true);
  });

  it("confirms near-verbatim support with high score", () => {
    const sourceText = "Each insurer shall acknowledge receipt of a claim within 14 days after receiving notice of loss.";
    const rule = "Each insurer shall acknowledge receipt of a claim within 14 days.";
    const { supported, score } = assessExtractionSupport(rule, sourceText);
    expect(supported).toBe(true);
    expect(score).toBeGreaterThan(0.6);
  });

  it("rejects fabricated rule text", () => {
    const sourceText = "Insurers must pay undisputed claims promptly.";
    const fabricated = "The carrier must respond within 3 business hours of any notice.";
    const { supported } = assessExtractionSupport(fabricated, sourceText);
    expect(supported).toBe(false);
  });
});