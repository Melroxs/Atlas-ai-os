-- ============================================================================
-- 20260939 — scheduler driver: decouple schedule firing from the worker call
--
-- WHY
-- ---
-- 20260938 registered the driver and pg_cron fired it correctly, but every
-- run failed with:
--
--     ERROR: schema "supabase" does not exist ... from supabase.jwt_secret()
--
-- This project is not laid out with Supabase's `supabase` schema, and its JWT
-- signing key is not reachable from SQL: vault.secrets is empty, and neither
-- app.settings.jwt_secret nor pgrst.jwt_secret is set. So the database cannot
-- mint a service-role JWT.
--
-- That failure was worse than a no-op for one specific reason: the whole driver
-- is a single transaction, so the exception rolled back the schedule firing
-- that had already succeeded. A problem reaching the worker silently stopped
-- the scheduler as well.
--
-- Two changes:
--
--   1. Schedule firing and the worker call are now independent. The worker
--      call is wrapped so that ANY failure — missing credential, DNS, HTTP,
--      timeout — is captured and returned in the result instead of aborting
--      the tick. schedules_fire_due() has already committed by then, and it
--      is itself safe to re-run, so the occurrence is simply retried next tick.
--
--   2. The worker bearer token is read from Supabase Vault by name, instead
--      of being derived from a signing key the database does not have. The
--      Atlas service-role key is itself a long-lived signed JWT, so it is used
--      directly as the bearer token; nothing is minted and no new key exists.
--      Until an operator creates that vault secret the driver still fires
--      schedules and reports `service_token_not_configured` for the drain —
--      it never invents a credential and never fakes a call.
--
-- OPERATOR SETUP (one command; no secret is committed to the repo):
--
--   select vault.create_secret('atlas_service_token', '<service role key>');
--
-- The driver is unchanged in cadence, idempotency and safety. It still calls
-- only the existing functions, creates no table, and schedules no work.
-- ============================================================================

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
  v_fired_count int  := 0;
  v_token       text;
  v_request_id  bigint;
  v_worker      jsonb;
begin
  -- 1. Elapsed schedule intervals become durable jobs. This is the part the
  --    database can always do, so nothing below is allowed to undo it.
  v_fired := public.schedules_fire_due(coalesce(p_schedule_limit, 20));
  v_fired_count := coalesce((v_fired ->> 'count')::int, 0);

  -- 2. Best-effort drain of what was just queued.
  v_worker := jsonb_build_object('ok', false, 'skipped', 'no_job_limit');
  if coalesce(p_job_limit, 0) > 0 then
    begin
      select decrypted_secret
      into v_token
      from vault.decrypted_secrets
      where name = 'atlas_service_token'
      limit 1;

      if v_token is null or length(trim(v_token)) = 0 then
        v_worker := jsonb_build_object(
          'ok', false,
          'skipped', 'service_token_not_configured',
          'remedy', 'select vault.create_secret(''atlas_service_token'', ''<service role key>'');'
        );
      else
        v_request_id := net.http_post(
          url     := 'https://ibxvzxblyhzwokljkslt.supabase.co/functions/v1/content-engine-worker',
          headers := jsonb_build_object(
                       'Content-Type',  'application/json',
                       'Authorization', 'Bearer ' || trim(v_token)
                     ),
          body    := jsonb_build_object('action', 'tick', 'limit', p_job_limit)::text,
          timeout_milliseconds := 20000
        );
        v_worker := jsonb_build_object('ok', true, 'request_id', v_request_id);
      end if;
    exception when others then
      -- Never let a worker problem roll back the schedule firing above.
      v_worker := jsonb_build_object(
        'ok', false,
        'error', sqlstate,
        'message', left(sqlerrm, 200)
      );
    end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'fired', v_fired_count,
    'schedules', v_fired,
    'worker', v_worker
  );
end;
$$;

comment on function public.atlas_platform_tick(int, int) is
  'pg_cron scheduler driver: fires due atlas_schedules into atlas_jobs and best-effort asks content-engine-worker to drain them. Service-role only. The worker token is read from vault secret "atlas_service_token".';

revoke execute on function public.atlas_platform_tick(int, int)
  from public, anon, authenticated;
grant execute on function public.atlas_platform_tick(int, int) to service_role;
