-- ---------------------------------------------------------------------------
-- Atlas billing — atomic, watermark-guarded subscription upsert
--
-- WHY
--
-- The Stripe webhook processor persisted subscription state with a full-row
-- upsert. Stripe delivers several events for the same subscription
-- concurrently: a real TEST-mode checkout delivered
-- `customer.subscription.created`, `invoice.paid` and `invoice.finalized` with
-- an identical `event_at`, handled within the same second. Two handlers
-- therefore read the SAME pre-existing row, and the write that landed LAST won
-- even when its snapshot was the older one.
--
-- Observed consequence on the live test subscription: the subscription-state
-- handler carries no invoice information, landed last, and reset
-- `payment_status` to 'unknown' with `latest_invoice_id` /
-- `latest_invoice_at` NULL — discarding an invoice outcome Stripe had already
-- reported. The stored record was a function of arrival order.
--
-- WHAT
--
-- This function makes the write the serialization point. It locks the
-- organization's subscription row, then merges the incoming row over the stored
-- one, field family by field family, so a stale snapshot can never roll a newer
-- field backwards:
--
--   subscription family (status, plan, interval, price, customer, subscription
--     id, trial, period, cancel fields)
--       -> applied only when the incoming provider_event_at is >= the stored one
--   invoice family (payment_status, latest_invoice_*)
--       -> applied only when the incoming latest_invoice_at is >= the stored one,
--          and a known outcome is never replaced by 'unknown'
--   watermarks -> monotonic; provider_event_at / latest_invoice_at only ever
--     move forward
--
-- `supabase/functions/_shared/stripe-webhook.ts` mirrors these rules in the pure
-- `mergeSubscriptionWrite` function (covered by
-- stripe-subscription-merge.test.ts). Both layers exist on purpose: the
-- TypeScript layer keeps the row the processor reports identical to the row
-- stored, and THIS function is what makes the decision atomic between two
-- genuinely concurrent webhook invocations.
--
-- No column is added, dropped or re-typed; this migration is additive and
-- introduces no data change of its own.
--
-- DEPLOYMENT NOTE
-- The deployed project's migration ledger stops at 20260909b, so the trusted-
-- server primitives added by 20260918 (`atlas_is_trusted_server` /
-- `atlas_assert_trusted_server`) do NOT exist there yet. The authorization test
-- below is therefore inlined rather than called, using exactly the same
-- predicate as `atlas_is_trusted_server()`:
--     auth.uid() is null and coalesce(auth.role(), 'service_role') <> 'anon'
-- If 20260918 is ever applied, this function can be simplified to call
-- `atlas_assert_trusted_server()` with no change in behaviour.
-- ---------------------------------------------------------------------------

