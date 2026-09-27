-- Phase 11 — nothing was created: no pilot, no user, no invite, no Stripe
-- record, and no trace of any probe.
select
  (select count(*) from public.tenants)::int                                   as tenants,
  (select count(*) from public.tenants where account_type = 'free_pilot')::int  as pilot_tenants,
  (select count(*) from public.tenants where account_type is null)::int         as tenants_null_type,
  (select count(*) from public.profiles)::int                                  as profiles,
  (select count(*) from public.memberships)::int                               as memberships,
  (select count(*) from public.invites)::int                                   as invites,
  (select count(*) from public.stripe_customers)::int                          as stripe_customers,
  (select count(*) from public.subscriptions)::int                             as subscriptions,
  (select count(*) from public.complimentary_access)::int                      as complimentary_access,
  (select count(*) from public.processed_webhook_events)::int                  as webhook_events,
  -- probe residue: the temporary atlas_admin promotion and any probe audit rows
  (select count(*) from public.profiles where platform_role = 'atlas_admin')::int as atlas_admins,
  (select count(*) from public.auditlogs where "metadata" ? 'by_super_admin')::int as helper_audit_rows,
  (select count(*) from public.auditlogs
     where "actionType" = 'archive_file_deleted')::int                          as per_file_deletion_audits;
