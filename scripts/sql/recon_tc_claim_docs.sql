-- READ-ONLY: documents (and their chunks) derived from Test Company's claim-linked archive files.
with tc as (select "_id" as tid from public.tenants where name = 'Test Company'),
claim_files as (
  select af."_id" as fid
  from public.archivefiles af
  where af."tenantId" = (select tid from tc)
    and af."archiveId" in (
      select c."archiveId" from public.claimcandidates c
      where c."tenantId" = (select tid from tc) and c."archiveId" is not null)
),
claim_docs as (
  select d."_id" as did
  from public.documents d
  where d."tenantId" = (select tid from tc)
    and d."_id" in (
      select af."documentId" from public.archivefiles af
      where af."documentId" is not null and af."_id" in (select fid from claim_files))
)
select
  (select count(*) from public.documents where "tenantId"=(select tid from tc)) as all_docs,
  (select count(*) from claim_docs) as claim_linked_docs,
  (select count(*) from public.documentchunks where "tenantId"=(select tid from tc)) as all_chunks,
  (select count(*) from public.documentchunks dc
     where dc."tenantId"=(select tid from tc)
       and dc."documentId" in (select did from claim_docs)) as claim_linked_chunks;
