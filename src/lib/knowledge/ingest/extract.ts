// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — training-manual document extraction
//
// PDF → per-page text → OCR when a page has no usable text layer → detected
// sections → a `TrainingManualDocument` with a document-level quality report.
//
// Non-negotiable properties:
//   - Page boundaries are preserved. The result has no flattened string.
//   - Nothing is invented. A page with no text layer yields empty text, is
//     flagged for OCR, and — if OCR is unavailable — is reported as needing
//     review. It is never replaced by model text.
//   - Every failure is explicit. Extraction never reports success when a page
//     was not read.
// ---------------------------------------------------------------------------

import { extractPdfStructure } from "@/lib/ingest/pdf";
import { fingerprintBytes } from "./dedup";
import { unavailableOcrProvider, type OcrPageResult, type OcrProvider } from "./ocr-provider";
import { detectSections } from "./sections";
import { TRAINING_MANUAL_SOURCE_ID } from "../training-manual";
import type {
  DocumentExtractionStatus,
  DocumentMetadata,
  ExtractionFailure,
  ExtractionOptions,
  ExtractionSummary,
  PageExtractionMethod,
  PageTextQuality,
  TrainingManualDocument,
  TrainingManualPage,
} from "./types";

/** Default page-level report template. Kept immutable by construction. */
const DEFAULT_LOW_TEXT_THRESHOLD = 40;

/** True when the bytes carry the PDF magic number. */
export function looksLikePdf(bytes: Uint8Array | ArrayBuffer): boolean {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 5) return false;
  return (
    b[0] === 0x25 && // %
    b[1] === 0x50 && // P
    b[2] === 0x44 && // D
    b[3] === 0x46 && // F
    b[4] === 0x2d // -
  );
}

function qualityFor(text: string, lowTextThreshold: number): PageTextQuality {
  const n = text.trim().length;
  if (n === 0) return "empty";
  if (n < lowTextThreshold) return "low";
  return "good";
}

/** Build a `failed` document shell so a hard failure still reports explicitly. */
function failedDocument(
  filename: string,
  documentId: string,
  fingerprint: string,
  version: string,
  errors: ExtractionFailure[],
): TrainingManualDocument {
  return {
    documentId,
    fingerprint,
    version,
    filename,
    title: filename,
    pageCount: 0,
    extractionStatus: "failed",
    metadata: { filename, pageCount: 0 },
    pages: [],
    summary: emptySummary(),
    errors,
  };
}

function emptySummary(): ExtractionSummary {
  return {
    pages: 0,
    textExtracted: 0,
    ocrRequired: 0,
    ocrCompleted: 0,
    ocrFailed: 0,
    ocrUnavailable: 0,
    requiresReview: 0,
    emptyPages: 0,
    lowTextPages: 0,
    extractionErrors: 0,
  };
}

/**
 * Read a training-manual PDF into a structured, page-aware document.
 *
 * Never throws for a readable-but-imperfect document: problems are reported in
 * `summary` and `errors`. Throws only if `bytes` is not a PDF at all, which the
 * caller must surface as an invalid input rather than ingest.
 */
