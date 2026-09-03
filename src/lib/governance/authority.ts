// ---------------------------------------------------------------------------
// Atlas Governance Engine — Authority Hierarchy & Temporal Intelligence
//
// Resolves which knowledge objects apply based on:
//   1. Authority level (law > regulation > standard > policy > practice)
//   2. Jurisdiction match
//   3. Temporal validity (effective/expired dates)
//   4. Supersession chains
//
// NEVER allows the LLM to decide authority merely by wording.
// Authority is determined by structured metadata only.
// ---------------------------------------------------------------------------

import type {
  AuthorityLevel,
  AuthorityBasis,
  KnowledgeObject,
  TemporalContext,
  TemporalRule,
  KnowledgeGap,
} from "./types";
import { AUTHORITY_RANK } from "./types";

// ---------------------------------------------------------------------------
// Authority Resolution
// ---------------------------------------------------------------------------

/**
 * Compare two authority levels. Returns negative if a is more authoritative,
 * positive if b is more authoritative, 0 if equal.
 */
export function compareAuthority(a: AuthorityLevel, b: AuthorityLevel): number {
  return AUTHORITY_RANK[a] - AUTHORITY_RANK[b];
}

/**
 * Given a set of knowledge objects, sort by authority (most authoritative first).
 */
export function sortByAuthority(items: KnowledgeObject[]): KnowledgeObject[] {
  return [...items].sort(
    (a, b) => AUTHORITY_RANK[a.authorityLevel] - AUTHORITY_RANK[b.authorityLevel],
  );
}

/**
 * Filter knowledge objects to only those that are currently effective
 * at the given date.
 */
export function filterEffectiveAt(
  items: KnowledgeObject[],
  date: number,
): KnowledgeObject[] {
  return items.filter((item) => {
    if (item.effectiveFrom > date) return false;
    if (item.effectiveTo && item.effectiveTo < date) return false;
    return true;
  });
}

/**
 * Filter out superseded/retired knowledge objects.
 */
export function filterActive(items: KnowledgeObject[]): KnowledgeObject[] {
  return items.filter(
    (item) =>
      item.verificationStatus !== "superseded" &&
      item.verificationStatus !== "retired" &&
      item.verificationStatus !== "stale",
  );
}

/**
 * Resolve the applicable knowledge objects for a given context.
 * Applies authority sorting, temporal filtering, and jurisdiction matching.
 */
export function resolveApplicableKnowledge(
  items: KnowledgeObject[],
  context: {
    jurisdiction?: string;
    temporalContext: TemporalContext;
    domain?: string;
  },
): {
  applicable: KnowledgeObject[];
  gaps: KnowledgeGap[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const gaps: KnowledgeGap[] = [];

  // Step 1: Filter by temporal validity at EVALUATION time (current date).
  // Rules in effect now govern Atlas's analysis of this claim; loss-date
  // specific deadlines (statute of limitations, policy periods, proof-of-loss
  // windows) are evaluated separately via isWithinStatuteOfLimitations and
  // the deadline tracker — never by filtering knowledge out of scope.
  const referenceDate = context.temporalContext.currentDate;
  let filtered = filterEffectiveAt(items, referenceDate);

  // Step 2: Filter out superseded/retired
  filtered = filterActive(filtered);

  // Step 3: Filter by jurisdiction if provided
  if (context.jurisdiction) {
    const jurisdictionFiltered = filtered.filter(
      (item) =>
        item.jurisdiction === context.jurisdiction ||
        item.jurisdiction === "United States" ||
        item.jurisdictionType === "federal",
    );

    if (jurisdictionFiltered.length === 0 && filtered.length > 0) {
      gaps.push({
        id: `gap-jurisdiction-${context.jurisdiction}-${Date.now()}`,
        description: `No applicable knowledge found for jurisdiction: ${context.jurisdiction}`,
        impact: "Atlas cannot determine jurisdiction-specific rules for this action.",
        canContinueSafely: true,
        requiresHumanReview: true,
        triggeredBy: "jurisdiction_resolution",
        severity: "medium",
      });
    }

    filtered = jurisdictionFiltered;
  }

  // Step 4: Sort by authority
  const applicable = sortByAuthority(filtered);

  // Step 5: Check for verification gaps
  const unverified = applicable.filter(
    (item) => item.verificationStatus === "unverified",
  );
  if (unverified.length > 0) {
    warnings.push(
      `${unverified.length} knowledge items are unverified and should not be treated as authoritative.`,
    );
  }

  // Step 6: Check for knowledge gaps (no items found at all)
  if (applicable.length === 0) {
    gaps.push({
      id: `gap-no-knowledge-${Date.now()}`,
      description: "No applicable authoritative knowledge found for this context.",
      impact: "Atlas cannot evaluate compliance or provide evidence-backed guidance.",
      canContinueSafely: false,
      requiresHumanReview: true,
      triggeredBy: "knowledge_resolution",
      severity: "critical",
    });
  }

  return { applicable, gaps, warnings };
}

// ---------------------------------------------------------------------------
// Temporal Intelligence
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a temporal rule is active for a given reference date.
 */
export function isRuleActive(rule: TemporalRule, referenceDate: number): boolean {
  if (rule.effectiveFrom > referenceDate) return false;
  if (rule.effectiveTo && rule.effectiveTo < referenceDate) return false;
  if (rule.supersededBy) return false; // superseded rules are inactive
  return true;
}

/**
 * Select the correct version of a rule based on the reference date.
 * Uses supersession chains to find the version that was in effect.
 */
export function selectRuleVersion(
  rules: TemporalRule[],
  referenceDate: number,
): TemporalRule | null {
  // Filter to active rules at the reference date
  const active = rules.filter((r) => isRuleActive(r, referenceDate));

  if (active.length === 0) return null;

  // Sort by effective date descending (most recent first)
  active.sort((a, b) => b.effectiveFrom - a.effectiveFrom);

  // Return the most recent one that was effective
  return active[0];
}

/**
 * Build temporal context from claim/property data.
 */
export function buildTemporalContext(opts: {
  lossDate?: string | number;
  policyPeriodStart?: string | number;
  policyPeriodEnd?: string | number;
  communicationDate?: string | number;
  submissionDate?: string | number;
  statuteOfLimitations?: number;
}): TemporalContext {
  const toDate = (v?: string | number): number | undefined =>
    typeof v === "string" ? new Date(v).getTime() : v;

  return {
    lossDate: toDate(opts.lossDate),
    policyPeriodStart: toDate(opts.policyPeriodStart),
    policyPeriodEnd: toDate(opts.policyPeriodEnd),
    communicationDate: toDate(opts.communicationDate),
    submissionDate: toDate(opts.submissionDate),
    currentDate: Date.now(),
    statuteOfLimitations: opts.statuteOfLimitations,
  };
}

/**
 * Check if a claim is within the statute of limitations.
 */
export function isWithinStatuteOfLimitations(
  temporal: TemporalContext,
): { withinLimit: boolean; daysRemaining?: number; expired: boolean } {
  if (!temporal.statuteOfLimitations || !temporal.lossDate) {
    return { withinLimit: true, expired: false };
  }

  const limitDeadline = temporal.lossDate + temporal.statuteOfLimitations;
  const now = temporal.currentDate;
  const daysRemaining = Math.ceil((limitDeadline - now) / (1000 * 60 * 60 * 24));

  return {
    withinLimit: daysRemaining > 0,
    daysRemaining: Math.max(0, daysRemaining),
    expired: daysRemaining <= 0,
  };
}
