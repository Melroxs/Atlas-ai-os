import type { AcquiredSource, Contradiction, RegulatoryProposition, SourceCandidate, VerificationResult, VerificationState } from "./types";

const PRIMARY_TIERS = new Set<RegulatoryProposition["authorityTier"]>([
  "current_enacted_statute",
  "current_administrative_regulation",
  "official_regulator_material",
  "controlling_court_authority",
  "recognized_official_guidance",
]);

const TIER_RANK: Record<RegulatoryProposition["authorityTier"], number> = {
  current_enacted_statute: 1,
  current_administrative_regulation: 2,
  official_regulator_material: 3,
  controlling_court_authority: 4,
  recognized_official_guidance: 5,
  model_law_or_standard: 6,
  secondary_reference: 7,
};

export function authorityRank(tier: RegulatoryProposition["authorityTier"]): number {
  return TIER_RANK[tier];
}

export function canBeVerified(proposition: RegulatoryProposition, source?: SourceCandidate): boolean {
  return Boolean(
    source &&
      source.jurisdictionCode === proposition.jurisdictionCode &&
      source.relationship !== "DISCOVERY_SOURCE" &&
      PRIMARY_TIERS.has(proposition.authorityTier) &&
      proposition.sourceId &&
      proposition.citation.citation &&
      proposition.evidenceText &&
      proposition.evidenceText.trim().length > 0,
  );
}

export function verifyProposition(
  proposition: RegulatoryProposition,
  source: AcquiredSource | undefined,
  now = new Date().toISOString(),
  contradictions: Contradiction[] = [],
): VerificationResult {
  const reasons: string[] = [];
  if (!source) reasons.push("authoritative source is not available");
  if (source && source.jurisdictionCode !== proposition.jurisdictionCode) reasons.push("source jurisdiction does not match proposition jurisdiction");
  if (source?.relationship === "DISCOVERY_SOURCE" || proposition.authorityTier === "secondary_reference") reasons.push("secondary source is discovery-only and cannot verify law");
  if (!proposition.citation.citation) reasons.push("citation could not be resolved");
  if (!proposition.evidenceText?.trim()) reasons.push("supporting source text is missing");
  if (!proposition.effectiveFrom && !proposition.enactedAt) reasons.push("effective or enacted date is unresolved");
  const criticalContradictions = contradictions.filter((item) => item.resolutionStatus !== "RESOLVED_PRIMARY_PREVAILS");
  if (criticalContradictions.length > 0) reasons.push("critical contradiction remains unresolved");
  if (reasons.length === 0 && canBeVerified(proposition, source)) {
    return { state: "VERIFIED", reasons: [], checkedAt: now, authoritativeSourceId: source?.id };
  }
  const missingSource = !source || source.status !== "FETCHED";
  const state: VerificationState = criticalContradictions.length > 0
    ? "CONTRADICTED"
    : missingSource
      ? "INSUFFICIENT_EVIDENCE"
      : proposition.requiresHumanReview
        ? "NEEDS_HUMAN_REVIEW"
        : proposition.citation.citation
          ? "PARTIALLY_VERIFIED"
          : "UNVERIFIED";
  return { state, reasons, checkedAt: now, authoritativeSourceId: source?.id, contradictionIds: criticalContradictions.map((item) => item.id).filter((id): id is string => Boolean(id)) };
}

export function detectContradiction(
  left: RegulatoryProposition,
  right: RegulatoryProposition,
): Contradiction | undefined {
  if (left.jurisdictionCode !== right.jurisdictionCode || left.topic !== right.topic) return undefined;
  const leftTime = left.normalizedValue?.amount;
  const rightTime = right.normalizedValue?.amount;
  const leftUnit = left.normalizedValue?.unit;
  const rightUnit = right.normalizedValue?.unit;
  const deadlineConflict = typeof leftTime === "number" && typeof rightTime === "number" && (leftTime !== rightTime || leftUnit !== rightUnit);
  const textConflict = left.statement.trim().toLowerCase() !== right.statement.trim().toLowerCase();
  if (!deadlineConflict && !textConflict) return undefined;
  const leftRank = authorityRank(left.authorityTier);
  const rightRank = authorityRank(right.authorityTier);
  const resolved = leftRank !== rightRank ? "RESOLVED_PRIMARY_PREVAILS" : "NEEDS_HUMAN_REVIEW";
  return {
    jurisdictionCode: left.jurisdictionCode,
    sourceAId: left.sourceId,
    sourceBId: right.sourceId,
    propositionAId: left.id,
    propositionBId: right.id,
    authorityTierA: left.authorityTier,
    authorityTierB: right.authorityTier,
    conflictType: deadlineConflict ? "DEADLINE" : left.effectiveFrom !== right.effectiveFrom ? "VERSION" : "SCOPE",
    description: `Conflicting propositions for ${left.topic}: ${left.statement} / ${right.statement}`,
    resolutionStatus: resolved,
  };
}

export function applyVerification(
  proposition: RegulatoryProposition,
  result: VerificationResult,
): RegulatoryProposition {
  return {
    ...proposition,
    verificationState: result.state,
    verifiedAt: result.checkedAt,
    requiresHumanReview: result.state === "NEEDS_HUMAN_REVIEW" || result.state === "CONTRADICTED",
  };
}
