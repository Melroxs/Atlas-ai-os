-- Which surviving row(s) point at the one genuinely deleted object?
select 'document' as kind, d."_id"::text as id, d.title, d.status::text, d."storageId"
from public.documents d
where d."storageId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa/586656f6-6e82-4424-8ad2-1dff82e509af'
union all
select 'archivefile', f."_id"::text, f.filename, f."ingestStatus"::text, f."storageId"
from public.archivefiles f
where f."storageId" = '877bf5ec-fd93-4ea1-8e55-280e320f32aa/586656f6-6e82-4424-8ad2-1dff82e509af';
