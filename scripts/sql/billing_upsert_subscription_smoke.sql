-- ============================================================================
-- ATLAS — billing_upsert_subscription live behavioral smoke test
--
-- Runs the REAL SQL RPC on the linked Supabase project through the Management
-- API /database/query endpoint, which wraps the whole script in ONE implicit
-- transaction. The final RAISE EXCEPTION rolls every write back, so no test
-- data is persisted and no production row is touched.
--
-- Scenarios (mirror stripe-subscription-merge.test.ts):
--   A  insert path (no existing row)
--   B  newer full event applied
--   C  stale/equal event must not roll any field backwards (the D1 race)
--   D  invoice event (dense production row: subscription re-read from Stripe,
--      providerEventAt carried forward, invoice family advanced)
--   E  subscription event after resume (fields absent from the Stripe object
--      are carried from existing by reconcile — no NULL overwrite)
--   F  reverse-order replay (A then B vs B then A) → equivalent final state
--   G  anon refused (EXECUTE revoked + in-function guard)
--   H  authenticated (with a JWT sub) refused
--
-- Result rides out in the exception message as SMOKE_OK <summary> (or
-- SMOKE_FAIL ... when an assertion is violated).
-- ============================================================================

do $test$
declare
  v_org_a uuid;
  v_org_b uuid;
  v_res   jsonb;
  v_row   public.organization_subscriptions;
  v_row_b public.organization_subscriptions;
  v_r     jsonb := '[]'::jsonb;
  v_pass  boolean := true;
