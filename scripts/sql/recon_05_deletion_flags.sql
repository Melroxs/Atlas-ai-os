-- Precise pre-change state of the two graded deletion RPCs.
select
  p.proname,
  p.prosecdef as security_definer,
  (p.prosrc like '%is_super_admin%')            as allows_super_admin,
  (p.prosrc like '%my_tenant_id()%')            as uses_my_tenant_id,
  (p.prosrc like '%owner%, %admin%, %manager%') as org_role_gate,
  (p.prosrc like '%by_super_admin%')            as records_by_super_admin,
  -- the per-file UPDATE scoped to the tenant (not id-only)
  (p.prosrc like '%where _id = p_fileId and "tenantId" = v_tenant%') as file_update_tenant_scoped
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ingestion_delete_archive_file', 'ingestion_delete_archive')
order by p.proname;
