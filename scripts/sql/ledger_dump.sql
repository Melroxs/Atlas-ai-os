-- READ-ONLY: dump the full migration ledger (versions + names) so it can be
-- compared against the migration files actually present in the repository.
select coalesce(jsonb_agg(version order by version), '[]'::jsonb) as versions,
       coalesce(jsonb_agg(name order by version), '[]'::jsonb) as names
from supabase_migrations.schema_migrations;
