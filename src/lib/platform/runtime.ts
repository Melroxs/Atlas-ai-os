// ---------------------------------------------------------------------------
// Atlas Platform — worker runtime
//
// The single host-agnostic entry point that turns the platform job vocabulary
// into a running system.
//
// It deliberately does NOT introduce a second job system:
//   * it drives the EXISTING AtlasWorker (src/lib/jobs/worker.ts)
//   * over the EXISTING atlas_jobs RPCs (jobs_dequeue / jobs_* — migration 0020)
//   * and registers the platform handlers into the ONE canonical registry
//     (@/lib/jobs/handler-registry), which already merges rather than replaces.
//
// Two host shapes are supported from the same wiring:
//   * long-lived process (Bun/Node, a container, a Supabase Edge Function with
//     a keep-alive loop):  runtime.start()
//   * cron / serverless tick:  runtime.tick()
//
// Nothing here publishes content and nothing here requires a browser. A run
// only touches work the database already recorded, so it is safe to invoke
// concurrently: jobs_dequeue uses FOR UPDATE SKIP LOCKED.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import {
  AtlasWorker,
  DEFAULT_WORKER_CONFIG,
  type AtlasWorkerConfig,
  type JobError,
  type WorkerRPC,
  type WorkerStatus,
} from "@/lib/jobs";
import { registerPlatformHandlers, type PlatformServices } from "./handlers";
import { createSupabasePlatformServices } from "./services";
import { fireDueSchedules, recordScheduleResult } from "./rpc";
import { PLATFORM_JOB_TYPES } from "./types";

// ---------------------------------------------------------------------------
// WorkerRPC over the existing job RPCs
// ---------------------------------------------------------------------------

/**
 * Bind the worker's RPC port to the real database.
 *
 * A host passes a service-role client (the worker is trusted infrastructure and
 * sees cross-tenant platform jobs); tests pass a stub. Every argument key is
 * snake_case matching the SQL parameter minus `p_`, because rpcCall() adds the
 * prefix and folds to lowercase.
 */
