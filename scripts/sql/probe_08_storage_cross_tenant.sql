-- Storage authorization as a NORMAL tenant user (owner of tenant 6379923e).
-- Must be allowed on their OWN org's objects and denied on another org's.
begin;
select set_config('request.jwt.claim.sub', '290e68ab-c60c-4da5-ae05-3ceacc1cfd39', true);
select set_config('request.jwt.claims', '{"sub":"290e68ab-c60c-4da5-ae05-3ceacc1cfd39","role":"authenticated"}', true);
select
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
group by 1, 2
order by 1, 2;
rollback;
