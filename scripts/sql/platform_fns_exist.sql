select jsonb_pretty(jsonb_build_object(
  'found', (
    select coalesce(jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', p.proname, 'kind', p.prokind) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname in (
      'schedules_list','schedules_upsert','schedules_set_enabled','schedules_fire_due',
      'schedules_record_result','sources_list_due','sources_get','sources_list_checks',
      'sources_record_check','sources_set_check_frequency','knowledge_versions',
      'knowledge_as_of','knowledge_create_version','knowledge_verify',
      'content_create','content_transition','content_list','content_get','content_list_provenance'
    )
  ),
  'schemas_searched_count', (select count(distinct n.nspname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace)
)) as report;
