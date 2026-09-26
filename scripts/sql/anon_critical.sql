-- READ-ONLY: minimal, targeted. Does `anon` have EXECUTE on the
-- billing-state writers and the cross-tenant credential reader?
select coalesce(jsonb_object_agg(t.n, jsonb_build_object(
  'exists', p.oid is not null,
  'anon_can_execute', p.oid is not null and has_function_privilege('anon', p.oid, 'EXECUTE'),
  'authenticated_can_execute', p.oid is not null and has_function_privilege('authenticated', p.oid, 'EXECUTE')
) order by t.n), '{}'::jsonb) as report
from (values
  ('tenants_activate_after_payment'),
  ('tenants_handle_payment_failure'),
  ('tenants_handle_subscription_cancelled'),
  ('email_accounts_get_credentials'),
  ('billing_apply_state'),
  ('billing_get_state'),
  ('billing_upsert_subscription'),
  ('admin_update_user_role')
) as t(n)
left join pg_proc p on p.proname = t.n
left join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public';
