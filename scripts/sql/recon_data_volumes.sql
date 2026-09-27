-- READ-ONLY: data volume per tenant, compact.
with v as (
  select t."_id" as tid, t.name as tname,
         (select count(*) from public.documents d where d."tenantId"=t."_id") as docs,
         (select count(*) from public.archivefiles af where af."tenantId"=t."_id") as afiles,
         (select count(*) from public.auditlogs al where al."tenantId"=t."_id") as logs,
         (select count(*) from public.invites i where i."tenantId"=t."_id") as inv,
         (select count(*) from public.connections c where c."tenantId"=t."_id") as conns
  from public.tenants t
)
select string_agg(tname || ' | docs=' || docs || ' files=' || afiles || ' logs=' || logs || ' invites=' || inv || ' conns=' || conns,
         E'\n' order by (docs+afiles) desc, tname) as report
from v;
