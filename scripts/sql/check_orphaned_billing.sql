-- Inspect orphaned billing rows (tenant reference set to NULL by ON DELETE SET NULL).
select
  (select count(*) from public.stripe_customers) as stripe_customers_total,
  (select count(*) from public.stripe_customers where tenant_id is null) as stripe_cust_orphaned,
  (select count(*) from public.subscriptions) as subs_total,
  (select count(*) from public.subscriptions where tenant_id is null) as subs_orphaned,
  (select count(*) from public.billing_audit_events) as billing_audit_total,
  (select count(*) from public.billing_audit_events where organization_id is null) as billing_audit_orphaned;
