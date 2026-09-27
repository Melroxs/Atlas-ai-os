-- READ-ONLY: tenant inventory, per-tenant stats computed first, then compacted to one string.
with per_tenant as (
  select t."_id" as tid,
         t.name as tname,
         coalesce(t.status,'-') as tstatus,
         coalesce(t.account_type,'-') as ttype,
         to_char(to_timestamp(t."_creationTime"/1000.0),'YYYY-MM-DD') as tcreated,
         count(m."_id") as members,
         count(m."_id") filter (where m.role = 'owner') as owners,
         bool_or(m."userId" = (select "_id" from public.profiles where lower(email)='melissa.o.rox@gmail.com')) as has_mel,
         (select count(*) from public.stripe_customers sc where sc.tenant_id = t."_id") as cus,
         (select count(*) from public.subscriptions s where s.tenant_id = t."_id") as subs
  from public.tenants t
  left join public.memberships m on m."tenantId" = t."_id"
  group by t."_id", t.name, t.status, t.account_type, t."_creationTime"
)
select string_agg(
         tname || ' | ' || tstatus || '/' || ttype || ' | ' || tcreated
         || ' | mbr=' || members || ' own=' || owners
         || ' mel=' || case when has_mel then 'Y' else 'n' end
         || ' cus=' || cus || ' sub=' || subs,
         E'\n' order by tcreated, tname) as report
from per_tenant;
