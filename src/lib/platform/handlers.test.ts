import { describe, expect, it } from "vitest";
import type { AtlasJob, JobExecutionContext, JobHandler } from "@/lib/jobs/types";
import { contentFingerprint } from "./change-detection";
import { createPlatformHandlers, type PlatformServices } from "./handlers";
import type {
  ContentItem,
  ContentStatus,
  ContentType,
  KnowledgeVersion,
  RegisteredSource,
  SourceCheckOutcome,
} from "./types";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const SOURCE_BODY = "<html><body>Current regulation text</body></html>";

const SOURCE: RegisteredSource = {
  sourceId: "osha-construction",
  name: "OSHA Construction Standards",
  organization: "OSHA",
  authorityTier: "tier1_primary",
  sourceType: "regulation",
  canonicalUrl: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926",
  updateFrequency: "Continuous",
  contentHash: contentFingerprint("Current regulation text"),
  enabled: true,
};

function makeJob(payload: Record<string, unknown>, tenantId: string | null = null): AtlasJob {
  return {
    _id: "job-1",
    _creationTime: NOW,
    tenant_id: tenantId,
    user_id: null,
    job_type: "knowledge_source_check",
    status: "processing",
    priority: 4,
    idempotency_key: "key-1",
    payload,
    result: null,
    error: null,
    attempt_count: 1,
    max_attempts: 3,
    scheduled_at: null,
    started_at: null,
    completed_at: null,
    locked_by: "worker-1",
    locked_at: null,
    lock_expires_at: null,
    parent_job_id: null,
    current_step_id: null,
    tags: [],
    ai_metadata: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
  } as AtlasJob;
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(payload: Record<string, unknown>, tenantId: string | null = null): JobExecutionContext {
  return {
    job: makeJob(payload, tenantId),
    step: null,
    steps: [],
    supabase: null,
    logger: silentLogger,
    signal: new AbortController().signal,
    worker_id: "worker-1",
    attempt: 1,
  };
}

interface HarnessOptions {
  body?: string | null;
  fetchOk?: boolean;
  httpStatus?: number | null;
  retryable?: boolean;
  sources?: RegisteredSource[];
  failedJobs?: Array<Record<string, unknown>>;
  parentContent?: ContentItem | null;
}

function makeHarness(options: HarnessOptions = {}) {
  // Mirrors the real queue: a duplicate idempotency key returns the existing
  // job and does NOT create a second job.
  const createdJobs = new Map<string, string>();
  const enqueued: Array<Parameters<PlatformServices["jobs"]["enqueue"]>[0]> = [];
  const recorded: Array<{ sourceId: string; outcome: SourceCheckOutcome }> = [];
  const created: Array<Parameters<PlatformServices["content"]["create"]>[0]> = [];
  const transitions: Array<Parameters<PlatformServices["content"]["transition"]>[0]> = [];

  const sources = options.sources ?? [SOURCE];
  const body = options.body === undefined ? SOURCE_BODY : options.body;
  const fetchOk = options.fetchOk ?? true;
  const httpStatus = options.httpStatus === undefined ? 200 : options.httpStatus;
  const retryable = options.retryable ?? true;

  const services: PlatformServices = {
    sources: {
      listDue: async () => sources,
      get: async (id) => sources.find((s) => s.sourceId === id) ?? null,
      recordCheck: async (sourceId, outcome) => {
        recorded.push({ sourceId, outcome });
        return { ok: true, check_id: `check-${recorded.length}`, freshness: outcome.status };
      },
    },
    knowledge: {
      listVersions: async () => [] as KnowledgeVersion[],
      createVersion: async (input) => ({ ok: true, knowledge_id: "new", version_number: 2, superseded: null, ...input }),
    },
    content: {
      get: async () => options.parentContent ?? null,
      create: async (input) => {
        created.push(input);
        return { ok: true, content_id: `content-${created.length}` };
      },
      transition: async (input) => {
        transitions.push(input);
        return { ok: true, status: input.status };
      },
    },
    jobs: {
      enqueue: async (input) => {
        const existing = createdJobs.get(input.idempotencyKey);
        if (existing) return { job_id: existing, deduplicated: true };
        const jobId = `job-${enqueued.length + 1}`;
        createdJobs.set(input.idempotencyKey, jobId);
        enqueued.push(input);
        return { job_id: jobId, deduplicated: false };
      },
      listFailed: async () => options.failedJobs ?? [],
    },
    fetch: {
      fetch: async () => ({
        ok: fetchOk,
        httpStatus,
        body: fetchOk ? body : null,
        error: fetchOk ? null : "fetch failed",
        retryable,
        latencyMs: 10,
      }),
    },
    now: () => NOW,
  };

  const handlers = new Map<string, JobHandler>(
    createPlatformHandlers(services).map((h) => [h.jobType, h.handler]),
  );

  return { services, handlers, enqueued, recorded, created, transitions };
}

describe("knowledge_source_check", () => {
  it("records an unchanged check and enqueues NOTHING", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_source_check")!(makeCtx({}));

    expect(result.success).toBe(true);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].outcome.status).toBe("unchanged");
    expect(h.enqueued).toHaveLength(0);
    expect(result.result).toMatchObject({ checked: 1, unchanged: 1, enqueued: 0 });
  });

  it("records a change and enqueues change detection with a deterministic key", async () => {
    const h = makeHarness({ body: "<html><body>Updated regulation</body></html>" });
    const result = await h.handlers.get("knowledge_source_check")!(makeCtx({}));

    expect(h.recorded[0].outcome.status).toBe("changed");
    expect(h.enqueued).toHaveLength(1);
    const enqueued = h.enqueued[0];
    expect(enqueued.jobType).toBe("knowledge_detect_change");
    expect(enqueued.idempotencyKey).toContain("osha-construction");
    expect(enqueued.idempotencyKey).toContain(h.recorded[0].outcome.contentHash!);
    expect(result.result).toMatchObject({ changed: 1, enqueued: 1 });
  });

  it("is idempotent: the same changed fingerprint is never processed twice", async () => {
    const h = makeHarness({ body: "<html><body>Updated regulation</body></html>" });
    const handler = h.handlers.get("knowledge_source_check")!;
    await handler(makeCtx({}));
    const second = await handler(makeCtx({}));

    expect(h.enqueued).toHaveLength(1);
    expect(second.result).toMatchObject({ enqueued: 0 });
  });

  it("records a transient failure without enqueueing work and stays retryable", async () => {
    const h = makeHarness({ fetchOk: false, httpStatus: 503, retryable: true });
    const result = await h.handlers.get("knowledge_source_check")!(makeCtx({}));

    expect(result.success).toBe(true);
    expect(h.recorded[0].outcome.status).toBe("failed");
    expect(h.recorded[0].outcome.retryable).toBe(true);
    expect(h.enqueued).toHaveLength(0);
    expect(result.result).toMatchObject({ failed: 1 });
  });

  it("records a permanent 404 as unavailable and does not retry forever", async () => {
    const h = makeHarness({ fetchOk: false, httpStatus: 404, retryable: false });
    await h.handlers.get("knowledge_source_check")!(makeCtx({}));
    expect(h.recorded[0].outcome.status).toBe("unavailable");
    expect(h.recorded[0].outcome.retryable).toBe(false);
  });

  it("skips a source that has no canonical URL", async () => {
    const h = makeHarness({ sources: [{ ...SOURCE, canonicalUrl: null }] });
    const result = await h.handlers.get("knowledge_source_check")!(makeCtx({}));
    expect(result.result).toMatchObject({ skipped: 1, checked: 0 });
  });

  it("keeps the job's tenant scope on enqueued follow-up work (tenant isolation)", async () => {
    const h = makeHarness({ body: "<html><body>Changed</body></html>" });
    await h.handlers.get("knowledge_source_check")!(
      makeCtx({}, "11111111-1111-1111-1111-111111111111"),
    );
    expect(h.enqueued[0].tenantId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("uses platform scope (null tenant) for global knowledge jobs", async () => {
    const h = makeHarness({ body: "<html><body>Changed</body></html>" });
    await h.handlers.get("knowledge_source_check")!(makeCtx({}, null));
    expect(h.enqueued[0].tenantId).toBeNull();
  });

  it("checks only the named source when source_id is supplied", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_source_check")!(
      makeCtx({ source_id: "osha-construction" }),
    );
    expect(result.result).toMatchObject({ checked: 1 });
  });

  it("succeeds with zero work when the named source does not exist", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_source_check")!(
      makeCtx({ source_id: "does-not-exist" }),
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ checked: 0 });
  });
});

