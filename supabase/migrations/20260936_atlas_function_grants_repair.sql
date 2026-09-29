-- ============================================================================
-- 20260936 — Atlas function EXECUTE grant repair
--
-- PRODUCTION DEFECT THIS MIGRATION FIXES
-- --------------------------------------
-- PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default.
-- Every role, including `anon`, inherits PUBLIC. So:
--
--     revoke all on function public.foo(...) from anon;
--
-- is a NO-OP whenever the function was created after the last blanket
-- `revoke execute on all functions in schema public from public`, because the
-- PUBLIC grant is still in place and `anon` still holds it.
--
-- Two migrations in this project were applied to production out of file order,
-- so both re-created functions AFTER 20260918 §4a had run and silently
-- restored the PUBLIC grant:
--
--   * 20260913 §1-§2 (the scheduler foundation) re-created schedules_*.
--   * 20260935 (the Content Engine) created content_*.
--
-- Verified live, not inferred: with `set role anon`, all of
-- schedules_upsert / schedules_fire_due / schedules_list /
-- schedules_set_enabled / schedules_record_result EXECUTED successfully. The
-- schedules_* functions have NO in-function authorization check by design
-- (20260918 line ~1002 relies on grants alone), so this was an
-- unauthenticated path to create arbitrary recurring schedules, force-fire
-- them, enumerate every tenant's schedules, and mutate their state.
--
-- This migration re-applies the 20260918 §4 policy verbatim and idempotently.
-- It grants nothing new: 4c re-grants `authenticated` exactly the set 4c
-- granted before, and 4d re-grants `anon` exactly the public allowlist.
-- Service-only functions are revoked from public, anon AND authenticated and
-- granted only to service_role.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 4a. Blanket revoke. This is the authoritative sweep that makes every
--      per-function revoke below meaningful: removing the PUBLIC grant is what
--      actually closes the hole, because `anon` reaches functions *through*
--      PUBLIC, not through a direct grant.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- ----------------------------------------------------------------------------
-- 4b. Stop future functions from re-introducing the exposure. Scoped to the
--      role executing this migration; the explicit per-function grants in
--      4c/4d/4e remain authoritative either way.
-- ----------------------------------------------------------------------------
alter default privileges in schema public
  revoke execute on functions from public, anon;
alter default privileges in schema public
  grant execute on functions to service_role, authenticated;

do $$
declare
  -- Privileged operations whose only legitimate caller is a trusted server
  -- process (an Edge Function or the scheduler). No client role may execute
  -- these: they either expose credentials, cross tenant boundaries, mutate
  -- billing state, or administer the platform.
  --
  -- This is 20260918 §4c's list, unchanged. Functions added by 20260935 are
  -- deliberately NOT added here: the Content Engine RPCs carry in-function
  -- `atlas_is_trusted_server()` / tenant guards, and `authenticated` needs
  -- EXECUTE on the Content Studio's browser path (content_engine_enqueue,
  -- content_automation_upsert, content_studio_list, ...). `anon` is revoked
  -- from all of them by 4a + 4d.
  v_service_only text[] := array[
    -- credentials / cross-tenant
    'email_accounts_get_credentials',
    'outreach_records_update_status',
    -- billing state writers (Paddle webhook / trusted server only)
    'billing_apply_state',
    'tenants_activate_after_payment',
    'tenants_handle_payment_failure',
    'tenants_handle_subscription_cancelled',
    -- corpus / knowledge ingestion
    'industry_ingest_corpus',
    'industry_seed_internal',
    -- platform infrastructure + content engine: no authorization check inside
    -- the function and no reachable client caller. Wiring a client later must
    -- be done together with an in-function admin guard, not by re-granting
    -- EXECUTE.
    'schedules_list','schedules_upsert','schedules_set_enabled',
    'schedules_fire_due','schedules_record_result',
    'sources_list_due','sources_get','sources_list_checks',
    'sources_record_check','sources_set_check_frequency',
    'knowledge_versions','knowledge_as_of','knowledge_create_version',
    'knowledge_verify',
    'content_create','content_transition','content_list','content_get',
    'content_list_provenance',
    -- Job queue drain + worker-owned lifecycle transitions.
    'jobs_dequeue',
    'jobs_complete_job','jobs_complete_step',
    'jobs_fail_job','jobs_fail_step','jobs_retry_step',
    'jobs_cancel_job','jobs_unlock_stuck','jobs_awaiting_review',
    -- Auth / tenancy bootstrap internals with no client caller.
    'handle_new_user','ensure_profile','org_seat_limit'
  ];
  -- Read-only predicate helpers that RLS policies may evaluate while serving an
  -- anonymous request (policies default to PUBLIC, so `anon` can trigger them).
  -- Without EXECUTE an anonymous query would fail 42501 instead of returning
  -- zero rows. These return booleans / a tenant id only — no data access.
  v_anon_helpers text[] := array[
    'get_current_tenant_id','my_tenant_id',
    'is_super_admin','is_atlas_admin','is_approved_user','can_access_atlas',
    'is_editor','is_manager'
  ];
  -- Genuinely public RPCs.
  v_anon_public text[] := array[
    'pilot_apply',          -- the public /pilot-apply form
    'content_public_list'   -- published blog/articles only
  ];
  r record;
begin
  -- 4c. authenticated: everything except the service-only set.
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not (p.proname = any (v_service_only))
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;

  -- 4d. anon: the explicit allowlist only.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (v_anon_helpers || v_anon_public)
  loop
    execute format('grant execute on function %s to anon', r.sig);
  end loop;

  -- 4e. Belt and braces: make the service-only set unambiguously private even
  --     if a later `grant all on all routines` is ever re-applied.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (v_service_only)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
