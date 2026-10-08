-- Read-only post-apply RPC digests + provider-aware label presence check.
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
       md5(pg_get_functiondef(p.oid)) as digest,
       (pg_get_functiondef(p.oid) like '%billing_provider = ''paystack''%')::text as has_paystack_label
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
