-- Read-only pre-apply baseline (no DDL, no DML): md5 of pg_get_functiondef
-- for every RPC the Paystack migration touches or must NOT touch.
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
       md5(pg_get_functiondef(p.oid)) as digest
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'billing_get_state',
    'users_current_user',
    'billing_apply_state',
    'billing_upsert_subscription'
  )
order by 1;
