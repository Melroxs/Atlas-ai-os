-- Read-only verification of the DEPLOYED definition of
-- public.connections_list_catalog, so a missing function can never be
-- mistaken for success.
--
-- The previous version was a bare SELECT over pg_proc: if the function did not
-- exist it returned ZERO ROWS, which the SQL runner reports as a successful
-- HTTP 201 with an empty result set. Absent was indistinguishable from OK.
--
-- This version asserts inside a DO block and RAISES on any mismatch:
--   * the function exists, exactly once
--   * signature is ()                      -- no arguments
--   * returns jsonb
--   * language plpgsql
--   * security definer
--   * search_path is public
--   * prosrc md5 matches the committed repair body
--
-- If the function is ever legitimately changed, update EXPECTED_PROSRC_MD5 in
-- scripts/compare-rpc-source.mjs and here together, in the same commit.
--
-- EXPECTED_PROSRC_MD5 for the 20260933 repair (quoted mixed-case identifiers).
-- Cross-checked by scripts/compare-rpc-source.mjs against the migration body.
do $$
declare
  expected_md5 constant text := '7a92abe137a74dcebfc1aa894c0dcf9d';
  v_count int;
  v_args  text;
  v_ret   text;
  v_lang  text;
  v_secdef boolean;
  v_config text;
  v_md5   text;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'connections_list_catalog';

  if v_count <> 1 then
    raise exception
      'VERIFY FAILED: expected exactly 1 public.connections_list_catalog, found %', v_count;
  end if;

  select pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid),
         l.lanname,
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ','), 'none'),
         md5(p.prosrc)
    into v_args, v_ret, v_lang, v_secdef, v_config, v_md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language  l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'connections_list_catalog';

  if v_args <> '' then
    raise exception 'VERIFY FAILED: expected a no-argument signature, got (%)', v_args;
  end if;
  if v_ret <> 'jsonb' then
    raise exception 'VERIFY FAILED: expected return type jsonb, got %', v_ret;
  end if;
  if v_lang <> 'plpgsql' then
    raise exception 'VERIFY FAILED: expected language plpgsql, got %', v_lang;
  end if;
  if v_secdef is not true then
    raise exception 'VERIFY FAILED: expected SECURITY DEFINER, got false';
  end if;
  if v_config not like '%search_path=public%' then
    raise exception 'VERIFY FAILED: expected search_path=public, got %', v_config;
  end if;
  if v_md5 <> expected_md5 then
    raise exception
      'VERIFY FAILED: deployed prosrc md5 % does not match the committed repair body %', v_md5, expected_md5;
  end if;
end $$;

-- Only reached when every assertion held.
select 'PASS' as result,
       'deployed connections_list_catalog matches the committed repair definition' as assertion,
       md5(p.prosrc) as prosrc_md5,
       length(p.prosrc) as prosrc_bytes,
       pg_get_function_identity_arguments(p.oid) as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'connections_list_catalog';
