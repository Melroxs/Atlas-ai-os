select jsonb_pretty(jsonb_build_object(
  'helpers', (
    select coalesce(jsonb_object_agg(p.proname, jsonb_build_object(
      'proacl', coalesce(array_to_string(p.proacl, ' | '), '(default: EXECUTE to PUBLIC)'),
      'public_grant', (p.proacl is null) or exists (
        select 1 from aclexplode(p.proacl) a where a.grantee = 0
      ),
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )), '{}'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'atlas_is_trusted_server','atlas_assert_trusted_server','atlas_is_internal_admin',
      'atlas_assert_internal_admin','atlas_can_access_tenant','atlas_assert_tenant_access',
      'atlas_caller_tenants'
    )
  ),
  'default_acl', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'role', pg_get_userbyid(d.defaclrole), 'type', d.defaclobjtype,
      'acl', array_to_string(d.defaclacl, ' | ')
    )), '[]'::jsonb)
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public'
  ),
  'anon_fns_full', (
    select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
)) as report;
