-- READ-ONLY: prove the idempotency probe left nothing behind, and record the
-- blast radius of the anon-exposed credential reader.
select jsonb_build_object(
  'probe_rows_left', (
    select count(*) from public.processed_webhook_events
    where provider_event_id = '__atlas_idem_probe__'
  ),
  'total_processed_webhook_events', (select count(*) from public.processed_webhook_events),
  'total_organization_subscriptions', (select count(*) from public.organization_subscriptions),
  'email_accounts_rows', (select count(*) from public.email_accounts)
) as report;
