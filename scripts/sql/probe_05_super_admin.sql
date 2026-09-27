-- PROBE 5 — platform super_admin acting in an organization they are NOT a
-- member of. Caller 0e914537 is a super_admin whose only membership is tenant
-- 877bf5ec; the target file belongs to tenant 6379923e. If the new branch works,
-- the organization is resolved from the target ROW and the delete proceeds.
--
-- This is a real write. It is executed inside a transaction and ROLLED BACK,
-- so no document, chunk, file row or audit record is permanently removed.
begin;
select set_config('request.jwt.claim.sub', '0e914537-e62b-4982-a49d-3056f0deb2b8', true);
select set_config('request.jwt.claims', '{"sub":"0e914537-e62b-4982-a49d-3056f0deb2b8","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  'e5c1000c-2494-4f4e-b377-69d086dfa4cc', 'knowledge'
) as result;
rollback;
