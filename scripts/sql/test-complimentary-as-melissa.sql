-- End-to-end test as Melissa, covering the whole complimentary-access path.
-- The whole probe is ROLLED BACK; nothing is persisted.
begin;
select set_config(
  'request.jwt.claim.sub',
  (select u.id::text from auth.users u where u.email = 'melissa.o.rox@gmail.com'), true);
select set_config('request.jwt.claims',
  (select json_build_object('sub', u.id::text, 'email', u.email, 'role', 'authenticated')::text
   from auth.users u where u.email = 'melissa.o.rox@gmail.com'), true);

do $$
declare
  v_tenant uuid := (select _id from public.tenants order by "_creationTime" limit 1);
  v_melissa uuid := (select _id from public.profiles where email = 'melissa.o.rox@gmail.com');
  v_org json;
  v_pilot jsonb;
begin
  -- A. create an organization
  v_org := public.admin_create_tenant('ZZ Probe Org', 'zz-probe-org');
  raise notice 'A create_org -> %', v_org::text;

  -- B. every complimentary duration that used to overflow
  raise notice 'B 7d  -> %', (public.admin_grant_complimentary_access(v_tenant,'7d','probe',v_melissa)->>'expires_at');
  raise notice 'B 30d -> %', (public.admin_grant_complimentary_access(v_tenant,'30d','probe',v_melissa)->>'expires_at');
  raise notice 'B 90d -> %', (public.admin_grant_complimentary_access(v_tenant,'90d','probe',v_melissa)->>'expires_at');
  raise notice 'B 1y  -> %', (public.admin_grant_complimentary_access(v_tenant,'1y','probe',v_melissa)->>'expires_at');
  raise notice 'B lifetime -> %', coalesce((public.admin_grant_complimentary_access(v_tenant,'lifetime','probe',v_melissa)->>'expires_at'), 'null (no expiration)');
  raise notice 'B org-wide -> %', (public.admin_grant_complimentary_access(v_tenant,'30d','probe',null)->>'status');

  -- C. Free Pilot organization: org + org-wide complimentary grant, new admin email
  v_pilot := public.admin_create_pilot_organization(
    'ZZ Probe Pilot', 'zzpilot@example.com', 'ZZ Pilot', 'zz-probe-pilot',
    (extract(epoch from now()) * 1000)::bigint + 2592000000, 'probe', null);
  raise notice 'C create_pilot_org -> %', v_pilot::text;

  -- D. a second pilot with a DIFFERENT slug, and an admin email that already
  --    has a profile (Melissa) — exercises the membership attach branch.
  v_pilot := public.admin_create_pilot_organization(
    'ZZ Probe Pilot 2', 'melissa.o.rox@gmail.com', 'Melissa', 'zz-probe-pilot-2',
    null, null, null);
  raise notice 'D create_pilot_org(existing user) -> %', v_pilot::text;
end $$;

select 'tenants=' || (select count(*) from public.tenants)
  || ' | profiles=' || (select count(*) from public.profiles)
  || ' | grants=' || (select count(*) from public.complimentary_access)
  || ' | pilot_status=' || public.atlas_pilot_status(
       (select _id from public.tenants where slug = 'zz-probe-pilot'))
  || ' | admin_list_users_rows=' || (select count(*) from public.admin_list_users())
as report;
rollback;
