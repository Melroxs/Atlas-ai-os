-- PROBE 1 — anonymous caller (no JWT subject) must be denied.
begin;
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as result;
rollback;
