-- ============================================================================
-- ATLAS — client RPC access check (READ-ONLY)
--
-- 20260918's 4c re-grants EXECUTE to `authenticated` for every public function
-- except its service-only set. This asserts that the RPCs the signed-in
-- application actually calls KEEP that grant — i.e. the hardening did not
-- over-revoke. `denied` must be empty.
-- ============================================================================

with client_rpcs(name) as (
  values
    ('tenants_get_my_workspace'), ('tenants_create_tenant'),
    ('tenants_init_for_checkout'), ('tenants_invite_member'),
    ('tenants_claim_invites'), ('tenants_update_member_role'),
    ('tenants_remove_member'), ('users_current_user'), ('billing_get_state'),
    ('human_reviews_get'), ('human_reviews_list'),
    ('human_reviews_count_pending'), ('human_reviews_create'),
    ('human_reviews_approve'), ('human_reviews_reject'),
    ('human_reviews_request_changes'),
    ('jobs_resume_from_review'), ('jobs_get_job'), ('jobs_list_jobs'),
    ('jobs_get_events'), ('jobs_create_job'), ('jobs_stats'),
    ('governance_record_decision'), ('governance_get_decision'),
    ('governance_list_decisions'), ('governance_latest_decision'),
    ('governance_list_actionable'), ('governance_list_events'),
    ('content_admin_list'), ('content_review_decide'), ('content_publish_blog'),
    ('complimentary_get_my_org'),
    ('connections_list_catalog'), ('connections_disconnect'),
    ('integration_sync_state_list'), ('integration_admin_overview'),
    ('admin_prepare_user_deletion'),
    ('email_accounts_list'), ('email_accounts_create'), ('email_accounts_update'),
    ('email_accounts_delete'), ('email_accounts_store_credentials'),
    ('org_seat_status')
)
select jsonb_pretty(jsonb_build_object(
  'checked', count(*),
  'denied', (
    select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb)
    from client_rpcs c
    where exists (select 1 from pg_proc p where p.proname = c.name and p.pronamespace = 'public'::regnamespace)
      and not exists (
        select 1 from pg_proc p
        where p.proname = c.name and p.pronamespace = 'public'::regnamespace
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ),
  'absent', (
    select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb)
    from client_rpcs c
    where not exists (select 1 from pg_proc p where p.proname = c.name and p.pronamespace = 'public'::regnamespace)
  )
)) as report
from client_rpcs;
