-- 20260933 — Fix unquoted mixed-case identifiers in connections_list_catalog
--
-- BUG (live in production): `public.connections` stores two columns whose names
-- are mixed case and therefore REQUIRE double quotes:
--     "_creationTime"  bigint
--     "lastError"      text
-- An unquoted reference is folded to lower case by PostgreSQL, so both of these
-- resolved to columns that do not exist and the function raised on every call
-- for an authorized caller:
--     ERROR: column c.lasterror does not exist
--     HINT: Perhaps you meant to reference the column "c.lastError".
-- Every other mixed-case column in this same function was already correctly
-- quoted, which is why only these two slipped through.
--
-- SCOPE: the function body is otherwise byte-identical to the deployed version
--   (pre-change md5 98793a5d7fee89a86d7c56b25665922a, preserved in
--   scripts/sql/backups/20260933_pre_change_definitions.sql). Only the two
--   identifiers gain double quotes. No schema change, no column rename, no new
--   column, no behaviour change, and no authorization change: the
--   is-tenant-scoped guard and the existing EXECUTE grants are untouched and
--   are not restated here. Source migration 20260922 is fixed at source too.
--
-- VERIFIED: the function failed before with "column c.lasterror does not exist"
--   and succeeds after, as the super admin, through its real tenant-scoped
--   path. The whole probe runs inside a rolled-back transaction.
create or replace function public.connections_list_catalog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'Access denied: no active Atlas organization' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          '_id', c._id,
          'name', c.name,
          'provider', c.provider,
          'category', c.category,
          'status', c.status,
          'connectionType', c."connectionType",
          'capabilities', c.capabilities,
          'accountName', c."accountName",
          'accountEmail', c."accountEmail",
          'externalAccountId', c."externalAccountId",
          'scopes', c.scopes,
          'lastSyncAt', c."lastSyncAt",
          'lastAttemptedSyncAt', c."lastAttemptedSyncAt",
          'lastError', c."lastError",
          'healthStatus', c."healthStatus",
          'lastTestedAt', c."lastTestedAt",
          'lastTestSuccessAt', c."lastTestSuccessAt",
          'lastTestFailureAt', c."lastTestFailureAt",
          'lastTestLatencyMs', c."lastTestLatencyMs",
          'disconnectedAt', c."disconnectedAt"
        )
        order by c."_creationTime"
      )
      from public.connections c
      where c."tenantId" = v_tenant
        and c."disconnectedAt" is null
    ), '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', s.provider,
        'configured', s.configured,
        'missingEnvVars', to_jsonb(s.missing_env_vars),
        'checkedAt', s.checked_at
      ))
      from public.integration_provider_settings s
    ), '[]'::jsonb)
  );
end;
$$;
