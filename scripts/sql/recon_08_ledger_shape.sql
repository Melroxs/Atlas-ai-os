select version, name, array_length(statements, 1) as n_statements, statements
from supabase_migrations.schema_migrations
where version in ('20260928', '20260927')
order by version;
