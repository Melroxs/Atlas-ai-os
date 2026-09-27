-- READ-ONLY: invites remaining in Test Company after the 23 orgs are deleted.
select string_agg(
   coalesce(email,'(no email)') || ' | role=' || coalesce(role,'-') || ' | status=' || coalesce(status,'-'),
   E'\n' order by email) as report
from public.invites
where "tenantId" = (select "_id" from public.tenants where name = 'Test Company');
