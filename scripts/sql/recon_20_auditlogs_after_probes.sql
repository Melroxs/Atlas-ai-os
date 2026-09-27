select count(*)::int as auditlogs_rows_after_all_probes,
       count(*) filter (where "actionType" in ('archive_file_deleted','archive_deleted'))::int
         as deletion_audit_rows_persisted
from public.auditlogs;
