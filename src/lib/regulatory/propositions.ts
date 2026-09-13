// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Propositions & Versioning
//
// A proposition is the normalized, source-attached unit of regulatory
// knowledge. Regulations change: old propositions are NEVER overwritten —
// a new version is created with its own effective window, and claim-date
// resolution picks the version that was in force on the claim's date.
// ---------------------------------------------------------------------------

import type {
  RegulatoryProposition,
  RegulatorySource,
  VerificationStatus,
  AuthorityTier,
} from "./types";
import {
  normalizeRuleText,
  extractActor,
  detectClaimPhases,
  extractDeadline,
  extractException,
  isRequirement,
  isProhibition,
  extractCitations,
} from "./extraction";

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/**
 * Deterministic dedup key for a proposition: jurisdiction | topic | actor |
 * normalized rule hash. Re-extraction of the same rule maps to the same key,
 * so acquisition can supersede instead of duplicating.
 */
export function buildDedupKey(input: {
  jurisdictionId: string;
  topic: string;
  actor?: string;
  ruleText: string;
}): string {
  const norm = normalizeRuleText(input.ruleText).replace(/[^a-z0-9]+/g, " ").trim();
  const hash = simpleHash(`${input.jurisdictionId}|${input.topic}|${input.actor ?? ""}|${norm}`);
  return `${input.jurisdictionId}|${input.topic}|${input.actor ?? "*"}|${hash}`;
}

/** FNV-1a 32-bit hex hash — deterministic, no deps. */
export function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface BuildPropositionInput {
  jurisdictionId: string;
  source: RegulatorySource;
  topic: string;
  subtopic?: string;
  ruleText: string;
  effectiveFrom?: number;
  effectiveTo?: number;
  citation?: string;
  confidence?: number;
  verificationStatus?: VerificationStatus;
  supplementState?: RegulatoryProposition["supplementState"];
  peril?: string;
  insuranceType?: string;
  trigger?: string;
}

/**
 * Build a proposition from source text. Extraction is deterministic;
 * anything not extractable stays undefined — never guessed.
 */
