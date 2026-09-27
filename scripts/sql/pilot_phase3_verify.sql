-- ============================================================================
-- ATLAS — Free Pilot PHASE 3/5 verification (READ-ONLY)
-- Confirms the live database contract after reconciliation. No writes.
-- ============================================================================

with f as (
  select p.proname, p.prosecdef as is_definer,
         pg_get_functiondef(p.oid) as def,
         p.oid::regprocedure as sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select jsonb_pretty(jsonb_build_object(
  -- ---- PHASE 3: pilot contract ----
  'pilot_limits_comment_present', (
    select col_description('public.tenants'::regclass, ordinal_position) is not null
    from information_schema.columns
    where table_schema='public' and table_name='tenants' and column_name='pilot_limits'
  ),
  'pilot_limits_not_enforced_anywhere', (
    select not exists (
      select 1 from f
      where proname not in ('admin_create_pilot_organization','admin_list_tenants')
        and position('pilot_limits' in def) > 0
    )
  ),
  'convert_pilot_now_trusted_server_and_super_admin', (
    select position('atlas_is_trusted_server' in def) > 0 and position('is_super_admin' in def) > 0
    from f where proname = 'admin_convert_pilot_to_paid'
  ),
  'convert_pilot_is_definer', (select is_definer from f where proname = 'admin_convert_pilot_to_paid'),
  'atlas_pilot_status_guard_ok', (
    select position('is_super_admin' in def) > 0 and position('atlas_can_access_tenant' in def) > 0
       and position('pilot_converted_at' in def) > 0
    from f where proname = 'atlas_pilot_status'
  ),
  'pilot_lifecycle_rpcs', (
    select coalesce(jsonb_agg(sig::text order by proname), '[]'::jsonb)
    from f where proname in (
      'admin_extend_pilot','admin_set_pilot_status','admin_convert_pilot_to_paid',
      'admin_create_pilot_organization','admin_grant_complimentary_access_until'
    )
  ),
  'no_duplicate_entitlement_tables', (
    select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb)
    from pg_tables
    where schemaname='public' and (tablename like '%entitlement%' or tablename like '%pilot%subscription%')
  ),
  'complimentary_access_table_exists', to_regclass('public.complimentary_access') is not null,
  'seat_limits_table_exists', to_regclass('public.plan_seat_limits') is not null,
  'org_seat_status_bypasses_for_complimentary', (
    select position('complimentary' in def) > 0 and position('seat_limit_reached' in def) > 0
    from f where proname = 'org_seat_status'
  ),

  -- ---- PHASE 5: deletion contract ----
  'deletion_functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', proname, 'definer', is_definer,
      'authenticated_can_execute', has_function_privilege('authenticated', sig, 'EXECUTE'),
      'anon_can_execute', has_function_privilege('anon', sig, 'EXECUTE'),
      'service_role_can_execute', has_function_privilege('service_role', sig, 'EXECUTE')
    ) order by proname), '[]'::jsonb)
    from f where proname in ('ingestion_delete_archive_file','ingestion_delete_archive')
  ),
  'deletion_guards', (
    select coalesce(jsonb_object_agg(proname, jsonb_build_object(
      'auth_uid', position('auth.uid()' in def) > 0,
      'my_tenant_id', position('my_tenant_id' in def) > 0,
      'member_role', position('my_member_role' in def) > 0,
      'audit_log', position('log_audit' in def) > 0,
      'tenant_filter', position('"tenantId" = v_tenant' in def) > 0,
      'preserves_entities', position('delete from public.entities' in def) = 0,
      'preserves_claims', position('delete from public.insuranceClaims' in def) = 0,
      'returns_storage', position('storagePath' in def) > 0
    )), '{}'::jsonb)
    from f where proname in ('ingestion_delete_archive_file','ingestion_delete_archive')
  )
)) as report;
