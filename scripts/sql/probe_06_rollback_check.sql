-- Rollback proof: everything probe 5 touched must be back, and no audit row
-- from the probe may have survived.
select
  (select count(*) from public.documents where _id = 'c772fdba-ed95-49ef-bb74-5b21a0381ec6')::int as target_document_rows,
  (select count(*) from public.documentChunks where "documentId" = 'c772fdba-ed95-49ef-bb74-5b21a0381ec6')::int as target_chunk_rows,
  (select "documentId"::text from public.archivefiles where _id = 'e5c1000c-2494-4f4e-b377-69d086dfa4cc') as file_document_link,
  (select "ingestStatus" from public.archivefiles where _id = 'e5c1000c-2494-4f4e-b377-69d086dfa4cc') as file_ingest_status,
  (select count(*) from public.atlas_audit_log)::int as audit_rows_now;
