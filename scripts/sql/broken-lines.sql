select string_agg(line, E'\n' order by fn, ord) as report
from (
  select p.proname as fn,
         (regexp_matches(p.prosrc, '[^\n]*_creationTime[^\n]*', 'g'))[1] as line,
         0 as ord
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('admin_create_tenant','admin_create_pilot_organization','admin_list_users')
) s;
