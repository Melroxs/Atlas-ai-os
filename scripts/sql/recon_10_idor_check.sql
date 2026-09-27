-- IDOR check: the RPCs must accept NO tenant parameter at all, and must
-- resolve a super admin's organization from the TARGET ROW, never the request.
select
  p.proname,
  p.pronargs as arg_count,
  (pg_get_function_arguments(p.oid) ilike '%tenant%') as accepts_tenant_arg,
  (p.prosrc like '%p_tenant%')                        as body_reads_p_tenant,
  -- super-admin branch resolves from the target row
  (p.prosrc like '%if v_super then%select f."tenantId" into v_tenant%')  as sa_branch_file,
  (p.prosrc like '%if v_super then%select a."tenantId" into v_tenant%')  as sa_branch_archive,
  -- everyone else is still scoped by their own membership
  (p.prosrc like '%else%v_tenant := public.my_tenant_id()%')           as else_uses_my_tenant_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ingestion_delete_archive_file', 'ingestion_delete_archive')
order by p.proname;
