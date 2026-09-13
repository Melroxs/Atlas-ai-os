-- ===========================================================================
-- Atlas — Paddle Billing hardening
--
-- Two fixes on top of 20260907000000_paddle_billing.sql:
--
--   1. Client-side entitlement bypass: the Stripe-era RPCs
--      tenants_activate_after_payment / tenants_handle_payment_failure /
--      tenants_handle_subscription_cancelled are SECURITY DEFINER functions
--      that flip tenant.billing_state, and they were executable by any
--      authenticated client (default PUBLIC EXECUTE). Any user could call
--      tenants_activate_after_payment('<their tenant>') and mark their own
--      organization billing_state='active' without paying. Revoke execution
--      from PUBLIC/anon/authenticated so only server-side code (the legacy
--      stripe-webhook Edge Function, which runs as service_role) can call
--      them.
--
--   2. Event-ordering column: organization_subscriptions gains
--      provider_event_at so the webhook can refuse to let an older Paddle
--      event overwrite newer subscription state (defensive ADD COLUMN in case
--      a pre-fix copy of the base migration was ever applied).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke client-side billing-state flippers (legacy Stripe-era RPCs)
-- ---------------------------------------------------------------------------
-- These were created SECURITY DEFINER with default PUBLIC EXECUTE. Paddle is
-- now the billing source of truth and only the verified paddle-webhook (via
-- billing_apply_state) may transition tenant.billing_state. The legacy
-- stripe-webhook Edge Function still uses these server-side, so service_role
-- keeps EXECUTE after the PUBLIC revoke.

revoke execute on function public.tenants_activate_after_payment(uuid) from public, anon, authenticated;
revoke execute on function public.tenants_handle_payment_failure(uuid) from public, anon, authenticated;
revoke execute on function public.tenants_handle_subscription_cancelled(uuid) from public, anon, authenticated;

grant execute on function public.tenants_activate_after_payment(uuid) to service_role;
grant execute on function public.tenants_handle_payment_failure(uuid) to service_role;
grant execute on function public.tenants_handle_subscription_cancelled(uuid) to service_role;

-- Belt-and-braces for billing_apply_state if a pre-fix copy of the base
-- migration was ever applied without the service_role grant.
revoke execute on function public.billing_apply_state(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_apply_state(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Event-ordering column (defensive)
-- ---------------------------------------------------------------------------

alter table public.organization_subscriptions
  add column if not exists provider_event_at bigint;