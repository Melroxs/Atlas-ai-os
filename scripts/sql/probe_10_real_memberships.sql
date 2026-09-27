-- The REAL memberships of each probe subject (no aggregate sampling).
select
  p.platform_role,
  p.account_status,
  m."tenantId"::text as tenant_id,
  m.role,
  m.status,
  p._id::text as uid
from public.profiles p
left join public.memberships m on m."userId" = p._id
where p._id::text in (
  '0e914537-e62b-4982-a49d-3056f0deb2b8',
  '21a46f50-6703-44b2-983d-35592bc4f690',
  '290e68ab-c60c-4da5-ae05-3ceacc1cfd39',
  '03174c50-1577-416a-8236-dd9277e57eb9'
)
order by p.platform_role, p._id;
