// ---------------------------------------------------------------------------
// Atlas Platform — Supabase RPC wrappers + port implementations
//
// Thin wrappers over the platform RPCs added in
// 20260913_atlas_platform_infrastructure.sql, plus the port implementations the
// platform job handlers depend on.
//
// Argument keys are snake_case and match the SQL parameter names minus the `p_`
// prefix, because rpcCall() prefixes `p_` and lowercases (see
// @/lib/actions/rpc.ts). Sending camelCase here would silently produce
// PGRST202 (function not found in schema cache).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import type {
  ContentItem,
  ContentStatus,
  ContentType,
  KnowledgeVersion,
  RegisteredSource,
  ScheduleDefinition,
  SourceCheckOutcome,
} from "./types";

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export async function listSchedules(
  supabase: SupabaseClient,
): Promise<ScheduleDefinition[]> {
  return asArray<ScheduleDefinition>(await rpcCall(supabase, "schedules_list"));
}

export async function upsertSchedule(
  supabase: SupabaseClient,
  draft: {
    name: string;
    jobType: string;
    intervalSeconds: number;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    tenantId?: string | null;
    tags?: string[];
    enabled?: boolean;
    description?: string | null;
  },
): Promise<{ ok: boolean; schedule_id?: string }> {
  return (await rpcCall(supabase, "schedules_upsert", {
    name: draft.name,
    job_type: draft.jobType,
    interval_seconds: draft.intervalSeconds,
    payload: draft.payload ?? {},
    priority: draft.priority ?? 4,
    max_attempts: draft.maxAttempts ?? 3,
    tenant_id: draft.tenantId ?? null,
    tags: draft.tags ?? [],
    enabled: draft.enabled ?? true,
    description: draft.description ?? null,
  })) as { ok: boolean; schedule_id?: string };
}

export async function setScheduleEnabled(
  supabase: SupabaseClient,
  name: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return (await rpcCall(supabase, "schedules_set_enabled", {
    name,
    enabled,
  })) as { ok: boolean; error?: string };
}

export async function fireDueSchedules(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ fired: Array<Record<string, unknown>>; count: number }> {
  return (await rpcCall(supabase, "schedules_fire_due", { limit })) as {
    fired: Array<Record<string, unknown>>;
    count: number;
  };
}

export async function recordScheduleResult(
  supabase: SupabaseClient,
  name: string,
  success: boolean,
): Promise<{ ok: boolean; consecutive_failures?: number }> {
  return (await rpcCall(supabase, "schedules_record_result", {
    name,
    success,
  })) as { ok: boolean; consecutive_failures?: number };
}

// ---------------------------------------------------------------------------
// Source registry / checks
// ---------------------------------------------------------------------------

export async function listDueSources(
  supabase: SupabaseClient,
  limit = 50,
): Promise<RegisteredSource[]> {
  return asArray<RegisteredSource>(
    await rpcCall(supabase, "sources_list_due", { limit }),
  );
}

