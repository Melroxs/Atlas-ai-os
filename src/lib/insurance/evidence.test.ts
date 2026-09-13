// ---------------------------------------------------------------------------
// Regression tests — canonical evidence decoder + findings boundary fix.
//
// Production defect guarded:
//   claimFindings.evidence was a TEXT column. The write path inserted a jsonb
//   value (assignment-cast to its text rendering, e.g. `["estimate"]`) and the
//   read path serialized the row with to_jsonb(), which turned that text back
//   into a JSON *string*. ClaimDetail called `(f.evidence ?? []).map(...)` and
//   threw `TypeError: f.evidence.map is not a function` for every claim with
//   persisted findings; the package builder silently dropped the evidence.
//
// The decoder below must NEVER throw, must never fabricate entries, and must
// never drop the original value. The boundary normalizers must guarantee that
// every finding row reaching a page carries `evidence` as a real string array.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  normalizeEvidence,
  normalizeEvidenceRow,
  normalizeEvidenceRows,
} from "./evidence";
import {
  matchCandidateEvidenceDocs,
  normalizeClaimListResponse,
  normalizeClaimPackageResponse,
} from "./logic";

describe("normalizeEvidence (canonical decoder)", () => {
  it("returns [] for missing / null / undefined evidence", () => {
    expect(normalizeEvidence(null)).toEqual([]);
    expect(normalizeEvidence(undefined)).toEqual([]);
    expect(normalizeEvidence("")).toEqual([]);
    expect(normalizeEvidence("null")).toEqual([]);
  });

  it("passes a real array through unchanged (current canonical shape)", () => {
    expect(normalizeEvidence(["estimate", "invoice"])).toEqual(["estimate", "invoice"]);
    expect(normalizeEvidence([])).toEqual([]);
  });

  it("decodes a JSON-array string (the pre-jsonb TEXT column shape)", () => {
    // This is exactly what to_jsonb(text) used to return to the browser:
    // the string `["estimate","invoice"]`, not an array.
    expect(normalizeEvidence('["estimate","invoice"]')).toEqual(["estimate", "invoice"]);
    expect(normalizeEvidence("[]")).toEqual([]);
  });

  it("preserves legacy plain-text evidence as a single discoverable entry", () => {
    expect(normalizeEvidence("estimate, invoice")).toEqual(["estimate, invoice"]);
    expect(normalizeEvidence("estimate")).toEqual(["estimate"]);
  });

  it("never throws on malformed JSON — keeps the raw value, never drops it", () => {
    expect(normalizeEvidence('["estimate",')).toEqual(['["estimate",']);
    expect(normalizeEvidence("{not json}")).toEqual(["{not json}"]);
  });

  it("keeps unexpected shapes discoverable instead of silently returning []", () => {
    expect(normalizeEvidence(42)).toEqual(["42"]);
    expect(normalizeEvidence({ kind: "estimate" })).toEqual(['{"kind":"estimate"}']);
  });
});

describe("normalizeEvidenceRow / normalizeEvidenceRows", () => {
  it("returns a new row with evidence guaranteed to be an array", () => {
    const row = normalizeEvidenceRow({ _id: "f1", title: "Missing line item", evidence: '["estimate"]' });
    expect(row.evidence).toEqual(["estimate"]);
    expect(row._id).toBe("f1");
  });

  it("handles mixed shapes and non-array inputs without throwing", () => {
    const rows = normalizeEvidenceRows([
      { _id: "f1", evidence: ["estimate"] },
      { _id: "f2", evidence: '["invoice"]' },
      { _id: "f3", evidence: "legacy text" },
      { _id: "f4", evidence: null },
      "garbage",
      null,
    ]);
    expect(rows).toHaveLength(6);
    expect(rows[0].evidence).toEqual(["estimate"]);
    expect(rows[1].evidence).toEqual(["invoice"]);
    expect(rows[2].evidence).toEqual(["legacy text"]);
    expect(rows[3].evidence).toEqual([]);
    expect(rows[4]).toEqual({ evidence: [] });
    expect(rows[5]).toEqual({ evidence: [] });
    expect(normalizeEvidenceRows(null)).toEqual([]);
    expect(normalizeEvidenceRows({})).toEqual([]);
  });
});

