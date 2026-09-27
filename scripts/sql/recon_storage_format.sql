-- READ-ONLY: sample storageId formats to learn the storage path convention.
select 'documents' as src, string_agg(coalesce("storageId",'(null)'), E'\n' order by "storageId") as ids
from (select "storageId" from public.documents where "storageId" is not null limit 6) s;
