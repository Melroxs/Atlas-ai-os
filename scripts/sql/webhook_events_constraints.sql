-- READ-ONLY: the check/unique constraints on processed_webhook_events.
-- The UNIQUE constraint is the actual Stripe webhook idempotency mechanism;
-- the CHECK constraint tells the probe which `result` values are legal.
select coalesce(jsonb_agg(jsonb_build_object(
         'name', con.conname,
         'type', con.contype,
         'definition', pg_get_constraintdef(con.oid)
       ) order by con.conname), '[]'::jsonb) as constraints
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'processed_webhook_events';
