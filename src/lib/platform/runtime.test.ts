import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AtlasWorker,
  DEFAULT_WORKER_CONFIG,
  clearHandlers,
  registerJobHandler,
  type AtlasJob,
  type JobExecutionContext,
  type WorkerRPC,
} from "@/lib/jobs";
import { createPlatformHandlers, type PlatformServices } from "./handlers";
import {
  createPlatformRuntime,
  createSupabaseWorkerRPC,
  runPlatformTick,
} from "./runtime";
import type { SourceCheckOutcome } from "./types";

const NOW = Date.parse("2026-09-13T12:00:00Z");

// ---------------------------------------------------------------------------
// Fake PostgREST surface
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function fakeSupabase(handler: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: handler(fn, args), error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function makeServices(): PlatformServices {
  const recorded: Array<{ sourceId: string; outcome: SourceCheckOutcome }> = [];
  return {
    sources: {
      listDue: async () => [],
      get: async () => null,
      recordCheck: async (sourceId, outcome) => {
        recorded.push({ sourceId, outcome });
        return { ok: true };
      },
    },
    knowledge: {
      listVersions: async () => [],
      createVersion: async () => ({ ok: true, knowledge_id: "k", version_number: 1, superseded: null }),
    },
    content: {
      get: async () => null,
      create: async () => ({ ok: true, content_id: "c" }),
      transition: async (input) => ({ ok: true, status: input.status }),
    },
    jobs: {
      enqueue: async () => ({ job_id: "j", deduplicated: false }),
      listFailed: async () => [],
    },
    fetch: {
      fetch: async () => ({
        ok: true,
        httpStatus: 200,
        body: "body",
        error: null,
        retryable: true,
        latencyMs: 1,
      }),
    },
    now: () => NOW,
  };
}

function makeJob(jobType: string, id = "job-1"): AtlasJob {
  return {
    _id: id,
    _creationTime: NOW,
    tenant_id: null,
    user_id: null,
    job_type: jobType,
    status: "processing",
    priority: 4,
    idempotency_key: `key-${id}`,
    payload: {},
    result: null,
    error: null,
    attempt_count: 1,
    max_attempts: 3,
    scheduled_at: null,
    started_at: null,
    completed_at: null,
    locked_by: "w1",
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

afterEach(() => {
  clearHandlers();
});

// ---------------------------------------------------------------------------
// WorkerRPC port
// ---------------------------------------------------------------------------

describe("createSupabaseWorkerRPC", () => {
  it("uses snake_case keys that rpcCall folds to the SQL parameter names", async () => {
    const { client, calls } = fakeSupabase(() => ({ jobs: [], count: 0 }));
    const rpc = createSupabaseWorkerRPC(client);

    await rpc.dequeue("worker-A", ["knowledge_source_check"], 4);

    expect(calls[0].fn).toBe("jobs_dequeue");
    // rpcCall prefixes `p_` and lowercases — the keys must already be snake_case.
    expect(calls[0].args).toMatchObject({
      p_worker_id: "worker-A",
      p_job_types: ["knowledge_source_check"],
      p_max_jobs: 4,
    });
  });

  it("maps the { jobs: uuid[] } dequeue payload to { id } records", async () => {
    const { client } = fakeSupabase(() => ({ jobs: ["a", "b"], count: 2 }));
    const rpc = createSupabaseWorkerRPC(client);

    await expect(rpc.dequeue("w", undefined, 2)).resolves.toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("passes null job_types so the worker can claim every type", async () => {
    const { client, calls } = fakeSupabase(() => ({ jobs: [] }));
    await createSupabaseWorkerRPC(client).dequeue("w", [], 1);
    expect(calls[0].args.p_job_types).toBeNull();
  });

  it("carries the retryable flag through to jobs_fail_job", async () => {
    const { client, calls } = fakeSupabase(() => ({ ok: true, retrying: false }));
    await createSupabaseWorkerRPC(client).failJob(
      "job-1",
      { code: "UPSTREAM", message: "boom", retryable: false } as never,
      false,
    );
    expect(calls[0].fn).toBe("jobs_fail_job");
    expect(calls[0].args.p_retryable).toBe(false);
  });

  it("reclaims leases older than the stale window", async () => {
    const { client, calls } = fakeSupabase(() => ({ unlocked: 3 }));
    await expect(createSupabaseWorkerRPC(client).unlockStuck()).resolves.toEqual({ unlocked: 3 });
    expect(calls[0].fn).toBe("jobs_unlock_stuck");
    expect(calls[0].args.p_stale_after).toBe("10 minutes");
  });

  it("returns null for a missing job instead of throwing", async () => {
    const { client } = fakeSupabase(() => null);
    await expect(createSupabaseWorkerRPC(client).getJob("nope")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AtlasWorker.runOnce — the cron/serverless execution path
// ---------------------------------------------------------------------------

describe("AtlasWorker.runOnce", () => {
  it("does nothing when the queue is empty", async () => {
    const rpc: WorkerRPC = {
      dequeue: async () => [],
      getJob: async () => null,
      completeJob: async () => ({ ok: true }),
      failJob: async () => ({ ok: true, retrying: false }),
      awaitingReview: async () => ({ ok: true }),
      completeStep: async () => ({ ok: true }),
      failStep: async () => ({ ok: true }),
      cancelJob: async () => ({ ok: true }),
      unlockStuck: async () => ({ unlocked: 0 }),
    };
    const worker = new AtlasWorker(DEFAULT_WORKER_CONFIG, rpc);

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 0, processed: 0, failed: 0 });
  });

  it("executes a claimed job once and completes it", async () => {
    const completed: Array<{ id: string; result: Record<string, unknown> }> = [];
    let executions = 0;

    registerJobHandler("system_maintenance", async (_ctx: JobExecutionContext) => {
      executions += 1;
      return { success: true, result: { done: true } };
    });

    const rpc: WorkerRPC = {
      dequeue: async () => [{ id: "job-1" }],
      getJob: async () => makeJob("system_maintenance") as never,
      completeJob: async (id, result) => {
        completed.push({ id, result });
        return { ok: true };
      },
      failJob: async () => ({ ok: true, retrying: false }),
      awaitingReview: async () => ({ ok: true }),
      completeStep: async () => ({ ok: true }),
      failStep: async () => ({ ok: true }),
      cancelJob: async () => ({ ok: true }),
      unlockStuck: async () => ({ unlocked: 0 }),
    };

    const worker = new AtlasWorker(
      { ...DEFAULT_WORKER_CONFIG, worker_id: "w-test", enable_sweeper: false },
      rpc,
    );

    const summary = await worker.runOnce();

    expect(executions).toBe(1);
    expect(summary).toEqual({ claimed: 1, processed: 1, failed: 0 });
    expect(completed).toEqual([{ id: "job-1", result: { done: true } }]);
  });

  it("fails a job whose type has no handler, without retrying", async () => {
    const failures: Array<{ id: string; retryable?: boolean }> = [];

    const rpc: WorkerRPC = {
      dequeue: async () => [{ id: "job-x" }],
      getJob: async () => makeJob("no_such_handler_type") as never,
      completeJob: async () => ({ ok: true }),
      failJob: async (id, _error, retryable) => {
        failures.push({ id, retryable });
        return { ok: true, retrying: false };
      },
      awaitingReview: async () => ({ ok: true }),
      completeStep: async () => ({ ok: true }),
      failStep: async () => ({ ok: true }),
      cancelJob: async () => ({ ok: true }),
      unlockStuck: async () => ({ unlocked: 0 }),
    };

    const worker = new AtlasWorker(
      { ...DEFAULT_WORKER_CONFIG, worker_id: "w-test", enable_sweeper: false },
      rpc,
    );

    const summary = await worker.runOnce();

    expect(failures).toEqual([{ id: "job-x", retryable: false }]);
    expect(summary.claimed).toBe(1);
    expect(summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Platform runtime
// ---------------------------------------------------------------------------

describe("createPlatformRuntime", () => {
  it("registers the platform handlers into the one canonical registry", async () => {
    const { client } = fakeSupabase(() => null);
    createPlatformRuntime({ supabase: client, services: makeServices() });

    const { listRegisteredHandlers } = await import("@/lib/jobs");
    const registered = listRegisteredHandlers();

    for (const entry of createPlatformHandlers(makeServices())) {
      expect(registered).toContain(entry.jobType);
    }
  });

  it("fires due schedules and drains jobs in one tick", async () => {
    const { client, calls } = fakeSupabase((fn) => {
      if (fn === "schedules_fire_due") return { fired: [{ schedule: "s" }], count: 1 };
      return null;
    });

    const drained: WorkerRPC["dequeue"] = async () => [];
    const runtime = createPlatformRuntime({
      supabase: client,
      services: makeServices(),
      rpc: {
        dequeue: drained,
        getJob: async () => null,
        completeJob: async () => ({ ok: true }),
        failJob: async () => ({ ok: true, retrying: false }),
        awaitingReview: async () => ({ ok: true }),
        completeStep: async () => ({ ok: true }),
        failStep: async () => ({ ok: true }),
        cancelJob: async () => ({ ok: true }),
        unlockStuck: async () => ({ unlocked: 0 }),
      },
    });

    const result = await runtime.tick(5);

    expect(calls.some((c) => c.fn === "schedules_fire_due")).toBe(true);
    expect(result).toEqual({ fired: 1, claimed: 0, processed: 0, failed: 0, scheduleFailures: 0 });
  });

  it("keeps executing jobs when the scheduler call fails", async () => {
    const client = {
      rpc: async () => {
        throw new Error("scheduler unavailable");
      },
    } as unknown as SupabaseClient;

    const runtime = createPlatformRuntime({
      supabase: client,
      services: makeServices(),
      rpc: {
        dequeue: async () => [],
        getJob: async () => null,
        completeJob: async () => ({ ok: true }),
        failJob: async () => ({ ok: true, retrying: false }),
        awaitingReview: async () => ({ ok: true }),
        completeStep: async () => ({ ok: true }),
        failStep: async () => ({ ok: true }),
        cancelJob: async () => ({ ok: true }),
        unlockStuck: async () => ({ unlocked: 0 }),
      },
    });

    const result = await runtime.tick();

    // The scheduler outage is reported, never swallowed, and never stops work.
    expect(result.scheduleFailures).toBe(1);
    expect(result.claimed).toBe(0);
  });
});

describe("runPlatformTick", () => {
  it("returns a zeroed tick when nothing is due and nothing is queued", async () => {
    const { client } = fakeSupabase((fn) =>
      fn === "schedules_fire_due" ? { fired: [], count: 0 } : null,
    );

    const result = await runPlatformTick(client, {
      services: makeServices(),
      rpc: {
        dequeue: async () => [],
        getJob: async () => null,
        completeJob: async () => ({ ok: true }),
        failJob: async () => ({ ok: true, retrying: false }),
        awaitingReview: async () => ({ ok: true }),
        completeStep: async () => ({ ok: true }),
        failStep: async () => ({ ok: true }),
        cancelJob: async () => ({ ok: true }),
        unlockStuck: async () => ({ unlocked: 0 }),
      },
    });

    expect(result.fired).toBe(0);
    expect(result.processed).toBe(0);
  });
});
