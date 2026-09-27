// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — training-manual ingestion
//
// Public entry point. Reads a paged training document, preserves page-level
// provenance, routes unscannable pages honestly through OCR, and runs every
// candidate through the EXISTING training-manual guardrails before producing
// deduplicated knowledge records. Nothing is persisted here — the pipeline
// returns a payload so ingestion stays additive and reversible.
//
// The real Christian Construction Insurance Education Manual PDF is still
// required; until it exists no statement is ingested (see ../training-manual
// `CONTENT_INGESTED` / `MISSING_INPUT`).
// ---------------------------------------------------------------------------

export type {
  DocumentExtractionStatus,
  DocumentMetadata,
  ExtractionFailure,
  ExtractionOptions,
  ExtractionSummary,
  IngestionFailureCode,
  OcrReason,
  PageExtractionMethod,
  PageOcrStatus,
  PageTextQuality,
  TrainingManualDocument,
  TrainingManualPage,
} from "./types";

export {
  UnavailableOcrProvider,
  unavailableOcrProvider,
  fromIngestOcr,
} from "./ocr-provider";
export type { OcrPageInput, OcrPageResult, OcrProvider } from "./ocr-provider";

export { detectSections, detectTableOfContents } from "./sections";
export type { PageTextInput, SectionAssignment } from "./sections";

export {
  AUTHORITY_ORDER,
  classifyDuplicate,
  dedupeAgainstCorpus,
  fingerprintBytes,
  fingerprintItem,
  fnv1a,
  fnv1aBytes,
  isContradictory,
  normalizeForFingerprint,
  textSimilarity,
} from "./dedup";
export type { DedupDecision, DedupOptions, DuplicateVerdict } from "./dedup";

export { extractTrainingManual, looksLikePdf } from "./extract";

export { buildCandidateItems } from "./candidates";
export type { CandidateItem } from "./candidates";

export { ingestCandidateItems, ingestTrainingManualDocument } from "./pipeline";
export type {
  BoundaryAnnotation,
  CandidateDecision,
  CandidateOutcome,
  IngestionPipelineOptions,
  IngestionResult,
} from "./pipeline";

export { buildExtractionReport, buildIngestionReport } from "./report";
export type { ExtractionReport, IngestionOutcomeLike, IngestionReport } from "./report";

// NOTE: ./fixtures (synthetic, test-only PDF builders) is intentionally NOT
// re-exported here — it is not part of the product surface. Tests import it
// directly.
