with fns as (
  select p.proname,
         p.prosecdef,
         array_to_string(coalesce(p.proargnames, '{}'::name[]), ',') as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proname like '%complimentary%' or p.proname like 'admin_%')
)
select string_agg(format('%s(security_definer=%s, args=%s)', proname, prosecdef, args), E'\n' order by proname) as report
from fns;
