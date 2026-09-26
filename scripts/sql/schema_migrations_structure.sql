-- READ-ONLY: structure of the Supabase migration ledger, so a repair can be
-- written to match what `supabase migration repair` actually stores.
select jsonb_pretty(jsonb_build_object(
  'columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', column_name, 'type', data_type, 'nullable', is_nullable, 'default', column_default
    ) order by ordinal_position), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
  ),
  'constraints', (
    select coalesce(jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid))), '[]'::jsonb)
    from pg_constraint
    where conrelid = 'supabase_migrations.schema_migrations'::regclass
  ),
  'indexes', (
    select coalesce(jsonb_agg(indexdef), '[]'::jsonb)
    from pg_indexes where schemaname = 'supabase_migrations' and tablename = 'schema_migrations'
  )
)) as report;
