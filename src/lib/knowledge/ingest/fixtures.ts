// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — SYNTHETIC TEST FIXTURES ONLY
//
// SYNTHETIC_TEST_FIXTURE. Nothing here is manual content. These builders exist
// solely so the extraction + ingestion machinery can be tested before the real
// 114-page PDF is available. The text used by tests is deliberately artificial
// and, where a prohibited practice is exercised, plainly instructional so the
// guardrails can be shown to fire.
//
// A multi-page PDF writer is needed because `makePdf` (src/lib/npp/pdf.ts)
// produces a single page and cannot model the two cases that matter most here:
// page boundaries and pages with no text layer (scanned/image-only).
// ---------------------------------------------------------------------------

export const SYNTHETIC_TEST_FIXTURE = "synthetic_test_fixture";

function escapePdfText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, "")
    .replace(/\n/g, " ");
}

function wrap(text: string, width = 92): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      if (line && (line + " " + w).length > width) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Build a synthetic multi-page text PDF.
 *
 * `pages[i]` is the text for page i+1. A `null` or empty string produces a page
 * with an EMPTY content stream — i.e. a page with no text layer, which is how a
 * scanned/image-only page presents to the extractor.
 */
export function makeSyntheticPdf(pages: Array<string | null>): Uint8Array {
  if (pages.length === 0) pages = [null];

  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  let next = 3; // 1 = catalog, 2 = pages, 3 = font
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(++next);
    contentObjNums.push(++next);
  }
  const totalObjects = next;

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((pageText, i) => {
    const pageObj = pageObjNums[i];
    const contentObj = contentObjNums[i];
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;

    let content = "";
    if (pageText && pageText.trim()) {
      const lines = wrap(pageText);
      const parts = ["BT", "/F1 11 Tf", "50 760 Td", "16 TL"];
      for (const line of lines) parts.push(`(${escapePdfText(line)}) Tj`, "T*");
      parts.push("ET");
      content = parts.join("\n");
    }
    objects[contentObj] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= totalObjects; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A synthetic PDF whose bytes are not a PDF at all (for PDF_INVALID tests). */
export function notAPdf(): Uint8Array {
  return new TextEncoder().encode("this is not a pdf, it is synthetic fixture text");
}
