-- ============================================================================
-- 20260942 — fix the worker's pg_net call in the platform tick
--
-- DEFECT FOUND BY LIVE TESTING
-- ----------------------------
-- The tick ran every minute and reported honestly, but the worker call never
-- left the database. Invoking public.atlas_platform_tick() directly returned:
--
--   worker: {"ok": false, "error": "42883",
--            "message": "function net.http_post(url => unknown, headers => jsonb,
--                       body => text, timeout_milliseconds => integer)
--                       does not exist"}
--
-- The installed pg_net signature is:
--
--   net.http_post(url text, body jsonb, params jsonb, headers jsonb,
--                 timeout_milliseconds integer) returns bigint
--
-- so `body` is jsonb, not text. 20260938/20260939 passed
--
--   body := jsonb_build_object(...)::text
--
-- and named-argument resolution does not coerce text to jsonb when choosing an
-- overload, so no candidate matched and the call failed. Because the worker
-- call is wrapped in an exception block, schedule firing was never affected —
-- the error was reported in the result instead — which is why the failure was
-- silent in cron.job_run_details ("1 row") and only surfaced on a direct call.
--
-- FIX
-- ---
-- Pass body as jsonb. Named arguments are kept so the parameter names stay
-- self-documenting. Nothing else changes: the credential is still read from
-- the atlas_service_token vault secret, still used only as an outbound
-- Authorization header, and is never returned, stored or logged.
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
        -- body must be jsonb: pg_net's http_post has no text overload, and
        -- named-argument resolution will not coerce one.
        v_request_id := net.http_post(
          url     := 'https://ibxvzxblyhzwokljkslt.supabase.co/functions/v1/content-engine-worker',
          body    := jsonb_build_object('action', 'tick', 'limit', p_job_limit),
          headers := jsonb_build_object(
                       'Content-Type',  'application/json',
                       'Authorization', 'Bearer ' || trim(v_token)
                     ),
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
  'pg_cron scheduler driver: fires due atlas_schedules into atlas_jobs and best-effort asks content-engine-worker to drain them. Service-role only. The worker token is read from vault secret "atlas_service_token" and is used only as an outbound Authorization header.';

revoke execute on function public.atlas_platform_tick(int, int)
  from public, anon, authenticated;
grant execute on function public.atlas_platform_tick(int, int) to service_role;
