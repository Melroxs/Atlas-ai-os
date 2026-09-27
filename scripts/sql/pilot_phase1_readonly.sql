-- ============================================================================
-- ATLAS — Free Pilot production reconciliation, PHASE 1 (READ-ONLY)
-- No writes, no DDL. Positively identifies the target and reports whether the
-- two pending migrations are already present, partially present, or absent.
-- ============================================================================

select jsonb_pretty(jsonb_build_object(
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'ledger_exists', to_regclass('supabase_migrations.schema_migrations') is not null,
  'ledger_2026092x', (
    select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name)
      order by version), '[]'::jsonb)
    from supabase_migrations.schema_migrations
    where version like '2026092%'
  ),
  'tenants_pilot_columns', (
    select coalesce(jsonb_agg(column_name order by column_name), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants'
      and column_name in ('account_type', 'pilot_notes', 'pilot_limits', 'pilot_converted_at')
  ),
  'pilot_limits_comment', (
    select col_description('public.tenants'::regclass, ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants' and column_name = 'pilot_limits'
  ),
  'pilot_functions_present', (
    select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'admin_create_tenant', 'admin_grant_complimentary_access_until',
      'admin_create_pilot_organization', 'atlas_pilot_status', 'admin_extend_pilot',
      'admin_set_pilot_status', 'admin_convert_pilot_to_paid', 'admin_list_tenants',
      'ingestion_delete_archive_file', 'ingestion_delete_archive'
    )
  ),
  'admin_create_tenant_arities', (
    select coalesce(jsonb_agg(p.proname || '/' || pg_get_function_identity_arguments(p.oid) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_create_tenant'
  ),
  'atlas_pilot_status_guarded', (
    select exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'atlas_pilot_status'
        and position('atlas_can_access_tenant' in pg_get_functiondef(p.oid)) > 0
        and position('is_super_admin' in pg_get_functiondef(p.oid)) > 0
    )
  ),
  'convert_pilot_guard_has_trusted_server', (
    select exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_convert_pilot_to_paid'
        and position('atlas_is_trusted_server' in pg_get_functiondef(p.oid)) > 0
    )
  )
)) as report;
