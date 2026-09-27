select
  f._id as file_id,
  f."archiveId" as archive_id,
  f."documentId" as document_id,
  f."storageId" as storage_id,
  f."ingestStatus"
from public.archivefiles f
where f."tenantId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa'::uuid
  and f."documentId" is not null
  and f."storageId" is not null
  and f."ingestStatus" <> 'deleted'
limit 1;
