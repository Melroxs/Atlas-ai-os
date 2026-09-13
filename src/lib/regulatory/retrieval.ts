// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Retrieval & Answer Contract
//
// Retrieval filters by jurisdiction, claim date (temporal versioning), actor,
// topic, claim phase, authority tier, confidence, and verification strength.
// The answer contract distinguishes: what the source says, what Atlas
// inferred, and what remains uncertain. Nothing is ever presented as law.
// ---------------------------------------------------------------------------

import type {
  RegulatoryContradiction,
  RegulatoryProposition,
  RegulatoryRetrievalOptions,
  RegulatoryRetrievalResult,
  RegulatoryRuleAnswer,
  RegulatorySource,
  VerificationStatus,
} from "./types";
import { resolveVersionsForDate } from "./propositions";
import { phasesForTopic } from "./taxonomy";
import { AUTHORITY_TIER_LABELS } from "./types";

// ---------------------------------------------------------------------------
// Verification strength ordering
// ---------------------------------------------------------------------------

const VERIFICATION_STRENGTH: Record<VerificationStatus, number> = {
  VERIFIED: 5,
  PARTIALLY_VERIFIED: 4,
  NEEDS_HUMAN_REVIEW: 3,
  EXTRACTED: 2,
  FETCHED: 1,
  DISCOVERED: 1,
  UNVERIFIED: 1,
  CONTRADICTED: 0,
  SUPERSEDED: -1,
  STALE: 0,
  FAILED: -1,
  INSUFFICIENT_EVIDENCE: -1,
};

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve applicable regulatory rules for a claim context.
 *
 * Temporal correctness is enforced here: `asOfDate` (default now) resolves
 * version chains so a 2024 claim sees 2024 rules, never rules introduced in
 * 2026. Filters are additive.
 */
export function retrieveRegulatoryRules(
  propositions: RegulatoryProposition[],
  sources: RegulatorySource[],
  options: RegulatoryRetrievalOptions,
): RegulatoryRetrievalResult[] {
  const asOfDate = options.asOfDate ?? Date.now();
  const sourceById = new Map(sources.map((s) => [s.sourceId, s]));
  const minTier = options.minAuthorityTier ?? 4; // default: include all tiers
  const minConfidence = options.minConfidence ?? 0;
  const minVerification = options.minVerification;
  const verifiedOnly = options.verifiedOnly ?? false;

  // 1. Jurisdiction + temporal filter first (cheapest, most important).
  const applicable = resolveVersionsForDate(
    propositions.filter((p) => p.jurisdictionId === options.jurisdictionId),
    asOfDate,
  );

  const results: RegulatoryRetrievalResult[] = [];
  for (const p of applicable) {
    const source = sourceById.get(p.sourceId);
    if (!source) continue;

    // Authority tier filter.
    if (p.authorityTier > minTier) continue;

    // Confidence filter.
    if (p.confidence < minConfidence) continue;

    // Verification filters.
    if (VERIFICATION_STRENGTH[p.verificationStatus] < 0) continue;
    if (verifiedOnly && VERIFICATION_STRENGTH[p.verificationStatus] < 4) continue;
    if (minVerification && VERIFICATION_STRENGTH[p.verificationStatus] < VERIFICATION_STRENGTH[minVerification]) continue;

    const matchedBy: string[] = [];

    // Actor filter.
    if (options.actors && options.actors.length > 0) {
      if (!options.actors.includes(p.actor)) continue;
      matchedBy.push(`actor:${p.actor}`);
    }

    // Topic filter.
    if (options.topics && options.topics.length > 0) {
      if (!options.topics.includes(p.topic)) continue;
      matchedBy.push(`topic:${p.topic}`);
    }

    // Claim-phase filter (derived from topic when not set on the proposition).
    if (options.claimPhases && options.claimPhases.length > 0) {
      const phases = phasesForTopic(p.topic);
      const overlaps = phases.some((ph) => options.claimPhases!.includes(ph));
      if (!overlaps) continue;
      matchedBy.push(`phase:${p.claimPhase}`);
    }

    // Relevance: tier weight + verification + confidence.
    const tierWeight = 1 - (p.authorityTier - 1) * 0.2;
    const verificationWeight = VERIFICATION_STRENGTH[p.verificationStatus] / 5;
    const relevance = Math.min(
      0.99,
      Math.round((tierWeight * 0.5 + verificationWeight * 0.3 + p.confidence * 0.2) * 100) / 100,
    );

    results.push({
      proposition: p,
      source,
      relevance,
      matchedBy: matchedBy.length > 0 ? matchedBy : ["jurisdiction"],
    });
  }

  // Rank: relevance desc, then tier, then verification.
  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (a.proposition.authorityTier !== b.proposition.authorityTier) {
      return a.proposition.authorityTier - b.proposition.authorityTier;
    }
    return VERIFICATION_STRENGTH[b.proposition.verificationStatus] -
      VERIFICATION_STRENGTH[a.proposition.verificationStatus];
  });

  return results.slice(0, options.limit ?? 25);
}

// ---------------------------------------------------------------------------
// Answer contract
// ---------------------------------------------------------------------------

const CAVEAT =
  "Regulatory intelligence only. Verify the cited authority and consult qualified counsel or a licensed professional where appropriate.";

