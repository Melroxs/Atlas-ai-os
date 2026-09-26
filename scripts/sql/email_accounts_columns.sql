-- READ-ONLY: what does the row returned by the unguarded, anon-executable
-- email_accounts_get_credentials actually contain?
select jsonb_build_object(
  'email_accounts_columns', (
    select coalesce(jsonb_agg(column_name order by ordinal_position), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'email_accounts'
  ),
  'credential_shaped_columns', (
    select coalesce(jsonb_agg(column_name order by column_name), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_accounts'
      and (column_name ilike '%password%' or column_name ilike '%secret%'
           or column_name ilike '%token%' or column_name ilike '%credential%'
           or column_name ilike '%enc%')
  ),
  'related_credential_tables', (
    select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (c.relname ilike '%credential%' or c.relname ilike '%email_account%')
  ),
  'row_count', (select count(*) from public.email_accounts)
) as report;
