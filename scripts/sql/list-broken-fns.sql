select string_agg(p.proname, E'\n' order by p.proname) as report
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ~ '(^|[^"_])_creationTime';
