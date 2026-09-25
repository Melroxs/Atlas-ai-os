-- ============================================================================
-- ATLAS — READ-ONLY live state check (no writes, no DDL)
--
-- Establishes, from the actual target database rather than from repository
-- files or previous agent claims:
--   * what the migration ledger says, and which versions are ABSENT from it,
--   * whether the objects those migrations create actually exist,
--   * the real EXECUTE grants on the billing / content / integration RPCs,
--   * that the smoke test below left nothing behind.
--
-- Run with:  bun scripts/run-db-sql.mjs scripts/sql/billing_state_check.sql
-- Returns one jsonb row. Nothing is created, altered or deleted.
--
-- Companion: scripts/sql/billing_upsert_subscription_smoke.sql exercises the
-- real billing_upsert_subscription RPC and rolls itself back.
-- ============================================================================

with ledger as (
  select jsonb_build_object(
    'total', count(*),
    'newest', max(version),
    'absent_of_expected', (
      select coalesce(jsonb_agg(v order by v), '[]'::jsonb)
      from (values ('20260918'), ('20260919'), ('20260920'), ('20260921'), ('20260922')) as t(v)
      where not exists (
        select 1 from supabase_migrations.schema_migrations m
        where m.version like t.v || '%'
      )
    )
  ) as j
  from supabase_migrations.schema_migrations
),
fns as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'sig', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'security_definer', p.prosecdef,
    'acl', coalesce(array_to_string(p.proacl, ' | '), '(default)')
  ) order by p.proname), '[]'::jsonb) as j
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      -- billing
      'billing_upsert_subscription',
      -- the trusted-server primitives 20260921's deployment note says are absent
      'atlas_is_trusted_server',
      'atlas_assert_trusted_server',
      -- content (blog) — client-callable by design
      'content_public_list',
      'content_public_get',
      'content_admin_list',
      'content_review_decide',
      'content_publish_blog',
      -- integrations — server-only by design
      'integration_event_ingest',
      'integration_oauth_state_create',
      'integration_oauth_state_consume',
      'connections_register',
      'connections_set_status'
    )
),
tables as (
  select coalesce(jsonb_agg(jsonb_build_object('t', c.relname, 'rls', c.relrowsecurity)
    order by c.relname), '[]'::jsonb) as j
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'organization_subscriptions',
      'atlasContentItems',
      'atlasContentProvenance',
      'integration_events',
      'integration_sync_state',
      'integration_external_refs',
      'integration_oauth_states',
      'integration_provider_settings'
    )
),
tenant_cols as (
  select coalesce(jsonb_agg(column_name order by column_name), '[]'::jsonb) as j
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'tenants'
    and column_name in (
      'billing_state',
      'billing_provider',
      'complimentary_access',
      'complimentary_access_until'
    )
),
leftovers as (
  select jsonb_build_object(
    -- The smoke test's DO block ends in RAISE EXCEPTION. These must be zero.
    'smoke_tenants', (
      select count(*) from public.tenants
      where name = '__atlas_rpc_smoke__' or slug like '__atlas_rpc_smoke%'
    ),
    'smoke_subscriptions', (
      select count(*) from public.organization_subscriptions s
      where s.provider_customer_id in ('cus_A', 'cus_B')
         or s.provider_subscription_id in ('sub_A2', 'sub_B')
    ),
    'total_tenants', (select count(*) from public.tenants),
    'total_org_subscriptions', (select count(*) from public.organization_subscriptions)
  ) as j
)
select jsonb_pretty(jsonb_build_object(
  'checked_at', now(),
  'ledger', (select j from ledger),
  'functions', (select j from fns),
  'tables', (select j from tables),
  'tenants_billing_columns', (select j from tenant_cols),
  'smoke_rollback', (select j from leftovers)
)) as report;
