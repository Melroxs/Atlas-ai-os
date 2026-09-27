-- PHASE 8 — audit record produced by a SUPER ADMIN deletion.
-- The call and the audit read happen in one transaction that is ROLLED BACK,
-- so nothing is persisted; the row is displayed only to prove its contents.
begin;
select set_config('request.jwt.claim.sub', '0e914537-e62b-4982-a49d-3056f0deb2b8', true);
select set_config('request.jwt.claims', '{"sub":"0e914537-e62b-4982-a49d-3056f0deb2b8","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  'e5c1000c-2494-4f4e-b377-69d086dfa4cc', 'knowledge'
) as deleted;
select
  a.action,
  a.target_type,
  a.target_id::text,
  (a.actor_id = '0e914537-e62b-4982-a49d-3056f0deb2b8') as actor_is_the_super_admin,
  a.details->>'by_super_admin' as by_super_admin,
  a.details->>'path' is not null as records_the_file_path,
  a.details->>'scope' as scope
from public.atlas_audit_log a
order by a.created_at desc
limit 1;
rollback;
