begin;
select set_config('request.jwt.claim.sub', '290e68ab-c60c-4da5-ae05-3ceacc1cfd39', true);
select
  m."tenantId"::text as membership_tenant,
  m.role,
  m.status,
  public.my_tenant_id()::text as resolved_my_tenant_id,
  public.my_member_role() as resolved_role
from public.memberships m
where m."userId" = '290e68ab-c60c-4da5-ae05-3ceacc1cfd39';
rollback;
