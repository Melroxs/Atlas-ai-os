import { describe, expect, it } from "vitest";
import {
  scoreFreshness,
  jurisdictionFreshness,
  freshnessIntervalDays,
  FRESHNESS_INTERVALS_DAYS,
} from "./freshness";
import type { RegulatorySource } from "./types";

const NOW = Date.UTC(2026, 8, 6);
const DAY = 86_400_000;

function src(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    sourceId: "s",
    jurisdictionId: "wy", // no freshness multiplier — stable 45-day interval
    sourceType: "regulator_bulletin",
    authorityTier: 1,
    publisher: "FL OIR",
    title: "Bulletin",
    status: "VERIFIED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: NOW - 365 * DAY,
    updatedAt: NOW - 365 * DAY,
    lastVerifiedAt: NOW,
    ...overrides,
  };
}

describe("freshness scoring", () => {
  it("returns UNKNOWN when never verified — never CURRENT", () => {
    const s = src({ lastVerifiedAt: undefined, retrievedAt: undefined });
    const score = scoreFreshness(s, NOW);
    expect(score.level).toBe("UNKNOWN");
    expect(score.ageDays).toBeNull();
  });

  it("classifies by source-class interval (bulletins verify every 45 days)", () => {
    expect(FRESHNESS_INTERVALS_DAYS.regulator_bulletin).toBe(45);

    const fresh = scoreFreshness(src({ lastVerifiedAt: NOW - 10 * DAY }), NOW);
    expect(fresh.level).toBe("CURRENT");

    const aging = scoreFreshness(src({ lastVerifiedAt: NOW - 60 * DAY }), NOW);
    expect(aging.level).toBe("AGING");

    const stale = scoreFreshness(src({ lastVerifiedAt: NOW - 120 * DAY }), NOW);
    expect(stale.level).toBe("STALE");
  });

  it("critical sources get shorter intervals than secondary ones", () => {
    const bulletin = src({ sourceType: "regulator_bulletin" });
    const secondary = src({ sourceType: "secondary_reference" });
    expect(freshnessIntervalDays(bulletin)).toBeLessThan(freshnessIntervalDays(secondary));
  });

  it("high-activity jurisdictions get tighter intervals", () => {
    const fl = src({ jurisdictionId: "fl" });
    const wy = src({ jurisdictionId: "wy" });
    expect(freshnessIntervalDays(fl)).toBeLessThan(freshnessIntervalDays(wy));
  });

  it("reports next check date", () => {
    const lastVerified = NOW - 10 * DAY;
    const score = scoreFreshness(src({ lastVerifiedAt: lastVerified }), NOW);
    expect(score.nextCheckAt).toBe(lastVerified + 45 * DAY);
  });
});

describe("jurisdiction freshness rollup", () => {
  it("is the worst of its sources", () => {
    const current = scoreFreshness(src({ lastVerifiedAt: NOW }), NOW);
    const stale = scoreFreshness(src({ lastVerifiedAt: NOW - 400 * DAY }), NOW);
    expect(jurisdictionFreshness([current, stale])).toBe("STALE");
  });

  it("returns UNKNOWN for no sources", () => {
    expect(jurisdictionFreshness([])).toBe("UNKNOWN");
  });
});