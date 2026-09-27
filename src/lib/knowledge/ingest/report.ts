// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — ingestion quality reports
//
// Two reports, both deterministic:
//   - `ExtractionReport` — what happened when the FILE was read.
//   - `IngestionReport`  — what happened when its text met the safety pipeline.
//
// The design goal is that a partially extracted or partially accepted document
// can never be mistaken for a complete one: the numbers that would differ are
// always present, including the percentage of accepted items that lack page
// provenance (which must be 0).
// ---------------------------------------------------------------------------

import type { DuplicateVerdict } from "./dedup";
import type { GuardrailViolation } from "../training-manual-guardrails";
import type { TrainingManualDocument } from "./types";

export interface ExtractionReport {
  filename: string;
  documentId: string;
  fingerprint: string;
  version: string;
  pageCount: number;
  extractionStatus: TrainingManualDocument["extractionStatus"];
  pagesSuccessfullyExtracted: number;
  emptyPages: number;
  lowTextPages: number;
  ocrRequired: number;
  ocrCompleted: number;
  ocrFailed: number;
  ocrUnavailable: number;
  pagesRequiringReview: number;
  pagesWithExtractionErrors: number;
  /** Distinct pages named in `document.errors`. */
  pagesWithProblems: number[];
  extractionErrors: number;
}

/** Build the file-level extraction report. */
export function buildExtractionReport(document: TrainingManualDocument): ExtractionReport {
  const pagesWithProblems = [
    ...new Set(document.errors.map((e) => e.page).filter((p): p is number => typeof p === "number")),
  ].sort((a, b) => a - b);

  return {
    filename: document.filename,
    documentId: document.documentId,
    fingerprint: document.fingerprint,
    version: document.version,
    pageCount: document.pageCount,
    extractionStatus: document.extractionStatus,
    pagesSuccessfullyExtracted: document.pages.filter((p) => p.text.trim().length > 0).length,
    emptyPages: document.summary.emptyPages,
    lowTextPages: document.summary.lowTextPages,
    ocrRequired: document.summary.ocrRequired,
    ocrCompleted: document.summary.ocrCompleted,
    ocrFailed: document.summary.ocrFailed,
    ocrUnavailable: document.summary.ocrUnavailable,
    pagesRequiringReview: document.summary.requiresReview,
    pagesWithExtractionErrors: document.pages.filter(
      (p) => p.ocrStatus === "failed" || (p.requiresOcr && p.ocrStatus === "unavailable"),
    ).length,
    pagesWithProblems,
    extractionErrors: document.errors.length,
  };
}

export interface IngestionReport {
  // -- Knowledge ---------------------------------------------------------
  itemsExtracted: number;
  itemsAccepted: number;
  itemsRejected: number;
  itemsRequiringReview: number;
  itemsHistorical: number;
  itemsWithBoundaries: number;
  prohibitedWarningsRetained: number;
  prohibitedDirectivesRejected: number;
  // -- Provenance --------------------------------------------------------
  provenanceWithPage: number;
  provenanceWithSection: number;
  provenanceWithPagePercent: number;
  provenanceWithSectionPercent: number;
  itemsMissingProvenance: number;
  // -- Deduplication -----------------------------------------------------
  duplicates: Record<DuplicateVerdict, number>;
  duplicatesMerged: number;
  higherAuthorityPreserved: number;
  // -- Guardrails --------------------------------------------------------
  guardrailViolations: Record<GuardrailViolation["rule"], number>;
}

export interface IngestionOutcomeLike {
  decision: "accepted" | "rejected" | "requires_review" | "duplicate";
  item: { locator?: { page?: number; section?: string }; temporalScope?: string };
  guardrail: { violations: GuardrailViolation[] };
  duplicate?: { verdict: DuplicateVerdict; mergeable: boolean; wouldEraseHigherAuthority: boolean };
  boundary?: unknown;
  rejectedAsProhibitedDirective?: boolean;
  prohibitedWarningRetained?: boolean;
}

/**
 * Build the knowledge-level ingestion report.
 *
 * `itemsExtracted` counts every candidate that entered the pipeline, so
 * `accepted + rejected + review + duplicate` always reconciles with it.
 */
export function buildIngestionReport(outcomes: IngestionOutcomeLike[]): IngestionReport {
  const report: IngestionReport = {
    itemsExtracted: outcomes.length,
    itemsAccepted: 0,
    itemsRejected: 0,
    itemsRequiringReview: 0,
    itemsHistorical: 0,
    itemsWithBoundaries: 0,
    prohibitedWarningsRetained: 0,
    prohibitedDirectivesRejected: 0,
    provenanceWithPage: 0,
    provenanceWithSection: 0,
    provenanceWithPagePercent: 0,
    provenanceWithSectionPercent: 0,
    itemsMissingProvenance: 0,
    duplicates: {
      unique: 0,
      exact_duplicate: 0,
      near_duplicate: 0,
      related: 0,
      contradictory: 0,
    },
    duplicatesMerged: 0,
    higherAuthorityPreserved: 0,
    guardrailViolations: {
      missing_locator: 0,
      missing_temporal_scope: 0,
      historical_tag_missing: 0,
      prohibited_practice: 0,
      legal_authority_claim: 0,
      coverage_determination: 0,
      invalid_evidence_status: 0,
      proposed_presented_as_fact: 0,
      unknown_source: 0,
    },
  };

  const acceptedOrKept: IngestionOutcomeLike[] = [];

  for (const o of outcomes) {
    switch (o.decision) {
      case "accepted":
        report.itemsAccepted++;
        acceptedOrKept.push(o);
        break;
      case "requires_review":
        report.itemsRequiringReview++;
        acceptedOrKept.push(o);
        break;
      case "duplicate":
        report.duplicatesMerged++;
        break;
      case "rejected":
        report.itemsRejected++;
        break;
    }

    if (o.rejectedAsProhibitedDirective) report.prohibitedDirectivesRejected++;
    if (o.prohibitedWarningRetained) report.prohibitedWarningsRetained++;

    if (o.item.temporalScope === "historical_context") report.itemsHistorical++;
    if (o.boundary) report.itemsWithBoundaries++;
    if (o.duplicate) {
      report.duplicates[o.duplicate.verdict]++;
      if (o.duplicate.wouldEraseHigherAuthority) report.higherAuthorityPreserved++;
    }
    for (const v of o.guardrail.violations) report.guardrailViolations[v.rule]++;

    if (o.item.locator?.page != null) report.provenanceWithPage++;
    else report.itemsMissingProvenance++;
    if (o.item.locator?.section) report.provenanceWithSection++;
  }

  const denom = acceptedOrKept.length || 1;
  report.provenanceWithPagePercent = Math.round((report.provenanceWithPage / denom) * 100);
  report.provenanceWithSectionPercent = Math.round((report.provenanceWithSection / denom) * 100);
  return report;
}