describe("knowledge_detect_change", () => {
  it("pauses for human review and never auto-authors a knowledge version", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_detect_change")!(
      makeCtx({ source_id: "osha-construction", content_hash: "abc", previous_hash: "def" }),
    );

    expect(result.success).toBe(true);
    expect(result.requires_human_review).toBe(true);
    expect(result.result).toMatchObject({
      kind: "knowledge_change_detected",
      source_id: "osha-construction",
    });
    expect(result.result?.recommended_action).toContain("effective date");
  });

  it("is idempotent: an already-processed fingerprint is skipped", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_detect_change")!(
      makeCtx({ source_id: "osha-construction", content_hash: "same", previous_hash: "same" }),
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ skipped: true });
    expect(result.requires_human_review).toBeUndefined();
  });

  it("fails permanently for a missing payload", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_detect_change")!(makeCtx({}));
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
  });

  it("fails permanently for an unregistered source", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_detect_change")!(
      makeCtx({ source_id: "ghost", content_hash: "a", previous_hash: "b" }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.error?.retryable).toBe(false);
  });
});

describe("knowledge_freshness_sweep", () => {
  it("enqueues one bounded source-check job for due sources", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("knowledge_freshness_sweep")!(makeCtx({}));
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].jobType).toBe("knowledge_source_check");
    expect(result.result).toMatchObject({ due: 1, enqueued: 1 });
  });

  it("deduplicates within the same hourly bucket", async () => {
    const h = makeHarness();
    const handler = h.handlers.get("knowledge_freshness_sweep")!;
    await handler(makeCtx({}));
    const second = await handler(makeCtx({}));
    expect(h.enqueued).toHaveLength(1);
    expect(second.result).toMatchObject({ enqueued: 0 });
  });

  it("does nothing when no source is due", async () => {
    const h = makeHarness({
      sources: [{ ...SOURCE, nextCheckAt: NOW + 3_600_000, freshness: "current" }],
    });
    const result = await h.handlers.get("knowledge_freshness_sweep")!(makeCtx({}));
    expect(h.enqueued).toHaveLength(0);
    expect(result.result).toMatchObject({ due: 0 });
  });
});

