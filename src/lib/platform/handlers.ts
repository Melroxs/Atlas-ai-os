// ---------------------------------------------------------------------------
// Atlas Platform — Job handlers
//
// Small, composable workers that plug into the EXISTING job system
// (@/lib/jobs/handler-registry) — there is no second queue.
//
//   Job -> dispatcher (existing AtlasWorker) -> ONE specific handler -> result
//
// Every handler:
//   - is safe to retry (idempotent by fingerprint / idempotency key)
//   - performs no irreversible side effect twice
//   - depends on no browser state and no open page
//   - fails visibly instead of marking work complete
//
// All I/O goes through injectable ports so the handlers are unit-testable
// without a database or network.
// ---------------------------------------------------------------------------

import type {
  HandlerResult,
  JobExecutionContext,
  JobHandler,
} from "@/lib/jobs/types";
import { createJobError } from "@/lib/jobs/engine";
import { registerJobHandlers } from "@/lib/jobs/handler-registry";
import {
  isSourceDue,
  normalizeSourceContent,
  outcomeFromFetch,
  planFollowOnWork,
  shouldProcessChange,
} from "./change-detection";
import { buildLinkedInDraft, validateContentDraft } from "./content";
import type {
  ContentItem,
  ContentStatus,
  ContentType,
  KnowledgeVersion,
  RegisteredSource,
  SourceCheckOutcome,
  SourceFetcher,
} from "./types";

// ---------------------------------------------------------------------------
// Ports (implemented against Supabase in ./services)
// ---------------------------------------------------------------------------

export interface SourceRegistryPort {
  listDue(limit: number): Promise<RegisteredSource[]>;
  get(sourceId: string): Promise<RegisteredSource | null>;
  recordCheck(
    sourceId: string,
    outcome: SourceCheckOutcome,
    jobId: string | null,
    checker: string,
  ): Promise<{ ok: boolean; check_id?: string; freshness?: string; error?: string }>;
}

export interface KnowledgePort {
  listVersions(versionGroup: string): Promise<KnowledgeVersion[]>;
  createVersion(input: {
    versionGroup: string;
    sourceId: string;
    title: string;
    statement: string;
    effectiveDate: number;
    interpretation?: string | null;
    jurisdiction?: string | null;
    industry?: string | null;
    version?: string | null;
    confidence?: number;
    reviewStatus?: string;
    contentHash?: string | null;
    sourceCheckId?: string | null;
    jobId?: string | null;
  }): Promise<{ ok: boolean; knowledge_id?: string; version_number?: number; error?: string }>;
}

export interface ContentPort {
  get(contentId: string): Promise<ContentItem | null>;
  create(input: {
    contentType: ContentType;
    title: string;
    slug?: string | null;
    summary?: string | null;
    body?: string | null;
    seo?: Record<string, unknown>;
    jurisdiction?: string | null;
    industry?: string | null;
    effectiveDate?: number | null;
    knowledgeIds?: string[];
    sourceIds?: string[];
    parentContentId?: string | null;
    researchJobId?: string | null;
    status?: ContentStatus;
  }): Promise<{ ok: boolean; content_id?: string; error?: string }>;
  transition(input: {
    contentId: string;
    status: ContentStatus;
    note?: string | null;
    body?: string | null;
    seo?: Record<string, unknown> | null;
    failureReason?: string | null;
    draftJobId?: string | null;
  }): Promise<{ ok: boolean; status?: string; error?: string }>;
}

export interface JobsPort {
  enqueue(input: {
    jobType: string;
    tenantId?: string | null;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    tags?: string[];
  }): Promise<{ job_id: string; deduplicated: boolean }>;
  listFailed(limit: number): Promise<Array<Record<string, unknown>>>;
}

export interface PlatformServices {
  sources: SourceRegistryPort;
  knowledge: KnowledgePort;
  content: ContentPort;
  jobs: JobsPort;
  fetch: SourceFetcher;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isDuplicateError(message: string | undefined): boolean {
  if (!message) return false;
  return /duplicate|unique|already exists/i.test(message);
}

function validationFailure(message: string, details: Record<string, unknown> = {}): HandlerResult {
  return {
    success: false,
    error: createJobError("VALIDATION_FAILED", message, details, false),
  };
}

function sourceTargets(
  payload: Record<string, unknown>,
  services: PlatformServices,
  defaultLimit: number,
): Promise<RegisteredSource[]> | RegisteredSource[] {
  const single = str(payload.source_id);
  if (single) {
    return services.sources.get(single).then((s) => (s ? [s] : []));
  }
  return services.sources.listDue(num(payload.limit, defaultLimit));
}

// ---------------------------------------------------------------------------
// Knowledge — source check (the fetch -> normalize -> compare worker)
// ---------------------------------------------------------------------------

const DEFAULT_CHECK_LIMIT = 25;

export const handleKnowledgeSourceCheck: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const targets = await sourceTargets(payload, services, DEFAULT_CHECK_LIMIT);

