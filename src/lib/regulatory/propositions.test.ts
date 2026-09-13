import { describe, expect, it } from "vitest";
import {
  buildRegulatoryProposition,
  buildDedupKey,
  versionProposition,
  resolveVersionsForDate,
  groupVersionChains,
  currentVersions,
  simpleHash,
} from "./propositions";
import type { RegulatoryProposition, RegulatorySource } from "./types";

function makeSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  const now = Date.now();
  return {
    sourceId: "src-fl-ins-code",
    jurisdictionId: "fl",
    sourceType: "statute",
    authorityTier: 1,
    publisher: "Florida Legislature",
    title: "Florida Statutes — Insurance",
    canonicalUrl: "https://www.leg.state.fl.us/statutes/",
    status: "VERIFIED",
    reliabilityScore: 0.95,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("proposition construction", () => {
  it("builds a proposition with deterministic fields", () => {
    const source = makeSource();
    const p = buildRegulatoryProposition({
      jurisdictionId: "fl",
      source,
      topic: "acknowledgment",
      ruleText:
        "Each insurer must acknowledge receipt of a claim within 14 days after receiving the notice of loss (Fla. Stat. § 627.426).",
      verificationStatus: "UNVERIFIED",
    });
    expect(p.jurisdictionId).toBe("fl");
    expect(p.sourceId).toBe("src-fl-ins-code");
    expect(p.topic).toBe("acknowledgment");
    expect(p.deadline).toBe(14);
    expect(p.deadlineUnit).toBe("calendar_days");
    expect(p.actor).toBe("insurer");
    expect(p.requirement).toBeDefined();
    expect(p.citation).toBeDefined();
    expect(p.version).toBe(1);
    expect(p.verificationStatus).toBe("UNVERIFIED");
    expect(p.propositionId).toMatch(/^prop_/);
  });

  it("dedup keys are deterministic and sensitive to rule text", () => {
    const a = buildDedupKey({ jurisdictionId: "fl", topic: "payment", actor: "insurer", ruleText: "Pay within 30 days." });
    const b = buildDedupKey({ jurisdictionId: "fl", topic: "payment", actor: "insurer", ruleText: "Pay within 30 days." });
    const c = buildDedupKey({ jurisdictionId: "fl", topic: "payment", actor: "insurer", ruleText: "Pay within 60 days." });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("simpleHash is stable and short", () => {
    expect(simpleHash("fl|payment|insurer|pay within 30 days")).toHaveLength(8);
    expect(simpleHash("x")).toBe(simpleHash("x"));
    expect(simpleHash("x")).not.toBe(simpleHash("y"));
  });
});

describe("temporal versioning", () => {
  const t2024 = Date.UTC(2024, 0, 1);
  const t2025 = Date.UTC(2025, 6, 1);
  const t2026 = Date.UTC(2026, 6, 1);

  function propV1(): RegulatoryProposition {
    return buildRegulatoryProposition({
      jurisdictionId: "fl",
      source: makeSource({ effectiveDate: t2024 }),
      topic: "response_deadlines",
      ruleText: "The insurer must respond within 60 days.",
      effectiveFrom: t2024,
      verificationStatus: "VERIFIED",
    });
  }

  it("creates a version chain without mutating the original", () => {
    const v1 = propV1();
    const { previous, next } = versionProposition(v1, {
      ruleText: "The insurer must respond within 30 days.",
      effectiveFrom: t2025,
      verificationStatus: "VERIFIED",
    });

    expect(next.version).toBe(2);
    expect(next.previousVersionId).toBe(v1.propositionId);
    expect(next.dedupKey).toBe(v1.dedupKey);
    expect(next.effectiveFrom).toBe(t2025);
    expect(previous.effectiveTo).toBe(t2025 - 1);
    // The original object is untouched (immutability of history).
    expect(v1.effectiveTo).toBeUndefined();
    // Distinct ids even when rule text is unchanged.
    expect(next.propositionId).not.toBe(v1.propositionId);
  });

  it("resolves the applicable version for a claim date", () => {
    const v1 = propV1();
    const { previous, next } = versionProposition(v1, {
      ruleText: "The insurer must respond within 30 days.",
      effectiveFrom: t2025,
      verificationStatus: "VERIFIED",
    });
    const all = [previous, next];

    // A 2024 claim sees the 60-day rule.
    const for2024 = resolveVersionsForDate(all, t2024);
    expect(for2024).toHaveLength(1);
    expect(for2024[0].deadline).toBe(60);

    // A mid-2025 claim sees the 30-day rule.
    const for2025 = resolveVersionsForDate(all, t2025);
    expect(for2025).toHaveLength(1);
    expect(for2025[0].deadline).toBe(30);

    // A claim before the rule existed sees nothing — never anachronistic law.
    const before = resolveVersionsForDate(all, Date.UTC(2023, 0, 1));
    expect(before).toHaveLength(0);
  });

  it("never applies a 2026 rule to a 2024 claim", () => {
    const v1 = propV1();
    const { next } = versionProposition(v1, {
      ruleText: "The insurer must respond within 10 days.",
      effectiveFrom: t2026,
      verificationStatus: "VERIFIED",
    });
    const resolved = resolveVersionsForDate([v1, next], Date.UTC(2024, 6, 1));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].deadline).toBe(60);
  });

  it("groups version chains and returns current versions", () => {
    const v1 = propV1();
    const { previous, next } = versionProposition(v1, {
      ruleText: "The insurer must respond within 30 days.",
      effectiveFrom: t2025,
      verificationStatus: "VERIFIED",
    });
    const chains = groupVersionChains([previous, next]);
    expect(chains).toHaveLength(1);
    expect(chains[0].versions).toHaveLength(2);
    expect(chains[0].versions[0].version).toBe(1);
    expect(chains[0].versions[1].version).toBe(2);

    const current = currentVersions([previous, next]);
    expect(current).toHaveLength(1);
    expect(current[0].version).toBe(2);
  });
});