-- After 20260929: user references must be SET NULL (rows preserved), and
-- every tenant reference must keep its original rule.
select
  c.confrelid::regclass::text as references_to,
  case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
       when 'c' then 'CASCADE' when 'n' then 'SET NULL' else c.confdeltype::text end as on_delete,
  count(*)::int as fk_count
from pg_constraint c
where c.contype = 'f'
  and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass, 'public.tenants'::regclass)
group by 1, 2
order by 1, 2;
