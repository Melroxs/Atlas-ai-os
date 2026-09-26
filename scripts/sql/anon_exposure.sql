-- READ-ONLY: compact list of privileged RPCs still executable by `anon`.
select jsonb_build_object(
  'dangerous_billing_and_credentials', (
    select coalesce(jsonb_object_agg(p.proname, has_function_privilege('anon', p.oid, 'EXECUTE')), '{}'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'tenants_activate_after_payment',
        'tenants_handle_payment_failure',
        'tenants_handle_subscription_cancelled',
        'email_accounts_get_credentials',
        'billing_apply_state',
        'billing_upsert_subscription',
        'handle_new_user',
        'industry_ingest_corpus',
        'jobs_create_job',
        'jobs_dequeue'
      )
  ),
  'anon_executable_count', (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon_executable_names', (
    select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
) as report;
