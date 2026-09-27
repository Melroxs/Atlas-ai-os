-- Read-only production data-safety report.
--
-- Two deliberate changes from the previous version:
--
--  1. The residue test no longer matches broad patterns such as '%test%'.
--     A legitimate organization can contain the word "test" in its name, and
--     the old predicate reported exactly that legitimate row as test residue.
--     Residue is now matched only by the explicit probe namespaces this repo's
--     tooling creates: 'probe-%' (scripts/probes) and 'zz-%' (legacy probes).
--     Both are anchored prefixes, so no legitimate production name can match.
--
--  2. No account address is embedded in this file. The previous version
--     hardcoded a specific user's email. Account state is now reported as
--     aggregate counts, and the profile inventory is produced at RUN time
--     (it is output, not committed data).
--
-- Read-only: a temp table plus SELECTs, no DDL and no DML.
create temp table _prod_state on commit drop as
select
  (select count(*) from public.tenants)::int                        as tenants,
  (select count(*) from public.memberships)::int                    as memberships,
  (select count(*) from public.profiles)::int                       as profiles,
  (select count(*) from public.complimentary_access)::int           as grants,
  (select count(*) from public.stripe_customers)::int               as stripe_customers,
  (select count(*) from public.subscriptions)::int                  as subscriptions,
  (select count(*) from public.organization_subscriptions)::int     as org_subscriptions,
  (select count(*) from public.billing_audit_events)::int           as billing_audit_events,

  -- Residue: explicit probe namespaces only. Anchored prefixes by design.
  (select count(*) from public.tenants
     where slug like 'probe-%' or slug like 'zz-%')::int            as probe_tenants,
  (select count(*) from public.profiles
     where lower(email) like 'probe-%' or lower(email) like 'zz-%')::int as probe_profiles,
  (select count(*) from public.insuranceclaims
     where coalesce(customer, '') like 'Probe %'
        or coalesce(customer, '') like 'ZZ%'
        or coalesce("claimNumber", '') like 'ZZ%')::int            as probe_claims,
  (select count(*) from public.memberships m
     join public.profiles p on p._id = m."userId"
    where lower(p.email) like 'probe-%' or lower(p.email) like 'zz-%')::int as probe_memberships,
  (select count(*) from public.complimentary_access c
    where c.organization_id in (select _id from public.tenants
                                  where slug like 'probe-%' or slug like 'zz-%'))::int as probe_grants,
  ((select count(*) from public.stripe_customers
     where tenant_id in (select _id from public.tenants
                          where slug like 'probe-%' or slug like 'zz-%'))
   + (select count(*) from public.subscriptions
      where tenant_id in (select _id from public.tenants
                           where slug like 'probe-%' or slug like 'zz-%'))
   + (select count(*) from public.organization_subscriptions
      where organization_id in (select _id from public.tenants
                                 where slug like 'probe-%' or slug like 'zz-%'))
   + (select count(*) from public.billing_audit_events
      where organization_id in (select _id from public.tenants
                                 where slug like 'probe-%' or slug like 'zz-%')))::int as probe_billing,

  -- Accounts without any membership, counted rather than named.
  (select count(*) from public.profiles p
    where not exists (select 1 from public.memberships m where m."userId" = p._id))::int
                                                                                    as accounts_without_membership,
  (select count(*) from public.profiles where platform_role = 'super_admin')::int as super_admins,
  (select count(*) from public.profiles where account_status = 'pending')::int    as pending_accounts;

create temp table _prod_inventory on commit drop as
select string_agg(format('%s (%s, %s)', coalesce(p.email, '(no email)'),
                                coalesce(p.platform_role, '?'),
                                coalesce(p.account_status, '?')), ' | ' order by p.email) as profiles,
       (select string_agg(t.name, ' | ' order by t.name) from public.tenants t) as tenants
from public.profiles p;

select format(
  'tenants=%s | memberships=%s | profiles=%s | grants=%s | stripe=%s subs=%s org_subs=%s audit=%s',
  tenants, memberships, profiles, grants, stripe_customers, subscriptions,
  org_subscriptions, billing_audit_events) as baseline,
  format(
  'RESIDUE (probe-/zz- namespaces only) probe_tenants=%s probe_profiles=%s probe_claims=%s probe_memberships=%s probe_grants=%s probe_billing=%s',
  probe_tenants, probe_profiles, probe_claims, probe_memberships, probe_grants, probe_billing) as residue,
  format('accounts_without_membership=%s | super_admins=%s | pending_accounts=%s',
         accounts_without_membership, super_admins, pending_accounts) as accounts,
  format('tenants=[%s]', coalesce((select tenants from _prod_inventory), '-')) as tenant_list,
  format('profiles=[%s]', coalesce((select profiles from _prod_inventory), '-')) as profile_list
from _prod_state;