/**
 * Build a structured regulatory answer from retrieval results.
 * `exceptions` are propositions on the same topics whose exception field is
 * populated. `uncertainties` are honest statements about what is unknown.
 */
export function buildRegulatoryAnswer(
  input: {
    jurisdictionId: string;
    question?: string;
    results: RegulatoryRetrievalResult[];
    allPropositions: RegulatoryProposition[];
    contradictions: RegulatoryContradiction[];
    asOfDate: number;
  },
): RegulatoryRuleAnswer {
  const { jurisdictionId, question, results, allPropositions, contradictions, asOfDate } = input;

  const topicIds = [...new Set(results.map((r) => r.proposition.topic))];

  const exceptions = allPropositions.filter(
    (p) =>
      p.jurisdictionId === jurisdictionId &&
      topicIds.includes(p.topic) &&
      p.exception !== undefined,
  );

  const uncertainties: string[] = [];
  const coveredTopics = new Set(results.map((r) => r.proposition.topic));
  const knownTopics = [...new Set(allPropositions.filter((p) => p.jurisdictionId === jurisdictionId).map((p) => p.topic))];
  for (const topic of knownTopics) {
    if (!coveredTopics.has(topic)) {
      uncertainties.push(
        `No applicable rule returned for topic "${topic}" as of ${new Date(asOfDate).toISOString().slice(0, 10)}.`,
      );
    }
  }
  if (results.length === 0) {
    uncertainties.push(
      "No verified regulatory propositions matched the requested context. This means Atlas has insufficient evidence — it does not mean no rule exists.",
    );
  }

  const sourceTrace = results.map((r) => ({
    propositionId: r.proposition.propositionId,
    sourceId: r.source.sourceId,
    title: r.source.title,
    publisher: r.source.publisher,
    canonicalUrl: r.source.canonicalUrl,
    citation: r.proposition.citation ?? r.source.citation,
    effectiveFrom: r.proposition.effectiveFrom,
    effectiveTo: r.proposition.effectiveTo,
    authorityTier: r.proposition.authorityTier,
    verificationStatus: r.proposition.verificationStatus,
    confidence: r.proposition.confidence,
  }));

  const hasContradictions = contradictions.length > 0;

  return {
    jurisdictionId,
    question,
    rules: results,
    exceptions,
    contradictions,
    uncertainties,
    sourceTrace,
    caveat: hasContradictions || results.length === 0 ? CAVEAT : undefined,
  };
}

// ---------------------------------------------------------------------------
// Regulatory answer formatting (for the reasoning layer / UI)
// ---------------------------------------------------------------------------

/** Render an answer in the required QUESTION → RULES → EXCEPTIONS → … shape. */
export function formatRegulatoryAnswer(answer: RegulatoryRuleAnswer): string {
  const lines: string[] = [];
  if (answer.question) lines.push(`QUESTION: ${answer.question}`);
  lines.push(`JURISDICTION: ${answer.jurisdictionId.toUpperCase()}`);
  lines.push("");

  lines.push("APPLICABLE RULES");
  if (answer.rules.length === 0) {
    lines.push("  (none returned — insufficient evidence, not proof of absence)");
  }
  for (const r of answer.rules) {
    lines.push(`  1. ${r.proposition.ruleText}`);
    lines.push(`     Authority: ${AUTHORITY_TIER_LABELS[r.proposition.authorityTier]}`);
    if (r.proposition.citation) lines.push(`     Citation: ${r.proposition.citation}`);
    lines.push(
      `     Effective: ${r.proposition.effectiveFrom ? new Date(r.proposition.effectiveFrom).toISOString().slice(0, 10) : "unknown"} → ${
        r.proposition.effectiveTo ? new Date(r.proposition.effectiveTo).toISOString().slice(0, 10) : "current"
      }`,
    );
    lines.push(`     Source: ${r.source.title} (${r.source.publisher})${r.source.canonicalUrl ? ` — ${r.source.canonicalUrl}` : ""}`);
    lines.push(`     Confidence: ${Math.round(r.proposition.confidence * 100)}% · Verification: ${r.proposition.verificationStatus}`);
  }

  if (answer.exceptions.length > 0) {
    lines.push("");
    lines.push("EXCEPTIONS");
    for (const e of answer.exceptions) {
      if (e.exception) lines.push(`  - ${e.exception}`);
    }
  }

  if (answer.contradictions.length > 0) {
    lines.push("");
    lines.push("CONTRADICTIONS / UNCERTAINTIES");
    for (const c of answer.contradictions) {
      lines.push(`  - [${c.severity}] ${c.detail}`);
    }
  } else if (answer.uncertainties.length > 0) {
    lines.push("");
    lines.push("UNCERTAINTIES");
    for (const u of answer.uncertainties) {
      lines.push(`  - ${u}`);
    }
  }

  lines.push("");
  lines.push("SOURCE TRACE");
  for (const t of answer.sourceTrace) {
    lines.push(
      `  - ${t.propositionId} → ${t.title} (${t.publisher})${t.canonicalUrl ? ` ${t.canonicalUrl}` : ""} · tier ${t.authorityTier} · ${t.verificationStatus}`,
    );
  }

  if (answer.caveat) {
    lines.push("");
    lines.push(`NOTE: ${answer.caveat}`);
  }

  return lines.join("\n");
}