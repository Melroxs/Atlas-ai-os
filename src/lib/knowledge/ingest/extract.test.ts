import { describe, expect, it } from "vitest";
import { extractTrainingManual } from "./extract";
import { makeSyntheticPdf, notAPdf } from "./fixtures";
import { UnavailableOcrProvider, type OcrProvider } from "./ocr-provider";

// NOTE: every PDF in this file is a SYNTHETIC_TEST_FIXTURE. The text is
// artificial and is never represented as Christian Construction manual content.

const buf = (u: Uint8Array) => u.buffer as ArrayBuffer;

/** Test-only OCR provider that returns a fixed result per page. */
function fakeOcr(
  answers: Record<number, { status: "completed" | "failed" | "unavailable"; text?: string }>,
  name = "fake-ocr",
): OcrProvider {
  return {
    name,
    isAvailable: () => true,
    async extractPage(input) {
      const a = answers[input.pageNumber];
      if (!a) {
        return { pageNumber: input.pageNumber, status: "failed", provider: name, message: "no answer" };
      }
      return { pageNumber: input.pageNumber, status: a.status, text: a.text, provider: name };
    },
  };
}

const TEXT_PAGE = (n: number) =>
  `${n}. Inspection Procedures\nSynthetic fixture text for page ${n} of the extractor harness.`;

describe("extractTrainingManual — normal PDF", () => {
  it("preserves page boundaries and never produces a flattened document string", async () => {
    const pdf = makeSyntheticPdf([TEXT_PAGE(1), TEXT_PAGE(2)]);
    const doc = await extractTrainingManual(buf(pdf), { filename: "synthetic.pdf" });

    expect(doc.pageCount).toBe(2);
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(doc.pages[0].text).toContain("page 1");
    expect(doc.pages[1].text).toContain("page 2");
    // The two pages must NOT have been concatenated into one string.
    expect(doc.pages[0].text).not.toContain("page 2");
    expect((doc as unknown as { text?: string }).text).toBeUndefined();
  }, 30_000);

  it("extracts text, method, quality and detected section per page", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1)])), {
      filename: "synthetic.pdf",
    });
    const page = doc.pages[0];
    expect(page.extractionMethod).toBe("text_layer");
    expect(page.textQuality).toBe("good");
    expect(page.charCount).toBeGreaterThan(0);
    expect(page.requiresOcr).toBe(false);
    expect(page.ocrStatus).toBe("not_required");
    expect(page.section).toBe("Inspection Procedures");
    expect(doc.extractionStatus).toBe("complete");
  }, 30_000);

  it("records only metadata actually present (no fabricated author/date)", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1)])), {
      filename: "synthetic-titled-document.pdf",
    });
    expect(doc.metadata.filename).toBe("synthetic-titled-document.pdf");
    expect(doc.metadata.pageCount).toBe(1);
    expect(doc.metadata.author).toBeUndefined();
    expect(doc.metadata.publicationDate).toBeUndefined();
    // Title falls back to the filename as a label — never invented.
    expect(doc.title).toBe("synthetic-titled-document.pdf");
  }, 30_000);
});

describe("extractTrainingManual — scanned and empty pages", () => {
  it("flags an image-only page for OCR and never fabricates text", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1), null])), {
      filename: "synthetic.pdf",
    });
    const scanned = doc.pages[1];
    expect(scanned.text).toBe("");
    expect(scanned.charCount).toBe(0);
    expect(scanned.requiresOcr).toBe(true);
    expect(scanned.ocrReason).toBe("image_only");
    expect(scanned.ocrStatus).toBe("unavailable");
    expect(doc.summary.ocrRequired).toBe(1);
    expect(doc.summary.ocrUnavailable).toBe(1);
    expect(doc.summary.emptyPages).toBe(1);
    expect(doc.extractionStatus).toBe("partial");
  }, 30_000);

  it("reports OCR_UNAVAILABLE explicitly instead of claiming completeness", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([null])), {
      filename: "synthetic.pdf",
    });
    const codes = doc.errors.map((e) => e.code);
    expect(codes).toContain("OCR_UNAVAILABLE");
    expect(doc.summary.requiresReview).toBe(1);
    expect(doc.extractionStatus).not.toBe("complete");
  }, 30_000);

  it("routes a low-text page to OCR with reason low_text", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf(["page ii"])), {
      filename: "synthetic.pdf",
      lowTextThreshold: 40,
    });
    expect(doc.pages[0].requiresOcr).toBe(true);
    expect(doc.pages[0].ocrReason).toBe("low_text");
    expect(doc.pages[0].textQuality).toBe("low");
  }, 30_000);
});

