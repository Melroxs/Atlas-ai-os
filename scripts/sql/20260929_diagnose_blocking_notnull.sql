-- NOT NULL among the columns that currently block user deletion.
select c.conname as fk,
       src.relname || '.' || a.attname as column_ref,
       a.attnotnull as column_is_not_null,
       c.confrelid::regclass::text as references_to
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_namespace src_ns on src_ns.oid = src.relnamespace
join unnest(c.conkey) with ordinality k(attnum, ord) on true
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
where c.contype = 'f'
  and src_ns.nspname = 'public'
  and a.attnotnull
  and c.confdeltype in ('a', 'r')
  and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
order by 1;
