select
  c.conname,
  src.relname || '.' || a.attname as from_col,
  c.confrelid::regclass::text as references,
  af.attname as ref_col,
  af.attnotnull as ref_not_null,
  case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
       when 'c' then 'CASCADE' when 'n' then 'SET NULL' else c.confdeltype::text end as on_delete
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_namespace src_ns on src_ns.oid = src.relnamespace
join unnest(c.conkey) with ordinality k(attnum, ord) on true
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
join unnest(c.confkey) with ordinality fk(attnum, ord) on fk.ord = k.ord
join pg_attribute af on af.attrelid = c.confrelid and af.attnum = fk.attnum
where c.contype = 'f' and c.conrelid = 'public.auditLogs'::regclass
order by 2;
