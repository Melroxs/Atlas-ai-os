-- PROBE 4b — what atlas_admin actually resolves to. No RPC call, so the
-- context is returned instead of aborting.
begin;
update public.profiles set platform_role = 'atlas_admin'
where _id = '03174c50-1577-416a-8236-dd9277e57eb9';
select set_config('request.jwt.claim.sub', '03174c50-1577-416a-8236-dd9277e57eb9', true);
select set_config('request.jwt.claims', '{"sub":"03174c50-1577-416a-8236-dd9277e57eb9","role":"authenticated"}', true);
select
  public.is_super_admin()      as is_super_admin,
  public.my_tenant_id()::text as resolved_tenant,
  public.my_member_role()     as org_role,
  'atlas_admin gets no allowance' as verdict;
rollback;
