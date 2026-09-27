-- Any FK to public.tenants from OUTSIDE the public schema would still block
-- `delete from tenants`. There must be none.
select src_ns.nspname as source_schema,
       src.relname as source_table,
       c.conname as fk,
       case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
            when 'c' then 'CASCADE' when 'n' then 'SET NULL' else c.confdeltype::text end as on_delete
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_namespace src_ns on src_ns.oid = src.relnamespace
where c.contype = 'f'
  and c.confrelid = 'public.tenants'::regclass
  and src_ns.nspname <> 'public'
order by 1, 2;
