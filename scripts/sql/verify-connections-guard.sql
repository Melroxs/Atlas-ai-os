-- Read-only verification that public.connections_list_catalog() REFUSES a
-- caller that has no active Atlas organization.
--
-- This is a real assertion, not a print. The unauthorized call is expected to
-- raise. If it ever succeeds, this script RAISES and the run fails loudly.
-- The previous version merely selected the literal string 'unreachable',
-- which cannot distinguish "the guard fired" from "the guard is gone".
--
-- The runner executes this batch with no JWT claims set, so
-- get_current_tenant_id() yields NULL and the guard must reject.
--
-- Read-only: the guard raises before any row is touched.
do $$
declare
  v_raised  boolean := false;
  v_state   text;
  v_msg     text;
begin
  begin
    perform public.connections_list_catalog();
  exception when others then
    v_raised := true;
    get stacked diagnostics v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  end;

  if not v_raised then
    raise exception
      'VERIFY FAILED: connections_list_catalog() SUCCEEDED for a caller with no active tenant - the authorization guard is not enforcing';
  end if;

  -- Assert the authorization SQLSTATE, not just the wording, so a cosmetic
  -- message change cannot mask a different failure mode.
  if v_state <> '42501' then
    raise exception
      'VERIFY FAILED: expected SQLSTATE 42501 (insufficient_privilege) from the tenant guard, got % (% )', v_state, v_msg;
  end if;
end $$;

-- Only reached when the guard behaved correctly.
select 'PASS' as result,
       'connections_list_catalog() refused a caller with no active Atlas organization'
         as assertion,
       42501 as expected_sqlstate;
