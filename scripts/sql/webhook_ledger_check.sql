-- Read-only: the Stripe webhook event ledger, newest first.
-- Evidence of real deliveries, their results, and duplicate handling.
select provider_event_id, event_type, result, note, created_at
from public.billing_audit_events
order by created_at desc
limit 40;
