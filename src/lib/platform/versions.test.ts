import { describe, expect, it } from "vitest";
import {
  describeAsOf,
  isVerifiableVersion,
  latestVersion,
  nextVersionNumber,
  planSupersession,
  selectVersionAsOf,
  sortVersionChain,
  summarizeVersionChain,
  validateNewVersion,
} from "./versions";
import type { KnowledgeVersion } from "./types";

const DAY = 86_400_000;
const base = Date.parse("2026-01-01T00:00:00Z");

function version(over: Partial<KnowledgeVersion>): KnowledgeVersion {
  return {
    knowledgeId: "k1",
    versionGroup: "g1",
    versionNumber: 1,
    title: "Requirement",
    statement: "The requirement.",
    sourceId: "src-1",
    status: "active",
    effectiveDate: base,
    ...over,
  };
}

describe("sortVersionChain / latestVersion / nextVersionNumber", () => {
  it("orders oldest first", () => {
    const chain = sortVersionChain([
      version({ knowledgeId: "v2", versionNumber: 2 }),
      version({ knowledgeId: "v1", versionNumber: 1 }),
    ]);
    expect(chain.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it("returns the highest version number as latest", () => {
    const chain = [version({ versionNumber: 1 }), version({ versionNumber: 4 })];
    expect(latestVersion(chain)?.versionNumber).toBe(4);
  });

  it("starts at 1 for an empty chain and increments otherwise", () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber([version({ versionNumber: 3 })])).toBe(4);
  });
});

describe("isVerifiableVersion", () => {
  it("requires a real source and effective date", () => {
    expect(isVerifiableVersion(version({}))).toBe(true);
    expect(isVerifiableVersion(version({ sourceId: "" }))).toBe(false);
    expect(isVerifiableVersion(version({ effectiveDate: null }))).toBe(false);
    expect(isVerifiableVersion(version({ statement: "  " }))).toBe(false);
  });
});

describe("validateNewVersion", () => {
  it("requires an effective date", () => {
    expect(validateNewVersion(version({}), null)).toHaveLength(1);
  });

  it("refuses to backdate a version before the one it supersedes", () => {
    const previous = version({ effectiveDate: base });
    expect(validateNewVersion(previous, base - DAY)).toHaveLength(1);
    expect(validateNewVersion(previous, base + DAY)).toHaveLength(0);
  });
});

describe("selectVersionAsOf (historical accuracy)", () => {
  const v1 = version({
    knowledgeId: "k1:v1",
    versionNumber: 1,
    effectiveDate: base,
    effectiveTo: base + 180 * DAY,
    status: "superseded",
  });
  const v2 = version({
    knowledgeId: "k1:v2",
    versionNumber: 2,
    effectiveDate: base + 180 * DAY,
    effectiveTo: null,
    status: "active",
  });
  const chain = [v1, v2];

  it("selects the version that applied on the date of loss", () => {
    // Date of loss inside the first version's window.
    expect(selectVersionAsOf(chain, base + 100 * DAY)?.knowledgeId).toBe("k1:v1");
  });

  it("selects the current version for a later date", () => {
    expect(selectVersionAsOf(chain, base + 300 * DAY)?.knowledgeId).toBe("k1:v2");
  });

  it("does NOT substitute current knowledge for a date before any version", () => {
    expect(selectVersionAsOf(chain, base - DAY)).toBeNull();
  });

  it("treats an inclusive boundary correctly (new version owns its effective date)", () => {
    expect(selectVersionAsOf(chain, base + 180 * DAY)?.knowledgeId).toBe("k1:v2");
    expect(selectVersionAsOf(chain, base + 180 * DAY - 1)?.knowledgeId).toBe("k1:v1");
  });

  it("ignores versions with no effective date", () => {
    expect(selectVersionAsOf([version({ effectiveDate: null })], base + DAY)).toBeNull();
  });
});

describe("describeAsOf", () => {
  it("states honestly when no version applied", () => {
    const text = describeAsOf(null, base);
    expect(text).toContain("2026-01-01");
    expect(text).toContain("no versioned knowledge");
    expect(text).toContain("does not substitute");
  });

  it("describes the version that applied", () => {
    const text = describeAsOf(version({ versionNumber: 2, version: "2026 ed." }), base);
    expect(text).toContain("version 2");
    expect(text).toContain("2026 ed.");
    expect(text).toContain("src-1");
  });
});

describe("planSupersession", () => {
  it("patches the superseded row without deleting history", () => {
    const patches = planSupersession([version({ knowledgeId: "old", status: "active" })], "new", "old");
    expect(patches).toEqual([
      { knowledgeId: "old", patch: { status: "superseded", supersededBy: ["new"] } },
    ]);
  });

  it("does nothing when there is no previous version", () => {
    expect(planSupersession([], "new", null)).toEqual([]);
  });

  it("does not re-supersede an already superseded row", () => {
    const patches = planSupersession(
      [version({ knowledgeId: "old", status: "superseded" })],
      "new",
      "old",
    );
    expect(patches).toEqual([]);
  });
});

describe("summarizeVersionChain", () => {
  it("counts the chain and flags unreviewed versions", () => {
    const summary = summarizeVersionChain([
      version({ knowledgeId: "a", versionNumber: 1, status: "superseded" }),
      version({ knowledgeId: "b", versionNumber: 2, status: "active", reviewStatus: "needs_review" }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.superseded).toBe(1);
    expect(summary.unpublishedReview).toBe(1);
    expect(summary.current?.knowledgeId).toBe("b");
  });
});
