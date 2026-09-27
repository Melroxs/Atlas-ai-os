select pg_get_functiondef(p.oid) as log_audit_def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'log_audit';
