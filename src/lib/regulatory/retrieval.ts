import type { ClaimContext, RegulatoryProposition, RetrievedProposition } from "./types";
import type { RegulatoryStore } from "./types";
import { authorityRank } from "./verification";

function dateOnly(value?: string): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

function appliesOnDate(proposition: RegulatoryProposition, claimDate: string): boolean {
  const date = dateOnly(claimDate);
  const from = dateOnly(proposition.effectiveFrom ?? proposition.enactedAt);
  const to = dateOnly(proposition.effectiveTo ?? proposition.repealedAt);
  return (!from || !date || from <= date) && (!to || !date || date < to);
}

function matchesText(value: string | undefined, requested: string): boolean {
  if (!value) return true;
  return value.toLowerCase().includes(requested.toLowerCase()) || requested.toLowerCase().includes(value.toLowerCase());
}

export async function retrieveRegulatoryContext(
  store: RegulatoryStore,
  context: ClaimContext,
  options: { includeUnverified?: boolean; limit?: number } = {},
): Promise<RetrievedProposition[]> {
  const propositions = await store.listPropositions({ jurisdictionCode: context.jurisdictionCode });
  const contradictions = await store.listContradictions(context.jurisdictionCode);
  const includeUnverified = options.includeUnverified === true;
  const results = propositions.flatMap((proposition) => {
    if (!includeUnverified && proposition.verificationState !== "VERIFIED") return [];
    if (!appliesOnDate(proposition, context.claimDate)) return [];
    if (!matchesText(proposition.actor, context.actor)) return [];
    if (!matchesText(proposition.claimType, context.claimType)) return [];
    if (!matchesText(proposition.activity, context.activity)) return [];
    if (context.topics && context.topics.length > 0 && !context.topics.includes(proposition.topic)) return [];
    const unresolved = contradictions.some((item) => (item.propositionAId === proposition.id || item.propositionBId === proposition.id) && item.resolutionStatus !== "RESOLVED_PRIMARY_PREVAILS");
    if (unresolved && !includeUnverified) return [];
    const retrievalReasons = [
      "jurisdiction matched",
      "claim date matched an effective version",
      "actor and activity matched or were not restricted",
      proposition.verificationState === "VERIFIED" ? "verified proposition" : "explicitly surfaced as unverified",
      `authority rank ${authorityRank(proposition.authorityTier)}`,
    ];
    if (unresolved) retrievalReasons.push("unresolved contradiction retained because unverified retrieval was explicitly requested");
    return [{
      ...proposition,
      retrievalScore: 100 - authorityRank(proposition.authorityTier) * 5 + (proposition.verificationState === "VERIFIED" ? 20 : 0) + (proposition.citation.citation ? 5 : 0),
      retrievalReasons,
    }];
  });
  return results.sort((a, b) => b.retrievalScore - a.retrievalScore || a.topic.localeCompare(b.topic)).slice(0, options.limit ?? 100);
}

export function provenanceFor(proposition: RegulatoryProposition): Record<string, unknown> {
  return {
    sourceId: proposition.sourceId,
    discoverySourceId: proposition.discoverySourceId,
    citation: proposition.citation.citation,
    evidenceText: proposition.evidenceText,
    evidenceLocation: proposition.evidenceLocation,
    effectiveFrom: proposition.effectiveFrom,
    effectiveTo: proposition.effectiveTo,
    verifiedAt: proposition.verifiedAt,
    authorityTier: proposition.authorityTier,
    verificationState: proposition.verificationState,
  };
}
