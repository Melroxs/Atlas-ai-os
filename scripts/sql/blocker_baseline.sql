-- ============================================================================
-- ATLAS — B1/B2 baseline capture (READ-ONLY: no writes, no DDL)
-- Captured BEFORE applying 20260918 / repairing the ledger.
-- ============================================================================

select jsonb_pretty(jsonb_build_object(
  -- 1. ledger shape (columns, so a repair can be written correctly)
  'ledger_columns', (
    select coalesce(jsonb_agg(column_name order by ordinal_position), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
  ),
  'ledger_count', (select count(*) from supabase_migrations.schema_migrations),
  'ledger_latest', (
    select coalesce(jsonb_agg(version order by version desc), '[]'::jsonb)
    from (select version from supabase_migrations.schema_migrations order by version desc limit 5) t
  ),

  -- 2. the critical exposure, current live ACL
  'email_accounts_get_credentials', (
    select jsonb_build_object(
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'public_grant', p.proacl is null or exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0
      ),
      'proacl', coalesce(array_to_string(p.proacl, ' | '), '(default)')
    )
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'email_accounts_get_credentials'
  ),

  -- 3. how many functions can anon execute right now
  'anon_executable_count', (
    select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),

  -- 4. do the 20260918-introduced objects already exist? (expect NONE)
  'hardening_objects_present', (
    select coalesce(jsonb_object_agg(o.n, o.present) , '{}'::jsonb)
    from (
      select 'plan_seat_limits' as n, to_regclass('public.plan_seat_limits') is not null as present
      union all select 'org_seat_limit', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='org_seat_limit')
      union all select 'org_seat_status', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='org_seat_status')
      union all select 'atlas_is_trusted_server', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_is_trusted_server')
      union all select 'atlas_assert_trusted_server', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_assert_trusted_server')
      union all select 'atlas_is_internal_admin', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_is_internal_admin')
      union all select 'atlas_assert_internal_admin', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_assert_internal_admin')
      union all select 'atlas_can_access_tenant', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_can_access_tenant')
      union all select 'atlas_assert_tenant_access', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_assert_tenant_access')
      union all select 'atlas_caller_tenants', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='atlas_caller_tenants')
    ) o
  ),

  -- 5. data counts that must not change
  'counts', jsonb_build_object(
    'email_accounts', (select count(*) from public.email_accounts),
    'tenants', (select count(*) from public.tenants),
    'organization_subscriptions', (select count(*) from public.organization_subscriptions)
  ),

  -- 6. the post-change anon allowlist must equal this tiny set; sample the
  --    public content RPCs' current anon grants for before/after comparison
  'content_rpc_anon', (
    select coalesce(jsonb_object_agg(p.proname, has_function_privilege('anon', p.oid, 'EXECUTE')), '{}'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('content_public_list','content_public_get','pilot_apply')
  )
)) as report;