export function buildRegulatoryProposition(input: BuildPropositionInput): RegulatoryProposition {
  const { source, topic, ruleText } = input;
  const actor = extractActor(ruleText);
  const phases = detectClaimPhases(ruleText);
  const deadline = extractDeadline(ruleText);
  const now = Date.now();

  const citation =
    input.citation ??
    source.citation ??
    extractCitations(ruleText)[0] ??
    source.sourceIdentifier;

  return {
    propositionId: `prop_${simpleHash(`${source.sourceId}|${topic}|${normalizeRuleText(ruleText)}`)}`,
    jurisdictionId: input.jurisdictionId,
    sourceId: source.sourceId,
    lineageKey: `${input.jurisdictionId}|${source.sourceId}|${topic}`,
    topic,
    subtopic: input.subtopic,
    ruleText: ruleText.trim(),
    normalizedRule: normalizeRuleText(ruleText),
    actor: actor ?? "insurer",
    claimPhase: phases[0] ?? "carrier_review",
    peril: input.peril,
    insuranceType: input.insuranceType,
    trigger: input.trigger,
    requirement: isRequirement(ruleText) ? ruleText.trim() : undefined,
    prohibition: isProhibition(ruleText) ? ruleText.trim() : undefined,
    exception: extractException(ruleText),
    deadline: deadline?.amount,
    deadlineUnit: deadline?.unit ?? "none",
    effectiveFrom: input.effectiveFrom ?? source.effectiveDate,
    effectiveTo: input.effectiveTo,
    citation,
    authorityTier: source.authorityTier,
    confidence: input.confidence ?? defaultConfidenceFor(source.authorityTier, input.verificationStatus),
    verificationStatus: input.verificationStatus ?? "UNVERIFIED",
    supplementState: input.supplementState,
    dedupKey: buildDedupKey({
      jurisdictionId: input.jurisdictionId,
      topic,
      actor,
      ruleText,
    }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Confidence defaults: primary sources start higher, secondary lower. */
export function defaultConfidenceFor(
  tier: AuthorityTier,
  verificationStatus?: VerificationStatus,
): number {
  const base = tier === 1 ? 0.6 : tier === 2 ? 0.5 : tier === 3 ? 0.4 : 0.25;
  if (verificationStatus === "VERIFIED") return Math.min(0.95, base + 0.3);
  if (verificationStatus === "PARTIALLY_VERIFIED") return Math.min(0.8, base + 0.15);
  return base;
}

// ---------------------------------------------------------------------------
// Temporal versioning
// ---------------------------------------------------------------------------

/**
 * Create a new version of a proposition. The previous version is untouched;
 * its effective window is closed at `effectiveFrom - 1ms`, and the new
 * version opens at `effectiveFrom`. Never overwrite history.
 */
export function versionProposition(
  previous: RegulatoryProposition,
  input: Omit<BuildPropositionInput, "jurisdictionId" | "source" | "topic" | "ruleText"> & {
    ruleText: string;
    effectiveFrom: number;
  },
): { previous: RegulatoryProposition; next: RegulatoryProposition } {
  const closedPrevious: RegulatoryProposition = {
    ...previous,
    effectiveTo: input.effectiveFrom - 1,
    updatedAt: Date.now(),
  };

  const next = buildRegulatoryProposition({
    jurisdictionId: previous.jurisdictionId,
    source: { ...getSourceStub(previous), effectiveDate: input.effectiveFrom },
    topic: previous.topic,
    subtopic: previous.subtopic,
    ruleText: input.ruleText,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    citation: input.citation ?? previous.citation,
    confidence: input.confidence ?? previous.confidence,
    verificationStatus: input.verificationStatus ?? "UNVERIFIED",
    supplementState: input.supplementState ?? previous.supplementState,
    peril: previous.peril,
    insuranceType: previous.insuranceType,
    trigger: previous.trigger,
  });

  next.version = previous.version + 1;
  next.previousVersionId = previous.propositionId;
  // Keep the same dedup key so the chain stays linked.
  next.dedupKey = previous.dedupKey;
  // Ensure the id is unique even when the rule text is unchanged.
  next.propositionId = `${next.propositionId}_v${next.version}`;

  return { previous: closedPrevious, next };
}

/** Minimal source stub carrying provenance forward across versions. */
function getSourceStub(prop: RegulatoryProposition): RegulatorySource {
  return {
    sourceId: prop.sourceId,
    jurisdictionId: prop.jurisdictionId,
    sourceType: "statute",
    authorityTier: prop.authorityTier,
    publisher: "unknown",
    title: prop.citation ?? "source",
    status: "VERIFIED",
    reliabilityScore: 0.5,
    accessibilityStatus: "unknown",
    createdAt: prop.createdAt,
    updatedAt: prop.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Claim-date resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the applicable proposition versions for a claim date.
 * A proposition applies when: asOf >= effectiveFrom AND (effectiveTo is
 * undefined OR asOf <= effectiveTo). Returns the effective chain, newest
 * first, so callers can distinguish "current rule" from "historical rule".
 */
export function resolveVersionsForDate(
  propositions: RegulatoryProposition[],
  asOfDate: number,
): RegulatoryProposition[] {
  return propositions
    .filter((p) => {
      if (p.effectiveFrom !== undefined && asOfDate < p.effectiveFrom) return false;
      if (p.effectiveTo !== undefined && asOfDate > p.effectiveTo) return false;
      return true;
    })
    .sort((a, b) => (b.effectiveFrom ?? 0) - (a.effectiveFrom ?? 0));
}

/**
 * Group a proposition list into version chains by lineage key, then return the
 * full chain for each key (oldest → newest). Used by the admin UI to show
 * "VERSION 1 effective 2024-01-01 → 2025-06-30 / VERSION 2 …".
 */
export function groupVersionChains(
  propositions: RegulatoryProposition[],
): Array<{ dedupKey: string; versions: RegulatoryProposition[] }> {
  const byKey = new Map<string, RegulatoryProposition[]>();
  for (const p of propositions) {
    const key = p.lineageKey || p.dedupKey;
    const list = byKey.get(key) ?? [];
    list.push(p);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .map(([dedupKey, versions]) => ({
      dedupKey,
      versions: versions.sort((a, b) => (a.effectiveFrom ?? 0) - (b.effectiveFrom ?? 0)),
    }))
    .sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
}

/** Current (latest) version of each chain. */
export function currentVersions(
  propositions: RegulatoryProposition[],
): RegulatoryProposition[] {
  return groupVersionChains(propositions)
    .map((c) => c.versions[c.versions.length - 1])
    .filter((p): p is RegulatoryProposition => Boolean(p));
}