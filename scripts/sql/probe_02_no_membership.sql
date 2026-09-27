-- PROBE 2 — signed-in active user with NO organization membership.
-- This is the "ordinary viewer" case: they are authenticated, so they clear
-- the signed-in guard, but my_tenant_id() is NULL and is_super_admin() is false.
begin;
select set_config('request.jwt.claim.sub', '03174c50-1577-416a-8236-dd9277e57eb9', true);
select set_config('request.jwt.claims', '{"sub":"03174c50-1577-416a-8236-dd9277e57eb9","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as result;
rollback;
