// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Freshness Scoring
//
// Freshness depends on source class and jurisdiction, not one universal
// number. Critical regulatory sources (statutes, regulations, bulletins)
// get shorter re-verification intervals; secondary sources get longer ones.
// A source with no lastVerifiedAt is UNKNOWN, never CURRENT.
// ---------------------------------------------------------------------------

import type { FreshnessLevel, FreshnessScore, RegulatorySource, SourceType } from "./types";

/** Re-verification interval (days) by source class. */
export const FRESHNESS_INTERVALS_DAYS: Record<SourceType, number> = {
  statute: 180,
  regulation: 90,
  administrative_code: 180,
  regulator_bulletin: 45,
  regulator_order: 45,
  regulator_guidance: 120,
  court_decision: 180,
  federal_statute: 180,
  federal_regulation: 90,
  model_law: 365,
  industry_standard: 365,
  government_manual: 365,
  secondary_reference: 730,
  consumer_guidance: 365,
};

/** Freshness level thresholds as fractions of the interval. */
export const FRESHNESS_THRESHOLDS = {
  CURRENT: 0.5, // up to 50% of interval → CURRENT
  RECENT: 1.0, // up to 100% → RECENT
  AGING: 1.5, // up to 150% → AGING
  // beyond → STALE
} as const;

/** Jurisdiction multipliers: high-activity states get tighter intervals. */
const JURISDICTION_MULTIPLIER: Record<string, number> = {
  fl: 0.8,
  tx: 0.8,
  ca: 0.8,
  ny: 0.8,
  la: 0.8,
  // All other states: 1.0 (default).
};

export function freshnessIntervalDays(source: RegulatorySource): number {
  const base = FRESHNESS_INTERVALS_DAYS[source.sourceType] ?? 365;
  const mult = source.jurisdictionId ? (JURISDICTION_MULTIPLIER[source.jurisdictionId] ?? 1) : 1;
  return Math.round(base * mult);
}

/**
 * Score a source's freshness. `now` defaults to Date.now() but is injectable
 * for deterministic tests.
 */
export function scoreFreshness(
  source: RegulatorySource,
  now: number = Date.now(),
): FreshnessScore {
  const intervalDays = freshnessIntervalDays(source);
  const lastVerifiedAt = source.lastVerifiedAt ?? source.retrievedAt;

  if (lastVerifiedAt === undefined) {
    return {
      sourceId: source.sourceId,
      level: "UNKNOWN",
      ageDays: null,
      intervalDays,
      nextCheckAt: null,
    };
  }

  const ageDays = Math.max(0, (now - lastVerifiedAt) / 86_400_000);
  let level: FreshnessLevel;
  if (ageDays <= intervalDays * FRESHNESS_THRESHOLDS.CURRENT) level = "CURRENT";
  else if (ageDays <= intervalDays * FRESHNESS_THRESHOLDS.RECENT) level = "RECENT";
  else if (ageDays <= intervalDays * FRESHNESS_THRESHOLDS.AGING) level = "AGING";
  else level = "STALE";

  return {
    sourceId: source.sourceId,
    level,
    ageDays: Math.round(ageDays * 10) / 10,
    intervalDays,
    nextCheckAt: lastVerifiedAt + intervalDays * 86_400_000,
  };
}

/**
 * Roll up per-source freshness into a jurisdiction-level signal.
 * Jurisdiction freshness is the WORST of its sources (a jurisdiction with
 * one stale primary source is not "current").
 */
export function jurisdictionFreshness(
  scores: FreshnessScore[],
): FreshnessLevel {
  if (scores.length === 0) return "UNKNOWN";
  const rank: Record<FreshnessLevel, number> = {
    CURRENT: 0,
    RECENT: 1,
    AGING: 2,
    STALE: 3,
    UNKNOWN: 4,
  };
  const worst = scores.reduce(
    (w, s) => (rank[s.level] > rank[w] ? s.level : w),
    "CURRENT" as FreshnessLevel,
  );
  return worst;
}