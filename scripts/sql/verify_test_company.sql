-- Verify Test Company state after claim cleanup.
select
  (select count(*) from public.tenants) as tenants,
  (select count(*) from public.invites) as invites,
  (select count(*) from public.memberships) as memberships,
  (select string_agg(p.email, ', ') from public.memberships m
     join public.profiles p on p."_id" = m."userId") as members,
  (select count(*) from public.insuranceclaims) as claims,
  (select count(*) from public.claimcandidates) as candidates,
  (select count(*) from public.claimfindings) as findings,
  (select count(*) from public.claimsupplements) as supplements,
  (select count(*) from public.archiveingestions) as ingestions,
  (select count(*) from public.archivefiles) as archivefiles,
  (select count(*) from public.documents) as documents,
  (select count(*) from public.documentchunks) as chunks;