begin
  -- ------------------------------------------------------------------ setup
  insert into public.tenants (name, slug, status)
  values ('__atlas_rpc_smoke__', '__atlas_rpc_smoke_a_' || md5(random()::text), 'active')
  returning _id into v_org_a;

  insert into public.tenants (name, slug, status)
  values ('__atlas_rpc_smoke__', '__atlas_rpc_smoke_b_' || md5(random()::text), 'active')
  returning _id into v_org_b;

  -- ------------------------------------------------------------------ A
  select public.billing_upsert_subscription(v_org_a, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_B',
    'provider_subscription_id','sub_A2',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'active',
    'payment_status',          'paid',
    'latest_invoice_id',       'in_1001',
    'latest_invoice_at',       1000,
    'provider_event_at',       1000,
    'current_period_start',    900,
    'current_period_end',      2592000900::bigint,
    'cancel_at_period_end',    false
  )) into v_res;

  v_pass := v_pass and (v_res->>'ok') = 'true' and (v_res->>'created') = 'true';
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','A_insert','created',v_res->>'created','status',v_res->>'status','payment',v_res->>'payment_status'));

  -- ------------------------------------------------------------------ B
  -- Newer event (2000): past_due, new invoice, cancel scheduled.
  select public.billing_upsert_subscription(v_org_a, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_B',
    'provider_subscription_id','sub_A2',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'past_due',
    'payment_status',          'paid',
    'latest_invoice_id',       'in_1002',
    'latest_invoice_at',       2000,
    'provider_event_at',       2000,
    'cancel_at',               2000,
    'cancel_at_period_end',    true
  )) into v_res;

  select * into v_row from public.organization_subscriptions where organization_id = v_org_a;
  v_pass := v_pass and v_row.status = 'past_due' and v_row.latest_invoice_id = 'in_1002'
                     and v_row.payment_status = 'paid' and v_row.cancel_at_period_end is true;
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','B_newer_full','status',v_row.status,'invoice',v_row.latest_invoice_id,
    'payment',v_row.payment_status,'cape',v_row.cancel_at_period_end));

  -- ------------------------------------------------------------------ C
  -- STALE snapshot (event_at 1000 < 2000) with payment 'unknown' and no
  -- invoice id: exactly the D1 race — must change NOTHING.
  select public.billing_upsert_subscription(v_org_a, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_subscription_id','sub_A2',
    'status',                  'active',
    'payment_status',          'unknown',
    'latest_invoice_id',       '',
    'latest_invoice_at',       1000,
    'provider_event_at',       1000
  )) into v_res;

  select * into v_row from public.organization_subscriptions where organization_id = v_org_a;
  v_pass := v_pass and (v_res->>'subscription_applied') = 'false'
                     and (v_res->>'invoice_applied') = 'false'
                     and v_row.status = 'past_due'
                     and v_row.payment_status = 'paid'
                     and v_row.latest_invoice_id = 'in_1002'
                     and v_row.provider_event_at = 2000;
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','C_stale_ignored','sub_applied',v_res->>'subscription_applied',
    'inv_applied',v_res->>'invoice_applied','status',v_row.status,
    'payment',v_row.payment_status,'invoice',v_row.latest_invoice_id));

  -- ------------------------------------------------------------------ D
  -- Newer invoice event (3000): production re-reads the subscription from
  -- Stripe and writes a DENSE row — subscription family carried from the
  -- re-read state, providerEventAt carried forward (invoice events do not
  -- advance it), invoice family advanced.
  select public.billing_upsert_subscription(v_org_a, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_A',
    'provider_subscription_id','sub_A2',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'past_due',
    'payment_status',          'failed',
    'latest_invoice_id',       'in_1003',
    'latest_invoice_at',       3000,
    'provider_event_at',       2000,
    'current_period_start',    900,
    'current_period_end',      2592000900::bigint,
    'cancel_at',               2000,
    'cancel_at_period_end',    true
  )) into v_res;

  select * into v_row from public.organization_subscriptions where organization_id = v_org_a;
  v_pass := v_pass and v_row.payment_status = 'failed' and v_row.latest_invoice_id = 'in_1003'
                     and v_row.status = 'past_due' and v_row.cancel_at_period_end is true
                     and v_row.current_period_end = 2592000900 and v_row.provider_event_at = 2000
                     and v_row.latest_invoice_at = 3000;
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','D_invoice_family','payment',v_row.payment_status,'invoice',v_row.latest_invoice_id,
    'status',v_row.status,'cape',v_row.cancel_at_period_end));

  -- ------------------------------------------------------------------ E
  -- Subscription event (4000) after the customer resumed: the Stripe object
  -- carries no period fields, so production reconcile carries the existing
  -- periods forward; status active, cancel_at cleared, payment status carried
  -- (a subscription event never invents an invoice outcome).
  select public.billing_upsert_subscription(v_org_a, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_A',
    'provider_subscription_id','sub_A2',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'active',
    'payment_status',          'failed',
    'latest_invoice_id',       'in_1003',
    'latest_invoice_at',       3000,
    'provider_event_at',       4000,
    'current_period_start',    900,
    'current_period_end',      2592000900::bigint,
    'cancel_at',               null,
    'cancel_at_period_end',    false
  )) into v_res;

  select * into v_row from public.organization_subscriptions where organization_id = v_org_a;
  v_pass := v_pass and v_row.status = 'active' and v_row.cancel_at_period_end is false
                     and v_row.cancel_at is null and v_row.current_period_start = 900
                     and v_row.current_period_end = 2592000900 and v_row.payment_status = 'failed';
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','E_resume_carries_state','status',v_row.status,'cape',v_row.cancel_at_period_end,
    'period_end',v_row.current_period_end,'payment',v_row.payment_status));

  -- ------------------------------------------------------------------ F
  -- Reverse-order equivalence on a second org: replay A(1000) then B(2000)
  -- and B(2000) then A(1000); final state must be identical.
  select public.billing_upsert_subscription(v_org_b, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_B',
    'provider_subscription_id','sub_B',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'past_due',
    'payment_status',          'paid',
    'latest_invoice_id',       'in_1002',
    'latest_invoice_at',       2000,
    'provider_event_at',       2000,
    'cancel_at',               2000,
    'cancel_at_period_end',    true
  )) into v_res; -- B first
  select public.billing_upsert_subscription(v_org_b, jsonb_build_object(
    'billing_provider',        'stripe',
    'provider_customer_id',    'cus_B',
    'provider_subscription_id','sub_B',
    'provider_price_id',       'price_growth_m',
    'internal_plan',           'ATLAS_GROWTH',
    'billing_interval',        'monthly',
    'status',                  'active',
    'payment_status',          'paid',
    'latest_invoice_id',       'in_1001',
    'latest_invoice_at',       1000,
    'provider_event_at',       1000,
    'current_period_start',    900,
    'current_period_end',      2592000900::bigint,
    'cancel_at_period_end',    false
  )) into v_res; -- then stale A

  select * into v_row_b from public.organization_subscriptions where organization_id = v_org_b;
  -- B-org final must equal the A-org state after A→B→(stale C at 1000):
  v_pass := v_pass and v_row_b.status = 'past_due'
                     and v_row_b.latest_invoice_id = 'in_1002'
                     and v_row_b.cancel_at_period_end is true
                     and v_row_b.provider_event_at = 2000
                     and v_row_b.provider_price_id = 'price_growth_m';
  v_r := v_r || jsonb_build_array(jsonb_build_object(
    'case','F_reverse_order','status',v_row_b.status,'invoice',v_row_b.latest_invoice_id,
    'cape',v_row_b.cancel_at_period_end,'event_at',v_row_b.provider_event_at));

  -- ------------------------------------------------------------------ G
  -- anon must be refused (no EXECUTE grant; in-function guard as 2nd layer).
  begin
    set local role = 'anon';
    begin
      perform public.billing_upsert_subscription(v_org_a, '{}'::jsonb);
      v_pass := false;
      v_r := v_r || jsonb_build_array(jsonb_build_object('case','G_anon','result','FAIL_EXECUTED'));
    exception when insufficient_privilege then
      v_r := v_r || jsonb_build_array(jsonb_build_object('case','G_anon','result','refused'));
    end;
    reset role;
  exception when others then
    v_r := v_r || jsonb_build_array(jsonb_build_object('case','G_anon','result','error: ' || sqlerrm));
    reset role;
  end;

  -- ------------------------------------------------------------------ H
  -- authenticated (with a JWT sub present) must be refused too.
  begin
    set local role = 'authenticated';
    set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
    begin
      perform public.billing_upsert_subscription(v_org_a, '{}'::jsonb);
      v_pass := false;
      v_r := v_r || jsonb_build_array(jsonb_build_object('case','H_authenticated','result','FAIL_EXECUTED'));
    exception when insufficient_privilege then
      v_r := v_r || jsonb_build_array(jsonb_build_object('case','H_authenticated','result','refused'));
    end;
    reset role;
  exception when others then
    v_r := v_r || jsonb_build_array(jsonb_build_object('case','H_authenticated','result','error: ' || sqlerrm));
    reset role;
  end;

  if v_pass then
    raise exception 'SMOKE_OK %', v_r::text;
  else
    raise exception 'SMOKE_FAIL %', v_r::text;
  end if;
end;
$test$;
