-- ============================================================================
-- ATLAS — live privilege posture (READ-ONLY)
--
-- 20260918_atlas_security_hardening.sql is the migration that REVOKES client
-- EXECUTE from the privileged RPC set. The reconciliation check showed its own
-- new objects are absent live, i.e. it was never applied.
--
-- This asks the database directly whether those RPCs are still reachable by
-- `anon` / `authenticated`. `has_function_privilege` is used rather than
-- `proacl` because a NULL proacl means the Postgres default (EXECUTE to
-- PUBLIC) — which is exactly how the original exposure arose.
-- ============================================================================

with privileged(name) as (
  values
    -- billing state writers: a client that can call these grants itself access
    ('billing_apply_state'),
    ('billing_upsert_subscription'),
    ('tenants_activate_after_payment'),
    ('tenants_handle_payment_failure'),
    ('tenants_handle_subscription_cancelled'),
    -- cross-tenant credential read
    ('email_accounts_get_credentials'),
    ('outreach_records_update_status'),
    -- corpus / knowledge ingestion
    ('industry_ingest_corpus'),
    ('industry_seed_internal'),
    -- job queue drain + worker-owned lifecycle
    ('jobs_dequeue'),
    ('jobs_complete_job'),
    ('jobs_fail_job'),
    ('jobs_cancel_job'),
    ('jobs_unlock_stuck'),
    ('jobs_awaiting_review'),
    ('jobs_create_job'),
    -- platform infrastructure
    ('schedules_fire_due'),
    ('schedules_upsert'),
    ('content_create'),
    ('content_transition'),
    ('knowledge_create_version'),
    -- identity
    ('handle_new_user'),
    -- integrations (20260922, expected service-only)
    ('integration_event_ingest'),
    ('connections_register')
),
live as (
  select pr.name,
         p.oid as oid,
         coalesce(array_to_string(p.proacl, ' | '), '(default: EXECUTE to PUBLIC)') as acl
  from privileged pr
  left join pg_proc p on p.proname = pr.name
  left join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where true
)
select jsonb_pretty(jsonb_build_object(
  'anon_executable', (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
    from live
    where oid is not null and has_function_privilege('anon', oid, 'EXECUTE')
  ),
  'authenticated_executable', (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
    from live
    where oid is not null and has_function_privilege('authenticated', oid, 'EXECUTE')
  ),
  'public_default_acl_count', (
    select count(*) from live where oid is not null and acl = '(default: EXECUTE to PUBLIC)'
  ),
  'details', (
    select jsonb_object_agg(name, jsonb_build_object(
      'exists', oid is not null,
      'anon', oid is not null and has_function_privilege('anon', oid, 'EXECUTE'),
      'authenticated', oid is not null and has_function_privilege('authenticated', oid, 'EXECUTE'),
      'acl', acl
    ) order by name)
    from live where oid is not null
  )
)) as report;