describe("platform_failed_job_sweep", () => {
  it("reports failed jobs without mutating their state", async () => {
    const failed = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}` }));
    const h = makeHarness({ failedJobs: failed });
    const result = await h.handlers.get("platform_failed_job_sweep")!(makeCtx({}));

    expect(result.success).toBe(true);
    expect(result.result?.failed_count).toBe(40);
    // Bounded sample so the UI never renders an unbounded list.
    expect((result.result?.jobs as unknown[]).length).toBe(25);
    expect(result.result?.note).toContain("nothing is marked complete");
  });

  it("reports zero honestly when there is nothing failed", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("platform_failed_job_sweep")!(makeCtx({}));
    expect(result.result?.failed_count).toBe(0);
  });
});

describe("content_detect_opportunity", () => {
  it("does not invent opportunities", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_detect_opportunity")!(makeCtx({}));
    expect(result.result).toMatchObject({ created: 0 });
    expect(h.created).toHaveLength(0);
  });

  it("materializes a knowledge-backed opportunity", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_detect_opportunity")!(
      makeCtx({
        opportunities: [
          {
            title: "Florida licensing change",
            summary: "What changed.",
            knowledge_ids: ["fl-contractor-license"],
            source_ids: ["fl-dbpr-contractor"],
            jurisdiction: "United States > Florida",
          },
        ],
      }),
    );
    expect(result.result).toMatchObject({ created: 1 });
    expect(h.created[0]).toMatchObject({
      contentType: "blog",
      status: "opportunity",
      knowledgeIds: ["fl-contractor-license"],
      sourceIds: ["fl-dbpr-contractor"],
    });
  });

  it("skips an opportunity with no title and reports it", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_detect_opportunity")!(
      makeCtx({ opportunities: [{ knowledge_ids: ["k"] }] }),
    );
    expect(result.result).toMatchObject({ created: 0 });
    expect((result.result?.skipped as string[]).length).toBe(1);
  });
});

describe("content pipeline transitions", () => {
  it("moves research -> drafted -> in_review explicitly", async () => {
    const h = makeHarness();
    await h.handlers.get("content_research")!(makeCtx({ content_id: "c1" }));
    await h.handlers.get("content_write_blog")!(makeCtx({ content_id: "c1", body: "Real body." }));
    await h.handlers.get("content_review")!(makeCtx({ content_id: "c1" }));

    expect(h.transitions.map((t) => t.status)).toEqual(["researching", "drafted", "in_review"]);
  });

  it("refuses to fabricate an article body", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_write_blog")!(makeCtx({ content_id: "c1" }));
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain("does not invent article content");
    expect(h.transitions).toHaveLength(0);
  });

  it("requires content_id", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_research")!(makeCtx({}));
    expect(result.success).toBe(false);
  });
});

describe("content_write_linkedin", () => {
  const approvedBlog = {
    _id: "blog-1",
    contentType: "blog" as ContentType,
    status: "approved" as ContentStatus,
    title: "Florida licensing update",
    summary: "Thesis sentence.",
    body: "SENTINEL_FULL_ARTICLE_BODY",
    knowledgeIds: ["k1"],
    sourceIds: ["s1"],
    approvalStatus: "approved" as const,
  } as ContentItem;

  it("derives a separate native post that does not copy the article", async () => {
    const h = makeHarness({ parentContent: approvedBlog });
    const result = await h.handlers.get("content_write_linkedin")!(
      makeCtx({ parent_content_id: "blog-1", key_points: ["Point one"] }),
    );

    expect(result.success).toBe(true);
    expect(h.created[0].contentType).toBe("linkedin_post");
    expect(h.created[0].parentContentId).toBe("blog-1");
    expect(h.created[0].body).toContain("Thesis sentence.");
    expect(h.created[0].body).not.toContain("SENTINEL_FULL_ARTICLE_BODY");
  });

  it("refuses when the parent is not approved", async () => {
    const h = makeHarness({
      parentContent: { ...approvedBlog, status: "drafted", approvalStatus: "pending" },
    });
    const result = await h.handlers.get("content_write_linkedin")!(
      makeCtx({ parent_content_id: "blog-1", key_points: ["Point one"] }),
    );
    expect(result.success).toBe(false);
    expect(h.created).toHaveLength(0);
  });

  it("fails permanently when the parent does not exist", async () => {
    const h = makeHarness({ parentContent: null });
    const result = await h.handlers.get("content_write_linkedin")!(
      makeCtx({ parent_content_id: "missing", key_points: ["p"] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("requires a parent id", async () => {
    const h = makeHarness();
    const result = await h.handlers.get("content_write_linkedin")!(makeCtx({}));
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
  });
});

describe("publishing handlers", () => {
  it("are explicitly NOT implemented and never retry", async () => {
    const h = makeHarness();
    for (const jobType of ["content_publish_blog", "content_publish_linkedin"]) {
      const result = await h.handlers.get(jobType)!(makeCtx({}));
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("NOT_IMPLEMENTED");
      expect(result.error?.retryable).toBe(false);
    }
  });
});

describe("handler registration surface", () => {
  it("registers exactly the documented platform job types", () => {
    const h = makeHarness();
    expect([...h.handlers.keys()].sort()).toEqual(
      [
        "content_detect_opportunity",
        "content_publish_blog",
        "content_publish_linkedin",
        "content_research",
        "content_review",
        "content_write_blog",
        "content_write_linkedin",
        "knowledge_detect_change",
        "knowledge_freshness_sweep",
        "knowledge_source_check",
        "platform_failed_job_sweep",
      ].sort(),
    );
  });
});
