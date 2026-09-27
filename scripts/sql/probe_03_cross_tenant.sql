-- PROBE 3 — CROSS-TENANT / IDOR.
-- Caller is a genuine active OWNER, but of tenant 6379923e. The target file
-- belongs to tenant 877bf5ec. Must be refused as "not found" — never as
-- "forbidden", which would leak that the row exists.
begin;
select set_config('request.jwt.claim.sub', '290e68ab-c60c-4da5-ae05-3ceacc1cfd39', true);
select set_config('request.jwt.claims', '{"sub":"290e68ab-c60c-4da5-ae05-3ceacc1cfd39","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as result;
rollback;
