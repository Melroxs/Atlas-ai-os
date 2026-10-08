-- Read-only existence check for the Paystack migration objects (no DDL, no DML).
select 'billing_transactions' as obj,
       coalesce(to_regclass('public.billing_transactions')::text, 'MISSING') as state
union all
select 'provider_subscription_token',
       coalesce(
         (select 'PRESENT' from information_schema.columns
          where table_schema = 'public'
            and table_name = 'organization_subscriptions'
            and column_name = 'provider_subscription_token'),
         'MISSING')
union all
select 'billing_provider_check',
       coalesce(
         (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'organization_subscriptions_billing_provider_check'),
         'MISSING');
