-- ============================================================================
-- 20260938 — Atlas production scheduler driver
--
-- THE GAP THIS CLOSES
-- -------------------
-- Atlas already has the whole recurring model: `atlas_schedules`, and
-- `schedules_fire_due()` (migration 20260913 §2). Nothing in production ever
-- CALLED it, so no schedule could ever fire. The Content Engine's automation
-- was armed but inert.
--
-- There is no existing Atlas recurring runtime: `runPlatformTick` /
-- `createPlatformRuntime` in src/lib/platform/runtime.ts call `fireDueSchedules`
-- and `worker.runOnce()`, but src/lib/platform is imported by no deployed
-- entry point (PlatformOps is not routed). The INNGEST_* secrets are
-- vestigial — no code references Inngest. `connections-run-due-syncs` is a
-- browser-triggered sweep, not a recurring driver. So the platform genuinely
-- has no production execution mechanism to own this call, and a new scheduled
-- invocation is required.
--
-- WHAT INVOKES IT
--   pg_cron, already preloaded in this project's shared_preload_libraries.
--   One job, one row, registered idempotently by job name below. There is no
--   second schedule table and no second recurrence system: the driver only
--   calls the existing functions.
--
-- AUTHENTICATION MECHANISM
--   The driver is database-internal. It is not an HTTP endpoint, is not
--   browser reachable, and is revoked from anon/authenticated/public. It runs
--   as the database owner and reaches the worker over pg_net with a JWT signed
--   by supabase.jwt_secret() (the project's own signing key, already held by
--   the platform) carrying role=service_role. NO new secret is created and no
--   credential is stored in vault or in this file.
--
-- REQUIRED SECRET
--   None. The worker is reached with the service role, which the platform
--   already issues; the driver adds no new configuration.
--
-- CADENCE
--   Every minute. Cron cannot express a sub-minute period, so one minute is
--   the floor for the DRIVER. The scheduler's own MIN_SCHEDULE_INTERVAL_SECONDS
--   is 30, so a 30s schedule is serviced on the next driver tick rather than
--   exactly on time — a schedule interval below 60s is therefore not honoured
--   to the second. Nothing in Atlas registers an interval that short.
--
-- FAILURE BEHAVIOUR
--   schedules_fire_due() is transactional and self-contained: a failure
--   leaves next_run_at untouched and the occurrence is retried on the next
--   tick, because the job is only de-duplicated once it exists. The worker
--   call is asynchronous (net.http_post returns a request id), so a slow or
--   failing worker never blocks or rolls back schedule firing; its response is
--   recorded in net._http_response for inspection. A driver failure surfaces
--   in cron.job_run_details, which pg_cron maintains natively — no Atlas
--   table was added for monitoring.
--
-- DUPLICATE-RUN BEHAVIOUR
--   pg_cron will not start a second run of the same job while one is still
--   running. Even if it did, firing is safe: schedules_fire_due() claims rows
--   `for update skip locked` and inserts each occurrence under the unique
--   partial index idx_atlas_jobs_platform_idempotency with `on conflict do
--   nothing`, then advances next_run_at in the same transaction. The same
--   occurrence therefore cannot produce a second job.
--
-- MONITORING
--   select * from cron.job_run_details order by start_time desc;
--   Failed worker responses: select * from net._http_response order by ...;
--   Schedule health: public.schedules_list() as service_role.
--
-- This migration is additive: it creates an extension, one function, and one
-- cron row. It drops nothing and rewrites no existing object.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ----------------------------------------------------------------------------
-- atlas_platform_tick — one driver pass.
--
-- Deliberately tiny: turn elapsed intervals into durable jobs, then ask the
-- worker to drain them. It NEVER generates content itself and never
-- publishes; scheduling and execution stay in the functions that own them.
-- ----------------------------------------------------------------------------
create or replace function public.atlas_platform_tick(
  p_schedule_limit int default 20,
  p_job_limit      int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fired       jsonb;
  v_fired_count int := 0;
  v_request_id  bigint := null;
  v_token       text;
  v_url         text := 'https://ibxvzxblyhzwokljkslt.supabase.co/functions/v1/content-engine-worker';
begin
  -- 1. Elapsed schedule intervals become durable jobs. A schedule never
  --    executes work itself, so this is safe to re-run and safe to overlap.
  v_fired := public.schedules_fire_due(coalesce(p_schedule_limit, 20));
  v_fired_count := coalesce((v_fired ->> 'count')::int, 0);

  -- 2. Ask the worker to drain what is queued. Asynchronous by design: the
  --    request id is returned for inspection and a worker outage must never
  --    roll back the schedule firing above.
  --
  --    The service-role JWT is signed with the project's own signing key, so
  --    the driver holds no credential of its own.
  if p_job_limit > 0 then
    select sign(
             jwt,
             jsonb_build_object(
               'role', 'service_role',
               'iss', 'supabase',
               'iat', extract(epoch from now())::bigint,
               'exp', extract(epoch from now())::bigint + 300
             )::text,
             'HS256'
           )
    into v_token
    from supabase.jwt_secret();

    v_request_id := net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_token
                 ),
      body    := jsonb_build_object('action', 'tick', 'limit', p_job_limit)::text,
      timeout_milliseconds := 20000
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'fired', v_fired_count,
    'schedules', v_fired,
    'worker_request_id', v_request_id
  );
end;
$$;

comment on function public.atlas_platform_tick(int, int) is
  'pg_cron scheduler driver: fires due atlas_schedules into atlas_jobs and asks content-engine-worker to drain them. Service-role only.';

-- The driver is a trusted-server entrypoint. Revoke from PUBLIC as well as
-- the client roles: revoking from a role alone leaves the default PUBLIC
-- grant intact, which is exactly how schedules_* became anonymously
-- executable in 20260936.
revoke execute on function public.atlas_platform_tick(int, int)
  from public, anon, authenticated;
grant execute on function public.atlas_platform_tick(int, int) to service_role;


-- ----------------------------------------------------------------------------
-- Idempotent registration: cron.schedule(job_name, ...) updates the existing
-- row when the name is already present, so re-running this migration never
-- creates a second driver.
-- ----------------------------------------------------------------------------
select cron.schedule(
  'atlas-platform-tick',
  '* * * * *',
  'select public.atlas_platform_tick();'
);
