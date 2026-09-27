-- Does a SUPER ADMIN deletion now write an audit row?
-- Aggregate so a result is always returned. Rolled back afterwards.
begin;
select set_config('request.jwt.claim.sub', '0e914537-e62b-4982-a49d-3056f0deb2b8', true);
select set_config('request.jwt.claims', '{"sub":"0e914537-e62b-4982-a49d-3056f0deb2b8","role":"authenticated"}', true);
select public.ingestion_delete_archive_file(
  'e5c1000c-2494-4f4e-b377-69d086dfa4cc', 'knowledge'
) as deleted;
select
  count(*)::int as audit_rows_written,
  max("actorType") as actor_type,
  max("actionType") as action_type,
  max("targetType") as target_type,
  max("metadata"->>'by_super_admin') as by_super_admin,
  max("tenantId"::text) as recorded_tenant,
  max("actorId"::text) as recorded_actor
from public.auditlogs
where "actionType" = 'archive_file_deleted';
rollback;
