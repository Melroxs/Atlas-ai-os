// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Verification State Machine
//
// A proposition is NEVER verified merely because a model believes it. The
// verification path is: source exists → URL resolves → authority matches →
// citation exists → extracted text supports the proposition → jurisdiction
// matches → effective dates considered → supersession considered →
// contradictions checked. Every transition below is enforced; the critical
// invariants are:
//
//   - secondary sources (tier 4) can NEVER reach VERIFIED / VERIFIED_PRIMARY
//   - UNVERIFIED / INSUFFICIENT_EVIDENCE can never auto-promote
//   - "not found" is represented as INSUFFICIENT_EVIDENCE, never "does not exist"
//   - BLOCK-style uncertainty (no authoritative source) must surface, not fold
// ---------------------------------------------------------------------------

import type {
  AuthorityTier,
  RegulatorySource,
  VerificationStatus,
} from "./types";
import { SOURCE_TYPE_TIERS } from "./types";

// ---------------------------------------------------------------------------
// Status metadata
// ---------------------------------------------------------------------------

export const VERIFICATION_STATUS_ORDER: VerificationStatus[] = [
  "DISCOVERED",
  "FETCHED",
  "EXTRACTED",
  "UNVERIFIED",
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "CONTRADICTED",
  "SUPERSEDED",
  "STALE",
  "FAILED",
  "NEEDS_HUMAN_REVIEW",
  "INSUFFICIENT_EVIDENCE",
];

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  DISCOVERED: "Discovered",
  FETCHED: "Fetched",
  EXTRACTED: "Extracted",
  UNVERIFIED: "Unverified",
  VERIFIED: "Verified",
  PARTIALLY_VERIFIED: "Partially Verified",
  CONTRADICTED: "Contradicted",
  SUPERSEDED: "Superseded",
  STALE: "Stale",
  FAILED: "Failed",
  NEEDS_HUMAN_REVIEW: "Needs Human Review",
  INSUFFICIENT_EVIDENCE: "Insufficient Evidence",
};

/** Human label for the two distinct knowledge states around absence. */
export const SUPPLEMENT_STATE_LABELS = {
  explicitly_regulated: "Explicitly regulated",
  indirectly_regulated: "Indirectly regulated",
  no_identified_specific_provision: "No identified specific provision",
  insufficient_evidence: "Insufficient evidence",
  research_incomplete: "Research incomplete",
} as const;

// ---------------------------------------------------------------------------
// Verification evidence
// ---------------------------------------------------------------------------

export interface VerificationChecklist {
  /** Source object exists in the registry. */
  sourceExists: boolean;
  /** The canonical URL resolves (reachable). */
  urlResolves: boolean;
  /** The source belongs to the expected authority (publisher/domain check). */
  authorityMatches: boolean;
  /** The cited statute/regulation identifier exists in the source text. */
  citationExists: boolean;
  /** The extracted rule text appears in (or is directly supported by) the source text. */
  textSupported: boolean;
  /** Jurisdiction matches the proposition's jurisdiction. */
  jurisdictionMatches: boolean;
  /** Effective dates considered (rule was in force at the reference date). */
  effectiveDateConsidered: boolean;
  /** No newer superseding source is known. */
  notSuperseded: boolean;
  /** No open contradiction records reference this proposition/source. */
  noContradictions: boolean;
}

export type VerificationDecision =
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "UNVERIFIED"
  | "NEEDS_HUMAN_REVIEW"
  | "CONTRADICTED"
  | "FAILED";

/**
 * Evaluate a verification checklist against the rules. Tier-4 sources are
 * structurally capped: they can reach at most UNVERIFIED-with-review.
 */
export function decideVerification(
  source: RegulatorySource,
  checklist: VerificationChecklist,
): VerificationDecision {
  // Secondary research can never be verified as controlling authority.
  if (source.authorityTier === 4 || SOURCE_TYPE_TIERS[source.sourceType] === 4) {
    return checklist.noContradictions ? "UNVERIFIED" : "CONTRADICTED";
  }

  // Any open contradiction blocks verification.
  if (!checklist.noContradictions) return "CONTRADICTED";

  // Hard failures.
  if (!checklist.sourceExists || !checklist.urlResolves) return "FAILED";
  if (!checklist.authorityMatches || !checklist.jurisdictionMatches) return "FAILED";

  // Full verification requires every substantive check.
  const substantive = [
    checklist.citationExists,
    checklist.textSupported,
    checklist.effectiveDateConsidered,
    checklist.notSuperseded,
  ];
  if (substantive.every(Boolean)) return "VERIFIED";

  // Content AND citation confirmed against the source, but temporal or
  // supersession checks are incomplete — partial, never full.
  if (checklist.citationExists && checklist.textSupported) return "PARTIALLY_VERIFIED";

  // Neither the text nor the citation is confirmed — human review required.
  if (!checklist.textSupported && !checklist.citationExists) {
    return "NEEDS_HUMAN_REVIEW";
  }

  // The proposition cannot be anchored to a verified citation — stays
  // UNVERIFIED (never auto-promoted).
  return "UNVERIFIED";
}

// ---------------------------------------------------------------------------
// Anti-hallucination guards
// ---------------------------------------------------------------------------

/**
 * A proposition whose source is tier 4 can never be presented as primary.
 * Returns the effective status to store.
 */
export function capVerificationForSource(
  status: VerificationStatus,
  source: RegulatorySource,
): VerificationStatus {
  const tier = Math.max(source.authorityTier, SOURCE_TYPE_TIERS[source.sourceType] ?? source.authorityTier);
  // Secondary research: can never even be partially verified — discovery only.
  if (tier === 4) {
    if (status === "VERIFIED" || status === "PARTIALLY_VERIFIED") return "UNVERIFIED";
  }
  // Industry/standards: verifiable as to their own content, never as law.
  if (tier === 3) {
    if (status === "VERIFIED") return "PARTIALLY_VERIFIED";
  }
  return status;
}

/** A secondary source is usable for discovery but never as a citation basis. */
export function canCiteAsPrimary(source: RegulatorySource): boolean {
  return SOURCE_TYPE_TIERS[source.sourceType] <= 1;
}

// ---------------------------------------------------------------------------
// Absence semantics
// ---------------------------------------------------------------------------

/**
 * "No authoritative source found for this topic in this jurisdiction" is
 * represented as INSUFFICIENT_EVIDENCE (or research_incomplete at the topic
 * level) — never as "the rule does not exist". This function produces the
 * honest status for a topic-level gap.
 */
export function statusForAbsence(researchComplete: boolean): VerificationStatus {
  return researchComplete ? "INSUFFICIENT_EVIDENCE" : "UNVERIFIED";
}