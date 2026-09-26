-- ============================================================================
-- ATLAS — service-only posture verification (READ-ONLY)
--
-- The set below is the union of:
--   * 20260918's own v_service_only list, and
--   * the functions 20260921 / 20260922 additionally revoked from authenticated
--     (the apply-order compensation restores these).
--
-- Every listed function MUST be executable by service_role and by NO client
-- role. `violations` must be empty.
-- ============================================================================

with expected(name) as (
  values
    ('email_accounts_get_credentials'), ('outreach_records_update_status'),
    ('billing_apply_state'),
    ('tenants_activate_after_payment'), ('tenants_handle_payment_failure'),
    ('tenants_handle_subscription_cancelled'),
    ('industry_ingest_corpus'), ('industry_seed_internal'),
    ('schedules_list'), ('schedules_upsert'), ('schedules_set_enabled'),
    ('schedules_fire_due'), ('schedules_record_result'),
    ('sources_list_due'), ('sources_get'), ('sources_list_checks'),
    ('sources_record_check'), ('sources_set_check_frequency'),
    ('knowledge_versions'), ('knowledge_as_of'), ('knowledge_create_version'),
    ('knowledge_verify'),
    ('content_create'), ('content_transition'), ('content_list'),
    ('content_get'), ('content_list_provenance'),
    ('jobs_dequeue'), ('jobs_complete_job'), ('jobs_complete_step'),
    ('jobs_fail_job'), ('jobs_fail_step'), ('jobs_retry_step'),
    ('jobs_cancel_job'), ('jobs_unlock_stuck'), ('jobs_awaiting_review'),
    ('handle_new_user'), ('ensure_profile'), ('org_seat_limit'),
    -- later migrations (20260921 / 20260922)
    ('billing_upsert_subscription'),
    ('connections_register'), ('connections_set_status'), ('connections_raw'),
    ('integration_oauth_state_create'), ('integration_oauth_state_consume'),
    ('integration_event_ingest'), ('integration_event_finish'),
    ('integration_external_ref_upsert'), ('integration_sync_state_upsert'),
    ('integration_provider_settings_upsert')
),
live as (
  select e.name, p.oid,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
  from expected e
  left join pg_proc p
    on p.proname = e.name
   and p.pronamespace = 'public'::regnamespace
   and p.prokind = 'f'
)
select jsonb_pretty(jsonb_build_object(
  'checked', (select count(*) from live),
  'missing_function', (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
    from live where oid is null
  ),
  'violations', (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
    from live where oid is not null and (anon or auth)
  ),
  'not_service_role', (
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
    from live where oid is not null and not svc
  )
)) as report;
