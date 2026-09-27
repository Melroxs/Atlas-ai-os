-- Find existing real users to use as probe subjects. READ-ONLY: no rows created.
-- Emails are deliberately not selected; only roles and ids.
with m as (
  select m."userId" as uid, m."tenantId" as tid, m.role, m.status,
         p.platform_role, p.account_status
  from public.memberships m
  join public.profiles p on p._id = m."userId"
  where m.status = 'active'
)
select
  platform_role,
  account_status,
  role as org_role,
  count(*)::int as n,
  min(uid::text) as sample_uid,
  min(tid::text) as sample_tenant
from m
group by 1, 2, 3
order by 1 nulls last, 3;
