-- Read-only evidence check for the Atlas Stripe webhook.
-- Answers: has the production webhook EVER processed a real event, and does
-- any subscription / entitlement row exist?
-- SELECT-only. No writes, no DDL.

-- 1. Row counts across the billing surface.
select 'billing_audit_events' as table_name, count(*) as rows from public.billing_audit_events
union all select 'organization_subscriptions', count(*) from public.organization_subscriptions
union all select 'stripe_customers', count(*) from public.stripe_customers
union all select 'subscriptions', count(*) from public.subscriptions
order by 1;

-- 2. Every webhook event ever recorded, newest first.
select provider_event_id, event_type, result, note, provider_customer_id, provider_subscription_id, created_at
from public.billing_audit_events
order by created_at desc
limit 25;

-- 3. Subscription / entitlement state.
select organization_id, billing_provider, internal_plan, billing_interval, status,
       provider_customer_id, provider_subscription_id, provider_price_id,
       current_period_start, current_period_end
from public.organization_subscriptions
order by created_at desc
limit 25;