describe("findings boundary normalization (the crash site)", () => {
  const RAW_CLAIM = {
    _id: "c1",
    claimNumber: "GAP-26-51847",
    customer: "NPP Roofing & Restoration",
    status: "opened",
  };

  it("normalizeClaimPackageResponse gives every finding an array evidence field", () => {
    const pkg = normalizeClaimPackageResponse({
      claim: RAW_CLAIM,
      findings: [
        // Legacy TEXT-column shape: evidence arrives as a JSON string.
        { _id: "f1", title: "Legacy finding", status: "open", evidence: '["estimate","invoice"]' },
        // Current jsonb shape: real array.
        { _id: "f2", title: "Current finding", status: "open", evidence: ["photos"] },
        // Missing evidence.
        { _id: "f3", title: "No evidence", status: "open" },
        // Legacy plain text.
        { _id: "f4", title: "Plain text legacy", status: "open", evidence: "scope report" },
      ],
    });
    expect(pkg).not.toBeNull();
    const findings = pkg!.findings as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(4);
    for (const f of findings) {
      // The page calls .map() / .length on this field — it MUST be an array.
      expect(Array.isArray(f.evidence)).toBe(true);
    }
    expect(findings[0].evidence).toEqual(["estimate", "invoice"]);
    expect(findings[1].evidence).toEqual(["photos"]);
    expect(findings[2].evidence).toEqual([]);
    expect(findings[3].evidence).toEqual(["scope report"]);
  });

  it("normalizeClaimListResponse keeps finding evidence as arrays on list rows", () => {
    const rows = normalizeClaimListResponse([
      {
        claim: RAW_CLAIM,
        findings: [
          { _id: "f1", status: "open", evidence: '["estimate"]' },
          { _id: "f2", status: "open", evidence: null },
        ],
        supplements: [],
      },
    ]);
    expect(rows).toHaveLength(1);
    const findings = rows[0].findings as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(Array.isArray(f.evidence)).toBe(true);
    }
    expect(findings[0].evidence).toEqual(["estimate"]);
    expect(findings[1].evidence).toEqual([]);
  });
});

describe("candidate evidence matching (legacy shapes)", () => {
  const docs = [
    { _id: "d1", title: "Invoice-51847.pdf" },
    { _id: "d2", title: "Estimate-51847.pdf" },
    { _id: "d3", title: "Scope-51847.pdf" },
  ];

  it("matches real arrays (current canonical shape)", () => {
    const ids = matchCandidateEvidenceDocs(
      { evidence: ["Invoice-51847.pdf", "Estimate-51847.pdf"] },
      docs,
    );
    expect(ids.sort()).toEqual(["d1", "d2"]);
  });

  it("survives legacy string evidence and still matches the referenced doc", () => {
    // A legacy candidate row can hold a plain path string instead of an
    // array. It must be preserved (single entry) and still participate in
    // matching — never silently dropped to [] (data loss) and never a crash.
    const ids = matchCandidateEvidenceDocs(
      { evidence: "Invoice-51847.pdf" },
      docs,
    );
    expect(ids).toEqual(["d1"]);
  });

  it("handles JSON-array-literal strings, nulls and missing fields", () => {
    const ids = matchCandidateEvidenceDocs(
      { evidence: '["Scope-51847.pdf"]', filePaths: null, documentTitles: undefined },
      docs,
    );
    expect(ids).toEqual(["d3"]);
    expect(matchCandidateEvidenceDocs({ evidence: null }, docs)).toEqual([]);
    expect(matchCandidateEvidenceDocs({}, docs)).toEqual([]);
  });
});