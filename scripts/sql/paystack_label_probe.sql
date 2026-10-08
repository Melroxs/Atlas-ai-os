-- Read-only: confirm both re-created RPCs contain a provider-aware 'paystack' label.
select p.proname as fn,
       (pg_get_functiondef(p.oid) like '%''paystack''%')::text as mentions_paystack,
       (lower(pg_get_functiondef(p.oid)) like '%security definer%')::text as security_definer,
       (lower(pg_get_functiondef(p.oid)) like '%set search_path%')::text as search_path_set,
       (pg_get_functiondef(p.oid) like '%auth.uid()%')::text as uses_auth_uid,
       (lower(pg_get_functiondef(p.oid)) like '%revoke execute%')::text as functiondef_mentions_revoke
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('billing_get_state', 'users_current_user')
order by 1;
