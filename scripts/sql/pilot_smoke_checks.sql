-- ============================================================================
-- ATLAS — final smoke audit (READ-ONLY). No writes.
--   * pilot creation touches NO Stripe object
--   * access is granted via the complimentary entitlement, independent of Stripe
-- ============================================================================

with f as (
  select p.proname, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select jsonb_pretty(jsonb_build_object(
  -- 1. Pilot creation must not touch Stripe (no customer/subscription/price).
  'pilot_creation_references_stripe', (
    select position('stripe' in lower(def)) > 0
    from f where proname = 'admin_create_pilot_organization'
  ),
  'pilot_creation_writes_organization_subscriptions', (
    select position('organization_subscriptions' in def) > 0
    from f where proname = 'admin_create_pilot_organization'
  ),
  'pilot_creation_grants_complimentary', (
    select position('complimentary_access' in def) > 0
       and position('account_type' in def) > 0 and position('free_pilot' in def) > 0
    from f where proname = 'admin_create_pilot_organization'
  ),

  -- 2. Access without a paid subscription: the entitlement readers must grant
  --    on an active complimentary grant, independent of Stripe.
  'billing_get_state_reads_complimentary', (
    select position('complimentary' in lower(def)) > 0
    from f where proname = 'billing_get_state'
  ),
  'users_current_user_reads_complimentary', (
    select position('complimentary' in lower(def)) > 0
    from f where proname = 'users_current_user'
  ),
  'can_access_atlas_reads_complimentary', (
    select position('complimentary' in lower(def)) > 0
    from f where proname = 'can_access_atlas'
  ),

  -- 3. Standard orgs unaffected: no pilot function mutates a standard tenant's
  --    billing_state directly.
  'pilot_rpcs_touch_billing_state', (
    select coalesce(jsonb_agg(proname), '[]'::jsonb)
    from f
    where proname in ('admin_create_pilot_organization','admin_extend_pilot',
                      'admin_set_pilot_status','admin_convert_pilot_to_paid')
      and position('billing_state' in def) > 0
  )
)) as report;
