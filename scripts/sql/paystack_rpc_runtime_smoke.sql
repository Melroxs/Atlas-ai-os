-- Read-only runtime smoke: execute both re-created RPCs on their null paths.
-- Any parse/plan/body error would surface as an exception; correct behavior
-- is NULL (no auth context => membership/profile branches resolve to null).
select 'billing_get_state' as fn,
       (public.billing_get_state('00000000-0000-0000-0000-000000000000') is null)::text as returns_null_no_error
union all
select 'users_current_user',
       (public.users_current_user() is null)::text;
