// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — training-manual ingestion pipeline
//
// The single route from extracted text to knowledge records. Every candidate
// passes through the EXISTING guardrails — this module implements none of them
// a second time:
//
//   Extract  → (./extract)
//   Normalize → (./candidates)
//   Candidate → validateTrainingManualItem
//   Authority → confidence pinned to the TRAINING_MANUAL tier
//   Temporal  → coerced historical_context + tag
//   Prohibited → validator's prohibited_practice rule
//   Coverage/legal → requiresCurrentAuthorityVerification + handoff
//   Dedup     → classifyDuplicate
//   Persist   → NOT DONE HERE. The pipeline returns a payload; nothing is
//               written, so ingestion stays additive and reversible.
//
// A candidate that fails validation is rejected WITH its violations recorded —
// never silently dropped and never accepted with the rule suppressed.
// ---------------------------------------------------------------------------

import type { KnowledgeItem } from "../types";
import { SOURCE_CLASSIFICATIONS } from "../types";
import {
  COVERAGE_DETERMINATION_HANDOFF,
  isCoverageDeterminationRequest,
  isProhibitedPracticeText,
  requiresCurrentAuthorityVerification,
  validateTrainingManualItem,
  type GuardrailResult,
} from "../training-manual-guardrails";
import { buildCandidateItems, type CandidateItem } from "./candidates";
import { classifyDuplicate, type DedupDecision, type DedupOptions } from "./dedup";
import { buildIngestionReport, type IngestionReport } from "./report";
import type { ExtractionFailure, TrainingManualDocument } from "./types";

export type CandidateDecision = "accepted" | "rejected" | "requires_review" | "duplicate";

/** A coverage/legal boundary attached to an accepted-but-guarded item. */
export interface BoundaryAnnotation {
  requiresCurrentAuthorityVerification: boolean;
  coverageQuestionDetected: boolean;
  handoff: typeof COVERAGE_DETERMINATION_HANDOFF;
}

export interface CandidateOutcome {
  item: KnowledgeItem;
  page: number;
  decision: CandidateDecision;
  guardrail: GuardrailResult;
  duplicate?: DedupDecision;
  boundary?: BoundaryAnnotation;
  failure?: ExtractionFailure;
  /** True when the item was rejected specifically as a prohibited directive. */
  rejectedAsProhibitedDirective?: boolean;
  /**
   * True when an ACCEPTED item discusses a prohibited practice as a warning
   * ("never fabricate a measurement"). These must stay in the knowledge base:
   * refusing to help commit the act IS the knowledge.
   */
  prohibitedWarningRetained?: boolean;
}

/**
 * Concepts that indicate an ethics warning is present. This is a TOPIC
 * detector, deliberately distinct from the guardrail's directive detector —
 * pairing the two is what distinguishes "never fabricate" (retained) from
 * "fabricate a measurement" (rejected).
 */
const MISCONDUCT_TOPIC =
  /\b(fabricat|inflate|misrepresent|falsif|padding|exaggerat|conceal|manipulat|unethical|fraud|scam)/i;

export interface IngestionPipelineOptions {
  /** Existing knowledge to deduplicate against. Never mutated. */
  existing?: KnowledgeItem[];
  dedup?: DedupOptions;
}

export interface IngestionResult {
  document: TrainingManualDocument;
  outcomes: CandidateOutcome[];
  accepted: KnowledgeItem[];
  rejected: CandidateOutcome[];
  requiresReview: CandidateOutcome[];
  duplicates: CandidateOutcome[];
  report: IngestionReport;
}

/** Pin an item's authority to the training-manual tier — never raise it. */
function applyAuthorityHandling(item: KnowledgeItem): void {
  item.sourceClassification = "TRAINING_MANUAL";
  const ceiling = SOURCE_CLASSIFICATIONS.TRAINING_MANUAL.defaultConfidence;
  // Extraction confidence is not source authority. A perfectly extracted
  // training statement is still a training statement, so the ceiling holds.
  item.confidence = Math.min(item.confidence, ceiling);
}

/** Apply the guardrail's recoverable coercions (temporal scope + tags). */
function applyTemporalCoercion(item: KnowledgeItem, guardrail: GuardrailResult): void {
  if (guardrail.coerced?.temporalScope) {
    item.temporalScope = guardrail.coerced.temporalScope;
  }
  if (guardrail.coerced?.tags) {
    item.tags = guardrail.coerced.tags;
  }
  // Defensive: a manual item can never be marked `current` without a source
  // that justifies it. The source default is historical_context.
  if (!item.temporalScope) item.temporalScope = "historical_context";
}

/**
 * Run the safety pipeline over a list of already-built candidates. Exposed
 * separately from `ingestTrainingManualDocument` so tests (and any future
 * extractor) can inject candidates directly.
 */
