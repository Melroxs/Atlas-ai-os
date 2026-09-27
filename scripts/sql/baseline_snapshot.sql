-- Pre-deletion baseline snapshot.
select
  (select count(*) from public.tenants) as tenants,
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.memberships) as memberships,
  (select count(*) from public.invites) as invites,
  (select count(*) from public.documents) as documents,
  (select count(*) from public.archivefiles) as archivefiles,
  (select count(*) from public.archiveingestions) as ingestions,
  (select count(*) from public.documentchunks) as chunks,
  (select count(*) from public.insuranceclaims) as claims,
  (select count(*) from public.claimcandidates) as candidates,
  (select count(*) from public.claimfindings) as findings,
  (select count(*) from public.auditlogs) as auditlogs,
  (select count(*) from public.stripe_customers) as stripe_customers,
  (select count(*) from public.subscriptions) as subscriptions,
  (select count(*) from auth.users) as auth_users;
