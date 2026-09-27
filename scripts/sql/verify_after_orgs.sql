-- Post-org-delete verification.
select
  (select count(*) from public.tenants) as tenants,
  (select string_agg(name, ', ' order by name) from public.tenants) as tenant_names,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.memberships) as memberships,
  (select count(*) from public.documents) as documents,
  (select count(*) from public.archivefiles) as archivefiles,
  (select count(*) from public.archiveingestions) as ingestions,
  (select count(*) from public.insuranceclaims) as claims,
  (select count(*) from public.claimcandidates) as candidates,
  (select count(*) from public.claimfindings) as findings,
  (select count(*) from public.auditlogs) as auditlogs,
  (select count(*) from public.stripe_customers) as stripe_customers,
  (select count(*) from public.atlas_audit_log) as atlas_audit_log;
