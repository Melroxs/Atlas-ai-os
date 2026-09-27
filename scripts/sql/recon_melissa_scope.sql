-- READ-ONLY scope recon. SELECT only.

-- 1. MELISSA
select p."_id" as id, p.email, p.name, p.platform_role, p.account_status
from public.profiles p
where lower(p.email) = 'melissa.o.rox@gmail.com';

-- 2. EVERY TENANT with member/owner counts and Melissa flag
select t."_id" as tenant_id,
       t.name as tenant_name,
       t.status,
       t.account_type,
       to_timestamp(t."_creationTime" / 1000.0) as created,
       count(m."_id") as members,
       count(m."_id") filter (where m.role = 'owner') as owners,
       bool_or(m."userId" = (select "_id" from public.profiles where lower(email) = 'melissa.o.rox@gmail.com')) as melissa_in,
       (select count(*) from public.stripe_customers sc where sc.tenant_id = t."_id") as stripe_cust,
       (select count(*) from public.subscriptions s where s.tenant_id = t."_id") as subs
from public.tenants t
left join public.memberships m on m."tenantId" = t."_id"
group by t."_id", t.name, t.status, t.account_type, t."_creationTime"
order by melissa_in desc nulls last, t."_creationTime";

-- 3. TOTALS
select
  (select count(*) from public.tenants) as tenants,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.memberships) as memberships,
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.archivefiles) as archivefiles,
  (select count(*) from public.documents) as documents,
  (select count(*) from public.stripe_customers) as stripe_customers,
  (select count(*) from public.subscriptions) as subscriptions;

-- 4. USERS with their orgs
select p.email,
       p.platform_role,
       p.account_status,
       coalesce(string_agg(t.name || ' [' || m.role || ']', ', ' order by t.name), '(none)') as orgs
from public.profiles p
left join public.memberships m on m."userId" = p."_id"
left join public.tenants t on t."_id" = m."tenantId"
group by p."_id", p.email, p.platform_role, p.account_status
order by p.email;

-- 5. auth.users with no profile
select u.email, u.created_at
from auth.users u
left join public.profiles p on p."_id" = u.id
where p."_id" is null
order by u.email;

-- 6. subscriptions detail
select s.tenant_id, t.name as tenant_name, s.status, s.plan_name, s.stripe_subscription_id
from public.subscriptions s
left join public.tenants t on t."_id" = s.tenant_id;
