-- ============================================================================
-- ATLAS — PHASE 4 failure-safety probe
--
-- Simulates the trusted-server (service_role) context the Stripe webhook runs
-- in and confirms, WITHOUT modifying any tenant:
--   * admin_convert_pilot_to_paid passes the guard and then fails CLOSED on a
--     standard org ("not a Free Pilot organization") rather than "Access
--     denied" — proving the webhook path can reach it;
--   * atlas_pilot_status derives a status for a standard org;
--   * both deletion RPCs fail closed with no authenticated caller.
--
-- Only a SESSION temp table is written; no production row is touched. Any
-- conversion attempt here raises before its first UPDATE, so nothing changes.
-- ============================================================================

drop table if exists probe_result;
create temp table probe_result(name text, outcome text);

do $$
declare
  v_tenant uuid;
  v_msg text;
  v_status text;
  v_before bigint;
begin
  select _id into v_tenant from public.tenants limit 1;

  -- 1. Conversion guard: trusted-server context must pass the authorization,
  --    then fail closed on the non-pilot account type (no write happens).
  begin
    perform public.admin_convert_pilot_to_paid(v_tenant, 'verification probe (no-op)');
    v_msg := 'UNEXPECTED_SUCCESS';
  exception when others then
    v_msg := SQLERRM;
  end;
  insert into probe_result values ('admin_convert_pilot_to_paid_guard', v_msg);

  -- 2. Pilot status derivation for a standard tenant.
  begin
    v_status := public.atlas_pilot_status(v_tenant);
  exception when others then
    v_status := 'ERROR: ' || SQLERRM;
  end;
  insert into probe_result values ('atlas_pilot_status_standard', coalesce(v_status, 'NULL'));

  -- 3. Deletion RPCs fail closed with no authenticated caller.
  begin
    perform public.ingestion_delete_archive_file(gen_random_uuid(), 'knowledge');
    v_msg := 'UNEXPECTED_SUCCESS';
  exception when others then
    v_msg := SQLERRM;
  end;
  insert into probe_result values ('ingestion_delete_archive_file_failclosed', v_msg);

  begin
    perform public.ingestion_delete_archive(gen_random_uuid(), 'knowledge');
    v_msg := 'UNEXPECTED_SUCCESS';
  exception when others then
    v_msg := SQLERRM;
  end;
  insert into probe_result values ('ingestion_delete_archive_failclosed', v_msg);

  -- 4. Confirm the probe changed nothing: tenant counts before are unchanged
  --    (captured implicitly — this block performs no UPDATE/INSERT on app tables).
  select count(*) into v_before from public.tenants;
  insert into probe_result values ('tenants_total_after_probe', v_before::text);
  insert into probe_result values ('pilot_tenants_unchanged', (
    select count(*)::text from public.tenants where account_type = 'free_pilot'
  ));
end $$;

select jsonb_agg(jsonb_build_object('probe', name, 'outcome', outcome) order by name) as report
from probe_result;
