-- READ-ONLY: all profiles with their org memberships, compact.
with per_user as (
  select p."_id" as pid,
         p.email as email,
         coalesce(p.platform_role,'-') as prole,
         coalesce(p.account_status,'-') as astat,
         coalesce(string_agg(t.name || '[' || m.role || ']', ', ' order by t.name), '(no-org)') as orgs
  from public.profiles p
  left join public.memberships m on m."userId" = p."_id"
  left join public.tenants t on t."_id" = m."tenantId"
  group by p."_id", p.email, p.platform_role, p.account_status
)
select string_agg(email || ' | ' || prole || '/' || astat || ' | ' || orgs, E'\n' order by email) as report
from per_user;
