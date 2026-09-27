-- Exact split of the blocking user foreign keys 20260929 must neutralize.
select c.confrelid::regclass::text as references_to,
       count(*)::int as blocking_fks
from pg_constraint c
where c.contype = 'f'
  and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
  and c.confdeltype in ('a','r')
group by 1
order by 1;