export function createSupabaseWorkerRPC(supabase: SupabaseClient): WorkerRPC {
  return {
    async dequeue(workerId, jobTypes, maxJobs) {
      const res = (await rpcCall(supabase, "jobs_dequeue", {
        worker_id: workerId,
        job_types: jobTypes && jobTypes.length > 0 ? jobTypes : null,
        max_jobs: maxJobs ?? 1,
      })) as { jobs?: string[]; count?: number } | null;
      return (res?.jobs ?? []).map((id) => ({ id }));
    },

    async getJob(jobId) {
      const res = await rpcCall(supabase, "jobs_get_job", { job_id: jobId });
      return (res ?? null) as Awaited<ReturnType<WorkerRPC["getJob"]>>;
    },

    async completeJob(jobId, result, aiMetadata) {
      return (await rpcCall(supabase, "jobs_complete_job", {
        job_id: jobId,
        result,
        ai_metadata: aiMetadata ?? null,
      })) as { ok: boolean };
    },

    async failJob(jobId, error: JobError, retryable) {
      return (await rpcCall(supabase, "jobs_fail_job", {
        job_id: jobId,
        error,
        retryable: retryable ?? true,
      })) as { ok: boolean; retrying: boolean; next_scheduled_at?: string };
    },

    async awaitingReview(jobId, reviewId) {
      return (await rpcCall(supabase, "jobs_awaiting_review", {
        job_id: jobId,
        review_id: reviewId ?? null,
      })) as { ok: boolean };
    },

    async completeStep(stepId, output, aiMetadata) {
      return (await rpcCall(supabase, "jobs_complete_step", {
        step_id: stepId,
        output,
        ai_metadata: aiMetadata ?? null,
      })) as { ok: boolean };
    },

    async failStep(stepId, error) {
      return (await rpcCall(supabase, "jobs_fail_step", {
        step_id: stepId,
        error,
      })) as { ok: boolean };
    },

    async cancelJob(jobId) {
      return (await rpcCall(supabase, "jobs_cancel_job", {
        job_id: jobId,
      })) as { ok: boolean };
    },

    async unlockStuck() {
      return (await rpcCall(supabase, "jobs_unlock_stuck", {
        stale_after: "10 minutes",
      })) as { unlocked: number };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface PlatformRuntimeOptions {
  supabase: SupabaseClient;
  /** Override worker tuning; defaults to DEFAULT_WORKER_CONFIG. */
  config?: Partial<AtlasWorkerConfig>;
  /**
   * Register the existing evidence/agent handlers as well. Leave false when the
   * host is dedicated to platform work so a knowledge sweep cannot contend with
   * evidence processing.
   */
  includeExistingHandlers?: boolean;
  /** Injected for tests. */
  services?: PlatformServices;
  /** Injected for tests. */
  rpc?: WorkerRPC;
  now?: () => number;
}

export interface PlatformTickResult {
  fired: number;
  claimed: number;
  processed: number;
  failed: number;
  scheduleFailures: number;
}

export interface PlatformRuntime {
  services: PlatformServices;
  worker: AtlasWorker;
  /** Register handlers and start the poll loop (long-lived hosts). */
  start: () => void;
  /** Stop the poll loop. */
  stop: () => Promise<void>;
  /** One cron-style pass: fire due schedules, then drain a bounded batch. */
  tick: (limit?: number) => Promise<PlatformTickResult>;
  /** Worker counters (processed/failed/active). */
  status: () => WorkerStatus;
}

/**
 * Assemble a runnable platform worker.
 *
 * Creating a runtime has no side effects on the database beyond registering
 * handlers in memory; nothing runs until start() or tick() is called.
 */
export function createPlatformRuntime(
  options: PlatformRuntimeOptions,
): PlatformRuntime {
  const now = options.now ?? (() => Date.now());

  const services =
    options.services ??
    createSupabasePlatformServices(options.supabase, { now });

  // Register into the ONE canonical registry (it merges; it never replaces).
  registerPlatformHandlers(services);

  const config: AtlasWorkerConfig = {
    ...DEFAULT_WORKER_CONFIG,
    worker_id: `platform-worker-${now()}`,
    // Platform work is knowledge-heavy and low volume: a small concurrency
    // ceiling keeps a sweep from starving interactive tenant jobs.
    max_concurrent_jobs: 3,
    job_types: [...PLATFORM_JOB_TYPES],
    ...options.config,
  };

  const worker = new AtlasWorker(
    config,
    options.rpc ?? createSupabaseWorkerRPC(options.supabase),
  );

  const tick = async (limit = 20): Promise<PlatformTickResult> => {
    // 1. Turn elapsed schedule intervals into durable jobs. A schedule never
    //    executes work itself, so this is safe to re-run.
    let fired = 0;
    let scheduleFailures = 0;
    try {
      const result = await fireDueSchedules(options.supabase, limit);
      fired = result?.count ?? 0;
    } catch (err) {
      // A scheduler outage must not stop job execution.
      scheduleFailures += 1;
      console.error("[atlas-platform] schedule fire failed:", err);
    }

    // 2. Execute whatever is queued. Failures stay visible in atlas_jobs —
    //    nothing is silently marked complete.
    const drained = await worker.runOnce();

    return {
      fired,
      claimed: drained.claimed,
      processed: drained.processed,
      failed: drained.failed,
      scheduleFailures,
    };
  };

  return {
    services,
    worker,
    start: () => worker.start(),
    stop: () => worker.stop(),
    tick,
    status: () => worker.getStatus(),
  };
}

/**
 * Convenience for a cron/serverless host: one pass, no long-lived process.
 * Also reclaims leases from workers that died mid-job.
 */
export async function runPlatformTick(
  supabase: SupabaseClient,
  options: Omit<PlatformRuntimeOptions, "supabase"> & { limit?: number } = {},
): Promise<PlatformTickResult> {
  const runtime = createPlatformRuntime({ ...options, supabase });
  return runtime.tick(options.limit ?? 20);
}

/** Record the outcome of a scheduled run so backoff and health stay accurate. */
export async function reportScheduleResult(
  supabase: SupabaseClient,
  name: string,
  success: boolean,
): Promise<void> {
  await recordScheduleResult(supabase, name, success);
}
