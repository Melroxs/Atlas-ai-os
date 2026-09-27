-- None of the probe targets may appear as a persisted audit row.
select
  (select count(*) from public.auditlogs
     where "targetId" in ('e5c1000c-2494-4f4e-b377-69d086dfa4cc','3150a8e8-dee7-4906-8a22-14fa333cf9ee'))::int
    as probe_target_audit_rows,
  (select count(*) from public.auditlogs where "actionType" = 'archive_file_deleted')::int
    as per_file_deletion_audit_rows,
  (select count(*) from public.auditlogs where "metadata" ? 'by_super_admin')::int
    as rows_from_the_new_helper;
