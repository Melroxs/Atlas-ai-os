-- A NORMAL tenant admin's deletion must still be audited exactly as before.
begin;
select set_config('request.jwt.claim.sub', '21a46f50-6703-44b2-983d-35592bc4f690', true);
select set_config('request.jwt.claims', '{"sub":"21a46f50-6703-44b2-983d-35592bc4f690","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  '3150a8e8-dee7-4906-8a22-14fa333cf9ee', 'knowledge'
) as deleted;
select
  count(*)::int as audit_rows_written,
  max("actorType") as actor_type,
  max("tenantId"::text) as recorded_tenant,
  max("actorId"::text) as recorded_actor,
  max("metadata"->>'by_super_admin') as by_super_admin
from public.auditlogs
where "actionType" = 'archive_file_deleted';
rollback;
