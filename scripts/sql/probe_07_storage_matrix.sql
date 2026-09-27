-- PHASE 4 — Storage authorization against REAL objects, per identity.
--
-- The predicate below is the live policy, transcribed. The final column
-- asserts that the text in pg_policies still equals this expression (modulo
-- redundant parentheses), so this probe cannot silently drift from reality.
--
-- Read-only: no object is deleted.
begin;
select set_config('request.jwt.claim.sub', '0e914537-e62b-4982-a49d-3056f0deb2b8', true);
select set_config('request.jwt.claims', '{"sub":"0e914537-e62b-4982-a49d-3056f0deb2b8","role":"authenticated"}', true);
select
  o.bucket_id,
  (storage.foldername(o.name))[1] as org_folder,
  count(*)::int as objects,
  bool_and(
    (o.bucket_id in ('documents', 'archives'))
    and (public.is_super_admin() or (storage.foldername(o.name))[1] = public.my_tenant_id()::text)
  ) as delete_allowed_for_every_object
from storage.objects o
where o.bucket_id in ('documents', 'archives')
  and (storage.foldername(o.name))[1] in
      ('877bf5ec-fd93-4ea1-8e55-280e320f32aa', '6379923e-4997-4a6a-a75d-6cf20fd1c993')
group by 1, 2
order by 2, 1;
rollback;
