import { describe, expect, it } from "vitest";
import {
  parseRegulatoryDate,
  extractCitations,
  extractDeadline,
  extractActor,
  actorMentions,
  detectClaimPhases,
  isRequirement,
  isProhibition,
  extractException,
  normalizeRuleText,
  isDirectRuleStatement,
} from "./extraction";

describe("date parsing", () => {
  it("parses ISO, month-name, MM/DD/YYYY, and bare year", () => {
    expect(parseRegulatoryDate("2025-07-01")).toBe(Date.UTC(2025, 6, 1));
    expect(parseRegulatoryDate("January 1, 2025")).toBe(Date.UTC(2025, 0, 1));
    expect(parseRegulatoryDate("Dec. 31, 2024")).toBe(Date.UTC(2024, 11, 31));
    expect(parseRegulatoryDate("07/01/2025")).toBe(Date.UTC(2025, 6, 1));
    expect(parseRegulatoryDate("2024")).toBe(Date.UTC(2024, 0, 1));
  });

  it("returns undefined for garbage input", () => {
    expect(parseRegulatoryDate("not a date")).toBeUndefined();
    expect(parseRegulatoryDate("")).toBeUndefined();
    expect(parseRegulatoryDate("13/40/2025")).toBeUndefined();
  });
});

describe("citation extraction", () => {
  it("extracts state statute citations", () => {
    const cites = extractCitations(
      "Pursuant to Fla. Stat. § 627.428 and Texas Insurance Code § 542.051, the carrier must respond.",
    );
    expect(cites.some((c) => c.includes("627.428"))).toBe(true);
    expect(cites.some((c) => c.includes("542.051"))).toBe(true);
  });

  it("extracts generic section and CFR references", () => {
    const cites = extractCitations(
      "See § 1926.501 and 29 CFR 1926.501(a)(1); also 40 CFR 745.",
    );
    expect(cites.some((c) => c.includes("1926.501"))).toBe(true);
    expect(cites.some((c) => c.includes("40 CFR 745"))).toBe(true);
  });

  it("extracts US Code and public law references", () => {
    const cites = extractCitations("42 U.S.C. § 5151 and Pub. L. 116-93 apply.");
    expect(cites.some((c) => c.includes("42 U.S.C."))).toBe(true);
    expect(cites.some((c) => c.includes("116-93"))).toBe(true);
  });

  it("returns no citations for plain text", () => {
    expect(extractCitations("The carrier must respond promptly to all claims.")).toEqual([]);
  });
});

describe("deadline extraction", () => {
  it("extracts within-N-days deadlines", () => {
    const d = extractDeadline("The insurer must acknowledge receipt within 14 days of notice.");
    expect(d?.amount).toBe(14);
    expect(d?.unit).toBe("calendar_days");
  });

  it("extracts business days", () => {
    const d = extractDeadline("Payment is due within 15 business days after approval.");
    expect(d?.amount).toBe(15);
    expect(d?.unit).toBe("business_days");
  });

  it("extracts word-number deadlines", () => {
    const d = extractDeadline("Proof of loss must be filed within thirty (30) days.");
    expect(d?.amount).toBe(30);
  });

  it("extracts no-later-than deadlines", () => {
    const d = extractDeadline("The carrier must respond no later than 60 days after receipt.");
    expect(d?.amount).toBe(60);
  });

  it("returns undefined when no deadline is present", () => {
    expect(extractDeadline("The carrier must act in good faith.")).toBeUndefined();
  });
});

describe("actor extraction", () => {
  it("prefers restoration contractor for contractor rules", () => {
    expect(extractActor("A contractor may not waive the insured's deductible.")).toBe("restoration_contractor");
  });

  it("detects public adjuster rules", () => {
    expect(extractActor("A public adjuster must be licensed by the department.")).toBe("public_adjuster");
  });

  it("detects insurer duties", () => {
    expect(extractActor("The insurer shall pay undisputed amounts within 30 days.")).toBe("insurer");
  });

  it("returns all mentioned actors", () => {
    const mentions = actorMentions("The insured may hire a public adjuster; the insurer must respond.");
    expect(mentions).toContain("insured");
    expect(mentions).toContain("public_adjuster");
    expect(mentions).toContain("insurer");
  });
});

describe("claim-phase detection", () => {
  it("detects supplement and dispute phases", () => {
    const phases = detectClaimPhases(
      "Supplemental claims may be reopened; appraisal is available for disputed amounts.",
    );
    expect(phases).toContain("supplement_submission");
    expect(phases).toContain("dispute");
    expect(phases).toContain("reopening");
  });

  it("detects payment deadlines", () => {
    const phases = detectClaimPhases("The insurer must pay the claim within 30 days.");
    expect(phases).toContain("payment");
  });
});

describe("requirement / prohibition classification", () => {
  it("classifies shall/must as requirement", () => {
    expect(isRequirement("The insurer shall acknowledge the claim.")).toBe(true);
    expect(isRequirement("Payment must be made within 30 days.")).toBe(true);
  });

  it("classifies prohibitions", () => {
    expect(isProhibition("A contractor may not waive the deductible.")).toBe(true);
    expect(isProhibition("No person shall act as a public adjuster without a license.")).toBe(true);
  });

  it("does not misclassify ordinary statements", () => {
    expect(isRequirement("The claim was paid.")).toBe(false);
    expect(isProhibition("The claim was denied.")).toBe(false);
  });
});

describe("exception + normalization", () => {
  it("extracts exception clauses", () => {
    const ex = extractException(
      "The insurer must respond within 14 days, unless additional information is requested from the insured.",
    );
    expect(ex).toContain("unless");
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeRuleText("  The   Insurer MUST  respond. ")).toBe("the insurer must respond.");
  });

  it("detects direct rule statements vs hedging", () => {
    expect(isDirectRuleStatement("The insurer must respond within 14 days.")).toBe(true);
    expect(isDirectRuleStatement("I believe the insurer must respond.")).toBe(false);
  });
});