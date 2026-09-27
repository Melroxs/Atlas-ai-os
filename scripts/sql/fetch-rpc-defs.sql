select p.proname || ' :: ' || p.prosrc as def
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_create_tenant')
order by p.proname;
