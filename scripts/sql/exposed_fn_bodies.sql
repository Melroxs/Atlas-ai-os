-- READ-ONLY: do the two functions still executable by `anon` guard themselves
-- internally? This reads the LIVE definition (pg_get_functiondef), not the
-- migration text, so it reflects what is actually deployed.
select jsonb_pretty(jsonb_build_object(
  'email_accounts_get_credentials', (
    select jsonb_build_object(
      'security_definer', p.prosecdef,
      'auth_uid_referenced', position('auth.uid()' in pg_get_functiondef(p.oid)) > 0,
      'tenant_guard_referenced',
        position('atlas_can_access_tenant' in pg_get_functiondef(p.oid)) > 0
        or position('atlas_is_internal_admin' in pg_get_functiondef(p.oid)) > 0,
      'first_700_chars', left(replace(pg_get_functiondef(p.oid), chr(10), ' '), 700)
    )
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'email_accounts_get_credentials'
    limit 1
  ),
  'admin_update_user_role', (
    select jsonb_build_object(
      'security_definer', p.prosecdef,
      'auth_uid_referenced', position('auth.uid()' in pg_get_functiondef(p.oid)) > 0,
      'admin_guard_referenced',
        position('atlas_is_internal_admin' in pg_get_functiondef(p.oid)) > 0
        or position('super_admin' in pg_get_functiondef(p.oid)) > 0,
      'first_700_chars', left(replace(pg_get_functiondef(p.oid), chr(10), ' '), 700)
    )
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_update_user_role'
    limit 1
  )
)) as report;
