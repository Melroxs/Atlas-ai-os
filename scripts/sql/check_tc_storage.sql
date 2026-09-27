-- Do Test Company's surviving rows still reference storage objects?
select
  (select count(*) from public.documents) as docs,
  (select count(*) from public.documents where "storageId" is not null) as docs_with_storage,
  (select string_agg("storageId", E'\n' order by "storageId") from public.documents limit 5) as sample_doc_paths,
  (select count(*) from public.archivefiles) as files,
  (select count(*) from public.archivefiles where "storageId" is not null) as files_with_storage,
  (select string_agg("storageId", E'\n' order by "storageId") from public.archivefiles limit 5) as sample_file_paths;
