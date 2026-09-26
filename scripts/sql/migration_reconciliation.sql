-- ============================================================================
-- ATLAS — migration reconciliation check (READ-ONLY: no writes, no DDL)
--
-- Part 1: which repository migration versions are absent from the live ledger.
-- Part 2: whether the objects each migration creates actually EXIST live.
--
-- The point is to distinguish, per migration:
--   * applied and recorded        -> nothing to do
--   * applied but NOT recorded    -> history repair only (never re-run)
--   * partially applied           -> a real, deliberate apply is required
--   * not applied                 -> a real apply is required
--
-- NOTE (2026-09-26): the first version of this script omitted several real
-- objects — all of 20260913's functions/index/nullability change, 20260922's 11
-- added columns, and two of 20260913's tables — which made 20260913 look fully
-- applied when it is not. The lists below are extracted from the migrations.
-- ============================================================================

with repo_versions(version, file) as (
  values
    ('0001','0001_schema'), ('0002','0002_rpc_core'), ('0003','0003_rpc_insurance'),
    ('0004','0004_rpc_events_workflows'), ('0005','0005_rpc_everest'),
    ('0006','0006_upload_archive'), ('0007','0007_grants'),
    ('0008','0008_archive_contract'), ('0009','0009_fix_claim_package_scalar'),
    ('0010','0010_fix_archive_duplicate_provenance'),
    ('0011','0011_fix_tenant_bootstrap_idempotent'),
    ('0012','0012_fix_documents_list_cap'),
    ('0013','0013_fix_tenant_bootstrap_profile_repair'),
    ('0014','0014_fix_recommendation_decisions_and_archive_terminal_states'),
    ('0020','0020_atlas_jobs'), ('0021','0021_atlas_human_reviews'),
    ('20260820','20260820_atlas_access_control'),
    ('202608201','202608201_atlas_mail'), ('202608202','202608202_atlas_mail_combined'),
    ('202608203','202608203_atlas_mail_security'),
    ('202608204','202608204_atlas_pilot_intelligence'),
    ('20260821','20260821_atlas_crm_outreach'),
    ('20260822','20260822_atlas_crm_custom_fields'),
    ('202608221','202608221_atlas_user_management'),
    ('20260823','20260823_fix_pilot_app_stats'),
    ('20260824','20260824_atlas_mail_accounts'),
    ('202608241','202608241_atlas_outreach_resend'),
    ('20260825','20260825_fix_claim_invites_activate_user'),
    ('202608251','202608251_atlas_fix_user_management_rpc'),
    ('20260826','20260826_atlas_knowledge_layer'),
    ('20260827','20260827_atlas_knowledge_seed_internal'),
    ('20260827b','20260827b_atlas_corpus_ingestion'),
    ('20260827c','20260827c_fix_ingest_corpus'),
    ('20260827e','20260827e_complete_corpus_ingest'),
    ('20260901','20260901_atlas_subscriptions'),
    ('20260902','20260902_atlas_billing_state'),
    ('20260903','20260903_atlas_billing_fixes'),
    ('20260904','20260904_atlas_governance'),
    ('20260906','20260906_atlas_regulatory_intelligence'),
    ('20260907000000','20260907000000_paddle_billing'),
    ('20260908','20260908_paddle_billing_hardening'),
    ('20260909','20260909_atlas_complimentary_access'),
    ('20260909','20260909_atlas_findings_evidence_jsonb'),
    ('20260909a','20260909a_atlas_findings_evidence_jsonb'),
    ('20260909b','20260909b_atlas_supplement_evidence_decode'),
    ('20260913','20260913_atlas_platform_infrastructure'),
    ('20260918','20260918_atlas_security_hardening'),
    ('20260919','20260919_atlas_stripe_billing'),
    ('20260919','20260919_atlas_regulatory_schema_reconciliation'),
    ('20260920','20260920_atlas_blog_publishing'),
    ('20260921','20260921_atlas_billing_subscription_merge'),
    ('20260922','20260922_atlas_integration_foundation')
),
ledger as (select version from supabase_migrations.schema_migrations),
unrecorded as (
  select distinct r.version, r.file
  from repo_versions r
  where not exists (
    select 1 from ledger l
    where l.version = r.version
       -- the one known production version-string rename
       or (r.version = '20260906' and l.version = '20260906192230')
  )
),
expected(migration, kind, name) as (
  values
    -- ---- 20260913 platform infrastructure: 6 tables + 1 index + 20 functions
    ('20260913','table','atlas_schedules'),
    ('20260913','table','authoritativeSourceChecks'),
    ('20260913','table','atlasContentItems'),
    ('20260913','table','atlasContentProvenance'),
    ('20260913','table','connections'),
    ('20260913','table','connectiontokens'),
    ('20260913','index','idx_atlas_jobs_platform_idempotency'),
    ('20260913','function','schedules_list'),
    ('20260913','function','schedules_upsert'),
    ('20260913','function','schedules_set_enabled'),
    ('20260913','function','schedules_fire_due'),
    ('20260913','function','schedules_record_result'),
    ('20260913','function','sources_list_due'),
    ('20260913','function','sources_get'),
    ('20260913','function','sources_list_checks'),
    ('20260913','function','sources_record_check'),
    ('20260913','function','sources_set_check_frequency'),
    ('20260913','function','knowledge_versions'),
    ('20260913','function','knowledge_as_of'),
    ('20260913','function','knowledge_create_version'),
    ('20260913','function','knowledge_verify'),
    ('20260913','function','content_create'),
    ('20260913','function','content_transition'),
    ('20260913','function','content_list'),
    ('20260913','function','content_get'),
    ('20260913','function','content_list_provenance'),
    ('20260913','function','content_public_list'),
    -- ---- 20260918 security hardening: 1 table + 9 new functions ----
    ('20260918','table','plan_seat_limits'),
    ('20260918','function','org_seat_limit'),
    ('20260918','function','org_seat_status'),
    ('20260918','function','atlas_is_trusted_server'),
    ('20260918','function','atlas_assert_trusted_server'),
    ('20260918','function','atlas_is_internal_admin'),
    ('20260918','function','atlas_assert_internal_admin'),
    ('20260918','function','atlas_can_access_tenant'),
    ('20260918','function','atlas_assert_tenant_access'),
    ('20260918','function','atlas_caller_tenants'),
    -- ---- 20260919 stripe billing: functions + indexes + columns ----
    ('20260919sp','function','billing_apply_state'),
    ('20260919sp','function','billing_get_state'),
    ('20260919sp','function','users_current_user'),
    ('20260919sp','index','organization_subscriptions_org_idx'),
    ('20260919sp','index','organization_subscriptions_provider_customer_idx'),
    ('20260919sp','index','organization_subscriptions_provider_sub_idx'),
    ('20260919sp','index','processed_webhook_events_provider_event_idx'),
    ('20260919sp','column','organization_subscriptions.payment_status'),
    ('20260919sp','column','organization_subscriptions.cancel_at_period_end'),
    ('20260919sp','column','organization_subscriptions.latest_invoice_id'),
    ('20260919sp','column','organization_subscriptions.latest_invoice_at'),
    -- ---- 20260919 regulatory schema reconciliation ----
    ('20260919r','table','atlas_regulatory_acquisition_jobs'),
    ('20260919r','table','atlas_regulatory_contradictions'),
    ('20260919r','table','atlas_regulatory_coverage'),
    ('20260919r','table','atlas_regulatory_jurisdictions'),
    ('20260919r','table','atlas_regulatory_proposition_versions'),
    ('20260919r','table','atlas_regulatory_propositions'),
    ('20260919r','table','atlas_regulatory_review_queue'),
    ('20260919r','table','atlas_regulatory_source_versions'),
    ('20260919r','table','atlas_regulatory_sources'),
    ('20260919r','function','admin_prepare_user_deletion'),
    ('20260919r','index','idx_reg_acquisition_jobs_dequeue'),
    ('20260919r','index','idx_reg_contradictions_jurisdiction'),
    ('20260919r','index','idx_reg_props_context'),
    ('20260919r','index','idx_reg_props_dates'),
    ('20260919r','index','idx_reg_props_source'),
    ('20260919r','index','idx_reg_review_queue_status'),
    ('20260919r','index','idx_reg_sources_hash'),
    ('20260919r','index','idx_reg_sources_jurisdiction'),
    ('20260919r','index','idx_reg_sources_relationship'),
    -- ---- 20260920 blog publishing ----
    ('20260920','function','atlas_blog_slugify'),
    ('20260920','function','content_admin_list'),
    ('20260920','function','content_public_get'),
    ('20260920','function','content_public_list'),
    ('20260920','function','content_publish_blog'),
    ('20260920','function','content_review_decide'),
    ('20260920','index','contentitems_by_parent_idx'),
    ('20260920','index','contentitems_by_status_idx'),
    ('20260920','index','contentitems_by_type_idx'),
    ('20260920','index','contentitems_published_slug_idx'),
    ('20260920','index','contentitems_unique_published_slug_idx'),
    ('20260920','index','contentprovenance_by_content_idx'),
    -- ---- 20260921 subscription merge ----
    ('20260921','function','billing_upsert_subscription'),
    -- ---- 20260922 integration foundation: 5 tables + 13 functions + 10 indexes + 11 columns ----
    ('20260922','table','integration_events'),
    ('20260922','table','integration_external_refs'),
    ('20260922','table','integration_oauth_states'),
    ('20260922','table','integration_provider_settings'),
    ('20260922','table','integration_sync_state'),
    ('20260922','function','connections_disconnect'),
    ('20260922','function','connections_list_catalog'),
    ('20260922','function','connections_register'),
    ('20260922','function','connections_set_status'),
    ('20260922','function','integration_admin_overview'),
    ('20260922','function','integration_event_finish'),
    ('20260922','function','integration_event_ingest'),
    ('20260922','function','integration_external_ref_upsert'),
    ('20260922','function','integration_oauth_state_consume'),
    ('20260922','function','integration_oauth_state_create'),
    ('20260922','function','integration_provider_settings_upsert'),
    ('20260922','function','integration_sync_state_list'),
    ('20260922','function','integration_sync_state_upsert'),
    ('20260922','index','connections_tenant_provider_idx'),
    ('20260922','index','connectiontokens_connection_idx'),
    ('20260922','index','integration_events_dedupe_idx'),
    ('20260922','index','integration_events_org_idx'),
    ('20260922','index','integration_events_status_idx'),
    ('20260922','index','integration_external_refs_atlas_idx'),
    ('20260922','index','integration_external_refs_key_idx'),
    ('20260922','index','integration_oauth_states_expiry_idx'),
    ('20260922','index','integration_sync_state_due_idx'),
    ('20260922','index','integration_sync_state_key_idx'),
    ('20260922','column','connections.externalAccountId'),
    ('20260922','column','connections.connectionType'),
    ('20260922','column','connections.capabilities'),
    ('20260922','column','connections.lastAttemptedSyncAt'),
    ('20260922','column','connections.disconnectedAt'),
    ('20260922','column','connections.credentialKeyVersion'),
    ('20260922','column','connectiontokens.access_token_enc'),
    ('20260922','column','connectiontokens.refresh_token_enc'),
    ('20260922','column','connectiontokens.token_key_version'),
    ('20260922','column','connectiontokens.lastRefreshedAt'),
    ('20260922','column','connectiontokens.revokedAt')
),
checked as (
  select e.migration, e.kind, e.name,
    case e.kind
      when 'table' then to_regclass('public.' || quote_ident(e.name)) is not null
      when 'index' then to_regclass('public.' || quote_ident(e.name)) is not null
      when 'function' then exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = e.name
      )
      when 'column' then exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = split_part(e.name, '.', 1)
          and c.column_name = split_part(e.name, '.', 2)
      )
    end as present
  from expected e
),
per_migration as (
  select migration,
         count(*) as expected,
         count(*) filter (where present) as present,
         coalesce(jsonb_agg(name order by name) filter (where not present), '[]'::jsonb) as missing
  from checked
  group by migration
)
select jsonb_pretty(jsonb_build_object(
  'repo_migration_versions', (select count(distinct version) from repo_versions),
  'ledger_versions', (select count(*) from ledger),
  'repo_versions_absent_from_ledger', (
    select coalesce(jsonb_agg(file order by file), '[]'::jsonb) from unrecorded
  ),
  'per_migration', (
    select jsonb_object_agg(migration, jsonb_build_object(
      'expected', expected, 'present', present,
      'missing_count', expected - present, 'missing', missing
    ) order by migration)
    from per_migration
  )
)) as report;
