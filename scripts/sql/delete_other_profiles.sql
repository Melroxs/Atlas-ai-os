-- Delete every user profile except Melissa's.
-- Guard: the retained set must be exactly Melissa, and the deleted count must
-- be exactly 26. If reality disagrees with the approved scope, abort rather
-- than delete the wrong rows.
do $$
declare
  v_melissa constant uuid := '0e914537-e62b-4982-a49d-3056f0deb2b8';
  v_total int;
  v_keep int;
  v_del int;
begin
  select count(*) into v_total from public.profiles;
  select count(*) into v_keep from public.profiles where "_id" = v_melissa;
  v_del := v_total - v_keep;

  if v_keep <> 1 then
    raise exception 'ABORT: expected Melissa profile to exist exactly once, found %', v_keep;
  end if;

  if v_del <> 26 then
    raise exception 'ABORT: expected to delete 26 profiles, computed %', v_del;
  end if;

  -- Never touch Melissa, whatever else is true.
  delete from public.profiles where "_id" <> v_melissa;

  raise notice 'deleted % profiles, retained %', v_del, v_keep;
end;
$$;