    const summary: Record<string, number> = {
      checked: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
      unavailable: 0,
      skipped: 0,
      enqueued: 0,
    };
    const errors: string[] = [];

    for (const source of targets) {
      if (ctx.signal.aborted) break;

      const url = source.canonicalUrl ?? null;
      if (!url) {
        summary.skipped++;
        continue;
      }

      const fetched = await services.fetch.fetch(url);
      const normalized =
        fetched.ok && fetched.body != null ? normalizeSourceContent(fetched.body) : null;
      const outcome = outcomeFromFetch(fetched, normalized, source.contentHash ?? null);

      const recorded = await services.sources.recordCheck(
        source.sourceId,
        outcome,
        ctx.job._id ?? null,
        ctx.worker_id,
      );
      if (!recorded.ok) {
        errors.push(`${source.sourceId}: ${recorded.error ?? "check could not be recorded"}`);
      }

      summary.checked++;
      summary[outcome.status] = (summary[outcome.status] ?? 0) + 1;

      const follow = planFollowOnWork(outcome);
      if (shouldProcessChange(outcome) && follow.kind === "detect_change" && outcome.contentHash) {
        const enqueued = await services.jobs.enqueue({
          jobType: "knowledge_detect_change",
          tenantId: ctx.job.tenant_id ?? null,
          // Deterministic: the same changed fingerprint is never processed twice.
          idempotencyKey: `knowledge_detect_change:${source.sourceId}:${outcome.contentHash}`,
          payload: {
            source_id: source.sourceId,
            content_hash: outcome.contentHash,
            previous_hash: outcome.previousHash,
            change_type: outcome.changeType,
            check_id: recorded.check_id ?? null,
          },
          priority: 3,
          tags: ["knowledge", "change-detection"],
        });
        if (!enqueued.deduplicated) summary.enqueued++;
      }
    }

    return { success: true, result: { ...summary, errors } };
  };

// ---------------------------------------------------------------------------
// Knowledge — change detected (pause for human review; never auto-author)
// ---------------------------------------------------------------------------

export const handleKnowledgeDetectChange: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const sourceId = str(payload.source_id);
    const contentHash = str(payload.content_hash);
    const previousHash = str(payload.previous_hash);

    if (!sourceId || !contentHash) {
      return validationFailure("knowledge_detect_change requires source_id and content_hash.", {
        source_id: sourceId,
        content_hash: contentHash,
      });
    }

    // Idempotency: a retry of an already-processed fingerprint is a no-op.
    if (previousHash && previousHash === contentHash) {
      return {
        success: true,
        result: { skipped: true, reason: "Fingerprint already processed; no new change." },
      };
    }

    const source = await services.sources.get(sourceId);
    if (!source) {
      return {
        success: false,
        error: createJobError("NOT_FOUND", `Source ${sourceId} is not registered.`, { source_id: sourceId }, false),
      };
    }

    // A detected change is a POTENTIAL change. Atlas must not treat an
    // unreviewed reading as authoritative, so the job pauses durably for a
    // human instead of writing a new knowledge version automatically.
    return {
      success: true,
      requires_human_review: true,
      result: {
        kind: "knowledge_change_detected",
        source_id: sourceId,
        source_name: source.name,
        organization: source.organization,
        authority_tier: source.authorityTier,
        change_type: str(payload.change_type) ?? "content_changed",
        content_hash: contentHash,
        previous_hash: previousHash,
        check_id: str(payload.check_id),
        detected_at: services.now(),
        canonical_url: source.canonicalUrl ?? null,
        recommended_action:
          "Review the changed source, then create a new knowledge version with its real effective date.",
      },
    };
  };

// ---------------------------------------------------------------------------
// Knowledge — freshness sweep (enqueue checks for due sources)
// ---------------------------------------------------------------------------

const DEFAULT_SWEEP_LIMIT = 100;

