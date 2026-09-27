import { describe, expect, it } from "vitest";
import type { KnowledgeItem } from "../types";
import {
  CONTENT_INGESTED,
  TRAINING_MANUAL_SOURCE,
  TRAINING_MANUAL_SOURCE_ID,
} from "../training-manual";
import type { CandidateItem } from "./candidates";
import { buildCandidateItems } from "./candidates";
import { extractTrainingManual } from "./extract";
import { makeSyntheticPdf } from "./fixtures";
import { ingestCandidateItems, ingestTrainingManualDocument } from "./pipeline";
import type { TrainingManualDocument, TrainingManualPage } from "./types";

// Synthetic fixture text only — never manual content.

function page(pageNumber: number, text: string, section?: string): TrainingManualPage {
  return {
    pageNumber,
    text,
    extractionMethod: "text_layer",
    textQuality: text.trim().length === 0 ? "empty" : "good",
    charCount: text.length,
    requiresOcr: false,
    ocrStatus: "not_required",
    section,
  };
}

function doc(pages: TrainingManualPage[]): TrainingManualDocument {
  return {
    documentId: TRAINING_MANUAL_SOURCE_ID,
    fingerprint: "deadbeefcafef00d",
    version: "deadbeef",
    filename: "synthetic.pdf",
    title: "synthetic.pdf",
    pageCount: pages.length,
    extractionStatus: "complete",
    metadata: { filename: "synthetic.pdf", pageCount: pages.length },
    pages,
    summary: {
      pages: pages.length,
      textExtracted: pages.length,
      ocrRequired: 0,
      ocrCompleted: 0,
      ocrFailed: 0,
      ocrUnavailable: 0,
      requiresReview: 0,
      emptyPages: 0,
      lowTextPages: 0,
      extractionErrors: 0,
    },
    errors: [],
  };
}

function candidate(overrides: Partial<CandidateItem["item"]> = {}): CandidateItem {
  return {
    page: 1,
    block: 0,
    item: {
      id: "tm_x_p1_0",
      layer: "atlas_industry",
      sourceClassification: "TRAINING_MANUAL",
      sourceId: TRAINING_MANUAL_SOURCE_ID,
      documentId: TRAINING_MANUAL_SOURCE_ID,
      title: "Documentation",
      statement: "Record every observed condition with photographs.",
      knowledgeType: "training_guidance",
      confidence: 0.55,
      status: "draft",
      isInference: false,
      locator: { page: 1, section: "Documentation" },
      temporalScope: "historical_context",
      tags: ["source-training-manual", "historical-2020-2021"],
      evidenceStatus: "supported_potential",
      ...overrides,
    },
  };
}

describe("candidate construction", () => {
  it("uses the document's own text as the statement — no paraphrase", () => {
    const d = doc([page(1, "1. Inspection\nObserve the roof surface.", "Inspection")]);
    const items = buildCandidateItems(d);
    expect(items.length).toBeGreaterThan(0);
    for (const c of items) {
      expect(d.pages[0].text).toContain(c.item.statement);
    }
  });

  it("attaches a page locator to every candidate", () => {
    const items = buildCandidateItems(doc([page(1, "A block of body text here.")]));
    for (const c of items) expect(c.item.locator?.page).toBe(1);
    // The document has no flattened string property at all.
    const d = doc([page(1, "A block of body text here.")]);
    expect((d as unknown as { text?: string }).text).toBeUndefined();
    expect(buildCandidateItems(d).length).toBeGreaterThan(0);
  });
});

