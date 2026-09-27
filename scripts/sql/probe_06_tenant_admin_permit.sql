-- PROBE 6 — an ordinary tenant ADMIN must still be permitted.
-- 21a46f50 is a pilot_user (platform_role='pilot_user', NOT super_admin) whose
-- org role in tenant 877bf5ec is 'admin'. The target file belongs to that org.
-- This proves the super_admin change did not break the pre-existing org path.
--
-- Real write, executed inside a transaction and ROLLED BACK.
begin;
select set_config('request.jwt.claim.sub', '21a46f50-6703-44b2-983d-35592bc4f690', true);
select set_config('request.jwt.claims', '{"sub":"21a46f50-6703-44b2-983d-35592bc4f690","role":"authenticated"}', true);
select
  public.is_super_admin()    as is_super_admin,
  public.my_tenant_id()::text as resolved_tenant,
  public.my_member_role()   as org_role;
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as result;
rollback;