export const handleKnowledgeFreshnessSweep: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const limit = num(payload.limit, DEFAULT_SWEEP_LIMIT);
    const due = await services.sources.listDue(limit);
    const now = services.now();
    const eligible = due.filter((s) => isSourceDue(s, now));

    if (eligible.length === 0) {
      return { success: true, result: { due: 0, enqueued: 0 } };
    }

    // One hourly bucket key: a sweep retry within the same hour is deduplicated.
    const bucket = Math.floor(now / 3_600_000);
    const enqueued = await services.jobs.enqueue({
      jobType: "knowledge_source_check",
      tenantId: ctx.job.tenant_id ?? null,
      idempotencyKey: `knowledge_source_check:sweep:${bucket}`,
      payload: { limit: eligible.length },
      priority: 4,
      tags: ["knowledge", "freshness"],
    });

    return {
      success: true,
      result: { due: eligible.length, enqueued: enqueued.deduplicated ? 0 : 1, job_id: enqueued.job_id },
    };
  };

// ---------------------------------------------------------------------------
// Platform — failed job sweep (report only; never silently completes)
// ---------------------------------------------------------------------------

export const handlePlatformFailedJobSweep: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const limit = num(payload.limit, 50);
    const failed = await services.jobs.listFailed(limit);
    return {
      success: true,
      result: {
        failed_count: failed.length,
        // Bounded sample: the UI renders compactly, never an unbounded list.
        jobs: failed.slice(0, 25),
        note:
          "Failed jobs remain failed and visible. Retry is an explicit operator action; nothing is marked complete here.",
      },
    };
  };

// ---------------------------------------------------------------------------
// Content — opportunity detection (materialize declared opportunities only)
// ---------------------------------------------------------------------------

export const handleContentDetectOpportunity: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const opportunities = Array.isArray(payload.opportunities) ? payload.opportunities : [];

    if (opportunities.length === 0) {
      return {
        success: true,
        result: {
          created: 0,
          note:
            "No opportunities declared. Atlas does not invent content opportunities; a detector must supply knowledge-backed candidates.",
        },
      };
    }

    let created = 0;
    const skipped: string[] = [];

    for (const raw of opportunities.slice(0, 50)) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const title = str(item.title);
      const knowledgeIds = strArray(item.knowledge_ids);
      const sourceIds = strArray(item.source_ids);

      const validation = validateContentDraft({
        contentType: "blog",
        status: "opportunity",
        title,
        knowledgeIds,
      });
      if (validation.errors.length > 0) {
        skipped.push(`${title ?? "untitled"}: ${validation.errors.join(" ")}`);
        continue;
      }

      const res = await services.content.create({
        contentType: "blog",
        title: title as string,
        summary: str(item.summary),
        jurisdiction: str(item.jurisdiction),
        industry: str(item.industry),
        effectiveDate: typeof item.effective_date === "number" ? item.effective_date : null,
        knowledgeIds,
        sourceIds,
        status: "opportunity",
      });

      if (res.ok) {
        created++;
      } else if (isDuplicateError(res.error)) {
        created++; // already materialized — idempotent
      } else {
        skipped.push(`${title}: ${res.error ?? "create failed"}`);
      }
    }

    return { success: true, result: { created, skipped } };
  };

// ---------------------------------------------------------------------------
// Content — research / draft / review (explicit, payload-driven transitions)
// ---------------------------------------------------------------------------

function transitionHandler(
  services: PlatformServices,
  target: ContentStatus,
  requiredField?: "body",
): JobHandler {
  return async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const contentId = str(payload.content_id);
    if (!contentId) return validationFailure("content_id is required.", {});

    if (requiredField === "body") {
      const body = str(payload.body);
      if (!body) {
        // Atlas will not fabricate an article body.
        return validationFailure(
          "A drafted article requires a supplied body. Atlas does not invent article content.",
          { content_id: contentId },
        );
      }
    }

    const res = await services.content.transition({
      contentId,
      status: target,
      note: str(payload.note),
      body: requiredField === "body" ? str(payload.body) : null,
      draftJobId: ctx.job._id ?? null,
    });

    if (!res.ok) {
      if (res.error === "content_not_found") {
        return {
          success: false,
          error: createJobError("NOT_FOUND", `Content ${contentId} not found.`, { content_id: contentId }, false),
        };
      }
      return validationFailure(res.error ?? `Could not transition content to ${target}.`, {
        content_id: contentId,
      });
    }
    return { success: true, result: { content_id: contentId, status: target } };
  };
}

