import { describe, expect, it, vi } from "vitest";
import type { JobExecutionContext, JobHandler, JobHandlerServices } from "@/lib/jobs/types";
import { validatePublishable } from "./content";
import {
  handleContentPublishBlog,
  handleContentPublishLinkedin,
  type PlatformServices,
} from "./handlers";
import type { ContentItem } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_BODY = Array.from({ length: 260 }, (_, i) => `word${i}`).join(" ");

function approvedArticle(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    _id: "11111111-1111-1111-1111-111111111111",
    contentType: "blog",
    status: "approved",
    slug: null,
    title: "How restoration teams should model supplement recovery",
    summary: "A short thesis for the article.",
    body: `## Section\n\n${LONG_BODY}`,
    seo: null,
    jurisdiction: "US-CA",
    industry: "restoration",
    effectiveDate: null,
    knowledgeIds: ["know_1"],
    sourceIds: ["src_1"],
    approvalStatus: "approved",
    approvedBy: "22222222-2222-2222-2222-222222222222",
    approvedAt: Date.now(),
    publishedAt: null,
    publishTarget: null,
    updatedAt: Date.now(),
    ...overrides,
  } as ContentItem;
}

function makeServices(item: ContentItem | null) {
  const publish = vi.fn(async () => ({ ok: true, slug: "the-slug", canonicalUrl: "https://x/blog/the-slug" }));
  const transition = vi.fn(async () => ({ ok: true, status: "failed" }));
  const get = vi.fn(async () => item);
  const services = {
    sources: {},
    knowledge: {},
    content: { get, create: vi.fn(), transition, publish, review: vi.fn() },
    jobs: {},
    fetch: vi.fn(),
    now: () => Date.now(),
  } as unknown as PlatformServices;
  return { services, publish, transition, get };
}

function ctx(payload: Record<string, unknown>): JobExecutionContext {
  return { job: { _id: "job_1", payload } } as unknown as JobExecutionContext;
}

async function run(handler: JobHandler, payload: Record<string, unknown>) {
  return handler(ctx(payload));
}

// ---------------------------------------------------------------------------
// validatePublishable
// ---------------------------------------------------------------------------

describe("platform/content — validatePublishable", () => {
  it("accepts an approved, sourced, long-enough article", () => {
    const result = validatePublishable(approvedArticle());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("refuses an article that has not been human-approved", () => {
    const result = validatePublishable(approvedArticle({ approvalStatus: "pending" }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/approved by a human/i);
  });

  it("refuses an article that is not in the approved state", () => {
    const result = validatePublishable(approvedArticle({ status: "in_review" }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/approved state/i);
  });

  it("refuses an article with no body", () => {
    const result = validatePublishable(approvedArticle({ body: "   " }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/needs a body/i);
  });

  it("refuses an article below the minimum length", () => {
    const result = validatePublishable(approvedArticle({ body: "too short to publish" }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at least 200/i);
  });

  it("refuses content without provenance", () => {
    const result = validatePublishable(approvedArticle({ sourceIds: [], knowledgeIds: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/authoritative source/i);
  });

  it("refuses placeholder text", () => {
    const result = validatePublishable(
      approvedArticle({ body: `${LONG_BODY}\nTODO: add the real numbers` }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/TODO/i);
  });

  it("refuses leaked credentials", () => {
    const result = validatePublishable(
      approvedArticle({ body: `${LONG_BODY}\nkey sk_live_ABCDEFGHIJKLMNOP` }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/secret key/i);
  });

  it("refuses an empty section (heading with nothing under it)", () => {
    const result = validatePublishable(
      approvedArticle({ body: `## One\n\n## Two\n\n${LONG_BODY}` }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/heading with no content/i);
  });

  it("refuses a LinkedIn post sent to the blog publisher", () => {
    const result = validatePublishable(approvedArticle({ contentType: "linkedin_post" }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/only blog articles/i);
  });
});

// ---------------------------------------------------------------------------
// content_publish_blog handler
// ---------------------------------------------------------------------------

describe("platform/handlers — content_publish_blog", () => {
  it("requires content_id", async () => {
    const { services, publish } = makeServices(approvedArticle());
    const result = await run(handleContentPublishBlog(services), {});
    expect(result.success).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails when the item does not exist", async () => {
    const { services, publish } = makeServices(null);
    const result = await run(handleContentPublishBlog(services), { content_id: "missing" });
    expect(result.success).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses to publish an unapproved article", async () => {
    const { services, publish } = makeServices(approvedArticle({ approvalStatus: "pending" }));
    const result = await run(handleContentPublishBlog(services), { content_id: "x" });
    expect(result.success).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes an approved article and returns its slug", async () => {
    const { services, publish } = makeServices(approvedArticle());
    const result = await run(handleContentPublishBlog(services), {
      content_id: "x",
      base_url: "https://atlas.example",
      actor_user_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(result.success).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        contentId: "x",
        baseUrl: "https://atlas.example",
        actorUserId: "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect((result.result as { slug?: string }).slug).toBe("the-slug");
  });

  it("surfaces a database refusal instead of reporting success", async () => {
    const { services, publish } = makeServices(approvedArticle());
    publish.mockResolvedValueOnce({
      ok: false,
      error: "not_approved",
      detail: "The article must be human-approved before it can be published.",
    } as never);
    const result = await run(handleContentPublishBlog(services), { content_id: "x" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// content_publish_linkedin handler — must never fake a post
// ---------------------------------------------------------------------------

describe("platform/handlers — content_publish_linkedin", () => {
  it("reports NOT_CONFIGURED and records the real state when no credentials exist", async () => {
    const { services, transition } = makeServices(approvedArticle());
    const result = await run(handleContentPublishLinkedin(services), { content_id: "x" });

    expect(result.success).toBe(false);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        contentId: "x",
        status: "failed",
        failureReason: expect.stringContaining("NOT_CONFIGURED"),
      }),
    );
  });
});