create or replace function public.billing_upsert_subscription(
  p_organization_id uuid,
  p_row jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.organization_subscriptions;
  v_sub_applied boolean;
  v_invoice_applied boolean;
  v_created boolean := false;
begin
  -- Server-only: the stripe-webhook Edge Function runs as service_role. The
  -- `anon` role and any real user session (auth.uid() present) are refused, so
  -- a browser can never rewrite its own subscription row. Same predicate as
  -- public.atlas_is_trusted_server(), inlined — see the deployment note above.
  if auth.uid() is not null or coalesce(auth.role(), 'service_role') = 'anon' then
    raise exception 'Access denied: trusted server connection required'
      using errcode = '42501';
  end if;

  if p_organization_id is null then
    raise exception 'billing_upsert_subscription: organization id is required'
      using errcode = '22004';
  end if;

  -- Serialize concurrent webhook deliveries for this organization. Everything
  -- below reads a row that cannot be changed by another handler until commit.
  select * into v_existing
  from public.organization_subscriptions
  where organization_id = p_organization_id
  for update;

  if not found then
    insert into public.organization_subscriptions (
      organization_id,
      billing_provider,
      provider_customer_id,
      provider_subscription_id,
      provider_price_id,
      internal_plan,
      billing_interval,
      status,
      payment_status,
      trial_start,
      trial_end,
      current_period_start,
      current_period_end,
      next_billed_at,
      cancel_at,
      cancel_at_period_end,
      canceled_at,
      latest_invoice_id,
      latest_invoice_at,
      provider_event_at,
      created_at,
      updated_at
    ) values (
      p_organization_id,
      coalesce(nullif(p_row->>'billing_provider', ''), 'stripe'),
      nullif(p_row->>'provider_customer_id', ''),
      nullif(p_row->>'provider_subscription_id', ''),
      nullif(p_row->>'provider_price_id', ''),
      nullif(p_row->>'internal_plan', ''),
      nullif(p_row->>'billing_interval', ''),
      coalesce(nullif(p_row->>'status', ''), 'unknown'),
      coalesce(nullif(p_row->>'payment_status', ''), 'unknown'),
      (p_row->>'trial_start')::bigint,
      (p_row->>'trial_end')::bigint,
      (p_row->>'current_period_start')::bigint,
      (p_row->>'current_period_end')::bigint,
      (p_row->>'next_billed_at')::bigint,
      (p_row->>'cancel_at')::bigint,
      coalesce((p_row->>'cancel_at_period_end')::boolean, false),
      (p_row->>'canceled_at')::bigint,
      nullif(p_row->>'latest_invoice_id', ''),
      (p_row->>'latest_invoice_at')::bigint,
      (p_row->>'provider_event_at')::bigint,
      coalesce((p_row->>'created_at')::bigint, (extract(epoch from now()) * 1000)::bigint),
      coalesce((p_row->>'updated_at')::bigint, (extract(epoch from now()) * 1000)::bigint)
    )
    returning * into v_existing;

    v_created := true;
    v_sub_applied := true;
    v_invoice_applied := true;
  else
    v_sub_applied :=
      coalesce((p_row->>'provider_event_at')::bigint, 0)
        >= coalesce(v_existing.provider_event_at, 0);
    v_invoice_applied :=
      coalesce((p_row->>'latest_invoice_at')::bigint, 0)
        >= coalesce(v_existing.latest_invoice_at, 0);

    update public.organization_subscriptions set
      -- Row identity is fixed: a later event can never re-point the record.
      billing_provider = v_existing.billing_provider,

      -- ---- subscription family ------------------------------------------
      provider_customer_id = case when v_sub_applied
        then coalesce(nullif(p_row->>'provider_customer_id', ''), v_existing.provider_customer_id)
        else v_existing.provider_customer_id end,
      provider_subscription_id = case when v_sub_applied
        then coalesce(nullif(p_row->>'provider_subscription_id', ''), v_existing.provider_subscription_id)
        else v_existing.provider_subscription_id end,
      provider_price_id = case when v_sub_applied
        then nullif(p_row->>'provider_price_id', '')
        else v_existing.provider_price_id end,
      internal_plan = case when v_sub_applied
        then nullif(p_row->>'internal_plan', '')
        else v_existing.internal_plan end,
      billing_interval = case when v_sub_applied
        then nullif(p_row->>'billing_interval', '')
        else v_existing.billing_interval end,
      status = case when v_sub_applied
        then coalesce(nullif(p_row->>'status', ''), 'unknown')
        else v_existing.status end,
      trial_start = case when v_sub_applied
        then (p_row->>'trial_start')::bigint else v_existing.trial_start end,
      trial_end = case when v_sub_applied
        then (p_row->>'trial_end')::bigint else v_existing.trial_end end,
      current_period_start = case when v_sub_applied
        then (p_row->>'current_period_start')::bigint else v_existing.current_period_start end,
      current_period_end = case when v_sub_applied
        then (p_row->>'current_period_end')::bigint else v_existing.current_period_end end,
      next_billed_at = case when v_sub_applied
        then (p_row->>'next_billed_at')::bigint else v_existing.next_billed_at end,
      cancel_at = case when v_sub_applied
        then (p_row->>'cancel_at')::bigint else v_existing.cancel_at end,
      cancel_at_period_end = case when v_sub_applied
        then coalesce((p_row->>'cancel_at_period_end')::boolean, false)
        else v_existing.cancel_at_period_end end,
      canceled_at = case when v_sub_applied
        then (p_row->>'canceled_at')::bigint else v_existing.canceled_at end,

      -- ---- invoice family ----------------------------------------------
      -- 'unknown' means "this event carried no invoice information"; it is
      -- never a statement that an invoice outcome was reversed, so it must not
      -- overwrite evidence Stripe already gave us.
      payment_status = case
        when v_invoice_applied
          and coalesce(nullif(p_row->>'payment_status', ''), 'unknown') <> 'unknown'
          then p_row->>'payment_status'
        when v_invoice_applied and v_existing.payment_status is null
          then 'unknown'
        else v_existing.payment_status end,
      -- A non-null invoice id is never dropped by a delivery that carries none.
      latest_invoice_id = case when v_invoice_applied
        then coalesce(nullif(p_row->>'latest_invoice_id', ''), v_existing.latest_invoice_id)
        else v_existing.latest_invoice_id end,

      -- ---- watermarks: monotonic ---------------------------------------
      provider_event_at = greatest(
        coalesce((p_row->>'provider_event_at')::bigint, 0),
        coalesce(v_existing.provider_event_at, 0)
      ),
      latest_invoice_at = greatest(
        coalesce((p_row->>'latest_invoice_at')::bigint, 0),
        coalesce(v_existing.latest_invoice_at, 0)
      ),

      created_at = v_existing.created_at,
      updated_at = greatest(
        coalesce((p_row->>'updated_at')::bigint, 0),
        v_existing.updated_at
      )
    where organization_id = p_organization_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'subscription_applied', coalesce(v_sub_applied, true),
    'invoice_applied', coalesce(v_invoice_applied, true),
    'status', v_existing.status,
    'payment_status', v_existing.payment_status
  );
end;
$$;

comment on function public.billing_upsert_subscription(uuid, jsonb) is
  'Atomic, watermark-guarded subscription write for the Stripe webhook: locks '
  'the organization row and merges the incoming snapshot so a stale concurrent '
  'delivery cannot roll newer billing fields backwards.';

-- Client roles must never write their own subscription row. The stripe-webhook
-- Edge Function runs as service_role and needs EXECUTE back after the PUBLIC
-- revoke (PUBLIC includes service_role in Postgres). The in-function
-- trusted-server check is the second, independent layer.
revoke execute on function public.billing_upsert_subscription(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.billing_upsert_subscription(uuid, jsonb)
  to service_role;
