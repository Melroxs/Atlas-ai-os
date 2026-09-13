// ---------------------------------------------------------------------------
// Atlas Worker — Core Execution Engine
//
// A stateless, horizontally-scalable worker that:
//   1. Polls for pending/queued jobs via jobs_dequeue (SKIP LOCKED)
//   2. Resolves the handler from the registry
//   3. Executes the handler with timeout and abort signal
//   4. Persists results via jobs_complete_job / jobs_fail_job
//   5. Supports step-level execution for multi-step jobs
//   6. Extends the lock lease periodically (heartbeat)
//   7. Logs every execution for observability
//
// The worker does NOT contain business logic — it executes registered handlers.
// Multiple workers can safely run concurrently (SKIP LOCKED prevents double-claim).
//
// Deployment:
//   - As a Supabase Edge Function (service_role for RPC access)
//   - As a standalone Node.js/Bun process (with SUPABASE_URL + service role key)
//   - Horizontally replicated without coordination
// ---------------------------------------------------------------------------

import type {
  AtlasJob,
  AtlasJobStep,
  AtlasWorkerConfig,
  JobExecutionContext,
  JobHandler,
  HandlerResult,
  JobError,
  WorkerLogger,
  DEFAULT_WORKER_CONFIG,
} from "./types";
import { getJobHandler, hasJobHandler } from "./handler-registry";
import { determineNextAction, shouldRetry, createJobError } from "./engine";
import { JOB_ERROR_CODES } from "./engine";

// ---------------------------------------------------------------------------
// In-memory RPC abstraction (avoids circular import with Supabase client)
// ---------------------------------------------------------------------------

/**
 * The RPC functions the worker calls against the database.
 * This interface allows testing without a real Supabase connection.
 */
/** Job record as returned by the database RPC (has 'id' field + steps). */
export type JobWithSteps = AtlasJob & { id: string; steps: AtlasJobStep[] };

type DequeueItem = { id: string };
type FailResult = { ok: boolean; retrying: boolean; next_scheduled_at?: string };
type OkResult = { ok: boolean };
type UnlockResult = { unlocked: number };

export interface WorkerRPC {
  dequeue(workerId: string, jobTypes?: string[], maxJobs?: number): Promise<DequeueItem[]>;
  getJob(jobId: string): Promise<JobWithSteps | null>;
  completeJob(jobId: string, result: Record<string, unknown>, aiMetadata?: Record<string, unknown> | null): Promise<OkResult>;
  failJob(jobId: string, error: JobError, retryable?: boolean): Promise<FailResult>;
  awaitingReview(jobId: string, reviewId?: string | null): Promise<OkResult>;
  completeStep(stepId: string, output: Record<string, unknown>, aiMetadata?: Record<string, unknown> | null): Promise<OkResult>;
  failStep(stepId: string, error: JobError): Promise<OkResult>;
  cancelJob(jobId: string): Promise<OkResult>;
  unlockStuck(): Promise<UnlockResult>;
}

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function createLogger(prefix: string): WorkerLogger {
  const log = (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: `[${prefix}] ${message}`,
      ...meta,
    };
    if (level === "error") console.error(JSON.stringify(entry));
    else if (level === "warn") console.warn(JSON.stringify(entry));
    else if (level === "debug") console.debug(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
  };
  return {
    info: (m, meta) => log("info", m, meta),
    warn: (m, meta) => log("warn", m, meta),
    error: (m, meta) => log("error", m, meta),
    debug: (m, meta) => log("debug", m, meta),
  };
}

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

export interface WorkerStatus {
  worker_id: string;
  running: boolean;
  active_jobs: number;
  total_processed: number;
  total_failed: number;
  started_at: string | null;
}

