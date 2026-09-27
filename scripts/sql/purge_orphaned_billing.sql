-- Purge billing rows orphaned by ON DELETE SET NULL when their organization was deleted.
-- Only rows whose organization reference is NULL are removed; records still
-- pointing at the retained Test Company are preserved.
delete from public.stripe_customers where tenant_id is null;
delete from public.subscriptions where tenant_id is null;
delete from public.billing_audit_events where organization_id is null;
