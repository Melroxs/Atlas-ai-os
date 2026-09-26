// ---------------------------------------------------------------------------
// Atlas Intelligence — public read path
//
// The critical property is negative: a draft must be indistinguishable from a
// missing article, to an anonymous caller AND to a signed-in admin. These tests
// pin that, plus the boundary normalization that keeps a malformed jsonb column
// from crashing a render site.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

import {
  articleUrl,
  getPublishedArticleBySlug,
  listPublishedArticles,
  listRelatedArticles,
  siteOrigin,
} from "./queries";

/** A minimal chainable query builder that records the filters applied. */
function builder(result: { data?: unknown; error?: { message: string } | null }) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn((col: string, value: unknown) => {
      filters[col] = value;
      return chain;
    }),
    not: vi.fn((col: string, op: string) => {
      filters[`not:${col}`] = op;
      return chain;
    }),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(
        resolve,
      ),
  };
  return { chain, filters };
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "row-1",
    slug: "revenue-you-are-already-owed",
    title: "The Revenue You're Already Owed",
    summary: "Where restoration revenue leaks.",
    body: "## Heading\n\nBody text.",
    seo: { motif: "ledger", description: "A description." },
    jurisdiction: null,
    industry: "Insurance Restoration",
    category: "revenue-recovery",
    tags: ["revenue recovery", "supplements"],
    author: "Atlas Intelligence",
    heroImage: "https://cdn.example/blog-media/x/hero.svg",
    socialImage: null,
    readingTime: 5,
    ctaId: "B",
    publishedAt: 1_757_000_000_000,
    updatedAt: 1_757_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listPublishedArticles", () => {
  it("filters on published blog rows only", async () => {
    const { chain, filters } = builder({ data: [publishedRow()] });
    mockFrom.mockReturnValue(chain);

    const rows = await listPublishedArticles(60);

    expect(mockFrom).toHaveBeenCalledWith("atlasContentItems");
    expect(filters.status).toBe("published");
    expect(filters.contentType).toBe("blog");
    expect(filters["not:slug"]).toBe("is");
    expect(rows).toHaveLength(1);
    expect(rows[0].motif).toBe("ledger");
    expect(rows[0].category).toBe("revenue-recovery");
    expect(rows[0].tags).toEqual(["revenue recovery", "supplements"]);
  });

  it("returns an empty list rather than throwing when the read fails", async () => {
    const { chain } = builder({ error: { message: "permission denied" } });
    mockFrom.mockReturnValue(chain);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(listPublishedArticles()).resolves.toEqual([]);
  });
});

describe("getPublishedArticleBySlug", () => {
  it("filters on published, so a draft slug is indistinguishable from a missing one", async () => {
    const { chain, filters } = builder({ data: null });
    mockFrom.mockReturnValue(chain);

    const article = await getPublishedArticleBySlug("a-draft-slug");

    expect(filters.status).toBe("published");
    expect(filters.contentType).toBe("blog");
    expect(article).toBeNull();
  });

  it("returns the article for a published slug", async () => {
    const { chain } = builder({ data: publishedRow() });
    mockFrom.mockReturnValue(chain);

    const article = await getPublishedArticleBySlug("revenue-you-are-already-owed");
    expect(article?.title).toBe("The Revenue You're Already Owed");
    expect(article?.body).toContain("## Heading");
  });

  it("refuses an empty slug without touching the database", async () => {
    expect(await getPublishedArticleBySlug("")).toBeNull();
    expect(await getPublishedArticleBySlug("   ")).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("decodes a tags column that arrives as a JSON string rather than an array", async () => {
    const { chain } = builder({
      data: publishedRow({ tags: '["revenue recovery", "supplements"]' }),
    });
    mockFrom.mockReturnValue(chain);

    const article = await getPublishedArticleBySlug("revenue-you-are-already-owed");
    expect(article?.tags).toEqual(["revenue recovery", "supplements"]);
  });

  it("survives malformed tags and a missing motif", async () => {
    const { chain } = builder({
      data: publishedRow({ tags: "{not json", seo: null }),
    });
    mockFrom.mockReturnValue(chain);

    const article = await getPublishedArticleBySlug("revenue-you-are-already-owed");
    expect(article?.tags).toEqual([]);
    // A missing motif must fall back rather than render nothing.
    expect(article?.motif).toBe("product");
  });
});

describe("listRelatedArticles", () => {
  it("uses the related RPC when it succeeds", async () => {
    mockRpc.mockResolvedValue({
      data: [{ slug: "from-photos-to-evidence", title: "From Photos to Evidence" }],
      error: null,
    });

    const rows = await listRelatedArticles("revenue-you-are-already-owed", 3);
    expect(mockRpc).toHaveBeenCalledWith("content_public_related", {
      p_slug: "revenue-you-are-already-owed",
      p_limit: 3,
    });
    expect(rows[0].slug).toBe("from-photos-to-evidence");
  });

  it("degrades to recent articles instead of showing nothing when the RPC fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "missing function" } });
    const { chain } = builder({
      data: [
        publishedRow({ slug: "other-one" }),
        publishedRow({ slug: "other-two" }),
      ],
    });
    mockFrom.mockReturnValue(chain);

    const rows = await listRelatedArticles("revenue-you-are-already-owed", 2);
    expect(rows.map((r) => r.slug)).toEqual(["other-one", "other-two"]);
  });
});

describe("canonical URLs", () => {
  it("builds an absolute article URL", () => {
    expect(articleUrl("a-slug")).toBe(`${siteOrigin()}/blog/a-slug`);
  });
});
