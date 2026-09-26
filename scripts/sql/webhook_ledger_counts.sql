-- Read-only: full ledger aggregates (compact enough to avoid output truncation).
select result, event_type, count(*) as n
from public.billing_audit_events
group by result, event_type
order by result, n desc;