export function ingestCandidateItems(
  candidates: CandidateItem[],
  options: IngestionPipelineOptions = {},
): {
  outcomes: CandidateOutcome[];
  accepted: KnowledgeItem[];
  rejected: CandidateOutcome[];
  requiresReview: CandidateOutcome[];
  duplicates: CandidateOutcome[];
  report: IngestionReport;
} {
  const existing = options.existing ?? [];
  const outcomes: CandidateOutcome[] = [];

  for (const candidate of candidates) {
    const item = candidate.item;

    // 1. Validate against the existing training-manual rules.
    const guardrail = validateTrainingManualItem(item);

    // 2. Apply recoverable coercions regardless of verdict, so the stored item
    //    is never left in the unsafe default.
    applyTemporalCoercion(item, guardrail);
    applyAuthorityHandling(item);

    // 3. Coverage/legal boundary (independent of acceptance).
    const coverageQuestionDetected = isCoverageDeterminationRequest(
      `${item.title} ${item.statement}`,
    );
    const boundary: BoundaryAnnotation | undefined =
      requiresCurrentAuthorityVerification(`${item.title} ${item.statement}`) ||
      coverageQuestionDetected
        ? {
            requiresCurrentAuthorityVerification: requiresCurrentAuthorityVerification(
              `${item.title} ${item.statement}`,
            ),
            coverageQuestionDetected,
            handoff: COVERAGE_DETERMINATION_HANDOFF,
          }
        : undefined;

    // 4. Hard rejection.
    if (!guardrail.valid) {
      const prohibited = guardrail.violations.some((v) => v.rule === "prohibited_practice");
      outcomes.push({
        item,
        page: candidate.page,
        decision: "rejected",
        guardrail,
        boundary,
        rejectedAsProhibitedDirective: prohibited,
        failure: {
          code: "KNOWLEDGE_VALIDATION_FAILED",
          page: candidate.page,
          message: `Rejected by guardrails: ${guardrail.violations
            .map((v) => v.rule)
            .join(", ")}`,
        },
      });
      continue;
    }

    // 5. Deduplicate against existing knowledge.
    const duplicate = classifyDuplicate(item, existing, options.dedup);

    // Exact duplicates from the same source are merged (idempotent re-ingest).
    if (duplicate.verdict === "exact_duplicate" && duplicate.mergeable) {
      outcomes.push({
        item,
        page: candidate.page,
        decision: "duplicate",
        guardrail,
        duplicate,
        boundary,
        failure: {
          code: "DUPLICATE_DETECTED",
          page: candidate.page,
          message: duplicate.reason,
        },
      });
      continue;
    }

    // Contradictions are never merged; they are surfaced for human review.
    if (duplicate.verdict === "contradictory") {
      outcomes.push({
        item,
        page: candidate.page,
        decision: "requires_review",
        guardrail,
        duplicate,
        boundary,
        failure: {
          code: "REQUIRES_REVIEW",
          page: candidate.page,
          message: duplicate.reason,
        },
      });
      continue;
    }

    // Near-duplicates and related concepts are kept — different provenance is
    // useful context, and nothing is de-duplicated across authority tiers.
    const statementText = `${item.title} ${item.statement}`;
    outcomes.push({
      item,
      page: candidate.page,
      decision: "accepted",
      guardrail,
      duplicate: duplicate.verdict === "unique" ? undefined : duplicate,
      boundary,
      prohibitedWarningRetained:
        MISCONDUCT_TOPIC.test(statementText) && !isProhibitedPracticeText(statementText),
    });
  }

  const accepted = outcomes
    .filter((o) => o.decision === "accepted" || o.decision === "requires_review")
    .map((o) => o.item);

  const report = buildIngestionReport(
    outcomes.map((o) => ({
      decision: o.decision,
      item: o.item,
      guardrail: o.guardrail,
      duplicate: o.duplicate,
      boundary: o.boundary,
      rejectedAsProhibitedDirective: o.rejectedAsProhibitedDirective,
      prohibitedWarningRetained: o.prohibitedWarningRetained,
    })),
  );

  return {
    outcomes,
    accepted,
    rejected: outcomes.filter((o) => o.decision === "rejected"),
    requiresReview: outcomes.filter((o) => o.decision === "requires_review"),
    duplicates: outcomes.filter((o) => o.decision === "duplicate"),
    report,
  };
}

/**
 * The full flow: an extracted document → validated, provenance-preserving,
 * deduplicated knowledge records. No persistence.
 */
export function ingestTrainingManualDocument(
  document: TrainingManualDocument,
  options: IngestionPipelineOptions = {},
): IngestionResult {
  const candidates = buildCandidateItems(document);
  const { outcomes, accepted, report } = ingestCandidateItems(candidates, options);

  return {
    document,
    outcomes,
    accepted,
    rejected: outcomes.filter((o) => o.decision === "rejected"),
    requiresReview: outcomes.filter((o) => o.decision === "requires_review"),
    duplicates: outcomes.filter((o) => o.decision === "duplicate"),
    report,
  };
}

/** Re-export the failure type for consumers of this module. */
export type { ExtractionFailure };
