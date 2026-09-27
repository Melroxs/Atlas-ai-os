// ---------------------------------------------------------------------------
// PDF text extraction — pdfjs-dist (browser-safe).
//
// Production defect this fixes: the previous parser (pdf-parse) is a Node
// library that dynamically require()s an internal copy of pdf.js at runtime:
//
//   Could not dynamically require "./pdf.js/v1.10.100/build/pdf.js"
//
// A runtime require() of a path the bundler never saw cannot survive Vite's
// production bundle, so in the deployed browser every PDF failed with that
// error even though the same code passed in Node tests.
//
// This module uses pdfjs-dist — the ESM PDF engine Firefox ships — which
// Vite bundles natively. The LEGACY build is used so the exact same module
// runs in the browser and in Node (unit tests): the main build references
// browser-only globals (DOMMatrix) at module scope and is not usable under
// Node. The worker script is emitted as a static asset via the
// `new URL(..., import.meta.url)` pattern and handed to pdf.js through
// GlobalWorkerOptions.workerSrc. In Node pdf.js runs on the main thread
// without a worker, and if the browser worker ever fails to load pdf.js
// automatically falls back to main-thread execution — text extraction never
// depends on a fragile runtime require().
// ---------------------------------------------------------------------------

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

let workerConfigured = false;

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    !!process.versions.node
  );
}

/** Point pdf.js at the bundled worker asset. Safe to call repeatedly. */
function ensurePdfWorker(): void {
  if (workerConfigured) return;
  workerConfigured = true;
  // Node (unit tests): pdf.js detects isNodeJS, disables the worker and
  // resolves its own worker module relative to the package — overriding
  // workerSrc with a Vite asset URL would break that resolution.
  if (isNodeRuntime()) return;
  try {
    // Browser: Vite statically rewrites this literal to the hashed asset it
    // emits for the worker file, so workerSrc points at a real same-origin
    // module. If that worker ever fails to load, pdf.js automatically falls
    // back to main-thread execution (the fake worker imports the same URL).
    GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  } catch {
    // Keep pdf.js' default resolution if URL construction is unavailable.
  }
}

/** Text extracted from a single PDF page. */
export interface PdfPageText {
  /** 1-indexed page number, always preserved — page boundaries are mandatory. */
  pageNumber: number;
  /** Extracted text for this page ("" for scanned/image-only pages). */
  text: string;
}

/**
 * Document metadata as ACTUALLY present in the PDF's info dictionary. Every
 * field is optional because a manual PDF frequently carries none of them —
 * callers must never infer a value the file did not contain.
 */
export interface PdfDocumentMetadata {
  title?: string;
  author?: string;
  producer?: string;
  creationDate?: string;
}

/** A PDF's page count, per-page text, and metadata. */
export interface PdfStructure {
  numPages: number;
  pages: PdfPageText[];
  metadata: PdfDocumentMetadata;
}

/**
 * Read a PDF's structure in ONE load: page count, per-page text, and the
 * metadata dictionary. Prefer this over `extractPdfPages` when metadata is
 * needed too, so the file is not parsed twice.
 */
export async function extractPdfStructure(
  bytes: ArrayBuffer,
  onPageError?: (pageNumber: number, error: unknown) => void,
): Promise<PdfStructure> {
  ensurePdfWorker();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = getDocument({
    data,
    // Buffers are supplied locally — never touch the network layer.
    useWorkerFetch: false,
  });
  const doc = await task.promise;
  try {
    let metadata: PdfDocumentMetadata = {};
    try {
      const info = (await doc.getMetadata())?.info as Record<string, unknown> | undefined;
      const pick = (k: string): string | undefined => {
        const v = info?.[k];
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      };
      metadata = {
        title: pick("Title"),
        author: pick("Author"),
        producer: pick("Producer"),
        creationDate: pick("CreationDate"),
      };
    } catch {
      // Metadata is optional; a missing dictionary is not an error.
      metadata = {};
    }

    const pages: PdfPageText[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const lines: string[] = [];
        let line = "";
        for (const item of content.items) {
          if (typeof (item as { str?: unknown }).str !== "string") continue;
          const { str, hasEOL } = item as { str: string; hasEOL: boolean };
          line += str;
          if (hasEOL) {
            if (line.trim()) lines.push(line.trim());
            line = "";
          } else {
            line += " ";
          }
        }
        if (line.trim()) lines.push(line.trim());
        pages.push({ pageNumber: pageNum, text: lines.join("\n") });
      } catch (e) {
        // A page failed to render/content-extract. Record it honestly as an
        // empty page (the caller marks it for review) instead of skipping it.
        onPageError?.(pageNum, e);
        pages.push({ pageNumber: pageNum, text: "" });
      } finally {
        page.cleanup();
      }
    }
    return { numPages: doc.numPages, pages, metadata };
  } finally {
    // Destroying the loading task tears down the worker + frees the buffer.
    await task.destroy();
  }
}

/**
 * Extract the text layer of a PDF ONE PAGE AT A TIME.
 *
 * Unlike a flat document string, this keeps the page boundary for every
 * extracted block, which is what page-level provenance requires. A page with
 * no text layer yields `text: ""` (never fabricated) so the caller can route
 * it to OCR. Throws for corrupt/unreadable PDFs; a per-page failure inside a
 * readable document is reported to the caller via `onPageError` rather than
 * silently dropping the page. Delegates to `extractPdfStructure`.
 */
export async function extractPdfPages(
  bytes: ArrayBuffer,
  onPageError?: (pageNumber: number, error: unknown) => void,
): Promise<PdfPageText[]> {
  const structure = await extractPdfStructure(bytes, onPageError);
  return structure.pages;
}

/**
 * Extract the text layer of a PDF as one flat string. Returns "" when the PDF
 * has no text layer (scanned documents) so callers can decide whether OCR
 * applies — this function never fabricates content. Throws for corrupt/
 * unreadable PDFs. Delegates to `extractPdfPages` so the two stay consistent.
 */
export async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const pages = await extractPdfPages(bytes);
  return pages
    .map((p) => p.text)
    .join("\n")
    .trim();
}
