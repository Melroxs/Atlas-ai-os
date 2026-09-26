-- ============================================================================
-- ATLAS — live webhook idempotency probe (READ-ONLY in effect: rolls itself back)
--
-- The Stripe webhook's "have I already processed this event?" guard is the
-- unique index processed_webhook_events_provider_event_idx on
-- (provider, provider_event_id). This inserts the same event id twice inside
-- one transaction and reports whether the second insert is rejected.
--
-- The DO block always ends in RAISE EXCEPTION, so nothing persists.
-- Result rides out in the error message as IDEM_OK / IDEM_FAIL.
-- ============================================================================

do $probe$
declare
  v_cols text;
  v_first uuid;
begin
  select string_agg(column_name || ':' || data_type || case when is_nullable = 'NO' then '!' else '' end, ', ' order by ordinal_position)
    into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'processed_webhook_events';

  insert into public.processed_webhook_events (provider, provider_event_id, event_type, result)
  values ('stripe', '__atlas_idem_probe__', 'probe', 'processed');

  begin
    insert into public.processed_webhook_events (provider, provider_event_id, event_type, result)
    values ('stripe', '__atlas_idem_probe__', 'probe', 'processed');
    -- Reaching here means the duplicate was ACCEPTED.
    raise exception 'IDEM_FAIL duplicate accepted; columns=[%]', v_cols;
  exception
    when unique_violation then
      raise exception 'IDEM_OK duplicate rejected by unique constraint; columns=[%]', v_cols;
  end;
end;
$probe$;
