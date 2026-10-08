-- Read-only post-apply verification for 20261007_atlas_paystack_billing.sql.
-- 1) constraint widened  2) token column  3) billing_transactions shape
select 'constraint' as check,
       coalesce(
         (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'organization_subscriptions_billing_provider_check'),
         'MISSING') as result
union all
select 'token_column',
       coalesce(
         (select 'PRESENT data_type=' || data_type from information_schema.columns
          where table_schema = 'public'
            and table_name = 'organization_subscriptions'
            and column_name = 'provider_subscription_token'),
         'MISSING')
union all
select 'table_exists',
       coalesce(to_regclass('public.billing_transactions')::text, 'MISSING')
union all
select 'columns',
       (select string_agg(column_name, ',' order by ordinal_position)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'billing_transactions')
union all
select 'unique_index',
       coalesce(
         (select indexdef from pg_indexes
          where schemaname = 'public'
            and tablename = 'billing_transactions'
            and indexname = 'billing_transactions_provider_reference_idx'),
         'MISSING')
union all
select 'rls_enabled',
       (select relrowsecurity::text from pg_class
        where oid = 'public.billing_transactions'::regclass)
union all
select 'rls_policies_count',
       (select count(*)::text from pg_policies
        where schemaname = 'public' and tablename = 'billing_transactions')
union all
select 'grants_authenticated_select',
       has_table_privilege('authenticated', 'public.billing_transactions', 'SELECT')::text
union all
select 'grants_anon_select',
       has_table_privilege('anon', 'public.billing_transactions', 'SELECT')::text;
