select pg_get_functiondef(p.oid) as auth_uid_def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'auth' and p.proname = 'uid';
