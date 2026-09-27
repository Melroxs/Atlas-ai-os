-- Which public tables reference auth.users with a blocking ON DELETE?
select src.relname || '.' || a.attname as blocking_column
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_namespace src_ns on src_ns.oid = src.relnamespace
join unnest(c.conkey) with ordinality k(attnum, ord) on true
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
where c.contype = 'f'
  and c.confrelid = 'auth.users'::regclass
  and src_ns.nspname = 'public'
  and c.confdeltype in ('a', 'r')
order by 1;
