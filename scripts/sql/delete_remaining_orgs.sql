-- Delete the remaining 22 organizations (everything except Test Company).
-- The id list is materialised into an array first so the loop is not reading
-- a table it is simultaneously deleting from.
do $$
declare
  v_ids uuid[];
  v_id uuid;
  v_ok int := 0;
begin
  select coalesce(array_agg(t."_id"), '{}'::uuid[])
  into v_ids
  from public.tenants t
  where t.name <> 'Test Company';

  raise notice 'deleting % organizations', coalesce(array_length(v_ids, 1), 0);

  foreach v_id in array v_ids loop
    perform public.admin_delete_organization(
      v_id,
      'Production cleanup: retain only melissa.o.rox@gmail.com',
      false,  -- member accounts are removed in a separate, explicit step
      true,    -- no live Stripe subscription exists (subscriptions = 0)
      '0e914537-e62b-4982-a49d-3056f0deb2b8'::uuid
    );
    v_ok := v_ok + 1;
  end loop;

  raise notice 'deleted % organizations', v_ok;
end;
$$;
