// ---------------------------------------------------------------------------
// Atlas Job System — RPC Layer
//
// Client-side functions that interact with the atlas_jobs / atlas_job_steps
// / atlas_job_attempts / atlas_job_events tables through Supabase RPCs.
//
// Every function enforces tenant isolation by passing the authenticated
// user's tenant context through the RPC (the Postgres functions above read
// it from the JWT or the calling context).
//
// These functions are used by:
//   - Frontend pages (job status, observability dashboard)
//   - Client-side orchestrators (evidence pipeline kickoff)
//   - Tests
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import { toJobsRpcArgs, type JobsRpcFn } from "./rpc-args";
import type {
  AtlasJob,
  AtlasJobStep,
  AtlasJobEvent,
  CreateJobInput,
  EnqueueResult,
  JobType,
  JobStatus,
  JobPriority,
} from "./types";
import {
  validateJobInput,
  generateIdempotencyKey,
  createJobError,
  JOB_ERROR_CODES,
} from "./engine";

// ---------------------------------------------------------------------------
// RPC transport
//
// `rpcCall()` adds the `p_` prefix and lowercases camelCase keys, which is
// only correct for RPCs whose parameters were declared camelCase. The job
// RPCs declare snake_case parameters (`p_tenant_id`, `p_job_type`, …), so
// every call is translated through `toJobsRpcArgs()` first — otherwise the
// request becomes `jobs_create_job(p_tenantid, p_jobtype, p_idempotencykey)`
// and PostgREST answers PGRST202 (function not found in the schema cache).
// ---------------------------------------------------------------------------

async function jobsRpc<T = unknown>(
  supabase: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await rpcCall(supabase, fn, toJobsRpcArgs(fn as JobsRpcFn, args))) as T;
}

// ---------------------------------------------------------------------------
// Job creation
// ---------------------------------------------------------------------------

/**
 * Enqueue a new durable job. Returns the job id and whether it was deduplicated.
 *
 * Uses the same `rpcCall` convention as every other Atlas RPC — PostgREST
 * resolves arguments by lowercased name against the schema cache.
 */
export async function createJob(
  supabase: SupabaseClient,
  input: CreateJobInput,
): Promise<EnqueueResult> {
  const errors = validateJobInput(input);
  if (errors.length > 0) {
    throw new Error(`Invalid job input: ${errors.map((e) => e.message).join("; ")}`);
  }

  const result = (await jobsRpc(supabase, "jobs_create_job", {
    tenantId: input.tenant_id,
    userId: input.user_id ?? null,
    jobType: input.job_type,
    priority: input.priority ?? 3,
    idempotencyKey: input.idempotency_key,
    payload: input.payload,
    maxAttempts: input.max_attempts ?? 3,
    scheduledAt: input.scheduled_at ?? null,
    parentJobId: input.parent_job_id ?? null,
    tags: input.tags ?? [],
  })) as EnqueueResult;

  return result;
}

/**
 * Convenience: create and enqueue an evidence pipeline job.
 */
export async function enqueueEvidencePipeline(
  supabase: SupabaseClient,
  tenantId: string,
  claimId: string,
  userId?: string | null,
): Promise<EnqueueResult> {
  return createJob(supabase, {
    tenant_id: tenantId,
    user_id: userId,
    job_type: "evidence_ingestion" as JobType,
    priority: 2,
    idempotency_key: generateIdempotencyKey(
      "evidence_pipeline",
      tenantId,
      { claimId },
      true,
    ),
    payload: {
      claim_id: claimId,
      pipeline: "evidence_reasoning",
      stages: [
        "ingestion",
        "extraction",
        "classification",
        "entity_resolution",
        "claim_reconstruction",
        "evidence_requirements",
        "gap_intelligence",
        "contradiction_detection",
        "supplement_opportunity",
        "qa",
      ],
    },
    max_attempts: 3,
    tags: ["evidence", "claim", claimId],
  });
}

/**
 * Convenience: enqueue a single agent task.
 */
export async function enqueueAgentTask(
  supabase: SupabaseClient,
  tenantId: string,
  agentType: string,
  context: Record<string, unknown>,
  userId?: string | null,
  priority: JobPriority = 3,
): Promise<EnqueueResult> {
  return createJob(supabase, {
    tenant_id: tenantId,
    user_id: userId,
    job_type: `agent_${agentType}` as JobType,
    priority,
    idempotency_key: generateIdempotencyKey(
      `agent_${agentType}`,
      tenantId,
      context,
    ),
    payload: {
      agent_type: agentType,
      ...context,
    },
    max_attempts: 3,
    tags: ["agent", agentType],
  });
}

// ---------------------------------------------------------------------------
// Job steps
// ---------------------------------------------------------------------------

/**
 * Add a step to an existing job.
 */
