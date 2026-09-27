select 'tenants=' || (select count(*) from public.tenants)
  || ' | profiles=' || (select count(*) from public.profiles)
  || ' | grants=' || (select count(*) from public.complimentary_access)
  || ' | memberships=' || (select count(*) from public.memberships) as report;

select 'tenants=' || (select count(*) from public.tenants)
  || ' | profiles=' || (select count(*) from public.profiles)
  || ' | grants=' || (select count(*) from public.complimentary_access)
  || ' | memberships=' || (select count(*) from public.memberships) as report;
