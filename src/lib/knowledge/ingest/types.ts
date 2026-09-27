// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — training-manual ingestion types
//
// The SHAPE of a paged document extraction, independent of the extractor and
// of any OCR vendor. Nothing in this file states what the manual teaches; it
// describes how a document is represented while it is being read.
//
// Why a separate type model from `KnowledgeItem`:
//   - `KnowledgeItem` is a claim ABOUT the world.
//   - These types are observations about a FILE — which pages had text, which
//     needed OCR, what failed. Conflating the two is how a partially extracted
//     document starts to look like complete knowledge.
//
// Page boundaries are mandatory. There is deliberately no "document text"
// field on `TrainingManualDocument`: a flattened string is the exact thing
// page-level provenance cannot survive.
// ---------------------------------------------------------------------------

/** How a page's text was obtained. */
export type PageExtractionMethod = "text_layer" | "ocr" | "none";

/** Terminal OCR state for a page. Every page requiring OCR ends in one of these. */
export type PageOcrStatus =
  | "not_required"
  | "completed"
  | "failed"
  | "unavailable"
  | "requires_review";

/** Coarse quality bucket for a page's extracted text. */
export type PageTextQuality = "good" | "low" | "empty";

/** Why a page was routed to OCR. */
export type OcrReason = "image_only" | "low_text" | "extraction_failed";

/** A single extracted page. Never carries invented text. */
export interface TrainingManualPage {
  /** 1-indexed page number within the source document. */
  pageNumber: number;
  /** Normalized extracted text ("" when nothing readable was recovered). */
  text: string;
  extractionMethod: PageExtractionMethod;
  textQuality: PageTextQuality;
  /** Character count of `text` — the deterministic quality signal. */
  charCount: number;
  /** Whether this page needs OCR before it can contribute knowledge. */
  requiresOcr: boolean;
  ocrStatus: PageOcrStatus;
  ocrReason?: OcrReason;
  /** Name of the OCR provider that ran, when one did. */
  ocrProvider?: string;
  /** Section heading, only when a heading was actually detected. */
  section?: string;
  /** Subsection heading, only when actually detected. */
  subsection?: string;
  /** Non-fatal notes (e.g. a table/figure that cannot be safely extracted). */
  warnings?: string[];
}

/** Metadata actually present in the file — never inferred from the filename. */
export interface DocumentMetadata {
  filename: string;
  /** Only set when the PDF's own metadata/info dictionary carries it. */
  title?: string;
  author?: string;
  publisher?: string;
  publicationDate?: string;
  documentVersion?: string;
  pageCount: number;
}

/** Deterministic extraction failure codes. Failures are never swallowed. */
export type IngestionFailureCode =
  | "PDF_INVALID"
  | "PDF_UNREADABLE"
  | "PAGE_EXTRACTION_FAILED"
  | "OCR_UNAVAILABLE"
  | "OCR_FAILED"
  | "PROVENANCE_MISSING"
  | "SECTION_UNCERTAIN"
  | "KNOWLEDGE_VALIDATION_FAILED"
  | "DUPLICATE_DETECTED"
  | "REQUIRES_REVIEW";

export interface ExtractionFailure {
  code: IngestionFailureCode;
  /** Page the failure applies to, when page-specific. */
  page?: number;
  message: string;
}

/** Document-level extraction roll-up. Makes partial extraction impossible to mistake for complete. */
export interface ExtractionSummary {
  pages: number;
  textExtracted: number;
  ocrRequired: number;
  ocrCompleted: number;
  ocrFailed: number;
  ocrUnavailable: number;
  requiresReview: number;
  emptyPages: number;
  lowTextPages: number;
  extractionErrors: number;
}

/** Whether the whole document was read. `complete` requires every page readable. */
export type DocumentExtractionStatus = "complete" | "partial" | "failed";

/** The structured, page-aware result of reading a manual PDF. */
export interface TrainingManualDocument {
  /**
   * Stable identity of the DOCUMENT (the manual). Constant across versions so
   * a changed PDF becomes a new version, not a new source.
   */
  documentId: string;
  /** Content fingerprint of the exact bytes read — the idempotency key. */
  fingerprint: string;
  /** Short version tag derived from the fingerprint. */
  version: string;
  filename: string;
  title: string;
  pageCount: number;
  extractionStatus: DocumentExtractionStatus;
  metadata: DocumentMetadata;
  pages: TrainingManualPage[];
  summary: ExtractionSummary;
  errors: ExtractionFailure[];
}

/** Options for a document extraction run. */
export interface ExtractionOptions {
  filename: string;
  /**
   * Override the stable document identity. Defaults to the registered
   * training-manual source id.
   */
  documentId?: string;
  /** OCR provider to consult for pages that need it. Defaults to unavailable. */
  ocrProvider?: import("./ocr-provider").OcrProvider;
  /**
   * Pages with fewer than this many characters are treated as low-quality and
   * routed to OCR. Deterministic and configurable.
   */
  lowTextThreshold?: number;
}
