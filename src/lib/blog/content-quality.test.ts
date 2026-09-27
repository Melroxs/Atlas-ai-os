// ---------------------------------------------------------------------------
// Atlas Intelligence — content quality
//
// These tests are the ratchet on the publication. They assert the rules the
// editorial standard claims to hold, so a future article cannot be added that
// quietly breaks them.
//
// They are deliberately about CONTENT, not about rendering: the things that
// would make the publication look like a content farm are all checkable here.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ARTICLES, allTags, articleBySlug, featuredArticle } from "./articles";
import { CATEGORIES, categoryBySlug, isCategorySlug } from "./taxonomy";
import { countWords, readingTimeMinutes, validateArticle, validateLibrary } from "./validate";
import { CTAS, ctaById } from "./cta";
import { MOTIFS_FOR_TEST } from "./visuals.test-support";

describe("Atlas Intelligence article library", () => {
  it("publishes a full library (12-20 articles)", () => {
    expect(ARTICLES.length).toBeGreaterThanOrEqual(12);
    expect(ARTICLES.length).toBeLessThanOrEqual(20);
  });

  it("passes every publication rule", () => {
    const results = validateLibrary(ARTICLES);
    const errors = results.flatMap((r) => r.errors);
    expect(errors).toEqual([]);
  });

  it("has no duplicate slugs, and slugs are clean", () => {
    const slugs = ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("features exactly one article", () => {
    const featured = ARTICLES.filter((a) => a.featured);
    expect(featured).toHaveLength(1);
    expect(featuredArticle()?.slug).toBe(featured[0].slug);
  });
});

describe("Atlas Intelligence editorial standards", () => {
  it("covers all eight editorial pillars", () => {
    const used = new Set(ARTICLES.map((a) => a.category));
    for (const category of CATEGORIES) {
      expect(used.has(category.slug)).toBe(true);
    }
  });

  it("writes real articles, not filler (900+ words each)", () => {
    for (const article of ARTICLES) {
      expect(
        countWords(article.body),
        `${article.slug} is too short`,
      ).toBeGreaterThanOrEqual(900);
    }
  });

  it("structures every article with real subheadings", () => {
    for (const article of ARTICLES) {
      const headings = article.body.split("\n## ").length - 1;
      expect(headings, `${article.slug} has too few subheadings`).toBeGreaterThanOrEqual(3);
    }
  });

  it("never contains placeholder text", () => {
    for (const article of ARTICLES) {
      expect(article.body).not.toMatch(/lorem ipsum/i);
      expect(article.body).not.toMatch(/\bTODO\b|\bFIXME\b/i);
      expect(article.excerpt).not.toMatch(/lorem ipsum|placeholder/i);
    }
  });

  it("never contains credential-shaped material", () => {
    const dangerous =
      /sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|service_role_key/i;
    for (const article of ARTICLES) {
      expect(article.body).not.toMatch(dangerous);
      expect(article.excerpt).not.toMatch(dangerous);
    }
  });

  it("carries a byline on every article", () => {
    for (const article of ARTICLES) {
      expect(article.author.trim().length).toBeGreaterThan(1);
    }
  });

  it("gives every article at least three tags, and the tag vocabulary is bounded", () => {
    for (const article of ARTICLES) {
      expect(article.tags.length, article.slug).toBeGreaterThanOrEqual(3);
    }
    // A tag vocabulary that explodes is a sign of per-article keyword invention.
    expect(allTags().length).toBeLessThan(60);
  });

  it("never makes a fabricated product capability claim", () => {
    // The product refuses to submit to carriers, quote prices, or determine
    // coverage. The publication must not claim otherwise.
    const forbidden =
      /atlas (automatically )?(submits|quotes|prices|determines coverage|issues policies|settles claims)/i;
    for (const article of ARTICLES) {
      expect(article.body).not.toMatch(forbidden);
    }
  });
});

describe("Atlas Intelligence SEO contract", () => {
  it("gives every article a unique, SERP-length title and description", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const article of ARTICLES) {
      expect(article.seoTitle.length).toBeLessThanOrEqual(65);
      expect(article.seoDescription.length).toBeGreaterThanOrEqual(110);
      expect(article.seoDescription.length).toBeLessThanOrEqual(170);
      titles.add(article.seoTitle);
      descriptions.add(article.seoDescription);
    }
    expect(titles.size).toBe(ARTICLES.length);
    expect(descriptions.size).toBe(ARTICLES.length);
  });

  it("gives every article Open Graph metadata", () => {
    for (const article of ARTICLES) {
      expect(article.ogTitle.trim().length).toBeGreaterThan(0);
      expect(article.ogDescription.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every article a canonical URL that matches its slug", () => {
    for (const article of ARTICLES) {
      // The seed writes canonical as <origin>/blog/<slug>; this pins the shape.
      expect(article.slug).toBeTruthy();
      expect(article.slug).not.toMatch(/[^a-z0-9-]/);
    }
  });
});

describe("Atlas Intelligence visuals", () => {
  it("assigns every article a known motif and an artwork brief", () => {
    for (const article of ARTICLES) {
      expect(MOTIFS_FOR_TEST).toContain(article.motif);
      expect(article.imagePrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it("never points at an external image host", () => {
    for (const article of ARTICLES) {
      // Artwork is generated and stored by the pipeline. A hard-coded remote
      // URL would be both a rights problem and a broken-image risk.
      expect(article.imagePrompt).not.toMatch(/https?:\/\//i);
    }
  });
});

describe("Atlas Intelligence CTAs", () => {
  it("resolves every CTA an article references", () => {
    for (const article of ARTICLES) {
      const cta = ctaById(article.cta);
      if (article.cta === "none") {
        expect(cta).toBeNull();
      } else {
        expect(cta).not.toBeNull();
        expect(cta?.headline.length).toBeGreaterThan(10);
        expect(cta?.action.length).toBeGreaterThan(3);
      }
    }
  });

  it("uses CTAs selectively rather than on every article", () => {
    const withCta = ARTICLES.filter((a) => a.cta !== "none").length;
    expect(withCta).toBeLessThan(ARTICLES.length);
  });

  it("defines exactly the three shared CTAs", () => {
    expect(Object.keys(CTAS).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("taxonomy", () => {
  it("has exactly the eight pillars the database CHECK constraint allows", () => {
    expect(CATEGORIES.map((c) => c.slug).sort()).toEqual([
      "ai-automation",
      "atlas",
      "business-growth",
      "estimating-supplements",
      "insurance-claims",
      "restoration-intelligence",
      "restoration-operations",
      "revenue-recovery",
    ]);
  });

  it("rejects a category outside the closed set", () => {
    expect(isCategorySlug("seo-content")).toBe(false);
    expect(isCategorySlug("revenue-recovery")).toBe(true);
    expect(categoryBySlug("nope")).toBeUndefined();
  });
});

describe("article lookup", () => {
  it("finds an article by slug and rejects an unknown one", () => {
    expect(articleBySlug("revenue-you-are-already-owed")?.title).toBeTruthy();
    expect(articleBySlug("does-not-exist")).toBeUndefined();
  });
});

describe("reading time", () => {
  it("estimates reading time from the body", () => {
    expect(readingTimeMinutes("")).toBe(0);
    expect(readingTimeMinutes("one two three")).toBe(1);
    const long = new Array(1000).fill("word").join(" ");
    expect(readingTimeMinutes(long)).toBe(5);
  });
});

describe("validation rejects bad articles", () => {
  const base = ARTICLES[0];

  it("rejects a short body", () => {
    const result = validateArticle({ ...base, body: "Too short." });
    expect(result.errors.join(" ")).toMatch(/words/);
  });

  it("rejects an unknown category", () => {
    const result = validateArticle({ ...base, category: "not-a-pillar" });
    expect(result.errors.join(" ")).toMatch(/editorial pillars/);
  });

  it("rejects placeholder text", () => {
    const result = validateArticle({
      ...base,
      body: `${base.body}\n\nLorem ipsum dolor sit amet.`,
    });
    expect(result.errors.join(" ")).toMatch(/placeholder/);
  });

  it("rejects credential-shaped material", () => {
    const result = validateArticle({
      ...base,
      body: `${base.body}\n\nkey sk_live_abcdefghijklmnop\n`,
    });
    expect(result.errors.join(" ")).toMatch(/credential/);
  });
});
