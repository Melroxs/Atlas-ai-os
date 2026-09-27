-- Storage authorization as the tenant ADMIN of 877bf5ec (pilot_user platform
-- role, so NOT a super_admin — the super_admin branch must not be involved).
--
-- Expected: allowed on 877bf5ec's own bytes, denied on 6379923e's bytes.
-- Read-only: no object is deleted.
begin;
select set_config('request.jwt.claim.sub', '21a46f50-6703-44b2-983d-35592bc4f690', true);
select set_config('request.jwt.claims', '{"sub":"21a46f50-6703-44b2-983d-35592bc4f690","role":"authenticated"}', true);
select
  public.is_super_admin()      as is_super_admin,
  public.my_tenant_id()::text  as resolved_tenant,
  (storage.foldername(o.name))[1] as org_folder,
  o.bucket_id,
  count(*)::int as objects,
  bool_and(
    (o.bucket_id in ('documents', 'archives'))
    and (public.is_super_admin() or (storage.foldername(o.name))[1] = public.my_tenant_id()::text)
  ) as delete_allowed
from storage.objects o
where o.bucket_id in ('documents', 'archives')
  and (storage.foldername(o.name))[1] in
      ('877bf5ec-fd93-4ea1-8e55-280e320f32aa', '6379923e-4997-4a6a-a75d-6cf20fd1c993')
group by 2, 3, 4
order by 3, 4;
rollback;