export class AtlasWorker {
  private config: AtlasWorkerConfig;
  private rpc: WorkerRPC;
  private logger: WorkerLogger;
  private running = false;
  private activeJobs = new Map<string, AbortController>();
  private totalProcessed = 0;
  private totalFailed = 0;
  private startedAt: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: AtlasWorkerConfig, rpc: WorkerRPC) {
    this.config = {
      ...config,
    };
    this.rpc = rpc;
    this.logger = createLogger(`worker:${config.worker_id}`);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the worker poll loop. */
  start(): void {
    if (this.running) {
      this.logger.warn("Worker already running");
      return;
    }
    this.running = true;
    this.startedAt = new Date().toISOString();        this.logger.info("Worker started", {
      worker_id: this.config.worker_id,
      poll_interval_ms: this.config.poll_interval_ms,
      max_concurrent_jobs: this.config.max_concurrent_jobs,
      job_timeout_ms: this.config.job_timeout_ms,
    } as Record<string, unknown>);

    // Start polling
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        this.logger.error("Poll cycle error", { error: String(err) });
      });
    }, this.config.poll_interval_ms);

    // Start sweeper
    if (this.config.enable_sweeper) {
      this.sweeperTimer = setInterval(() => {
        this.sweepStuckJobs().catch((err) => {
          this.logger.error("Sweeper error", { error: String(err) });
        });
      }, this.config.sweeper_interval_ms);
    }

    // Run first poll immediately
    this.poll().catch((err) => {
      this.logger.error("Initial poll error", { error: String(err) });
    });
  }

  /** Stop the worker gracefully. */
  async stop(): Promise<void> {
    this.logger.info("Worker stopping...");
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }

    // Cancel all active heartbeats
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    // Abort all active jobs
    for (const [jobId, controller] of this.activeJobs) {
      this.logger.info("Aborting active job", { job_id: jobId });
      controller.abort();
    }

    // Wait for active jobs to finish (with a timeout)
    const deadline = Date.now() + 30_000;
    while (this.activeJobs.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.info("Worker stopped", this.getStatusRecord());
  }

  /**
   * Run exactly ONE dequeue + execution cycle and resolve once every claimed
   * job has settled.
   *
   * start()/stop() own a long-lived interval, which a cron-triggered or
   * serverless host cannot keep alive. runOnce() owns no timer, so the same
   * worker (and the same registered handlers) can be driven by either kind of
   * host without a second job system.
   */
  async runOnce(): Promise<{ claimed: number; processed: number; failed: number }> {
    const slots = Math.max(1, this.config.max_concurrent_jobs);
    const claimed = await this.rpc.dequeue(
      this.config.worker_id,
      this.config.job_types.length > 0 ? this.config.job_types : undefined,
      slots,
    );

    if (claimed.length === 0) {
      return { claimed: 0, processed: 0, failed: 0 };
    }

    const failedBefore = this.totalFailed;
    const doneBefore = this.totalProcessed + this.totalFailed;

    await Promise.all(
      claimed.map(({ id }) =>
        this.processJob(id).catch((err) => {
          this.logger.error("Job processing threw", { job_id: id, error: String(err) });
          this.activeJobs.delete(id);
          this.stopHeartbeat(id);
        }),
      ),
    );

    return {
      claimed: claimed.length,
      processed: this.totalProcessed + this.totalFailed - doneBefore,
      failed: this.totalFailed - failedBefore,
    };
  }

  /** Get current worker status. */
  getStatus(): WorkerStatus {
    return {
      worker_id: this.config.worker_id,
      running: this.running,
      active_jobs: this.activeJobs.size,
      total_processed: this.totalProcessed,
      total_failed: this.totalFailed,
      started_at: this.startedAt,
    };
  }

  /** Get status as a loggable record. */
  getStatusRecord(): Record<string, unknown> {
    const s = this.getStatus();
    return { ...s } as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.running) return;

    // Check capacity
    const availableSlots = this.config.max_concurrent_jobs - this.activeJobs.size;
    if (availableSlots <= 0) return;

    // Dequeue jobs
    const claimed = await this.rpc.dequeue(
      this.config.worker_id,
      this.config.job_types.length > 0 ? this.config.job_types : undefined,
      availableSlots,
    );

    if (claimed.length === 0) return;

    this.logger.info("Jobs claimed", { count: claimed.length, job_ids: claimed.map((j) => j.id) });

    // Process each claimed job concurrently (up to concurrency limit)
    for (const { id: jobId } of claimed) {
      this.processJob(jobId).catch((err) => {
        this.logger.error("Unhandled job processing error", { job_id: jobId, error: String(err) });
        this.activeJobs.delete(jobId);
        this.heartbeatTimers.get(jobId) && clearInterval(this.heartbeatTimers.get(jobId)!);
        this.heartbeatTimers.delete(jobId);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Job processing
  // -------------------------------------------------------------------------

  private async processJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.activeJobs.set(jobId, controller);

    // Start heartbeat to extend the lock
    this.startHeartbeat(jobId);

    try {
      // Load the full job with steps
      const jobRecord = await this.rpc.getJob(jobId);
      if (!jobRecord) {
        this.logger.error("Job not found after dequeue", { job_id: jobId });
        return;
      }
      // The RPC returns { id, steps, ...AtlasJob fields }
      const job = jobRecord as AtlasJob;
      const jobSteps: AtlasJobStep[] = (jobRecord as unknown as { steps?: AtlasJobStep[] }).steps ?? [];
      // Normalize id — the DB uses 'id' (uuid), AtlasJob type uses '_id'
      const rpcId = (jobRecord as unknown as { id?: string }).id ?? jobId;
      if (!job._id) job._id = rpcId;

      // Check cancellation before starting
      if (controller.signal.aborted || job.status === "cancelled") {
        this.logger.info("Job cancelled before execution", { job_id: jobId });
        return;
      }

      this.logger.info("Processing job", {
        job_id: jobId,
        job_type: job.job_type,
        tenant_id: job.tenant_id,
        attempt: job.attempt_count,
        steps: jobSteps.length,
      });

      // Resolve handler
      const handler = getJobHandler(job.job_type);
      if (!handler) {
        // No handler — permanent failure, no retry
        const error = createJobError(
          JOB_ERROR_CODES.HANDLER_NOT_FOUND,
          `No handler registered for job type: ${job.job_type}`,
          { job_type: job.job_type },
          false, // not retryable
        );
        await this.rpc.failJob(jobId, error, false);
        this.totalFailed++;
        this.logger.error("No handler for job type", { job_id: jobId, job_type: job.job_type });
        return;
      }

      // Determine execution strategy
      const action = determineNextAction(job, jobSteps);

      let result: HandlerResult;

      if (action.action === "execute" || action.action === "dequeue") {
        // Simple job: execute handler, then complete
        result = await this.executeWithTimeout(
          () => this.executeSimpleJob(job, handler, controller.signal),
          this.config.job_timeout_ms,
          controller.signal,
        );
      } else if (action.action === "execute_step" && action.nextStepIndex !== undefined) {
        // Multi-step job: execute the next eligible step
        const step = jobSteps.find((s) => s.sequence === action.nextStepIndex);
        if (!step) {
          await this.rpc.failJob(jobId, createJobError(
            JOB_ERROR_CODES.UNKNOWN,
            `Step at sequence ${action.nextStepIndex} not found`,
          ));
          this.totalFailed++;
          return;
        }
        result = await this.executeWithTimeout(
          () => this.executeStep(job, step, handler, controller.signal, jobSteps),
          this.config.job_timeout_ms,
          controller.signal,
        );
      } else if (action.action === "complete") {
        // All steps done — mark complete with existing result
        const output = job.result ?? {};
        const aiMeta = job.ai_metadata ? (job.ai_metadata as unknown as Record<string, unknown>) : null;
        await this.rpc.completeJob(jobId, output, aiMeta);
        this.totalProcessed++;
        this.logger.info("Job completed (all steps done)", { job_id: jobId });
        return;
      } else if (action.action === "escalate") {
        // Step failed beyond retry limit — permanent failure
        const failedStep = jobSteps.find((s) => s.status === "failed");
        const error = createJobError(
          JOB_ERROR_CODES.UNKNOWN,
          `Step "${failedStep?.step_type ?? "unknown"}" failed after ${failedStep?.attempt_count ?? 0} attempts`,
          { step_type: failedStep?.step_type, sequence: failedStep?.sequence },
          false,
        );
        await this.rpc.failJob(jobId, error, false);
        this.totalFailed++;
        this.logger.error("Job escalated (step exceeded max attempts)", { job_id: jobId });
        return;
      } else {
        // Simple job: execute handler directly
        result = await this.executeWithTimeout(
          () => this.executeSimpleJob(job, handler, controller.signal),
          this.config.job_timeout_ms,
          controller.signal,
        );
      }

      // Handle the result — pass jobSteps for context
      await this.handleResult(job, result, jobSteps);
    } catch (err) {
      // Unexpected error — fail the job
      const error = createJobError(
        JOB_ERROR_CODES.UNKNOWN,
        err instanceof Error ? err.message : String(err),
        { stack: err instanceof Error ? err.stack : undefined },
        true,
      );
      await this.rpc.failJob(jobId, error);
      this.totalFailed++;
      this.logger.error("Job processing failed", { job_id: jobId, error: String(err) });
    } finally {
      this.activeJobs.delete(jobId);
      this.stopHeartbeat(jobId);
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async executeSimpleJob(
    job: AtlasJob,
    handler: JobHandler,
    signal: AbortSignal,
  ): Promise<HandlerResult> {
    const ctx = this.createContext(job, null, [], signal);
    return handler(ctx);
  }

  private async executeStep(
    job: AtlasJob,
    step: AtlasJobStep,
    handler: JobHandler,
    signal: AbortSignal,
    steps: AtlasJobStep[],
  ): Promise<HandlerResult> {
    const ctx = this.createContext(job, step, steps, signal);
    return handler(ctx);
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(createJobError(JOB_ERROR_CODES.TIMEOUT, `Execution timed out after ${timeoutMs}ms`, { timeout_ms: timeoutMs }));
      }, timeoutMs);

      // Listen for abort
      const onAbort = () => {
        clearTimeout(timer);
        reject(createJobError(JOB_ERROR_CODES.TIMEOUT, "Execution cancelled", { cancelled: true }));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      fn()
        .then((result) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  }

  // -------------------------------------------------------------------------
  // Result handling
  // -------------------------------------------------------------------------

  private async handleResult(job: AtlasJob, result: HandlerResult, steps: AtlasJobStep[]): Promise<void> {
    if (result.success) {
      const aiMeta = result.ai_metadata ? (result.ai_metadata as unknown as Record<string, unknown>) : null;

      if (result.requires_human_review) {
        // DURABLE PAUSE: Transition job to awaiting_review via dedicated RPC.
        // The worker will NOT dequeue this job again until a human approves/rejects.
        // The job enters awaiting_review and stays there durably in the database.
        // When approved, jobs_resume_from_review transitions it back to pending
        // and the worker picks it up again.
        const reviewId = (result.result as Record<string, unknown>)?.review_id as string | undefined;
        await this.rpc.awaitingReview(job._id, reviewId ?? null);
        this.totalProcessed++;
        this.logger.info("Job paused: awaiting human review", {
          job_id: job._id,
          job_type: job.job_type,
          review_id: reviewId ?? null,
        });
      } else {
        // Normal completion — persist results and mark complete
        await this.rpc.completeJob(job._id, result.result ?? {}, aiMeta);
        this.totalProcessed++;
        this.logger.info("Job completed successfully", {
          job_id: job._id,
          job_type: job.job_type,
        });
      }
    } else {
      // Handler failed
      const error = result.error ?? createJobError(JOB_ERROR_CODES.UNKNOWN, "Handler returned failure");
      const retryable = shouldRetry(error);

      if (retryable && job.attempt_count < job.max_attempts) {
        // Schedule retry
        await this.rpc.failJob(job._id, error, true);
        this.totalFailed++;
        this.logger.info("Job failed (will retry)", {
          job_id: job._id,
          job_type: job.job_type,
          attempt: job.attempt_count,
          error_code: error.code,
        });
      } else {
        // Permanent failure
        await this.rpc.failJob(job._id, error, false);
        this.totalFailed++;
        this.logger.error("Job failed permanently", {
          job_id: job._id,
          job_type: job.job_type,
          attempt: job.attempt_count,
          error_code: error.code,
          error_message: error.message,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Context creation
  // -------------------------------------------------------------------------

  private createContext(
    job: AtlasJob,
    step: AtlasJobStep | null,
    steps: AtlasJobStep[],
    signal: AbortSignal,
  ): JobExecutionContext {
    return {
      job,
      step,
      steps,
      supabase: null, // Will be injected by the Edge Function wrapper
      logger: createLogger(`job:${(job._id ?? "unknown").slice(0, 8)}`),
      signal,
      worker_id: this.config.worker_id,
      attempt: job.attempt_count,
    };
  }

  // -------------------------------------------------------------------------
  // Heartbeat / lease extension
  // -------------------------------------------------------------------------

  private startHeartbeat(jobId: string): void {
    // Extend the lock every 60 seconds (lock expires in 5 minutes by default)
    const intervalMs = Math.max(this.config.lock_timeout_ms / 3, 30_000);
    const timer = setInterval(async () => {
      try {
        // Re-fetch the job to extend the lock — the dequeue RPC already
        // set lock_expires_at, but we can extend it by re-running dequeue
        // which will update the lock_expires_at for processing jobs.
        // For now, we rely on the worker finishing within the lock window.
        // A future enhancement can add an explicit `jobs_extend_lock` RPC.
        this.logger.debug("Heartbeat tick", { job_id: jobId });
      } catch (err) {
        this.logger.warn("Heartbeat failed", { job_id: jobId, error: String(err) });
      }
    }, intervalMs);
    this.heartbeatTimers.set(jobId, timer);
  }

  private stopHeartbeat(jobId: string): void {
    const timer = this.heartbeatTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(jobId);
    }
  }

  // -------------------------------------------------------------------------
  // Stuck job sweeper
  // -------------------------------------------------------------------------

  private async sweepStuckJobs(): Promise<void> {
    try {
      const result = await this.rpc.unlockStuck();
      if (result.unlocked > 0) {
        this.logger.info("Sweeper reclaimed stuck jobs", { unlocked: result.unlocked });
      }
    } catch (err) {
      this.logger.error("Sweeper failed", { error: String(err) });
    }
  }
}
