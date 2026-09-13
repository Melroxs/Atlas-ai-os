// ---------------------------------------------------------------------------
// Milestone 9 — 14,000 User Scale, Concurrency & Backpressure Tests
//
// Tests scalability configuration, backpressure, AI concurrency limiting,
// tenant quotas, priority bands, load testing, failure recovery, and
// observability metrics.
//
// All load tests are SIMULATED — they run against in-memory structures
// and do NOT require Supabase or AI providers.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  getBackpressureLevel,
  getMaxClaimForLevel,
  evaluateBackpressure,
  checkTenantQuota,
  DEFAULT_BACKPRESSURE,
  DEFAULT_TENANT_QUOTA,
  SCALE_PROFILES,
  DEFAULT_PRIORITY_BANDS,
} from "./jobs/scale-config";
import { AIConcurrencyLimiter, DEFAULT_AI_CONFIG } from "./jobs/ai-concurrency";
import { MetricsCollector } from "./jobs/metrics";
import {
  runLoadTest,
  createSimJob,
  resetJobCounter,
  SimJobQueue,
  SimWorker,
  type LoadTestConfig,
} from "./jobs/load-test";
import { JOB_STATUSES, JOB_PRIORITIES, JOB_STEP_STATUSES, DEFAULT_WORKER_CONFIG } from "./jobs/types";
import { getPipelineConfig } from "./jobs/pipeline-config";

// =========================================================================
// 1. Backpressure System
// =========================================================================

describe("Milestone 9: Backpressure", () => {
  it("normal level when queue is empty", () => {
    expect(getBackpressureLevel(0)).toBe("normal");
    expect(getBackpressureLevel(50)).toBe("normal");
    expect(getBackpressureLevel(99)).toBe("normal");
  });

  it("warning level at threshold", () => {
    expect(getBackpressureLevel(100)).toBe("warning");
    expect(getBackpressureLevel(200)).toBe("warning");
    expect(getBackpressureLevel(499)).toBe("warning");
  });

  it("high level at threshold", () => {
    expect(getBackpressureLevel(500)).toBe("high");
    expect(getBackpressureLevel(1000)).toBe("high");
  });

  it("critical level at threshold", () => {
    expect(getBackpressureLevel(2000)).toBe("critical");
    expect(getBackpressureLevel(5000)).toBe("critical");
  });

  it("max claim reduces under backpressure", () => {
    const normal = getMaxClaimForLevel("normal", DEFAULT_BACKPRESSURE, 5);
    const warning = getMaxClaimForLevel("warning", DEFAULT_BACKPRESSURE, 5);
    const high = getMaxClaimForLevel("high", DEFAULT_BACKPRESSURE, 5);
    const critical = getMaxClaimForLevel("critical", DEFAULT_BACKPRESSURE, 5);

    expect(normal).toBe(5);
    expect(warning).toBe(3);
    expect(high).toBe(1);
    expect(critical).toBe(1);
  });

  it("evaluateBackpressure returns correct decision", () => {
    const decision = evaluateBackpressure(250, 5, 10);
    expect(decision.level).toBe("warning");
    expect(decision.maxClaim).toBeLessThanOrEqual(10);
    expect(decision.deferLowPriority).toBe(false);
    expect(decision.deferNormalPriority).toBe(false);
  });

  it("critical backpressure defers low and normal priority", () => {
    const decision = evaluateBackpressure(3000, 10, 10);
    expect(decision.level).toBe("critical");
    expect(decision.deferLowPriority).toBe(true);
    expect(decision.deferNormalPriority).toBe(true);
  });

  it("custom thresholds work", () => {
    const custom = { ...DEFAULT_BACKPRESSURE, warning_depth: 10, high_depth: 50, critical_depth: 100 };
    expect(getBackpressureLevel(15, custom)).toBe("warning");
    expect(getBackpressureLevel(60, custom)).toBe("high");
    expect(getBackpressureLevel(150, custom)).toBe("critical");
  });
});

// =========================================================================
// 2. Tenant Quotas
// =========================================================================

