-- READ-ONLY: claim row counts per tenant.
with t as (select "_id" as tid, name as tname from public.tenants)
select string_agg(
   tname || ' | claims=' || (select count(*) from public.insuranceclaims c where c."tenantId"=t.tid)
   || ' candidates=' || (select count(*) from public.claimcandidates c where c."tenantId"=t.tid)
   || ' findings=' || (select count(*) from public.claimfindings c where c."tenantId"=t.tid)
   || ' supplements=' || (select count(*) from public.claimsupplements c where c."tenantId"=t.tid),
   E'\n' order by (select count(*) from public.insuranceclaims c where c."tenantId"=t.tid) desc, tname) as report
from t;
