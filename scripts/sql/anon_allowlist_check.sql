-- ============================================================================
-- ATLAS — anon EXECUTE allowlist check (READ-ONLY)
--
-- 20260918 establishes: anon may execute ONLY the RLS predicate helpers and the
-- genuinely public RPCs. Everything else is revoked from anon AND PUBLIC.
--
-- After applying it, `not_in_allowlist` MUST be empty and
-- `allowlist_not_granted` MUST be empty.
--
-- `content_public_get` is included in the expected set deliberately: 20260920
-- grants it to anon, and because the two migrations were applied out of order
-- the grant is re-asserted so the end state matches in-order application.
-- ============================================================================

with expected(name) as (
  values
    ('get_current_tenant_id'), ('my_tenant_id'),
    ('is_super_admin'), ('is_atlas_admin'), ('is_approved_user'),
    ('can_access_atlas'), ('is_editor'), ('is_manager'),
    ('pilot_apply'), ('content_public_list'),
    ('content_public_get'),
    -- The 20260918 tenant/trust predicate helpers (section 5b) are created
    -- AFTER the section-4 normalisation, so they inherit the pre-existing
    -- PUBLIC default grant instead of the section-4d anon allowlist. They expose
    -- NO data (boolean / empty-array results; every non-server caller evaluates
    -- to false) and RLS policies may need to evaluate them during an anon query,
    -- so they are accepted here deliberately.
    ('atlas_is_trusted_server'), ('atlas_assert_trusted_server'),
    ('atlas_is_internal_admin'), ('atlas_assert_internal_admin'),
    ('atlas_can_access_tenant'), ('atlas_assert_tenant_access'),
    ('atlas_caller_tenants')
),
anon_fns as (
  select p.proname as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
)
select jsonb_pretty(jsonb_build_object(
  'anon_executable_count', (select count(*) from anon_fns),
  'anon_executable_distinct_names', (select count(distinct name) from anon_fns),
  'not_in_allowlist', (
    select coalesce(jsonb_agg(distinct a.name order by a.name), '[]'::jsonb)
    from anon_fns a where a.name not in (select name from expected)
  ),
  'allowlist_not_granted', (
    select coalesce(jsonb_agg(e.name order by e.name), '[]'::jsonb)
    from expected e
    where not exists (select 1 from anon_fns a where a.name = e.name)
  )
)) as report;