describe("Milestone 9: Tenant Quotas", () => {
  it("allows within quota", () => {
    const result = checkTenantQuota("tenant-1", DEFAULT_TENANT_QUOTA, 3, 20);
    expect(result.allowed).toBe(true);
    expect(result.remaining_concurrent).toBe(7);
    expect(result.remaining_hourly).toBe(80);
  });

  it("blocks concurrent limit", () => {
    const result = checkTenantQuota("tenant-1", DEFAULT_TENANT_QUOTA, 10, 20);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("concurrent");
  });

  it("blocks hourly limit", () => {
    const result = checkTenantQuota("tenant-1", DEFAULT_TENANT_QUOTA, 5, 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("hourly");
  });

  it("does not allow tenant to flood queue", () => {
    const quota = { ...DEFAULT_TENANT_QUOTA, max_concurrent_jobs: 3, max_jobs_per_hour: 10 };
    // Tenant has 3 active and 10 done this hour
    const result = checkTenantQuota("tenant-A", quota, 3, 10);
    expect(result.allowed).toBe(false);
    // Tenant B with minimal usage should be fine
    const resultB = checkTenantQuota("tenant-B", quota, 0, 0);
    expect(resultB.allowed).toBe(true);
  });
});

// =========================================================================
// 3. Priority Bands
// =========================================================================

describe("Milestone 9: Priority Bands", () => {
  it("has 4 priority bands", () => {
    expect(DEFAULT_PRIORITY_BANDS.length).toBe(4);
  });

  it("critical band covers priority 1", () => {
    const critical = DEFAULT_PRIORITY_BANDS[0];
    expect(critical.priority_min).toBe(1);
    expect(critical.priority_max).toBe(1);
    expect(critical.name).toBe("critical");
  });

  it("all priority values are covered", () => {
    const covered = new Set<number>();
    for (const band of DEFAULT_PRIORITY_BANDS) {
      for (let p = band.priority_min; p <= band.priority_max; p++) {
        covered.add(p);
      }
    }
    for (const p of JOB_PRIORITIES) {
      expect(covered.has(p)).toBe(true);
    }
  });
});

// =========================================================================
// 4. Scale Profiles
// =========================================================================

describe("Milestone 9: Scale Profiles", () => {
  it("has pilot, early_production, growth, and target profiles", () => {
    expect(SCALE_PROFILES.pilot).toBeDefined();
    expect(SCALE_PROFILES.early_production).toBeDefined();
    expect(SCALE_PROFILES.growth).toBeDefined();
    expect(SCALE_PROFILES.target).toBeDefined();
  });

  it("pilot supports 100 users with 1 worker", () => {
    const pilot = SCALE_PROFILES.pilot;
    expect(pilot.expected_users).toBe(100);
    expect(pilot.workers).toBe(1);
    expect(pilot.worker_concurrency).toBe(5);
  });

  it("target supports 14,000 users with 25 workers", () => {
    const target = SCALE_PROFILES.target;
    expect(target.expected_users).toBe(14_000);
    expect(target.workers).toBe(25);
    expect(target.worker_concurrency).toBe(20);
  });

  it("each profile has tenant quota", () => {
    for (const profile of Object.values(SCALE_PROFILES)) {
      expect(profile.tenant_quota.max_concurrent_jobs).toBeGreaterThan(0);
      expect(profile.tenant_quota.max_jobs_per_hour).toBeGreaterThan(0);
    }
  });
});

// =========================================================================
// 5. AI Concurrency Limiter
// =========================================================================

describe("Milestone 9: AI Concurrency Limiter", () => {
  let limiter: AIConcurrencyLimiter;

  beforeEach(() => {
    limiter = new AIConcurrencyLimiter({
      global_max_concurrent: 10,
      per_tenant_max_concurrent: 3,
      global_rate_limit_per_minute: 60,
      per_tenant_rate_limit_per_minute: 10,
      global_cost_limit_per_hour_usd: 50,
      per_tenant_cost_limit_per_hour_usd: 5,
    });
  });

  it("allows within limits", () => {
    const allowed = limiter.claimSlot({
      tenant_id: "t1",
      agent_type: "evidence",
      model: "gpt-4o-mini",
      estimated_tokens: 1000,
      estimated_cost_usd: 0.01,
    });
    expect(allowed).toBe(true);
  });

  it("blocks when per-tenant concurrency hit", () => {
    for (let i = 0; i < 3; i++) {
      limiter.claimSlot({ tenant_id: "t1", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    }
    const blocked = limiter.claimSlot({
      tenant_id: "t1",
      agent_type: "evidence",
      model: "m",
      estimated_tokens: 100,
      estimated_cost_usd: 0.01,
    });
    expect(blocked).toBe(false);
  });

  it("blocks when global concurrency hit", () => {
    for (let i = 0; i < 10; i++) {
      limiter.claimSlot({
        tenant_id: `t${i}`,
        agent_type: "evidence",
        model: "m",
        estimated_tokens: 100,
        estimated_cost_usd: 0.01,
      });
    }
    const blocked = limiter.claimSlot({
      tenant_id: "new-tenant",
      agent_type: "evidence",
      model: "m",
      estimated_tokens: 100,
      estimated_cost_usd: 0.01,
    });
    expect(blocked).toBe(false);
  });

  it("releases slot correctly", () => {
    limiter.claimSlot({ tenant_id: "t1", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    limiter.releaseSlot("t1", 100, 0.01);
    // Should be able to claim again
    const allowed = limiter.claimSlot({
      tenant_id: "t1",
      agent_type: "evidence",
      model: "m",
      estimated_tokens: 100,
      estimated_cost_usd: 0.01,
    });
    expect(allowed).toBe(true);
  });

  it("checkAllowance without claiming", () => {
    const check = limiter.checkAllowance({
      tenant_id: "t1",
      agent_type: "evidence",
      model: "m",
      estimated_tokens: 100,
      estimated_cost_usd: 0.01,
    });
    expect(check.allowed).toBe(true);
  });

  it("retry delay increases with exponential backoff", () => {
    const d0 = limiter.getRetryDelay(0);
    const d1 = limiter.getRetryDelay(1);
    const d2 = limiter.getRetryDelay(2);
    // Base delays should roughly double (with jitter)
    expect(d1).toBeGreaterThan(d0 * 0.5);
    expect(d2).toBeGreaterThan(d1 * 0.5);
  });

  it("shouldRetry respects max retries", () => {
    expect(limiter.shouldRetry(0, false)).toBe(true);
    expect(limiter.shouldRetry(2, false)).toBe(true);
    expect(limiter.shouldRetry(3, false)).toBe(false);
  });

  it("rate-limited responses get extra retries", () => {
    expect(limiter.shouldRetry(3, true)).toBe(true);
    expect(limiter.shouldRetry(4, true)).toBe(true);
    expect(limiter.shouldRetry(5, true)).toBe(false);
  });

  it("tracks stats correctly", () => {
    limiter.claimSlot({ tenant_id: "t1", agent_type: "evidence", model: "m", estimated_tokens: 500, estimated_cost_usd: 0.05 });
    limiter.releaseSlot("t1", 500, 0.05);
    limiter.claimSlot({ tenant_id: "t2", agent_type: "qa", model: "m", estimated_tokens: 300, estimated_cost_usd: 0.03 });
    limiter.releaseSlot("t2", 300, 0.03);

    const stats = limiter.getStats();
    expect(stats.global_total_calls).toBe(2);
    expect(stats.global_total_tokens).toBe(800);
    expect(stats.global_total_cost_usd).toBeCloseTo(0.08, 2);
    expect(stats.tenant_stats.length).toBe(2);
  });

  it("blocks tokens exceeding max per call", () => {
    const check = limiter.checkAllowance({
      tenant_id: "t1",
      agent_type: "evidence",
      model: "m",
      estimated_tokens: 100_000,
      estimated_cost_usd: 1.0,
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("Token");
  });

  it("reset clears all state", () => {
    limiter.claimSlot({ tenant_id: "t1", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    limiter.releaseSlot("t1", 100, 0.01);
    limiter.reset();

    const stats = limiter.getStats();
    expect(stats.global_total_calls).toBe(0);
    expect(stats.global_active).toBe(0);
  });
});

// =========================================================================
// 6. Load Tests (SIMULATED)
// =========================================================================

describe("Milestone 9: Load Tests (SIMULATED)", () => {
  beforeEach(() => {
    resetJobCounter();
  });

  it("100 jobs with 1 worker completes", async () => {
    const result = await runLoadTest({
      totalJobs: 100,
      workers: [{ worker_id: "w1", max_concurrent_jobs: 5, poll_interval_ms: 10, job_timeout_ms: 5000 }],
      jobDurationMs: 1,
      failureRate: 0,
      tenantCount: 5,
      label: "SIMULATED: 100 jobs, 1 worker",
    });

    expect(result.completed).toBeGreaterThan(0);
    expect(result.duplicate_executions).toBe(0);
    expect(result.throughput_jobs_per_second).toBeGreaterThan(0);
  });

  it("1000 jobs with 3 workers completes", async () => {
    const result = await runLoadTest({
      totalJobs: 1000,
      workers: [
        { worker_id: "w1", max_concurrent_jobs: 10, poll_interval_ms: 10, job_timeout_ms: 5000 },
        { worker_id: "w2", max_concurrent_jobs: 10, poll_interval_ms: 10, job_timeout_ms: 5000 },
        { worker_id: "w3", max_concurrent_jobs: 10, poll_interval_ms: 10, job_timeout_ms: 5000 },
      ],
      jobDurationMs: 1,
      failureRate: 0,
      tenantCount: 20,
      label: "SIMULATED: 1000 jobs, 3 workers",
    });

    expect(result.completed).toBeGreaterThanOrEqual(900); // Allow some retries
    expect(result.duplicate_executions).toBe(0);
    expect(result.throughput_jobs_per_second).toBeGreaterThan(0);
  });

  it("5000 jobs with 10 workers completes", async () => {
    const result = await runLoadTest({
      totalJobs: 5000,
      workers: Array.from({ length: 10 }, (_, i) => ({
        worker_id: `w${i}`,
        max_concurrent_jobs: 15,
        poll_interval_ms: 10,
        job_timeout_ms: 5000,
      })),
      jobDurationMs: 1,
      failureRate: 0.02,
      tenantCount: 50,
      label: "SIMULATED: 5000 jobs, 10 workers",
    });

    expect(result.completed).toBeGreaterThanOrEqual(4000);
    expect(result.duplicate_executions).toBe(0);
    expect(result.throughput_jobs_per_second).toBeGreaterThan(0);
  });

  it("10000 jobs with 25 workers completes", async () => {
    const result = await runLoadTest({
      totalJobs: 10_000,
      workers: Array.from({ length: 25 }, (_, i) => ({
        worker_id: `w${i}`,
        max_concurrent_jobs: 20,
        poll_interval_ms: 10,
        job_timeout_ms: 5000,
      })),
      jobDurationMs: 1,
      failureRate: 0.02,
      tenantCount: 100,
      label: "SIMULATED: 10000 jobs, 25 workers",
    });

    expect(result.completed).toBeGreaterThanOrEqual(8000);
    expect(result.duplicate_executions).toBe(0);
  });

  it("no duplicate executions across workers (SKIP LOCKED)", async () => {
    const result = await runLoadTest({
      totalJobs: 500,
      workers: [
        { worker_id: "w1", max_concurrent_jobs: 20, poll_interval_ms: 1, job_timeout_ms: 5000 },
        { worker_id: "w2", max_concurrent_jobs: 20, poll_interval_ms: 1, job_timeout_ms: 5000 },
        { worker_id: "w3", max_concurrent_jobs: 20, poll_interval_ms: 1, job_timeout_ms: 5000 },
        { worker_id: "w4", max_concurrent_jobs: 20, poll_interval_ms: 1, job_timeout_ms: 5000 },
        { worker_id: "w5", max_concurrent_jobs: 20, poll_interval_ms: 1, job_timeout_ms: 5000 },
      ],
      jobDurationMs: 1,
      failureRate: 0,
      tenantCount: 10,
      label: "SIMULATED: 500 jobs, 5 workers contention test",
    });

    expect(result.duplicate_executions).toBe(0);
  });

  it("handles 5% failure rate with retries", async () => {
    const result = await runLoadTest({
      totalJobs: 200,
      workers: [{ worker_id: "w1", max_concurrent_jobs: 5, poll_interval_ms: 10, job_timeout_ms: 5000 }],
      jobDurationMs: 1,
      failureRate: 0.05,
      tenantCount: 5,
      label: "SIMULATED: 200 jobs, 5% failure rate",
    });

    expect(result.failed + result.retried).toBeGreaterThan(0);
    expect(result.completed).toBeGreaterThan(0);
  });

  it("throughput increases with more workers", async () => {
    const result1 = await runLoadTest({
      totalJobs: 500,
      workers: [{ worker_id: "w1", max_concurrent_jobs: 5, poll_interval_ms: 10, job_timeout_ms: 5000 }],
      jobDurationMs: 1,
      failureRate: 0,
      tenantCount: 5,
      label: "SIMULATED: 500 jobs, 1 worker",
    });

    resetJobCounter();

    const result5 = await runLoadTest({
      totalJobs: 500,
      workers: Array.from({ length: 5 }, (_, i) => ({
        worker_id: `w${i}`,
        max_concurrent_jobs: 5,
        poll_interval_ms: 10,
        job_timeout_ms: 5000,
      })),
      jobDurationMs: 1,
      failureRate: 0,
      tenantCount: 5,
      label: "SIMULATED: 500 jobs, 5 workers",
    });

    expect(result5.throughput_jobs_per_second).toBeGreaterThanOrEqual(result1.throughput_jobs_per_second);
  });
});

// =========================================================================
// 7. Worker Crash Recovery
// =========================================================================

describe("Milestone 9: Worker Crash Recovery", () => {
  beforeEach(() => {
    resetJobCounter();
  });

  it("worker crash releases job for re-claiming", () => {
    const queue = new SimJobQueue();
    const job = createSimJob({ id: "crash-test", _id: "crash-test" });
    queue.enqueue(job);

    // Worker claims the job
    const claimed = queue.dequeue("w1", 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0].status).toBe("processing");

    // Worker crashes — unlock the job so another worker can claim it
    queue.unlockJob(job.id);

    // Another worker can claim it
    const reClaimed = queue.dequeue("w2", 1);
    expect(reClaimed.length).toBe(1);
    expect(reClaimed[0].locked_by).toBe("w2");
  });

  it("duplicate trigger produces only one active job (idempotency)", () => {
    const queue = new SimJobQueue();
    const job = createSimJob({ id: "idemp-test", _id: "idemp-test", idempotency_key: "same-key" });
    queue.enqueue(job);

    // Claim once
    const claimed1 = queue.dequeue("w1", 1);
    expect(claimed1.length).toBe(1);

    // Try to claim again — should not be available
    const claimed2 = queue.dequeue("w1", 1);
    expect(claimed2.length).toBe(0);
  });

  it("approving a review resumes the job", () => {
    const queue = new SimJobQueue();
    const job = createSimJob({ id: "review-resume", _id: "review-resume" });
    job.status = "awaiting_review";
    queue.enqueue(job);

    // Worker should NOT claim awaiting_review jobs (only pending/queued)
    const claimed = queue.dequeue("w1", 1);
    expect(claimed.length).toBe(0);

    // Simulate approval: set back to pending and clear lock
    queue.unlockJob(job.id);

    // Now worker can claim
    const reClaimed = queue.dequeue("w1", 1);
    expect(reClaimed.length).toBe(1);
  });
});

// =========================================================================
// 8. Metrics
// =========================================================================

describe("Milestone 9: Metrics", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  it("tracks job creation and completion", () => {
    metrics.recordJobCreated("t1");
    metrics.recordJobCreated("t1");
    metrics.recordJobCompleted(100, "t1");

    const snap = metrics.getSnapshot();
    expect(snap.jobs.created_total).toBe(2);
    expect(snap.jobs.completed_total).toBe(1);
    expect(snap.jobs.created_per_minute).toBe(2);
  });

  it("tracks AI metrics", () => {
    metrics.recordAICall("t1", 1000, 0.05, 500);
    metrics.recordAICall("t1", 2000, 0.10, 800);

    const snap = metrics.getSnapshot();
    expect(snap.ai.total_calls).toBe(2);
    expect(snap.ai.total_tokens).toBe(3000);
    expect(snap.ai.total_cost_usd).toBeCloseTo(0.15, 2);
  });

  it("tracks agent runs", () => {
    metrics.recordAgentRun("evidence", 1000, true);
    metrics.recordAgentRun("qa", 500, false);

    const snap = metrics.getSnapshot();
    expect(snap.agents.total_agent_runs).toBe(2);
    expect(snap.agents.evidence_runs).toBe(1);
    expect(snap.agents.qa_runs).toBe(1);
    expect(snap.agents.failure_rate_pct).toBe(50);
  });

  it("tracks queue state", () => {
    metrics.setQueueState(150, 100, 40, 10, "warning");
    metrics.setWorkerState(5, 20, 5);

    const snap = metrics.getSnapshot();
    expect(snap.queue.depth).toBe(150);
    expect(snap.queue.backpressure_level).toBe("warning");
    expect(snap.workers.active_workers).toBe(5);
    expect(snap.workers.utilization_pct).toBe(80); // 20/25
  });

  it("reset clears all metrics", () => {
    metrics.recordJobCreated("t1");
    metrics.recordAICall("t1", 1000, 0.05, 100);
    metrics.reset();

    const snap = metrics.getSnapshot();
    expect(snap.jobs.created_total).toBe(0);
    expect(snap.ai.total_calls).toBe(0);
  });

  it("snapshot includes tenant-scoped metrics", () => {
    metrics.recordJobCompleted(100, "tenant-A");
    metrics.recordJobCompleted(200, "tenant-A");
    metrics.recordJobCompleted(150, "tenant-B");

    const snap = metrics.getSnapshot();
    expect(snap.tenants.length).toBe(2);
    const tenantA = snap.tenants.find((t) => t.tenant_id === "tenant-A");
    expect(tenantA?.jobs_completed_hour).toBe(2);
  });
});

// =========================================================================
// 9. Security Under Load
// =========================================================================

describe("Milestone 9: Security Under Load", () => {
  it("tenant A cannot exhaust tenant B quota", () => {
    const quota = { ...DEFAULT_TENANT_QUOTA, max_concurrent_jobs: 5, max_jobs_per_hour: 20 };

    // Tenant A uses all its quota
    for (let i = 0; i < 5; i++) {
      const result = checkTenantQuota("tenant-A", quota, i, 0);
      expect(result.allowed).toBe(true);
    }
    const aFull = checkTenantQuota("tenant-A", quota, 5, 20);
    expect(aFull.allowed).toBe(false);

    // Tenant B should still be allowed
    const bOk = checkTenantQuota("tenant-B", quota, 0, 0);
    expect(bOk.allowed).toBe(true);
  });

  it("AI limiter isolates tenants", () => {
    const limiter = new AIConcurrencyLimiter({
      global_max_concurrent: 100,
      per_tenant_max_concurrent: 3,
      global_rate_limit_per_minute: 1000,
      per_tenant_rate_limit_per_minute: 5,
      global_cost_limit_per_hour_usd: 1000,
      per_tenant_cost_limit_per_hour_usd: 1,
      max_tokens_per_call: 10_000,
      max_retries: 3,
      retry_base_delay_ms: 100,
      retry_max_delay_ms: 1000,
      call_timeout_ms: 5000,
    });

    // Tenant A fills its per-tenant limit
    for (let i = 0; i < 3; i++) {
      limiter.claimSlot({ tenant_id: "A", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    }
    const aBlocked = limiter.claimSlot({ tenant_id: "A", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    expect(aBlocked).toBe(false);

    // Tenant B should still be allowed
    const bOk = limiter.claimSlot({ tenant_id: "B", agent_type: "evidence", model: "m", estimated_tokens: 100, estimated_cost_usd: 0.01 });
    expect(bOk).toBe(true);

    limiter.reset();
  });
});

// =========================================================================
// 10. Capacity Model Validation
// =========================================================================

describe("Milestone 9: Capacity Model", () => {
  it("pilot profile is feasible with 1 worker", () => {
    const pilot = SCALE_PROFILES.pilot;
    // 1 worker × 5 concurrency = 5 concurrent jobs
    // At 10s avg per job = 30 jobs/min = 1,800 jobs/hour
    // 100 users × 10 jobs/day = 1,000 jobs/day = ~42 jobs/hour
    const maxJobsPerHour = pilot.workers * pilot.worker_concurrency * (3600 / 10);
    expect(maxJobsPerHour).toBeGreaterThan(1000); // Well above 42 jobs/hour
  });

  it("target profile handles 14k user load", () => {
    const target = SCALE_PROFILES.target;
    // 14,000 users × ~10 jobs/day = 140,000 jobs/day ≈ 5,833 jobs/hour ≈ 97 jobs/min
    // 25 workers × 20 concurrency = 500 concurrent jobs
    // At 10s avg = 3,000 jobs/min = 180,000 jobs/hour
    const maxJobsPerHour = target.workers * target.worker_concurrency * (3600 / 10);
    expect(maxJobsPerHour).toBeGreaterThan(5833);
  });

  it("atlas_worker_config defaults are documented", () => {
    // Verify the defaults we audited
    expect(DEFAULT_WORKER_CONFIG.poll_interval_ms).toBe(2000);
    expect(DEFAULT_WORKER_CONFIG.max_concurrent_jobs).toBe(5);
    expect(DEFAULT_WORKER_CONFIG.lock_timeout_ms).toBe(300_000);
    expect(DEFAULT_WORKER_CONFIG.job_timeout_ms).toBe(300_000);
    expect(DEFAULT_WORKER_CONFIG.enable_sweeper).toBe(true);
    expect(DEFAULT_WORKER_CONFIG.sweeper_interval_ms).toBe(60_000);
  });

  it("pipeline config defaults are documented", () => {
    const config = getPipelineConfig();
    expect(config.enabled).toBe(false);
    expect(typeof config.maxConcurrent).toBe("number");
    expect(typeof config.stepTimeoutMs).toBe("number");
    expect(typeof config.maxStepRetries).toBe("number");
  });

  it("job statuses include all workflow states", () => {
    expect(JOB_STATUSES).toContain("pending");
    expect(JOB_STATUSES).toContain("processing");
    expect(JOB_STATUSES).toContain("completed");
    expect(JOB_STATUSES).toContain("failed");
    expect(JOB_STATUSES).toContain("awaiting_review");
    expect(JOB_STATUSES).toContain("cancelled");
  });

  it("step statuses cover all step lifecycle states", () => {
    expect(JOB_STEP_STATUSES).toContain("pending");
    expect(JOB_STEP_STATUSES).toContain("processing");
    expect(JOB_STEP_STATUSES).toContain("completed");
    expect(JOB_STEP_STATUSES).toContain("failed");
    expect(JOB_STEP_STATUSES).toContain("skipped");
    expect(JOB_STEP_STATUSES).toContain("cancelled");
  });
});

// =========================================================================
// 11. Backpressure Integration
// =========================================================================

describe("Milestone 9: Backpressure Integration", () => {
  it("backpressure integrates with load test", async () => {
    // Simulate a growing queue
    const queue = new SimJobQueue();
    for (let i = 0; i < 150; i++) {
      queue.enqueue(createSimJob({ tenant_id: `t${i % 10}` }));
    }

    const level = getBackpressureLevel(queue.depth);
    expect(level).toBe("warning");

    const decision = evaluateBackpressure(queue.depth, 3, 10);
    expect(deferLowerPriority(decision)).toBe(false);
  });

  it("critical backpressure reduces throughput intentionally", () => {
    const decision = evaluateBackpressure(5000, 10, 20);
    expect(decision.level).toBe("critical");
    expect(decision.maxClaim).toBeLessThanOrEqual(5);
    expect(decision.deferLowPriority).toBe(true);
  });
});

// Helper
function deferLowerPriority(d: { deferLowPriority: boolean; deferNormalPriority: boolean }): boolean {
  return d.deferLowPriority;
}
