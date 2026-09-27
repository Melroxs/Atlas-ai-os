-- READ-ONLY: show the exact context of any 'stripe' mention inside
-- admin_create_pilot_organization, and prove it performs no Stripe WRITE.
with f as (
  select pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'admin_create_pilot_organization'
)
select jsonb_build_object(
  'stripe_context', (
    select substring(def from greatest(position('stripe' in lower(def)) - 90, 1) for 220)
    from f
  ),
  'mentions_insert_columns', (
    select substring(def from position('insert into public.tenants' in def) for 200)
    from f
  ),
  'any_stripe_write', (
    select (position('insert into public.organization_subscriptions' in def) > 0)
       or (position('update public.organization_subscriptions' in def) > 0)
       or (position('stripe' in lower(def)) > 0
           and position('--' in substring(def from greatest(position('stripe' in lower(def)) - 60, 1) for 120)) = 0
           and position('no ' in lower(substring(def from greatest(position('stripe' in lower(def)) - 90, 1) for 220))) = 0)
    from f
  )
) as report;