export async function createJobStep(
  supabase: SupabaseClient,
  jobId: string,
  stepType: string,
  sequence: number,
  input: Record<string, unknown> = {},
  maxAttempts = 3,
): Promise<{ step_id: string }> {
  const result = (await jobsRpc(supabase, "jobs_create_step", {
    jobId,
    stepType,
    sequence,
    input,
    maxAttempts,
  })) as { step_id: string };
  return result;
}

/**
 * Mark a step as completed with output.
 */
export async function completeStep(
  supabase: SupabaseClient,
  stepId: string,
  output: Record<string, unknown> = {},
  aiMetadata?: Record<string, unknown> | null,
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_complete_step", {
    stepId,
    output,
    aiMetadata: aiMetadata ?? null,
  })) as { ok: boolean };
}

/**
 * Mark a step as failed.
 */
export async function failStep(
  supabase: SupabaseClient,
  stepId: string,
  error: { code: string; message: string; details?: Record<string, unknown>; retryable?: boolean },
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_fail_step", {
    stepId,
    error,
  })) as { ok: boolean };
}

/**
 * Reset a failed step for retry.
 */
export async function retryStep(
  supabase: SupabaseClient,
  stepId: string,
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_retry_step", {
    stepId,
  })) as { ok: boolean };
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * Mark a job as completed with results.
 */
export async function completeJob(
  supabase: SupabaseClient,
  jobId: string,
  result: Record<string, unknown> = {},
  aiMetadata?: Record<string, unknown> | null,
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_complete_job", {
    jobId,
    result,
    aiMetadata: aiMetadata ?? null,
  })) as { ok: boolean };
}

/**
 * Mark a job as failed (or schedule retry if attempts remain).
 */
export async function failJob(
  supabase: SupabaseClient,
  jobId: string,
  error: { code: string; message: string; details?: Record<string, unknown>; retryable?: boolean },
): Promise<{ ok: boolean; retrying: boolean; next_scheduled_at?: string }> {
  return (await jobsRpc(supabase, "jobs_fail_job", {
    jobId,
    error,
    retryable: error.retryable ?? true,
  })) as { ok: boolean; retrying: boolean; next_scheduled_at?: string };
}

/**
 * Cancel a job and all its pending steps.
 */
export async function cancelJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_cancel_job", {
    jobId,
  })) as { ok: boolean };
}

// ---------------------------------------------------------------------------
// Job queries
// ---------------------------------------------------------------------------

/**
 * Get a job with all its steps.
 */
export async function getJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<AtlasJob & { steps: AtlasJobStep[] } | null> {
  const result = await jobsRpc(supabase, "jobs_get_job", { jobId });
  return (result as AtlasJob & { steps: AtlasJobStep[] }) ?? null;
}

/**
 * List jobs with optional filtering.
 */
export async function listJobs(
  supabase: SupabaseClient,
  options: {
    status?: JobStatus;
    job_type?: JobType;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AtlasJob[]> {
  const result = await jobsRpc(supabase, "jobs_list_jobs", {
    status: options.status ?? null,
    jobType: options.job_type ?? null,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  });
  return (Array.isArray(result) ? result : []) as AtlasJob[];
}

/**
 * Get the event trail for a job.
 */
export async function getJobEvents(
  supabase: SupabaseClient,
  jobId: string,
  limit = 100,
): Promise<AtlasJobEvent[]> {
  const result = await jobsRpc(supabase, "jobs_get_events", { jobId, limit });
  return (Array.isArray(result) ? result : []) as AtlasJobEvent[];
}

/**
 * Transition a job to awaiting_review (durable pause for human review).
 */
export async function awaitingReview(
  supabase: SupabaseClient,
  jobId: string,
  reviewId?: string | null,
): Promise<{ ok: boolean }> {
  return (await jobsRpc(supabase, "jobs_awaiting_review", {
    jobId,
    reviewId: reviewId ?? null,
  })) as { ok: boolean };
}

/**
 * Resume a job from awaiting_review after human decision.
 */
export async function resumeFromReview(
  supabase: SupabaseClient,
  jobId: string,
  reviewId: string,
  decision: "approved" | "rejected" | "needs_changes",
): Promise<{ ok: boolean; status?: string; rerun_step?: string }> {
  return (await jobsRpc(supabase, "jobs_resume_from_review", {
    jobId,
    reviewId,
    decision,
  })) as { ok: boolean; status?: string; rerun_step?: string };
}

/**
 * Get aggregate job statistics for the observability dashboard.
 */
export async function getJobStats(
  supabase: SupabaseClient,
): Promise<{
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  avg_duration_ms: number | null;
  queue_depth: number;
  processing_count: number;
  failed_24h: number;
}> {
  const result = await jobsRpc(supabase, "jobs_stats");
  return result as ReturnType<typeof getJobStats>;
}