describe("guardrail enforcement", () => {
  it("rejects a candidate that claims manual provenance without a page", () => {
    const { outcomes } = ingestCandidateItems([
      candidate({ id: "tm_bad", locator: undefined }),
    ]);
    expect(outcomes[0].decision).toBe("rejected");
    expect(outcomes[0].guardrail.violations.map((v) => v.rule)).toContain("missing_locator");
  });

  it("accepts a candidate that carries a page", () => {
    const { accepted } = ingestCandidateItems([candidate()]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].locator?.page).toBe(1);
  });

  it("caps authority at the TRAINING_MANUAL tier and cannot be raised", () => {
    const { accepted } = ingestCandidateItems([candidate({ confidence: 0.99 })]);
    expect(accepted[0].sourceClassification).toBe("TRAINING_MANUAL");
    expect(accepted[0].confidence).toBeLessThanOrEqual(0.55);
  });

  it("marks manual items historical and forces the historical tag", () => {
    const { accepted } = ingestCandidateItems([
      candidate({ temporalScope: undefined, tags: ["estimates"] }),
    ]);
    expect(accepted[0].temporalScope).toBe("historical_context");
    expect(accepted[0].tags).toContain("historical-2020-2021");
  });

  it("retains a warning against misconduct as knowledge", () => {
    const { accepted, rejected, report } = ingestCandidateItems([
      candidate({ id: "tm_warn", title: "Ethics", statement: "Never fabricate a measurement." }),
    ]);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(report.prohibitedWarningsRetained).toBe(1);
    expect(report.prohibitedDirectivesRejected).toBe(0);
  });

  it("rejects an instruction that facilitates misconduct", () => {
    const { accepted, rejected, report } = ingestCandidateItems([
      candidate({
        id: "tm_directive",
        title: "Estimating",
        statement: "Invent a measurement where none was taken.",
      }),
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].guardrail.violations.map((v) => v.rule)).toContain("prohibited_practice");
    expect(report.prohibitedDirectivesRejected).toBe(1);
  });

  it("rejects a passage asserting coverage, which the manual cannot establish", () => {
    const { rejected } = ingestCandidateItems([
      candidate({
        id: "tm_coverage",
        title: "Coverage",
        statement: "This damage is covered by the policy.",
      }),
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].guardrail.violations.map((v) => v.rule)).toContain("legal_authority_claim");
  });

  it("attaches a current-authority boundary to a regulated-topic item", () => {
    const { accepted, outcomes } = ingestCandidateItems([
      candidate({
        id: "tm_boundary",
        title: "Licensing",
        statement: "Contractor licensing requirements vary by state.",
      }),
    ]);
    // The record is kept as training content, but the boundary is attached.
    expect(accepted).toHaveLength(1);
    expect(outcomes[0].boundary?.requiresCurrentAuthorityVerification).toBe(true);
    expect(outcomes[0].boundary?.handoff.deferTo.length).toBeGreaterThan(0);
  });
});

describe("deduplication integration", () => {
  it("merges an exact duplicate on a second run — idempotent re-ingestion", () => {
    const d = doc([page(1, "Record every observed condition with photographs.")]);
    const first = ingestTrainingManualDocument(d);
    expect(first.accepted.length).toBeGreaterThan(0);

    const second = ingestTrainingManualDocument(
      doc([page(1, "Record every observed condition with photographs.")]),
      { existing: first.accepted },
    );
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates.length).toBeGreaterThan(0);
    expect(second.report.duplicatesMerged).toBeGreaterThan(0);
  });

  it("preserves a higher-authority existing record instead of overwriting it", () => {
    const regulatory: KnowledgeItem = {
      ...candidate().item,
      id: "kr_1",
      sourceClassification: "REGULATORY",
      sourceId: "src_reg",
      documentId: "reg-doc",
    };
    const { outcomes, report } = ingestCandidateItems([candidate({ id: "tm_incoming" })], {
      existing: [regulatory],
    });
    expect(outcomes[0].decision).not.toBe("duplicate");
    expect(report.higherAuthorityPreserved).toBeGreaterThan(0);
  });
});

describe("ingestion report", () => {
  it("reports 100% page provenance for accepted items", () => {
    const d = doc([
      page(1, "1. Inspection\nObserve the roof surface and record the conditions.", "Inspection"),
      page(2, "2. Documentation\nRecord every finding with a photograph.", "Documentation"),
    ]);
    const result = ingestTrainingManualDocument(d);
    expect(result.report.itemsMissingProvenance).toBe(0);
    expect(result.report.provenanceWithPagePercent).toBe(100);
  });

  it("accounts for every extracted candidate exactly once", () => {
    const d = doc([page(1, "First block of synthetic text.\n\nSecond block of synthetic text.")]);
    const result = ingestTrainingManualDocument(d);
    const { itemsExtracted, itemsAccepted, itemsRejected, itemsRequiringReview } = result.report;
    expect(itemsAccepted + itemsRejected + itemsRequiringReview + result.report.duplicatesMerged).toBe(
      itemsExtracted,
    );
  });
});

describe("end-to-end: PDF → candidates → guarded records", () => {
  it("runs the full flow and never reports success for a scanned page", async () => {
    const pdf = makeSyntheticPdf([
      "1. Inspection\nObserve the roof surface and record the observed conditions.",
      null,
    ]);
    const document = await extractTrainingManual(pdf.buffer as ArrayBuffer, {
      filename: "synthetic.pdf",
    });
    const result = ingestTrainingManualDocument(document);
    expect(result.report.itemsExtracted).toBeGreaterThan(0);
    expect(result.report.provenanceWithPagePercent).toBe(100);
    // The scanned page contributed no knowledge and is reported unresolved.
    expect(document.extractionStatus).toBe("partial");
    expect(document.errors.map((e) => e.code)).toContain("OCR_UNAVAILABLE");
  }, 30_000);
});

describe("source remains awaiting the real document", () => {
  it("does not flip the manual to ingested (no PDF is present)", () => {
    expect(CONTENT_INGESTED).toBe(false);
    expect(TRAINING_MANUAL_SOURCE.contentIngested).toBe(false);
    expect(TRAINING_MANUAL_SOURCE.ingestionState).toBe("awaiting_document");
  });
});
