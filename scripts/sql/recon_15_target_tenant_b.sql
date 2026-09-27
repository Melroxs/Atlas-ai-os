select
  f._id as file_id,
  f."tenantId" as tenant_id,
  f."documentId" as document_id,
  f."storageId" as storage_id,
  f."ingestStatus"
from public.archivefiles f
where f."tenantId" = '6379923e-4997-4a6a-a75d-6cf20fd1c993'::uuid
  and f."documentId" is not null
  and f."storageId" is not null
  and f."ingestStatus" <> 'deleted'
limit 1;
