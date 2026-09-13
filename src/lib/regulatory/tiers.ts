// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Authority Tier Helpers
//
// Tier 1: controlling/primary authority (statutes, codes, official regulator
//         publications, controlling decisions, applicable federal law)
// Tier 2: official interpretive material (guidance, FAQs, bulletins, consumer
//         guidance, enforcement materials)
// Tier 3: authoritative industry/standards (NAIC models, IICRC, NFIP/FEMA
//         materials) — NEVER automatically state law
// Tier 4: secondary research (discovery/corroboration only)
// ---------------------------------------------------------------------------

import type { AuthorityTier, SourceType } from "./types";
import { SOURCE_TYPE_TIERS } from "./types";

export const TIER_RANK: Record<AuthorityTier, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };

/** Compare two tiers: > 0 means a outranks b. */
export function compareTiers(a: AuthorityTier, b: AuthorityTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

/** Effective tier for a source type (never below the type's class). */
export function tierForSourceType(sourceType: SourceType): AuthorityTier {
  return SOURCE_TYPE_TIERS[sourceType] ?? 4;
}

/** Whether a tier is primary/controlling. */
export function isPrimaryTier(tier: AuthorityTier): boolean {
  return tier === 1;
}

/** Whether a tier can ever control a decision. */
export function isControllingTier(tier: AuthorityTier): boolean {
  return tier <= 2;
}

/** Whether a tier is discovery-only. */
export function isDiscoveryOnly(tier: AuthorityTier): boolean {
  return tier >= 4;
}

/**
 * Authority-ranking rule used by retrieval: prefer higher tiers, and when two
 * propositions conflict, the higher tier wins ranking (the lower tier is still
 * preserved and surfaced via the contradiction record — never deleted).
 */
export function rankByAuthority(
  aTier: AuthorityTier,
  aVerified: boolean,
  bTier: AuthorityTier,
  bVerified: boolean,
): number {
  const aScore = TIER_RANK[aTier] * 2 + (aVerified ? 1 : 0);
  const bScore = TIER_RANK[bTier] * 2 + (bVerified ? 1 : 0);
  return aScore - bScore;
}