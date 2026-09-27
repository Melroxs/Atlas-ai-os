select
  p.platform_role,
  p.account_status,
  m.role as org_role,
  m.status as membership_status,
  count(*)::int as n,
    min(p._id::text) as sample_uid
from public.profiles p
left join public.memberships m on m."userId" = p._id
group by 1, 2, 3, 4
order by 1 nulls first, 3 nulls first, 2;
