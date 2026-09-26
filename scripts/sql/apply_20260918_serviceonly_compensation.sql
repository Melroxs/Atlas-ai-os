-- ============================================================================
-- ATLAS — 20260918 apply-order compensation, part 2: service-only restoration
-- (WRITE: revoke + grant on exactly 11 functions)
--
-- Why this exists
-- ---------------
-- 20260918 section 4c re-grants EXECUTE on EVERY public function to
-- `authenticated` except the functions in its own `v_service_only` list. That
-- list was correct as of 20260918, but it predates 20260921 / 20260922, whose
-- migrations made ELEVEN further functions service-role-only by revoking them
-- from `public, anon, authenticated`.
--
-- Because 20260918 is being applied AFTER those migrations, its blind re-grant
-- re-opened exactly those eleven. Re-asserting their revokes here reproduces the
-- end state that applying all migrations in order would produce.
--
-- The eleven (verified against the migration files):
--   20260921 billing_upsert_subscription
--   20260922 connections_register, connections_set_status, connections_raw,
--            integration_oauth_state_create, integration_oauth_state_consume,
--            integration_event_ingest, integration_event_finish,
--            integration_external_ref_upsert, integration_sync_state_upsert,
--            integration_provider_settings_upsert
--
-- Driven off pg_proc (regprocedure) exactly like 20260918's own section 4e, so
-- no signature has to be guessed and overloads are all covered. Idempotent.
-- ============================================================================

do $$
declare
  -- Functions a LATER migration made service-role-only; must not be callable by
  -- authenticated or anon.
  v_later_service_only text[] := array[
    'billing_upsert_subscription',
    'connections_register',
    'connections_set_status',
    'connections_raw',
    'integration_oauth_state_create',
    'integration_oauth_state_consume',
    'integration_event_ingest',
    'integration_event_finish',
    'integration_external_ref_upsert',
    'integration_sync_state_upsert',
    'integration_provider_settings_upsert'
  ];
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname = any (v_later_service_only)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
