-- Run after applying 20260906_atlas_regulatory_intelligence.sql.
-- This script raises an exception instead of silently passing an incomplete schema.
DO $$
DECLARE
  required_table text;
  missing_count integer;
  jurisdiction_count integer;
  wave_count integer;
  missing_index_count integer;
  unprotected_count integer;
  missing_policy_count integer;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'atlas_regulatory_jurisdictions',
    'atlas_regulatory_sources',
    'atlas_regulatory_source_versions',
    'atlas_regulatory_propositions',
    'atlas_regulatory_proposition_versions',
    'atlas_regulatory_contradictions',
    'atlas_regulatory_review_queue',
    'atlas_regulatory_coverage',
    'atlas_regulatory_acquisition_jobs'
  ] LOOP
    SELECT count(*) INTO missing_count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = required_table;
    IF missing_count <> 1 THEN RAISE EXCEPTION 'Missing required table: %', required_table; END IF;
  END LOOP;

  SELECT count(*) INTO jurisdiction_count FROM public.atlas_regulatory_jurisdictions;
  IF jurisdiction_count <> 51 THEN RAISE EXCEPTION 'Expected 51 jurisdictions, found %', jurisdiction_count; END IF;
  SELECT count(*) INTO wave_count FROM public.atlas_regulatory_jurisdictions WHERE wave = 1 AND code IN ('FL','TX','CA','NY','CO','MD','GA','LA','AZ','WA');
  IF wave_count <> 10 THEN RAISE EXCEPTION 'Expected 10 Wave 1 jurisdictions, found %', wave_count; END IF;

  SELECT count(*) INTO missing_index_count
  FROM (VALUES
    ('idx_reg_sources_jurisdiction'),
    ('idx_reg_sources_hash'),
    ('idx_reg_sources_relationship'),
    ('idx_reg_props_context'),
    ('idx_reg_props_dates'),
    ('idx_reg_props_source'),
    ('idx_reg_contradictions_jurisdiction'),
    ('idx_reg_review_queue_status'),
    ('idx_reg_acquisition_jobs_dequeue')
  ) AS expected(index_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = expected.index_name);
  IF missing_index_count <> 0 THEN RAISE EXCEPTION 'Missing % expected regulatory indexes', missing_index_count; END IF;

  SELECT count(*) INTO unprotected_count
  FROM (VALUES
    ('atlas_regulatory_jurisdictions'),
    ('atlas_regulatory_sources'),
    ('atlas_regulatory_source_versions'),
    ('atlas_regulatory_propositions'),
    ('atlas_regulatory_proposition_versions'),
    ('atlas_regulatory_contradictions'),
    ('atlas_regulatory_review_queue'),
    ('atlas_regulatory_coverage'),
    ('atlas_regulatory_acquisition_jobs')
  ) AS expected(table_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = expected.table_name AND c.relrowsecurity);
  IF unprotected_count <> 0 THEN RAISE EXCEPTION 'RLS is not enabled on % regulatory tables', unprotected_count; END IF;

  SELECT count(*) INTO missing_policy_count
  FROM (VALUES
    ('atlas_regulatory_jurisdictions'),
    ('atlas_regulatory_sources'),
    ('atlas_regulatory_source_versions'),
    ('atlas_regulatory_propositions'),
    ('atlas_regulatory_proposition_versions'),
    ('atlas_regulatory_contradictions'),
    ('atlas_regulatory_review_queue'),
    ('atlas_regulatory_coverage'),
    ('atlas_regulatory_acquisition_jobs')
  ) AS expected(table_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = expected.table_name AND policyname LIKE 'regulatory%');
  IF missing_policy_count <> 0 THEN RAISE EXCEPTION 'Missing regulatory policy on % tables', missing_policy_count; END IF;

  RAISE NOTICE 'Atlas regulatory schema verification passed: 9 tables, 51 jurisdictions, 10 Wave 1 records, indexes, RLS, and policies present.';
END;
$$;

SELECT
  (SELECT count(*) FROM public.atlas_regulatory_jurisdictions) AS jurisdiction_count,
  (SELECT count(*) FROM public.atlas_regulatory_sources) AS source_count,
  (SELECT count(*) FROM public.atlas_regulatory_propositions) AS proposition_count,
  (SELECT count(*) FROM public.atlas_regulatory_propositions WHERE verification_state = 'VERIFIED') AS verified_count,
  (SELECT count(*) FROM public.atlas_regulatory_review_queue WHERE status = 'OPEN') AS open_review_count,
  (SELECT count(*) FROM public.atlas_regulatory_contradictions WHERE resolution_status <> 'RESOLVED_PRIMARY_PREVAILS') AS unresolved_contradiction_count;
