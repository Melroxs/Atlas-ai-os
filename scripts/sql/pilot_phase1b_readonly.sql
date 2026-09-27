-- ============================================================================
-- ATLAS — Free Pilot PHASE 1b (READ-ONLY)
-- Confirms the live 20260927 objects match the local migration contract, and
-- shows the LIVE admin_convert_pilot_to_paid source (to prove whether the
-- trusted-server guard is present).
-- ============================================================================

with f as (
  select p.proname, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select jsonb_pretty(jsonb_build_object(
  'admin_create_pilot_organization_ok', (
    select position('free_pilot' in def) > 0
       and position('owner' in def) > 0
       and position('complimentary_access' in def) > 0
       and position('next_step' in def) > 0
       and position('account_status' in def) > 0
       and position('''pending''' in def) > 0
    from f where proname = 'admin_create_pilot_organization'
  ),
  'admin_create_tenant_slug_ok', (
    select position('regexp_replace' in def) > 0 and position('v_slug' in def) > 0
    from f where proname = 'admin_create_tenant'
  ),
  'atlas_pilot_status_derived_ok', (
    select position('converted' in def) > 0 and position('suspended' in def) > 0
       and position('expired' in def) > 0 and position('active' in def) > 0
    from f where proname = 'atlas_pilot_status'
  ),
  'admin_list_tenants_ok', (
    select position('account_type' in def) > 0 and position('pilot_status' in def) > 0
       and position('has_stripe_subscription' in def) > 0
    from f where proname = 'admin_list_tenants'
  ),
  'pilot_lifecycle_rpcs_present', (
    select count(*) from f
    where proname in ('admin_extend_pilot', 'admin_set_pilot_status', 'admin_convert_pilot_to_paid')
  ),
  'convert_pilot_source', (
    select def from f where proname = 'admin_convert_pilot_to_paid'
  )
)) as report;
