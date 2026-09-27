-- Read-only verification that public.connections_list_catalog() WORKS for an
-- authorized caller through its real tenant-scoped path.
--
-- Properties:
--   * Read-only. The whole thing runs inside a transaction that is ROLLED BACK.
--   * Contains NO account address. The super-admin is selected by
--     platform_role, so no personal identifier is embedded in this file.
--   * Fails loudly. Every unmet expectation RAISEs, so the runner reports an
--     error instead of a quiet "no rows". Reaching the final SELECT means
--     every assertion held.
--   * The authorization guard is verified separately, by
--     verify-connections-guard.sql. This file asserts the SUCCESS path only.
begin;

do $$
declare
  v_sub   uuid;
  v_res   jsonb;
  v_conns int;
  v_prov  int;
begin
  select p._id into v_sub
  from public.profiles p
  where p.platform_role = 'super_admin'
  order by p._id
  limit 1;

  if v_sub is null then
    raise exception
      'VERIFY FAILED: no profile with platform_role=super_admin exists, so an authorized caller cannot be simulated';
  end if;

  perform set_config('request.jwt.claim.sub', v_sub::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_sub::text, 'role', 'authenticated')::text, true);

  -- The tenant guard must pass for this caller; if it does not, the failure
  -- below is about authorization, not about the function body.
  begin
    v_res := public.connections_list_catalog();
  exception when others then
    raise exception
      'VERIFY FAILED: connections_list_catalog() raised for an authorized caller: %', sqlerrm;
  end;

  if v_res is null or jsonb_typeof(v_res) <> 'object' then
    raise exception
      'VERIFY FAILED: expected a jsonb object, got %', coalesce(jsonb_typeof(v_res), 'null');
  end if;

  if not (v_res ? 'connections') or not (v_res ? 'providers') then
    raise exception
      'VERIFY FAILED: result is missing the connections and/or providers key: %', left(v_res::text, 200);
  end if;

  v_conns := jsonb_array_length(coalesce(v_res -> 'connections', '[]'::jsonb));
  v_prov  := jsonb_array_length(coalesce(v_res -> 'providers',   '[]'::jsonb));
end $$;

-- Only reached when every assertion above held.
select 'PASS' as result,
       'connections_list_catalog() returned a well-formed object for an authorized caller'
         as assertion,
       (select jsonb_array_length(coalesce(r->'connections','[]'::jsonb))
          from (select public.connections_list_catalog() as r) s) as connections_returned,
       (select jsonb_array_length(coalesce(r->'providers','[]'::jsonb))
          from (select public.connections_list_catalog() as r) s) as providers_returned;

rollback;