export async function getSource(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<RegisteredSource | null> {
  const result = await rpcCall(supabase, "sources_get", { source_id: sourceId });
  return (result as RegisteredSource | null) ?? null;
}

export async function listSourceChecks(
  supabase: SupabaseClient,
  sourceId: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  return asArray<Record<string, unknown>>(
    await rpcCall(supabase, "sources_list_checks", {
      source_id: sourceId,
      limit,
    }),
  );
}

export async function recordSourceCheck(
  supabase: SupabaseClient,
  sourceId: string,
  outcome: SourceCheckOutcome,
  jobId: string | null = null,
  checker = "worker",
): Promise<{ ok: boolean; check_id?: string; freshness?: string; error?: string }> {
  return (await rpcCall(supabase, "sources_record_check", {
    source_id: sourceId,
    status: outcome.status,
    content_hash: outcome.contentHash,
    previous_hash: outcome.previousHash,
    change_type: outcome.changeType,
    http_status: outcome.httpStatus,
    latency_ms: outcome.latencyMs,
    error: outcome.error,
    job_id: jobId,
    normalized_length: outcome.normalizedLength,
    checker,
  })) as { ok: boolean; check_id?: string; freshness?: string; error?: string };
}

export async function setSourceCheckFrequency(
  supabase: SupabaseClient,
  sourceId: string,
  seconds: number,
): Promise<{ ok: boolean; error?: string }> {
  return (await rpcCall(supabase, "sources_set_check_frequency", {
    source_id: sourceId,
    seconds,
  })) as { ok: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// Jobs (platform-scope reads; the queue itself lives in @/lib/jobs)
// ---------------------------------------------------------------------------

export async function listFailedJobs(
  supabase: SupabaseClient,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  return asArray<Record<string, unknown>>(
    await rpcCall(supabase, "jobs_list_jobs", {
      status: "failed",
      job_type: null,
      limit,
      offset: 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Knowledge versioning
// ---------------------------------------------------------------------------

export async function listKnowledgeVersions(
  supabase: SupabaseClient,
  versionGroup: string,
): Promise<KnowledgeVersion[]> {
  return asArray<KnowledgeVersion>(
    await rpcCall(supabase, "knowledge_versions", {
      version_group: versionGroup,
    }),
  );
}

export async function knowledgeAsOf(
  supabase: SupabaseClient,
  asOf: number,
  options: { jurisdiction?: string | null; industry?: string | null; limit?: number } = {},
): Promise<KnowledgeVersion[]> {
  return asArray<KnowledgeVersion>(
    await rpcCall(supabase, "knowledge_as_of", {
      as_of: asOf,
      jurisdiction: options.jurisdiction ?? null,
      industry: options.industry ?? null,
      limit: options.limit ?? 50,
    }),
  );
}

export async function createKnowledgeVersion(
  supabase: SupabaseClient,
  input: {
    versionGroup: string;
    sourceId: string;
    title: string;
    statement: string;
    effectiveDate: number;
    knowledgeId?: string;
    interpretation?: string | null;
    knowledgeType?: string;
    jurisdiction?: string | null;
    industry?: string | null;
    version?: string | null;
    confidence?: number;
    reviewStatus?: string;
    contentHash?: string | null;
    sourceCheckId?: string | null;
    jobId?: string | null;
  },
): Promise<{
  ok: boolean;
  knowledge_id?: string;
  version_number?: number;
  superseded?: string | null;
  error?: string;
}> {
  return (await rpcCall(supabase, "knowledge_create_version", {
    version_group: input.versionGroup,
    source_id: input.sourceId,
    title: input.title,
    statement: input.statement,
    effective_date: input.effectiveDate,
    knowledge_id: input.knowledgeId ?? null,
    interpretation: input.interpretation ?? null,
    knowledge_type: input.knowledgeType ?? "requirement",
    jurisdiction: input.jurisdiction ?? null,
    industry: input.industry ?? null,
    version: input.version ?? null,
    confidence: input.confidence ?? 0.7,
    review_status: input.reviewStatus ?? "needs_review",
    content_hash: input.contentHash ?? null,
    source_check_id: input.sourceCheckId ?? null,
    job_id: input.jobId ?? null,
  })) as {
    ok: boolean;
    knowledge_id?: string;
    version_number?: number;
    superseded?: string | null;
    error?: string;
  };
}

export async function verifyKnowledge(
  supabase: SupabaseClient,
  knowledgeId: string,
  decision: "verified" | "needs_review" | "rejected",
  note?: string | null,
): Promise<{ ok: boolean; review_status?: string; error?: string }> {
  return (await rpcCall(supabase, "knowledge_verify", {
    knowledge_id: knowledgeId,
    decision,
    note: note ?? null,
  })) as { ok: boolean; review_status?: string; error?: string };
}

// ---------------------------------------------------------------------------
// Content engine
// ---------------------------------------------------------------------------

export async function createContent(
  supabase: SupabaseClient,
  input: {
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
  },
): Promise<{ ok: boolean; content_id?: string; error?: string }> {
  return (await rpcCall(supabase, "content_create", {
    content_type: input.contentType,
    title: input.title,
    slug: input.slug ?? null,
    summary: input.summary ?? null,
    body: input.body ?? null,
    seo: input.seo ?? {},
    jurisdiction: input.jurisdiction ?? null,
    industry: input.industry ?? null,
    effective_date: input.effectiveDate ?? null,
    knowledge_ids: input.knowledgeIds ?? [],
    source_ids: input.sourceIds ?? [],
    parent_content_id: input.parentContentId ?? null,
    research_job_id: input.researchJobId ?? null,
    status: input.status ?? "opportunity",
  })) as { ok: boolean; content_id?: string; error?: string };
}

export async function transitionContent(
  supabase: SupabaseClient,
  input: {
    contentId: string;
    status: ContentStatus;
    actor?: string | null;
    note?: string | null;
    publishTarget?: string | null;
    failureReason?: string | null;
    body?: string | null;
    seo?: Record<string, unknown> | null;
    draftJobId?: string | null;
  },
): Promise<{ ok: boolean; status?: string; error?: string }> {
  return (await rpcCall(supabase, "content_transition", {
    content_id: input.contentId,
    status: input.status,
    actor: input.actor ?? null,
    note: input.note ?? null,
    publish_target: input.publishTarget ?? null,
    failure_reason: input.failureReason ?? null,
    body: input.body ?? null,
    seo: input.seo ?? null,
    draft_job_id: input.draftJobId ?? null,
  })) as { ok: boolean; status?: string; error?: string };
}

export async function listContent(
  supabase: SupabaseClient,
  options: {
    contentType?: ContentType | null;
    status?: ContentStatus | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ContentItem[]> {
  return asArray<ContentItem>(
    await rpcCall(supabase, "content_list", {
      content_type: options.contentType ?? null,
      status: options.status ?? null,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    }),
  );
}

export async function getContent(
  supabase: SupabaseClient,
  contentId: string,
): Promise<(ContentItem & { provenance?: unknown[] }) | null> {
  const result = await rpcCall(supabase, "content_get", {
    content_id: contentId,
  });
  return (result as (ContentItem & { provenance?: unknown[] }) | null) ?? null;
}

export async function listContentProvenance(
  supabase: SupabaseClient,
  contentId: string,
): Promise<Array<Record<string, unknown>>> {
  return asArray<Record<string, unknown>>(
    await rpcCall(supabase, "content_list_provenance", {
      content_id: contentId,
    }),
  );
}

export async function publicContentList(
  supabase: SupabaseClient,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  return asArray<Record<string, unknown>>(
    await rpcCall(supabase, "content_public_list", { limit }),
  );
}
