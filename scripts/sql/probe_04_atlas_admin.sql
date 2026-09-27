-- PROBE 4 — atlas_admin must receive NO deletion allowance.
-- No atlas_admin exists in production, so one is simulated: an ordinary
-- user (active, no membership) is temporarily promoted inside this
-- transaction. Nothing is committed — the transaction is rolled back, so no
-- profile is permanently altered and no user is created.
begin;
update public.profiles set platform_role = 'atlas_admin'
where _id = '03174c50-1577-416a-8236-dd9277e57eb9';
select set_config('request.jwt.claim.sub', '03174c50-1577-416a-8236-dd9277e57eb9', true);
select set_config('request.jwt.claims', '{"sub":"03174c50-1577-416a-8236-dd9277e57eb9","role":"authenticated"}', true);
-- Show the resolved context before the call, so the denial is attributable.
select
  public.is_super_admin()                as is_super_admin,
  public.my_tenant_id()::text           as resolved_tenant,
  public.my_member_role()               as org_role;
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as result;
rollback;