export const handleContentResearch = (services: PlatformServices): JobHandler =>
  transitionHandler(services, "researching");

export const handleContentWriteBlog = (services: PlatformServices): JobHandler =>
  transitionHandler(services, "drafted", "body");

export const handleContentReview = (services: PlatformServices): JobHandler =>
  transitionHandler(services, "in_review");

// ---------------------------------------------------------------------------
// Content — LinkedIn derivation (a separate native post, never a copy)
// ---------------------------------------------------------------------------

export const handleContentWriteLinkedin: (services: PlatformServices) => JobHandler =
  (services) => async (ctx: JobExecutionContext): Promise<HandlerResult> => {
    const payload = ctx.job.payload ?? {};
    const parentId = str(payload.parent_content_id);
    const keyPoints = strArray(payload.key_points);

    if (!parentId) {
      return validationFailure("parent_content_id is required for a LinkedIn post.", {});
    }

    const parent = await services.content.get(parentId);
    if (!parent) {
      return {
        success: false,
        error: createJobError("NOT_FOUND", `Parent content ${parentId} not found.`, { content_id: parentId }, false),
      };
    }

    const derived = buildLinkedInDraft(
      {
        _id: parent._id,
        title: parent.title,
        summary: parent.summary ?? null,
        status: parent.status,
        approvalStatus: parent.approvalStatus,
        sourceIds: parent.sourceIds ?? [],
        knowledgeIds: parent.knowledgeIds ?? [],
      },
      keyPoints,
    );

    if (!derived.ok || !derived.post) {
      return validationFailure(derived.error ?? "LinkedIn post could not be derived.", {
        content_id: parentId,
      });
    }

    const res = await services.content.create({
      contentType: "linkedin_post",
      title: derived.post.title,
      body: derived.post.body,
      parentContentId: parentId,
      knowledgeIds: derived.post.knowledgeIds,
      sourceIds: derived.post.sourceIds,
      jurisdiction: parent.jurisdiction ?? null,
      industry: parent.industry ?? null,
      effectiveDate: parent.effectiveDate ?? null,
      status: "drafted",
    });

    if (!res.ok) {
      return validationFailure(res.error ?? "LinkedIn draft could not be created.", {
        content_id: parentId,
      });
    }

    return {
      success: true,
      result: { content_id: res.content_id, parent_content_id: parentId, status: "drafted" },
    };
  };

// ---------------------------------------------------------------------------
// Content — publishing (deliberately NOT implemented in this phase)
// ---------------------------------------------------------------------------

function publishingNotImplemented(target: string): JobHandler {
  return async (): Promise<HandlerResult> => ({
    success: false,
    error: createJobError(
      "NOT_IMPLEMENTED",
      `Publishing to ${target} is not implemented. Content stays in the approved state until a human publishes it.`,
      { target },
      false,
    ),
  });
}

export const handleContentPublishBlog = publishingNotImplemented("atlas_blog");
export const handleContentPublishLinkedin = publishingNotImplemented("linkedin");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function createPlatformHandlers(
  services: PlatformServices,
): Array<{ jobType: string; handler: JobHandler }> {
  return [
    { jobType: "knowledge_source_check", handler: handleKnowledgeSourceCheck(services) },
    { jobType: "knowledge_detect_change", handler: handleKnowledgeDetectChange(services) },
    { jobType: "knowledge_freshness_sweep", handler: handleKnowledgeFreshnessSweep(services) },
    { jobType: "platform_failed_job_sweep", handler: handlePlatformFailedJobSweep(services) },
    { jobType: "content_detect_opportunity", handler: handleContentDetectOpportunity(services) },
    { jobType: "content_research", handler: handleContentResearch(services) },
    { jobType: "content_write_blog", handler: handleContentWriteBlog(services) },
    { jobType: "content_review", handler: handleContentReview(services) },
    { jobType: "content_write_linkedin", handler: handleContentWriteLinkedin(services) },
    { jobType: "content_publish_blog", handler: handleContentPublishBlog },
    { jobType: "content_publish_linkedin", handler: handleContentPublishLinkedin },
  ];
}

/** Register every platform handler into the existing job handler registry. */
export function registerPlatformHandlers(services: PlatformServices): void {
  registerJobHandlers(createPlatformHandlers(services));
}
