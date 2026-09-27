-- Applied migration ledger, newest first.
select version, name, statements
from supabase_migrations.schema_migrations
order by version desc
limit 25;
