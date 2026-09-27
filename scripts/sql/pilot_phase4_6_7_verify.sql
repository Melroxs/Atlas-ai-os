-- ============================================================================
-- ATLAS — PHASE 4 (stripe contract) / PHASE 6 (tenant counts) /
--          PHASE 7 (security posture) — READ-ONLY. No writes.
-- ============================================================================

select jsonb_pretty(jsonb_build_object(
  -- ---- PHASE 6: existing tenants (read-only counts) ----
  'tenants_total', (select count(*) from public.tenants),
  'tenants_by_account_type', (
    select coalesce(jsonb_object_agg(account_type, n), '{}'::jsonb)
    from (select account_type, count(*) n from public.tenants group by account_type) t
  ),
  'free_pilot_count', (select count(*) from public.tenants where account_type = 'free_pilot'),
  'converted_count', (select count(*) from public.tenants where pilot_converted_at is not null),
  'tenants_with_active_org_wide_grant', (
    select count(distinct c.organization_id) from public.complimentary_access c
    where c.status = 'active' and c.user_id is null
  ),
  'active_paid_subscriptions', (
    select count(*) from public.organization_subscriptions
    where status in ('active', 'trialing')
  ),
  'contradictory_states', (
    select coalesce(jsonb_agg(jsonb_build_object('_id', _id, 'account_type', account_type,
      'pilot_converted_at', pilot_converted_at, 'issue', issue)), '[]'::jsonb)
    from (
      -- a converted pilot that is still classified as a pilot
      select t._id, t.account_type, t.pilot_converted_at, 'converted_but_still_free_pilot' as issue
      from public.tenants t
      where t.account_type = 'free_pilot' and t.pilot_converted_at is not null
      union all
      -- a free_pilot that already has an active paid subscription but was never converted
      select t._id, t.account_type, t.pilot_converted_at, 'free_pilot_with_active_paid_subscription'
      from public.tenants t
      join public.organization_subscriptions s on s.organization_id = t._id
      where t.account_type = 'free_pilot' and t.pilot_converted_at is null
        and s.status in ('active', 'trialing')
    ) x
  ),

  -- ---- PHASE 4: stripe idempotency + reconciliation contract ----
  'processed_webhook_events_exists', to_regclass('public.processed_webhook_events') is not null,
  'processed_webhook_events_unique_keys', (
    select coalesce(jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid))), '[]'::jsonb)
    from pg_constraint where conrelid = 'public.processed_webhook_events'::regclass and contype in ('p','u')
  ),
  'processed_webhook_events_indexes', (
    select coalesce(jsonb_agg(indexdef), '[]'::jsonb)
    from pg_indexes where schemaname='public' and tablename='processed_webhook_events'
  ),
  'organization_subscriptions_exists', to_regclass('public.organization_subscriptions') is not null,
  'billing_rpcs_present', (
    select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in
      ('billing_apply_state','billing_upsert_subscription','billing_get_state')
  ),

  -- ---- PHASE 7: security posture ----
  'rls_enabled', (
    select jsonb_build_object(
      'tenants', (select relrowsecurity from pg_class where oid='public.tenants'::regclass),
      'complimentary_access', (select relrowsecurity from pg_class where oid='public.complimentary_access'::regclass),
      'organization_subscriptions', (select relrowsecurity from pg_class where oid='public.organization_subscriptions'::regclass),
      'documents', (select relrowsecurity from pg_class where oid='public.documents'::regclass),
      'archiveFiles', (select relrowsecurity from pg_class where oid='public.archiveFiles'::regclass),
      'atlas_audit_log', (select relrowsecurity from pg_class where oid='public.atlas_audit_log'::regclass)
    )
  ),
  'exec_privileges', (
    select jsonb_build_object(
      'atlas_pilot_status', jsonb_build_object(
        'anon', has_function_privilege('anon','public.atlas_pilot_status(uuid)','EXECUTE'),
        'authenticated', has_function_privilege('authenticated','public.atlas_pilot_status(uuid)','EXECUTE'),
        'service_role', has_function_privilege('service_role','public.atlas_pilot_status(uuid)','EXECUTE')
      ),
      'admin_convert_pilot_to_paid', jsonb_build_object(
        'anon', has_function_privilege('anon','public.admin_convert_pilot_to_paid(uuid,text)','EXECUTE'),
        'authenticated', has_function_privilege('authenticated','public.admin_convert_pilot_to_paid(uuid,text)','EXECUTE'),
        'service_role', has_function_privilege('service_role','public.admin_convert_pilot_to_paid(uuid,text)','EXECUTE')
      ),
      'ingestion_delete_archive', jsonb_build_object(
        'anon', has_function_privilege('anon','public.ingestion_delete_archive(uuid,text)','EXECUTE'),
        'authenticated', has_function_privilege('authenticated','public.ingestion_delete_archive(uuid,text)','EXECUTE'),
        'service_role', has_function_privilege('service_role','public.ingestion_delete_archive(uuid,text)','EXECUTE')
      ),
      'billing_apply_state', jsonb_build_object(
        'anon', has_function_privilege('anon','public.billing_apply_state(uuid,text)','EXECUTE'),
        'authenticated', has_function_privilege('authenticated','public.billing_apply_state(uuid,text)','EXECUTE'),
        'service_role', has_function_privilege('service_role','public.billing_apply_state(uuid,text)','EXECUTE')
      )
    )
  )
)) as report;
