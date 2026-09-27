import { describe, expect, it } from "vitest";
import { detectSections, detectTableOfContents, type PageTextInput } from "./sections";

// Synthetic test fixture text only.
const pages: PageTextInput[] = [
  { pageNumber: 1, text: "Table of Contents\n1. Inspection ........ 3\n2. Documentation ........ 9" },
  { pageNumber: 2, text: "FOREWORD\nAll figures are synthetic." },
  { pageNumber: 3, text: "1. Inspection\nObserve the roof surface." },
  { pageNumber: 4, text: "The inspector records conditions." },
  { pageNumber: 5, text: "2. Documentation\nRecord every finding." },
];

describe("section detection", () => {
  it("detects the document's own table of contents", () => {
    const toc = detectTableOfContents(pages);
    expect(toc.has("inspection")).toBe(true);
    expect(toc.has("documentation")).toBe(true);
  });

  it("assigns a section from a numbered heading and carries it forward", () => {
    const a = detectSections(pages);
    const byPage = new Map(a.map((x) => [x.pageNumber, x]));
    expect(byPage.get(3)?.section).toBe("Inspection");
    expect(byPage.get(3)?.confidence).toBeGreaterThanOrEqual(0.9); // in TOC
    // Continuation page inherits the section in force.
    expect(byPage.get(4)?.section).toBe("Inspection");
    expect(byPage.get(4)?.uncertain).toBe(false);
    expect(byPage.get(5)?.section).toBe("Documentation");
  });

  it("adopts an ALL-CAPS heading when it survives the digit/letter test", () => {
    const a = detectSections([{ pageNumber: 1, text: "ESTIMATING PRINCIPLES\nBody text." }]);
    expect(a[0].section).toBe("Estimating Principles");
    expect(a[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("does NOT treat a numeric data row as a heading", () => {
    const a = detectSections([{ pageNumber: 1, text: "1234 5678 9012 3456" }]);
    expect(a[0].section).toBeUndefined();
    expect(a[0].uncertain).toBe(true);
  });

  it("leaves the section unknown when nothing confirms one — never invents it", () => {
    const a = detectSections([{ pageNumber: 1, text: "ordinary body text with no heading at all." }]);
    expect(a[0].section).toBeUndefined();
    expect(a[0].uncertain).toBe(true);
    // Page provenance remains intact even with no section.
    expect(a[0].pageNumber).toBe(1);
  });

  it("flags an ambiguous heading-shaped page as uncertain rather than adopting it", () => {
    // Ends with a comma → not treated as a heading by the caps heuristic.
    const a = detectSections([{ pageNumber: 1, text: "SOME TEXT THAT LOOKS LIKE A HEADING," }]);
    expect(a[0].section).toBeUndefined();
    expect(a[0].uncertain).toBe(true);
  });
});
