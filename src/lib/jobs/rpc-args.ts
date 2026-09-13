// ---------------------------------------------------------------------------
// Atlas Durable Jobs — exact PostgREST argument names
//
// The shared `normalizeRpcArgs()` helper in src/lib/actions/rpc.ts hashes a
// camelCase key to `p_` + lowercased key (`tenantId` -> `p_tenantid`). That is
// the right convention for RPCs whose parameters were declared camelCase and
// therefore folded to lowercase by Postgres — but the durable-jobs RPCs are
// declared with explicit snake_case parameters (`p_tenant_id`, `p_job_type`,
// `p_idempotency_key`, …). PostgREST resolves arguments by exact name against
// the schema cache, so the camelCase shorthand silently produces
// `p_tenantid` / `p_jobtype` / `p_idempotencykey` and the call fails with
// PGRST202 ("Could not find the function … in the schema cache").
//
// Every job RPC call must therefore go through `toJobsRpcArgs()`, which maps
// the caller's logical keys onto the exact parameter names the database
// declares. Keep this table in sync with the job RPC definitions
// (supabase/migrations/0020_atlas_jobs.sql and later fixes).
// ---------------------------------------------------------------------------

/** Durable-jobs RPCs whose client call sites pass camelCase argument keys. */
export type JobsRpcFn =
  | "jobs_create_job"
  | "jobs_create_step"
  | "jobs_complete_step"
  | "jobs_fail_step"
  | "jobs_retry_step"
  | "jobs_complete_job"
  | "jobs_fail_job"
  | "jobs_cancel_job"
  | "jobs_get_job"
  | "jobs_list_jobs"
  | "jobs_get_events"
  | "jobs_awaiting_review"
  | "jobs_resume_from_review";

/**
 * Logical key (as passed by the client) -> exact PostgreSQL parameter name.
 * The values are already the lowercased, `p_`-prefixed form, so
 * `normalizeRpcArgs()` passes them through untouched.
 */
export const JOBS_RPC_PARAM_MAP: Record<JobsRpcFn, Record<string, string>> = {
  jobs_create_job: {
    tenantId: "p_tenant_id",
    userId: "p_user_id",
    jobType: "p_job_type",
    priority: "p_priority",
    idempotencyKey: "p_idempotency_key",
    payload: "p_payload",
    maxAttempts: "p_max_attempts",
    scheduledAt: "p_scheduled_at",
    parentJobId: "p_parent_job_id",
    tags: "p_tags",
  },
  jobs_create_step: {
    jobId: "p_job_id",
    stepType: "p_step_type",
    sequence: "p_sequence",
    input: "p_input",
    maxAttempts: "p_max_attempts",
  },
  jobs_complete_step: {
    stepId: "p_step_id",
    output: "p_output",
    aiMetadata: "p_ai_metadata",
  },
  jobs_fail_step: {
    stepId: "p_step_id",
    error: "p_error",
  },
  jobs_retry_step: {
    stepId: "p_step_id",
  },
  jobs_complete_job: {
    jobId: "p_job_id",
    result: "p_result",
    aiMetadata: "p_ai_metadata",
  },
  jobs_fail_job: {
    jobId: "p_job_id",
    error: "p_error",
    retryable: "p_retryable",
  },
  jobs_cancel_job: {
    jobId: "p_job_id",
  },
  jobs_get_job: {
    jobId: "p_job_id",
  },
  jobs_list_jobs: {
    status: "p_status",
    jobType: "p_job_type",
    limit: "p_limit",
    offset: "p_offset",
  },
  jobs_get_events: {
    jobId: "p_job_id",
    limit: "p_limit",
  },
  jobs_awaiting_review: {
    jobId: "p_job_id",
    reviewId: "p_review_id",
  },
  jobs_resume_from_review: {
    jobId: "p_job_id",
    reviewId: "p_review_id",
    decision: "p_decision",
  },
};

/**
 * Translate a jobs RPC's logical argument keys into the exact parameter names
 * declared by the database function. Unknown keys are passed through
 * unchanged so a schema change surfaces as a PostgREST error rather than
 * silently dropping an argument.
 */
export function toJobsRpcArgs(
  fn: JobsRpcFn,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const map = JOBS_RPC_PARAM_MAP[fn];
  if (!map) return { ...args };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[map[key] ?? key] = value;
  }
  return out;
}
