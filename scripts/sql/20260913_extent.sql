select jsonb_pretty(jsonb_build_object(
  'platform_jobs_index', to_regclass('public.idx_atlas_jobs_platform_idempotency') is not null,
  'atlas_jobs_tenant_id_nullable', (
    select is_nullable from information_schema.columns
    where table_schema='public' and table_name='atlas_jobs' and column_name='tenant_id'
  ),
  'tables_present', jsonb_build_object(
    'atlas_schedules', to_regclass('public.atlas_schedules') is not null,
    'authoritativeSourceChecks', to_regclass('public."authoritativeSourceChecks"') is not null,
    'atlasContentItems', to_regclass('public."atlasContentItems"') is not null,
    'atlasContentProvenance', to_regclass('public."atlasContentProvenance"') is not null,
    'connections', to_regclass('public.connections') is not null,
    'connectiontokens', to_regclass('public.connectiontokens') is not null
  ),
  'functions_present_count', (
    select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'schedules_list','schedules_upsert','schedules_set_enabled','schedules_fire_due',
      'schedules_record_result','sources_list_due','sources_get','sources_list_checks',
      'sources_record_check','sources_set_check_frequency','knowledge_versions',
      'knowledge_as_of','knowledge_create_version','knowledge_verify',
      'content_create','content_transition','content_list','content_get',
      'content_list_provenance','content_public_list'
    )
  )
)) as report;
