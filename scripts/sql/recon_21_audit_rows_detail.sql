select
  "actionType",
  "actorType",
  "actorId"::text,
  "tenantId"::text,
  "targetId"::text,
  "metadata"->>'by_super_admin' as by_super_admin,
  "metadata"->>'scope' as scope
from public.auditlogs
where "actionType" in ('archive_file_deleted', 'archive_deleted')
order by "targetId";
