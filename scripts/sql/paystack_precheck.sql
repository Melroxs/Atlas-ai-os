-- Read-only Paystack pre-implementation probe (no DDL, no DML).
-- Run with: bun scripts/run-db-sql.mjs scripts/sql/paystack_precheck.sql
-- Single statement: the Management API query endpoint returns the result of
-- the LAST statement only, so every probe is folded into one UNION ALL row set.
--
-- Purpose (Master Prompt 2, section 2): independently verify the LIVE billing
-- schema state before writing the Paystack migration, because the repository
-- verification documentation is known to drift from production.

select 'ledger_recent' as probe,
       string_agg(v, ', ' order by v desc) as value
from (select version as v from supabase_migrations.schema_migrations order by version desc limit 15) t
union all
select 'ledger_count',
       count(*)::text
from supabase_migrations.schema_migrations
union all
select 'org_subscriptions_constraints',
       coalesce(string_agg(conname || ' = ' || pg_get_constraintdef(oid), ' | ' order by conname), 'NONE')
from pg_constraint
where conrelid = 'public.organization_subscriptions'::regclass
  and contype = 'c'
union all
select 'billing_rpcs',
       coalesce(string_agg(p.proname || ':md5=' || md5(p.prosrc) || ':len=' || length(p.prosrc)
                           || ':secdef=' || p.prosecdef, ' | ' order by p.proname), 'NONE')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('billing_get_state', 'users_current_user',
                    'billing_apply_state', 'billing_upsert_subscription')
union all
select 'billing_tables',
       coalesce(string_agg(table_name, ', ' order by table_name), 'NONE')
from information_schema.tables
where table_schema = 'public'
  and (table_name ilike '%billing%'
       or table_name ilike '%subscription%'
       or table_name ilike '%webhook%'
       or table_name ilike '%transaction%'
       or table_name ilike '%complimentary%')
union all
select 'org_subscriptions_columns',
       string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns
where table_schema = 'public'
  and table_name = 'organization_subscriptions'
