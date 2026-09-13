// ---------------------------------------------------------------------------
// Atlas Platform — Supabase-backed service wiring
//
// Binds the platform handler ports to the real Supabase RPCs and the SSRF-
// guarded HTTP fetcher. The worker injects a service-role client; browser code
// uses the authenticated client (RLS still applies).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import { createHttpSourceFetcher } from "./fetcher";
import type { PlatformServices, JobsPort } from "./handlers";
import * as p from "./rpc";

export interface PlatformServiceOptions {
  /** Injected for tests. */
  fetcher?: PlatformServices["fetch"];
  now?: () => number;
}

function createJobsPort(supabase: SupabaseClient): JobsPort {
  return {
    async enqueue(input) {
      const result = (await rpcCall(supabase, "jobs_create_job", {
        tenant_id: input.tenantId ?? null,
        user_id: null,
        job_type: input.jobType,
        priority: input.priority ?? 4,
        idempotency_key: input.idempotencyKey,
        payload: input.payload,
        max_attempts: input.maxAttempts ?? 3,
        scheduled_at: null,
        parent_job_id: null,
        tags: input.tags ?? [],
      })) as { job_id: string; deduplicated: boolean };
      return result;
    },
    listFailed(limit) {
      return p.listFailedJobs(supabase, limit);
    },
  };
}

export function createSupabasePlatformServices(
  supabase: SupabaseClient,
  options: PlatformServiceOptions = {},
): PlatformServices {
  return {
    sources: {
      listDue: (limit) => p.listDueSources(supabase, limit),
      get: (sourceId) => p.getSource(supabase, sourceId),
      recordCheck: (sourceId, outcome, jobId, checker) =>
        p.recordSourceCheck(supabase, sourceId, outcome, jobId, checker),
    },
    knowledge: {
      listVersions: (versionGroup) => p.listKnowledgeVersions(supabase, versionGroup),
      createVersion: (input) => p.createKnowledgeVersion(supabase, input),
    },
    content: {
      get: (contentId) =>
        p.getContent(supabase, contentId) as ReturnType<PlatformServices["content"]["get"]>,
      create: (input) => p.createContent(supabase, input),
      transition: (input) => p.transitionContent(supabase, input),
    },
    jobs: createJobsPort(supabase),
    fetch: options.fetcher ?? createHttpSourceFetcher(),
    now: options.now ?? (() => Date.now()),
  };
}