describe("extractTrainingManual — OCR outcomes", () => {
  it("adopts OCR text on success and preserves page provenance", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([null])), {
      filename: "synthetic.pdf",
      ocrProvider: fakeOcr({ 1: { status: "completed", text: "Recovered by OCR engine." } }),
    });
    const page = doc.pages[0];
    expect(page.pageNumber).toBe(1);
    expect(page.text).toBe("Recovered by OCR engine.");
    expect(page.extractionMethod).toBe("ocr");
    expect(page.ocrStatus).toBe("completed");
    expect(page.ocrProvider).toBe("fake-ocr");
    expect(doc.summary.ocrCompleted).toBe(1);
    expect(doc.summary.requiresReview).toBe(0);
    expect(doc.extractionStatus).toBe("complete");
  }, 30_000);

  it("marks a page failed when OCR fails and does NOT claim completeness", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([null])), {
      filename: "synthetic.pdf",
      ocrProvider: fakeOcr({ 1: { status: "failed" } }),
    });
    expect(doc.pages[0].ocrStatus).toBe("failed");
    expect(doc.pages[0].text).toBe("");
    expect(doc.errors.map((e) => e.code)).toContain("OCR_FAILED");
    expect(doc.summary.ocrFailed).toBe(1);
    expect(doc.extractionStatus).not.toBe("complete");
  }, 30_000);

  it("treats a throwing OCR provider as a failed attempt, never a fabrication", async () => {
    const throwing: OcrProvider = {
      name: "throwing",
      isAvailable: () => true,
      async extractPage() {
        throw new Error("engine exploded");
      },
    };
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([null])), {
      filename: "synthetic.pdf",
      ocrProvider: throwing,
    });
    expect(doc.pages[0].ocrStatus).toBe("failed");
    expect(doc.pages[0].text).toBe("");
    expect(doc.errors.map((e) => e.code)).toContain("OCR_FAILED");
  }, 30_000);

  it("uses the honest unavailable provider by default", async () => {
    const doc = await extractTrainingManual(buf(makeSyntheticPdf([null])), {
      filename: "synthetic.pdf",
      ocrProvider: new UnavailableOcrProvider(),
    });
    expect(doc.pages[0].ocrStatus).toBe("unavailable");
    expect(doc.errors.map((e) => e.code)).toContain("OCR_UNAVAILABLE");
  }, 30_000);
});

describe("extractTrainingManual — no page is silently skipped", () => {
  it("keeps every page position even when one is unreadable (no fabricated replacement)", async () => {
    const doc = await extractTrainingManual(
      buf(makeSyntheticPdf([TEXT_PAGE(1), null, TEXT_PAGE(3)])),
      { filename: "synthetic.pdf" },
    );
    expect(doc.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(doc.pages[1].text).toBe("");
    expect(doc.pages[2].text).toContain("page 3");
    // The unreadable page did not shift or replace any other page.
    expect(doc.summary.pages).toBe(3);
  }, 30_000);
});

describe("extractTrainingManual — invalid input", () => {
  it("throws PDF_INVALID for bytes that are not a PDF", async () => {
    await expect(
      extractTrainingManual(buf(notAPdf()), { filename: "nope.pdf" }),
    ).rejects.toThrow(/PDF_INVALID/);
  });

  it("returns a failed document with PDF_UNREADABLE for a corrupt PDF", async () => {
    // Valid magic bytes, invalid body.
    const corrupt = new TextEncoder().encode("%PDF-1.4\nthis body is junk\n%%EOF");
    const doc = await extractTrainingManual(buf(corrupt), { filename: "corrupt.pdf" });
    expect(doc.extractionStatus).toBe("failed");
    expect(doc.errors.map((e) => e.code)).toContain("PDF_UNREADABLE");
    expect(doc.pages).toHaveLength(0);
  }, 30_000);
});

describe("extractTrainingManual — idempotent identity", () => {
  it("gives identical bytes the same fingerprint and version", async () => {
    const a = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1)])), { filename: "a.pdf" });
    const b = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1)])), { filename: "b.pdf" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.version).toBe(b.version);
    expect(a.documentId).toBe(b.documentId);
  }, 30_000);

  it("gives changed bytes a different fingerprint (a new version, not an overwrite)", async () => {
    const a = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(1)])), { filename: "a.pdf" });
    const b = await extractTrainingManual(buf(makeSyntheticPdf([TEXT_PAGE(2)])), { filename: "a.pdf" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.documentId).toBe(b.documentId); // same document identity
  }, 30_000);
});
