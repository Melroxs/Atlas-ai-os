-- Baseline snapshot for the deletion reconciliation. Read-only.
select
  (select count(*) from public.tenants)::int                                  as tenants,
  (select count(*) from public.tenants where account_type = 'free_pilot')::int as pilot_tenants,
  (select count(*) from public.profiles)::int                                as profiles,
  (select count(*) from public.memberships)::int                             as memberships,
  (select count(*) from public.invites)::int                                 as invites,
  (select count(*) from public.user_provisions)::int                         as user_provisions,
  (select count(*) from public.archiveingestions)::int                       as archive_ingestions,
  (select count(*) from public.archivefiles)::int                            as archive_files,
  (select count(*) from public.documents)::int                               as documents,
  (select count(*) from public.subscriptions)::int                           as subscriptions,
  (select count(*) from public.stripe_customers)::int                        as stripe_customers,
  (select count(*) from public.complimentary_access)::int                    as complimentary_access,
  (select count(*) from public.atlas_audit_log)::int                         as audit_rows;
