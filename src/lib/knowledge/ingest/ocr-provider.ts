// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — OCR abstraction
//
// The ingestion pipeline must not hard-code an OCR vendor. This module defines
// the seam: an `OcrProvider` is asked for one page at a time, and the pipeline
// treats its answer as authoritative about the OCR *attempt* — never about the
// page content.
//
// The only provider shipped today is `UnavailableOcrProvider`, which reports
// `status: "unavailable"`. It MUST NEVER manufacture text: a scanned page that
// no engine could read is knowledge that does not exist yet, and pretending
// otherwise would put invented content behind a real page citation.
//
// To enable OCR later, implement `OcrProvider` (e.g. over a hosted Tesseract
// endpoint) and pass it to `extractTrainingManual`. No pipeline change is
// required.
// ---------------------------------------------------------------------------

/** One page handed to an OCR engine. */
export interface OcrPageInput {
  /** 1-indexed page number the result must be attributed to. */
  pageNumber: number;
  /** Full source bytes; a provider may slice the page it needs. */
  bytes: ArrayBuffer;
  /** Source mime type (always application/pdf for the manual). */
  mimeType: string;
}

/**
 * A page's OCR result. `text` is only meaningful when `status === "completed"`.
 * `failed` means an engine ran and errored; `unavailable` means no engine was
 * configured. The pipeline surfaces them differently, so they are distinct.
 */
export interface OcrPageResult {
  pageNumber: number;
  status: "completed" | "failed" | "unavailable";
  /** Extracted text — present only for `completed`. Never synthesized. */
  text?: string;
  /** Provider name, recorded on the page for provenance. */
  provider: string;
  /** Human reason for a non-completed result. */
  message?: string;
}

/** An OCR engine the pipeline can consult. */
export interface OcrProvider {
  name: string;
  /** Whether this provider can actually attempt OCR right now. */
  isAvailable(): boolean;
  /** Attempt OCR for a single page. Must never fabricate text. */
  extractPage(input: OcrPageInput): Promise<OcrPageResult>;
}

/**
 * The honest default: no OCR engine is configured. Returns `unavailable` for
 * every page and never invents content.
 */
export class UnavailableOcrProvider implements OcrProvider {
  readonly name = "unavailable";

  isAvailable(): boolean {
    return false;
  }

  async extractPage(input: OcrPageInput): Promise<OcrPageResult> {
    return {
      pageNumber: input.pageNumber,
      status: "unavailable",
      provider: this.name,
      message:
        "No OCR engine is configured in this environment. The page has no text layer, so no text was extracted. No content was invented for it.",
    };
  }
}

/** Shared singleton instance of the unavailable provider. */
export const unavailableOcrProvider = new UnavailableOcrProvider();

/**
 * Build an `OcrProvider` from the existing `src/lib/ingest/ocr.ts` functions.
 * That module is the product's OCR hook; when a real engine is wired there this
 * adapter exposes it to the ingestion pipeline without duplicating the engine
 * choice. Currently it is unavailable, so this returns the unavailable provider.
 */
export function fromIngestOcr(available: boolean, ocr: (bytes: ArrayBuffer) => Promise<{ text: string } | null>, name = "ingest-ocr"): OcrProvider {
  return {
    name,
    isAvailable: () => available,
    async extractPage(input) {
      if (!available) {
        return {
          pageNumber: input.pageNumber,
          status: "unavailable",
          provider: name,
          message: "The configured OCR engine reports itself unavailable.",
        };
      }
      try {
        const result = await ocr(input.bytes);
        if (result?.text?.trim()) {
          return {
            pageNumber: input.pageNumber,
            status: "completed",
            text: result.text.trim(),
            provider: name,
          };
        }
        return {
          pageNumber: input.pageNumber,
          status: "failed",
          provider: name,
          message: "The OCR engine returned no readable text for this page.",
        };
      } catch (e) {
        return {
          pageNumber: input.pageNumber,
          status: "failed",
          provider: name,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