export async function extractTrainingManual(
  bytes: ArrayBuffer,
  options: ExtractionOptions,
): Promise<TrainingManualDocument> {
  const filename = options.filename;
  const documentId = options.documentId ?? TRAINING_MANUAL_SOURCE_ID;
  const lowTextThreshold = options.lowTextThreshold ?? DEFAULT_LOW_TEXT_THRESHOLD;
  const ocrProvider: OcrProvider = options.ocrProvider ?? unavailableOcrProvider;

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const fingerprint = fingerprintBytes(u8);
  const version = fingerprint.slice(0, 8);

  if (!looksLikePdf(u8)) {
    throw new Error(
      "PDF_INVALID: the supplied bytes are not a PDF (missing %PDF- header). No content was extracted.",
    );
  }

  const errors: ExtractionFailure[] = [];
  const pageErrors = new Set<number>();

  let structure;
  try {
    structure = await extractPdfStructure(bytes, (pageNumber) => {
      pageErrors.add(pageNumber);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ code: "PDF_UNREADABLE", message: `The PDF could not be opened: ${message}` });
    return failedDocument(filename, documentId, fingerprint, version, errors);
  }

  if (structure.numPages === 0) {
    errors.push({ code: "PDF_UNREADABLE", message: "The PDF reports zero pages." });
    return failedDocument(filename, documentId, fingerprint, version, errors);
  }

  const sections = detectSections(structure.pages);
  const sectionByPage = new Map(sections.map((s) => [s.pageNumber, s]));

  const pages: TrainingManualPage[] = [];

  for (const raw of structure.pages) {
    const originalText = raw.text.trim();
    let text = originalText;
    let method: PageExtractionMethod = text ? "text_layer" : "none";
    let quality = qualityFor(text, lowTextThreshold);

    const extractionFailed = pageErrors.has(raw.pageNumber);
    // A page needs OCR when there is no text, too little text, or extraction
    // itself failed. This is the ONLY route by which text can appear for such
    // a page — and only from a real OCR engine.
    const requiresOcr = quality !== "good";
    const ocrReason = extractionFailed
      ? "extraction_failed"
      : originalText.length === 0
        ? "image_only"
        : "low_text";

    let ocrStatus: TrainingManualPage["ocrStatus"] = "not_required";
    let ocrProviderName: string | undefined;

    if (extractionFailed) {
      errors.push({
        code: "PAGE_EXTRACTION_FAILED",
        page: raw.pageNumber,
        message: `Page ${raw.pageNumber} could not be parsed.`,
      });
    }

    if (requiresOcr) {
      const result: OcrPageResult = await safeOcr(ocrProvider, {
        pageNumber: raw.pageNumber,
        bytes,
        mimeType: "application/pdf",
      });
      ocrStatus = result.status;
      ocrProviderName = result.provider;

      if (result.status === "completed" && result.text?.trim()) {
        text = result.text.trim();
        method = "ocr";
        quality = qualityFor(text, lowTextThreshold);
      } else if (result.status === "unavailable") {
        errors.push({
          code: "OCR_UNAVAILABLE",
          page: raw.pageNumber,
          message:
            result.message ??
            `Page ${raw.pageNumber} has no readable text layer and no OCR engine is configured.`,
        });
      } else if (result.status === "failed") {
        errors.push({
          code: "OCR_FAILED",
          page: raw.pageNumber,
          message: result.message ?? `OCR failed for page ${raw.pageNumber}.`,
        });
      }
    }

    const section = sectionByPage.get(raw.pageNumber);
    if (section?.uncertain) {
      errors.push({
        code: "SECTION_UNCERTAIN",
        page: raw.pageNumber,
        message: `No confident section heading was detected for page ${raw.pageNumber}.`,
      });
    }

    pages.push({
      pageNumber: raw.pageNumber,
      text,
      extractionMethod: method,
      textQuality: quality,
      charCount: text.length,
      requiresOcr,
      ocrStatus,
      ocrReason: requiresOcr ? ocrReason : undefined,
      ocrProvider: ocrProviderName,
      section: section?.section,
      subsection: section?.subsection,
    });
  }

  const summary = summarize(pages, errors);
  const extractionStatus: DocumentExtractionStatus =
    summary.requiresReview === 0 && summary.ocrRequired === summary.ocrCompleted
      ? "complete"
      : pages.some((p) => p.text.length > 0)
        ? "partial"
        : "failed";

  const metadata: DocumentMetadata = {
    ...structure.metadata,
    filename,
    pageCount: structure.numPages,
  };

  return {
    documentId,
    fingerprint,
    version,
    filename,
    title: metadata.title ?? filename,
    pageCount: structure.numPages,
    extractionStatus,
    metadata,
    pages,
    summary,
    errors,
  };
}

/**
 * Consult the OCR provider, treating a thrown provider as a failed attempt.
 *
 * The provider is asked regardless of `isAvailable()`: an unavailable provider
 * is contractually required to answer `status: "unavailable"` and never to
 * fabricate text, so routing every attempt through `extractPage` keeps that
 * single contract authoritative instead of duplicating the check here.
 */
async function safeOcr(
  provider: OcrProvider,
  input: { pageNumber: number; bytes: ArrayBuffer; mimeType: string },
): Promise<OcrPageResult> {
  try {
    return await provider.extractPage(input);
  } catch (e) {
    return {
      pageNumber: input.pageNumber,
      status: "failed",
      provider: provider.name,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function summarize(pages: TrainingManualPage[], errors: ExtractionFailure[]): ExtractionSummary {
  const s = emptySummary();
  s.pages = pages.length;
  for (const p of pages) {
    if (p.text.trim().length > 0) s.textExtracted++;
    if (p.requiresOcr) s.ocrRequired++;
    if (p.ocrStatus === "completed") s.ocrCompleted++;
    if (p.ocrStatus === "failed") s.ocrFailed++;
    if (p.ocrStatus === "unavailable") s.ocrUnavailable++;
    if (p.textQuality === "empty") s.emptyPages++;
    if (p.textQuality === "low") s.lowTextPages++;
    // A page still needs human attention if it required OCR and OCR did not
    // complete, or if it carries no readable text at all.
    const unresolved = p.requiresOcr && p.ocrStatus !== "completed";
    if (unresolved || p.text.trim().length === 0) s.requiresReview++;
  }
  s.extractionErrors = errors.length;
  return s;
}
