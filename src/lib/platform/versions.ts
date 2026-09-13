// ---------------------------------------------------------------------------
// Atlas Platform — Knowledge versioning (pure, no I/O)
//
// Knowledge is never overwritten. Each change appends a new version and
// supersedes the previous one with an explicit effective boundary, so Atlas can
// answer the historical question:
//
//   "What requirement applied to this claim on the date of loss?"
//
// Supersession itself is already implemented in @/lib/atlas-data/authority
// (applySupersession) — this module reuses it rather than duplicating it, and
// adds the time-travel / verifiability layer on top.
// ---------------------------------------------------------------------------

import { applySupersession } from "@/lib/atlas-data/authority";
import type { KnowledgeVersion } from "./types";

/** Ascending by version number (oldest first). */
export function sortVersionChain(versions: KnowledgeVersion[]): KnowledgeVersion[] {
  return [...versions].sort((a, b) => (a.versionNumber ?? 0) - (b.versionNumber ?? 0));
}

export function latestVersion(versions: KnowledgeVersion[]): KnowledgeVersion | null {
  const sorted = sortVersionChain(versions);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

export function nextVersionNumber(versions: KnowledgeVersion[]): number {
  const latest = latestVersion(versions);
  return (latest?.versionNumber ?? 0) + 1;
}

/**
 * A version is only trustworthy if it can be traced to a real source and has a
 * real effective date. This is the guard that stops AI interpretation being
 * stored as if it were authoritative regulatory text.
 */
export function isVerifiableVersion(version: KnowledgeVersion): boolean {
  return Boolean(
    version.sourceId &&
      version.sourceId.trim().length > 0 &&
      version.effectiveDate != null &&
      version.statement &&
      version.statement.trim().length > 0,
  );
}

/**
 * Validate a proposed new version against the version it supersedes.
 * A new version may not become effective before the version it replaces —
 * history is append-only and cannot be rewritten.
 */
export function validateNewVersion(
  previous: KnowledgeVersion | null,
  newEffectiveDate: number | null | undefined,
): string[] {
  const errors: string[] = [];
  if (newEffectiveDate == null) {
    errors.push("A new knowledge version requires an effective date.");
  }
  if (
    previous?.effectiveDate != null &&
    newEffectiveDate != null &&
    newEffectiveDate < previous.effectiveDate
  ) {
    errors.push(
      "A new version cannot become effective before the version it supersedes.",
    );
  }
  return errors;
}

/**
 * Resolve the version that APPLIED at a point in time.
 *
 * Selection rule: effectiveDate <= asOf AND (effectiveTo is null OR > asOf).
 * If several match (overlapping boundaries should not happen but must fail
 * safe), the latest effective one wins.
 */
export function selectVersionAsOf(
  versions: KnowledgeVersion[],
  asOf: number,
): KnowledgeVersion | null {
  const candidates = versions.filter((v) => {
    if (v.effectiveDate == null) return false;
    if (v.effectiveDate > asOf) return false;
    if (v.effectiveTo != null && v.effectiveTo <= asOf) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => (b.effectiveDate ?? 0) - (a.effectiveDate ?? 0),
  )[0];
}

/**
 * Honestly describe which version applied (or say that none did).
 * Never implies current knowledge applied historically.
 */
export function describeAsOf(
  version: KnowledgeVersion | null,
  asOf: number,
): string {
  const date = new Date(asOf).toISOString().slice(0, 10);
  if (!version) {
    return `Atlas has no versioned knowledge that was effective on ${date}. It does not substitute today's knowledge for the version that actually applied.`;
  }
  const from = version.effectiveDate
    ? new Date(version.effectiveDate).toISOString().slice(0, 10)
    : "an unknown effective date";
  const to = version.effectiveTo
    ? ` until ${new Date(version.effectiveTo).toISOString().slice(0, 10)}`
    : " (still current)";
  return `The version effective on ${date} was version ${version.versionNumber} (${version.version ?? "unversioned"}), effective ${from}${to}. Source: ${version.sourceId}.`;
}

/**
 * Pure supersession planning for a newly-created version.
 * Returns the exact rows to patch — never deletes history.
 */
export function planSupersession(
  existing: KnowledgeVersion[],
  newKnowledgeId: string,
  previousKnowledgeId: string | null,
): Array<{ knowledgeId: string; patch: { status: "superseded"; supersededBy: string[] } }> {
  if (!previousKnowledgeId) return [];
  return applySupersession(
    existing.map((v) => ({
      knowledgeId: v.knowledgeId,
      status: v.status,
      supersededBy: v.supersededById ? [v.supersededById] : [],
    })),
    { knowledgeId: newKnowledgeId, supersedes: [previousKnowledgeId] },
  );
}

/** Compact summary for UI / voice. */
export function summarizeVersionChain(versions: KnowledgeVersion[]): {
  total: number;
  current: KnowledgeVersion | null;
  superseded: number;
  unpublishedReview: number;
} {
  const chain = sortVersionChain(versions);
  const current =
    chain.find((v) => v.status === "active") ?? chain[chain.length - 1] ?? null;
  return {
    total: chain.length,
    current,
    superseded: chain.filter((v) => v.status === "superseded").length,
    unpublishedReview: chain.filter(
      (v) => v.reviewStatus === "needs_review" || v.freshness === "needs_review",
    ).length,
  };
}
