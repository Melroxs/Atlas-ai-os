-- Read-only: constraints on the billing tables, so the Paystack migration can
-- extend them without conflicting with existing CHECK constraints.
select conrelid::regclass as table_name,
       conname,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.organization_subscriptions'::regclass,
                   'public.billing_audit_events'::regclass)
order by conrelid::regclass::text, conname;
