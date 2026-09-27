-- READ-ONLY: inside Test Company, split ingested content into claim-linked vs not.
with tc as (select "_id" as tid from public.tenants where name = 'Test Company'),
claim_ing as (
  select distinct c."archiveId" as ing_id
  from public.claimcandidates c
  where c."tenantId" = (select tid from tc) and c."archiveId" is not null
)
select
  (select count(*) from public.archiveingestions ai where ai."tenantId"=(select tid from tc)) as all_ingestions,
  (select count(*) from claim_ing) as claim_linked_ingestions,
  (select count(*) from public.archivefiles af
     where af."tenantId"=(select tid from tc)
       and af."archiveId" in (select ing_id from claim_ing)) as claim_linked_files,
  (select count(*) from public.archivefiles af where af."tenantId"=(select tid from tc)) as all_files,
  (select count(*) from public.documents d where d."tenantId"=(select tid from tc)) as all_documents,
  (select count(*) from public.insuranceclaims c where c."tenantId"=(select tid from tc)) as claims,
  (select count(*) from public.claimcandidates c where c."tenantId"=(select tid from tc)) as candidates,
  (select count(*) from public.claimfindings f where f."tenantId"=(select tid from tc)) as findings;
