// ---------------------------------------------------------------------------
// Regression tests — supplement document boundary (legacy evidence shapes).
//
// Production defect guarded:
//   insurance_get_supplement_document returns raw { claim, supplement } rows.
//   ClaimDetail's supplement document dialog rendered doc.sections.map(...),
//   doc.disclaimer, doc.status — none of which exist on the raw payload, so
//   clicking "View document" crashed with
//   "Cannot read properties of undefined (reading 'map')". Legacy supplement
//   rows can also carry string/object evidence instead of an array, which
//   used to crash `.join()` on the same dialog.
//
// The boundary now builds the derived document deterministically
// (normalizeSupplementDocumentResponse → buildSupplementDocument) and every
// list-valued field passes through the canonical evidence decoder — a legacy
// shape is coerced (value preserved), never dropped, never fabricated, and
// iteration never throws.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildSupplementDocument, normalizeSupplementDocumentResponse } from "./logic";

const CLAIM = {
  _id: "c1",
  claimNumber: "GAP-26-51847",
  customer: "NPP Roofing & Restoration",
  property: "123 Maple St",
  carrier: "StateFarm",
  status: "opened",
  createdAt: 1_700_000_000_000,
};

const SUPPLEMENT = {
  _id: "s1",
  claimId: "c1",
  reason: "Missing line item 12",
  amount: 4250,
  affectedLineItems: ["12", "14"],
  requestedItems: ["Line item 12"],
  evidence: ["Invoice-51847.pdf", "Estimate-51847.pdf"],
  justification: "Scope documented in photos and invoice.",
  status: "draft",
  createdAt: 1_700_000_100_000,
};

function section(doc: { sections: Array<{ title: string; body: string[] }> }, title: string) {
  return doc.sections.find((s) => s.title === title)?.body ?? [];
}

describe("normalizeSupplementDocumentResponse", () => {
  it("returns null for a null/missing/empty payload (dialog shows its loading state)", () => {
    expect(normalizeSupplementDocumentResponse(null)).toBeNull();
    expect(normalizeSupplementDocumentResponse(undefined)).toBeNull();
    expect(normalizeSupplementDocumentResponse("nope")).toBeNull();
    expect(normalizeSupplementDocumentResponse([])).toBeNull();
    expect(normalizeSupplementDocumentResponse({})).toBeNull();
  });

  it("builds the derived document from the deployed { claim, supplement } wrapper", () => {
    const doc = normalizeSupplementDocumentResponse({ claim: CLAIM, supplement: SUPPLEMENT });
    expect(doc).not.toBeNull();
    expect(doc!.status).toBe("draft");
    expect(doc!.requestedAmount).toBe(4250);
    expect(doc!.disclaimer.length).toBeGreaterThan(0);
    expect(Array.isArray(doc!.sections)).toBe(true);
    expect(doc!.sections.length).toBeGreaterThan(0);
    expect(section(doc!, "Supporting evidence")).toEqual([
      "Invoice-51847.pdf; Estimate-51847.pdf",
    ]);
    // The exact render pattern of ClaimDetail's SupplementDocumentDialog.
    expect(() => {
      doc!.sections.map((s) => s.body.map((line) => line));
    }).not.toThrow();
  });

  it("accepts an already-flat supplement row", () => {
    const doc = normalizeSupplementDocumentResponse({ ...SUPPLEMENT });
    expect(doc).not.toBeNull();
    expect(doc!.status).toBe("draft");
    expect(Array.isArray(doc!.sections)).toBe(true);
  });

  it("survives a legacy string evidence value without crashing or dropping it", () => {
    const doc = normalizeSupplementDocumentResponse({
      claim: CLAIM,
      supplement: { ...SUPPLEMENT, evidence: "estimate, invoice" },
    });
    expect(doc).not.toBeNull();
    // The legacy text is preserved verbatim as a single evidence entry.
    expect(section(doc!, "Supporting evidence")).toEqual(["estimate, invoice"]);
  });

  it("parses a JSON array-literal string (pre-jsonb write path) into its entries", () => {
    const doc = normalizeSupplementDocumentResponse({
      claim: CLAIM,
      supplement: { ...SUPPLEMENT, evidence: '["estimate","photos"]' },
    });
    expect(doc).not.toBeNull();
    expect(section(doc!, "Supporting evidence")).toEqual(["estimate; photos"]);
  });

  it("coerces an object affectedLineItems/requestedItems into a single entry", () => {
    const doc = normalizeSupplementDocumentResponse({
      claim: CLAIM,
      supplement: {
        ...SUPPLEMENT,
        affectedLineItems: { 0: "12", 1: "14" },
        requestedItems: "Line item 12",
      },
    });
    expect(doc).not.toBeNull();
    expect(section(doc!, "Affected line items")[0]).toContain("12");
    expect(section(doc!, "Revised scope / items requested")).toEqual(["Line item 12"]);
  });

  it("always renders all sections even when the supplement row is sparse", () => {
    const doc = normalizeSupplementDocumentResponse({
      claim: CLAIM,
      supplement: { _id: "s1", reason: "R" },
    });
    expect(doc).not.toBeNull();
    const titles = doc!.sections.map((s) => s.title);
    expect(titles).toContain("Supporting evidence");
    expect(titles).toContain("Requested amount");
    // No `.map()`/`.join()` over any section body can throw.
    expect(() => {
      for (const s of doc!.sections) s.body.forEach((l) => l.length);
    }).not.toThrow();
  });
});

describe("buildSupplementDocument (direct, legacy shapes)", () => {
  it("never throws on string / object / missing list fields", () => {
    const doc = buildSupplementDocument(CLAIM as never, {
      reason: "R",
      evidence: "estimate" as never,
      requestedItems: { a: "x" } as never,
      affectedLineItems: null,
    });
    expect(section(doc, "Supporting evidence")).toEqual(["estimate"]);
    expect(section(doc, "Revised scope / items requested")[0]).toContain("x");
  });

  it("coerces legacy string scope lists on the claim", () => {
    const doc = buildSupplementDocument(
      { ...CLAIM, expectedScope: "roof, gutters" as never, actualScope: "roof" as never } as never,
      { reason: "R", requestedItems: null },
    );
    expect(section(doc, "Original scope")).toEqual(["roof, gutters"]);
    expect(section(doc, "Revised scope / items requested")[0]).toContain("roof");
  });

  it("falls back to honest 'not documented' copy when evidence is missing", () => {
    const doc = buildSupplementDocument(CLAIM as never, { reason: "R" });
    expect(section(doc, "Supporting evidence")[0]).toContain("No supporting evidence");
  });
});