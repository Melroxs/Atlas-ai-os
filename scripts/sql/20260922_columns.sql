with want(tbl, col) as (
  values
    ('connections','externalAccountId'), ('connections','connectionType'),
    ('connections','capabilities'),
    ('connections','lastAttemptedSyncAt'), ('connections','disconnectedAt'),
    ('connections','credentialKeyVersion'),
    ('connectiontokens','access_token_enc'), ('connectiontokens','refresh_token_enc'),
    ('connectiontokens','token_key_version'), ('connectiontokens','lastRefreshedAt'),
    ('connectiontokens','revokedAt')
),
have as (
  select table_name as tbl, column_name as col
  from information_schema.columns where table_schema = 'public'
)
select jsonb_pretty(jsonb_build_object(
  'missing_columns', (
    select coalesce(jsonb_agg(w.tbl || '.' || w.col order by w.tbl, w.col), '[]'::jsonb)
    from want w
    where not exists (select 1 from have h where h.tbl = w.tbl and h.col = w.col)
  )
)) as report;
