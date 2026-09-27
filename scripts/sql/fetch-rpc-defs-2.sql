select p.proname || ' :: ' || p.prosrc as def
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_grant_complimentary_access')
order by p.proname;
