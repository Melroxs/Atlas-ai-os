import { describe, expect, it } from "vitest";
import {
  buildLinkedInDraft,
  buildProvenanceChain,
  buildSeoMetadata,
  canTransition,
  deriveKeywords,
  groupProvenanceByContent,
  hasCompleteProvenance,
  nextContentStatuses,
  requiresHumanApproval,
  slugify,
  validateContentDraft,
  validateTransition,
} from "./content";
import type { ContentItem, KnowledgeVersion } from "./types";

const BLOG: Pick<
  ContentItem,
  | "_id"
  | "contentType"
  | "title"
  | "summary"
  | "status"
  | "approvalStatus"
  | "sourceIds"
  | "knowledgeIds"
> = {
  _id: "content-1",
  contentType: "blog",
  title: "Florida contractor licensing changes",
  summary: "A summary of the verified change.",
  status: "approved",
  approvalStatus: "approved",
  sourceIds: ["fl-dbpr-contractor"],
  knowledgeIds: ["fl-contractor-license"],
};

describe("content state machine", () => {
  it("allows the research -> draft -> review -> approve -> publish path", () => {
    expect(canTransition("opportunity", "researching")).toBe(true);
    expect(canTransition("researching", "drafted")).toBe(true);
    expect(canTransition("drafted", "in_review")).toBe(true);
    expect(canTransition("in_review", "approved")).toBe(true);
    expect(canTransition("approved", "published")).toBe(true);
  });

  it("refuses to skip straight from opportunity to published", () => {
    expect(canTransition("opportunity", "published")).toBe(false);
    expect(validateTransition({ status: "opportunity", approvalStatus: "pending", contentType: "blog" }, "published").ok).toBe(false);
  });

  it("hard-gates publishing behind explicit approval", () => {
    const result = validateTransition(
      { status: "approved", approvalStatus: "pending", contentType: "blog" },
      "published",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("approved");
  });

  it("allows publishing only once approved", () => {
    const result = validateTransition(
      { status: "approved", approvalStatus: "approved", contentType: "blog" },
      "published",
    );
    expect(result.ok).toBe(true);
  });

  it("marks approval and publication as human-owned", () => {
    expect(requiresHumanApproval("approved")).toBe(true);
    expect(requiresHumanApproval("published")).toBe(true);
    expect(requiresHumanApproval("drafted")).toBe(false);
  });

  it("lists valid next statuses", () => {
    expect(nextContentStatuses("in_review")).toEqual(["approved", "failed", "archived"]);
    expect(nextContentStatuses("archived")).toEqual([]);
  });
});

describe("validateContentDraft", () => {
  it("requires a title", () => {
    expect(validateContentDraft({ contentType: "blog", title: "  " }).errors).toHaveLength(1);
  });

  it("requires a parent for a LinkedIn post", () => {
    const result = validateContentDraft({
      contentType: "linkedin_post",
      title: "Post",
      parentContentId: null,
    });
    expect(result.errors.join(" ")).toContain("parent blog article");
  });

  it("requires provenance beyond the opportunity stage", () => {
    const result = validateContentDraft({
      contentType: "blog",
      title: "Article",
      status: "drafted",
      knowledgeIds: [],
    });
    expect(result.errors.join(" ")).toContain("at least one knowledge item");
  });

  it("accepts a well-formed opportunity", () => {
    const result = validateContentDraft({
      contentType: "blog",
      title: "Article",
      status: "opportunity",
      knowledgeIds: ["k1"],
    });
    expect(result.errors).toEqual([]);
  });
});

describe("slugify", () => {
  it("produces url-safe slugs", () => {
    expect(slugify("Florida Contractor Licensing: What Changed?")).toBe(
      "florida-contractor-licensing-what-changed",
    );
  });

  it("strips accents and bounds length", () => {
    expect(slugify("Café Réglementation")).toBe("cafe-reglementation");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("buildSeoMetadata", () => {
  it("builds the SEO contract without inventing dates", () => {
    const seo = buildSeoMetadata(
      {
        title: "Florida licensing update",
        summary: "What changed and why it matters.",
        body: null,
        slug: null,
        jurisdiction: "United States > Florida",
        industry: "insurance restoration",
        publishedAt: null,
        updatedAt: null,
      },
      "https://atlas.example",
    );
    expect(seo.slug).toBe("florida-licensing-update");
    expect(seo.canonicalUrl).toBe("https://atlas.example/blog/florida-licensing-update");
    expect(seo.publishedDate).toBeUndefined();
    expect(seo.jurisdiction).toBe("United States > Florida");
    expect(seo.keywords?.length).toBeGreaterThan(0);
  });

  it("uses real dates when they exist", () => {
    const seo = buildSeoMetadata({
      title: "T",
      summary: "S",
      body: null,
      slug: "t",
      jurisdiction: null,
      industry: null,
      publishedAt: Date.parse("2026-09-01T00:00:00Z"),
      updatedAt: Date.parse("2026-09-02T00:00:00Z"),
    });
    expect(seo.publishedDate).toBe("2026-09-01");
    expect(seo.updatedDate).toBe("2026-09-02");
  });

  it("derives keywords from real words only", () => {
    const keywords = deriveKeywords("The quick brown fox", null);
    expect(keywords).toContain("quick");
    expect(keywords).toContain("brown");
    expect(keywords).not.toContain("the");
  });
});

describe("buildLinkedInDraft", () => {
  it("refuses before research is complete", () => {
    const res = buildLinkedInDraft({ ...BLOG, status: "researching" }, ["point"]);
    expect(res.ok).toBe(false);
  });

  it("refuses when the parent is not approved", () => {
    const res = buildLinkedInDraft(
      { ...BLOG, approvalStatus: "pending", status: "drafted" },
      ["point"],
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("approved");
  });

  it("refuses when there is no thesis material, instead of copying the article", () => {
    const res = buildLinkedInDraft({ ...BLOG, summary: null }, []);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("will not duplicate");
  });

  it("derives a short native post that does NOT reproduce the article body", () => {
    const res = buildLinkedInDraft(
      { ...BLOG, summary: "Thesis sentence." },
      ["Key point one", "Key point two"],
    );
    expect(res.ok).toBe(true);
    expect(res.post?.parentContentId).toBe("content-1");
    expect(res.post?.body).toContain("Thesis sentence.");
    expect(res.post?.body).toContain("Key point one");
    expect(res.post?.body.length).toBeLessThanOrEqual(1_300);
  });

  it("bounds the post length", () => {
    const res = buildLinkedInDraft({ ...BLOG, summary: "T" }, ["x".repeat(4000)], { maxChars: 200 });
    expect(res.post!.body.length).toBeLessThanOrEqual(200);
  });
});

describe("provenance chain", () => {
  const knowledge: KnowledgeVersion[] = [
    {
      knowledgeId: "fl-contractor-license",
      versionGroup: "fl-contractor-license",
      versionNumber: 2,
      title: "Florida contractor licensing",
      statement: "Statement",
      sourceId: "fl-dbpr-contractor",
      status: "active",
      reviewStatus: "verified",
      effectiveDate: Date.parse("2026-07-01T00:00:00Z"),
    },
  ];

  it("links source -> version -> verified -> content", () => {
    const chain = buildProvenanceChain(BLOG, knowledge, [
      { sourceId: "fl-dbpr-contractor", name: "Florida DBPR" },
    ]);
    expect(chain.map((s) => s.level)).toEqual([
      "authoritative_source",
      "knowledge_version",
      "verified_intelligence",
      "content_research",
      "blog_article",
    ]);
    expect(chain[0].label).toBe("Florida DBPR");
    expect(chain[1].detail).toContain("Version 2");
    expect(chain[2].detail).toContain("verified");
  });

  it("surfaces a missing source instead of skipping the hop", () => {
    const chain = buildProvenanceChain(BLOG, [], []);
    expect(chain[0].detail).toContain("must not be published");
  });

  it("flags verified vs unverified intelligence honestly", () => {
    const chain = buildProvenanceChain(
      BLOG,
      [{ ...knowledge[0], reviewStatus: "needs_review" }],
      [{ sourceId: "fl-dbpr-contractor", name: "Florida DBPR" }],
    );
    const verifiedStep = chain.find((s) => s.level === "verified_intelligence")!;
    expect(verifiedStep.detail).toContain("not yet authoritative");
  });

  it("requires both a source and knowledge for publishable provenance", () => {
    expect(hasCompleteProvenance(BLOG)).toBe(true);
    expect(hasCompleteProvenance({ sourceIds: [], knowledgeIds: ["k"] })).toBe(false);
  });

  it("groups provenance edges by content", () => {
    const grouped = groupProvenanceByContent([
      { contentId: "a", knowledgeId: "k1" },
      { contentId: "a", knowledgeId: "k2" },
      { contentId: "b", knowledgeId: "k3" },
    ]);
    expect(grouped.a).toHaveLength(2);
    expect(grouped.b).toHaveLength(1);
  });
});
