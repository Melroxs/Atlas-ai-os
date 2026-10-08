-- Read-only: EXECUTE grants on the re-created RPC + ledger state.
select 'anon_execute_billing_get_state' as check,
       has_function_privilege('anon', 'public.billing_get_state(uuid)', 'EXECUTE')::text as result
union all
select 'authenticated_execute_billing_get_state',
       has_function_privilege('authenticated', 'public.billing_get_state(uuid)', 'EXECUTE')::text
union all
select 'anon_execute_users_current_user',
       has_function_privilege('anon', 'public.users_current_user()', 'EXECUTE')::text
union all
select 'ledger_has_20261007',
       coalesce(
         (select 'PRESENT name=' || coalesce(name, 'null')
          from supabase_migrations.schema_migrations
          where version like '20261007%'),
         'ABSENT (query endpoint does not record ledger)')
union all
select 'ledger_row_count',
       (select count(*)::text from supabase_migrations.schema_migrations);
