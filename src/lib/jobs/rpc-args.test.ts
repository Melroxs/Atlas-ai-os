import { describe, it, expect } from "vitest";
import { toJobsRpcArgs, JOBS_RPC_PARAM_MAP } from "./rpc-args";
import { normalizeRpcArgs } from "@/lib/actions/rpc";

/**
 * Regression guard for the durable-jobs PostgREST contract: the database
 * declares snake_case parameters (`p_tenant_id`, `p_job_type`,
 * `p_idempotency_key`), so the client must never emit the camelCase-folded
 * forms (`p_tenantid`, `p_jobtype`, `p_idempotencykey`) that PostgREST cannot
 * resolve.
 */
describe("jobs RPC wire contract", () => {
  it("uses the exact parameter names production declares", () => {
    expect(toJobsRpcArgs("jobs_create_job", {})).toEqual({});
    expect(
      toJobsRpcArgs("jobs_create_job", {
        tenantId: "t",
        userId: "u",
        jobType: "evidence_pipeline",
        priority: 3,
        idempotencyKey: "k",
        payload: {},
        maxAttempts: 3,
        scheduledAt: null,
        parentJobId: null,
        tags: [],
      }),
    ).toEqual({
      p_tenant_id: "t",
      p_user_id: "u",
      p_job_type: "evidence_pipeline",
      p_priority: 3,
      p_idempotency_key: "k",
      p_payload: {},
      p_max_attempts: 3,
      p_scheduled_at: null,
      p_parent_job_id: null,
      p_tags: [],
    });
  });

  it("never emits a camelCase-folded parameter name", () => {
    const forbidden = [
      "p_tenantid",
      "p_jobtype",
      "p_idempotencykey",
      "p_jobid",
      "p_reviewid",
      "p_userid",
      "p_maxattempts",
      "p_scheduledat",
      "p_parentjobid",
      "p_steptype",
      "p_stepid",
      "p_aimetadata",
    ];
    for (const [fn, map] of Object.entries(JOBS_RPC_PARAM_MAP)) {
      // Feed each RPC exactly the logical keys it declares.
      const input = Object.fromEntries(Object.keys(map).map((k) => [k, 1]));
      const emitted = Object.keys(
        normalizeRpcArgs(toJobsRpcArgs(fn as keyof typeof JOBS_RPC_PARAM_MAP, input)),
      );
      expect(emitted.sort()).toEqual(Object.values(map).sort());
      for (const key of emitted) {
        expect(forbidden).not.toContain(key);
      }
    }
  });

  it("passes every mapped parameter through normalizeRpcArgs unchanged", () => {
    const sent = normalizeRpcArgs(
      toJobsRpcArgs("jobs_resume_from_review", {
        jobId: "j",
        reviewId: "r",
        decision: "needs_changes",
      }),
    );
    expect(sent).toEqual({
      p_job_id: "j",
      p_review_id: "r",
      p_decision: "needs_changes",
    });
  });

  it("passes unknown keys through rather than dropping them", () => {
    expect(toJobsRpcArgs("jobs_get_job", { jobId: "j", extra: 1 })).toEqual({
      p_job_id: "j",
      extra: 1,
    });
  });
});
