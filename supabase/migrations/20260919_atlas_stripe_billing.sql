-- ===========================================================================
-- Atlas — Stripe Billing migration
--
-- Stripe becomes the sole ACTIVE paid billing provider. Additive and
-- non-destructive:
--
--   * existing tables are REUSED (organization_subscriptions,
--     processed_webhook_events, billing_audit_events) — no table is dropped,
--     no history is rewritten;
--   * legacy Paddle rows keep billing_provider = 'paddle' (they are history;
--     live Paddle subscriptions must be re-subscribed in Stripe during
--     cutover — that is a human/customer step, not a migration);
--   * the RPCs that expose billing state to the client are re-created with the
--     'stripe' access source and the new fields. The previous definitions live
--     in 20260907000000_paddle_billing.sql and
--     20260909_atlas_complimentary_access.sql and are intentionally NOT edited.
--
-- What this migration adds (Phase 4 of the Stripe migration):
--   organization_subscriptions.payment_status        — invoice-derived state
--   organization_subscriptions.cancel_at_period_end  — pending cancellation
--   organization_subscriptions.latest_invoice_id     — invoice reference
--   organization_subscriptions.latest_invoice_at     — invoice watermark
--   + Stripe's full subscription status vocabulary in the CHECK constraint
--   + billing_provider DEFAULT is now 'stripe'
--
-- Security: unchanged and re-asserted. organization_subscriptions and the
-- ledger tables stay revoked from anon/authenticated; tenants.billing_state is
-- written only through billing_apply_state (service_role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. organization_subscriptions — Stripe columns
-- ---------------------------------------------------------------------------

alter table public.organization_subscriptions
  add column if not exists payment_status text not null default 'unknown',
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists latest_invoice_id text,
  add column if not exists latest_invoice_at bigint;

-- New installs (and re-created rows) default to the active provider.
alter table public.organization_subscriptions
  alter column billing_provider set default 'stripe';

-- Stripe's documented lifecycle statuses. Replaces the previous 6-value list;
-- existing rows already satisfy the wider set, so this is data-preserving.
alter table public.organization_subscriptions
  drop constraint if exists organization_subscriptions_status_check;
alter table public.organization_subscriptions
  add constraint organization_subscriptions_status_check
  check (status in (
    'active', 'trialing', 'past_due', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused', 'canceled', 'unknown'
  ));

-- Payment state vocabulary (invoice-derived; display + operator signal only).
alter table public.organization_subscriptions
  drop constraint if exists organization_subscriptions_payment_status_check;
alter table public.organization_subscriptions
  add constraint organization_subscriptions_payment_status_check
  check (payment_status in ('paid', 'pending', 'failed', 'requires_action', 'unknown'));

-- One row per organization — asserted again so a duplicate webhook can never
-- insert a second subscription row.
create unique index if not exists organization_subscriptions_org_idx
  on public.organization_subscriptions (organization_id);
create unique index if not exists organization_subscriptions_provider_sub_idx
  on public.organization_subscriptions (provider_subscription_id)
  where provider_subscription_id is not null;
create index if not exists organization_subscriptions_provider_customer_idx
  on public.organization_subscriptions (provider_customer_id)
  where provider_customer_id is not null;

alter table public.organization_subscriptions enable row level security;
revoke all on table public.organization_subscriptions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Idempotency ledger — already provider-scoped, re-asserted
-- ---------------------------------------------------------------------------
-- processed_webhook_events(provider, provider_event_id) is unique, so a
-- redelivered Stripe event id can never be processed twice.
create unique index if not exists processed_webhook_events_provider_event_idx
  on public.processed_webhook_events (provider, provider_event_id);

alter table public.processed_webhook_events enable row level security;
revoke all on table public.processed_webhook_events from anon, authenticated;

alter table public.billing_audit_events enable row level security;
revoke all on table public.billing_audit_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. billing_get_state — client-readable billing state (security definer)
--
-- Returns the caller's organization billing state ONLY when the caller is a
-- member of that organization. Effective access is paid-Stripe OR active
-- complimentary; `accessSource` says which path granted it (display only — the
-- authorization decision is the access gate over tenants.billing_state).
-- ---------------------------------------------------------------------------

create or replace function public.billing_get_state(p_tenantid uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- Complimentary organizations have NO organization_subscriptions row; the
    -- dummy row guarantees this still reports isActive = true for them.
    'isActive',
      coalesce(
        (s.status in ('active', 'trialing'))
        or (c.id is not null),
        false
      ),
    'plan', s.internal_plan,
    'status', coalesce(s.status, 'unknown'),
    'billingInterval', s.billing_interval,
    'provider', coalesce(s.billing_provider, 'stripe'),
    'providerCustomerId', s.provider_customer_id,
    'providerSubscriptionId', s.provider_subscription_id,
    'providerPriceId', s.provider_price_id,
    'paymentStatus', coalesce(s.payment_status, 'unknown'),
    'trialStart', s.trial_start,
    'trialEnd', s.trial_end,
    'currentPeriodStart', s.current_period_start,
    'currentPeriodEnd', s.current_period_end,
    'nextBilledAt', s.next_billed_at,
    'cancelAt', s.cancel_at,
    'cancelAtPeriodEnd', coalesce(s.cancel_at_period_end, false),
    'canceledAt', s.canceled_at,
    'canUsePaidFeatures', coalesce(s.status in ('active', 'trialing'), false),
    'accessSource',
      case
        when c.id is not null then 'complimentary'
        when s.status in ('active', 'trialing') then 'stripe'
        else null
      end,
    'complimentary',
      case when c.id is not null then to_jsonb(c) else null end,
    'subscription', to_jsonb(s)
  )
  from (select 1) dummy
  left join lateral (
    select s.*
    from public.organization_subscriptions s
    where s.organization_id = p_tenantid
    limit 1
  ) s on true
  left join lateral (
    select c.*
    from public.complimentary_access c
    where c.organization_id = p_tenantid
      and c.status = 'active'
      and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
      and (c.user_id is null or c.user_id = auth.uid())
    order by (c.user_id = auth.uid()) desc, c.granted_at desc
    limit 1
  ) c on true
  where exists (
    select 1
    from public.memberships m
    where m."userId" = auth.uid()
      and m."tenantId" = p_tenantid
  )
$$;

-- Signed-in members only. The membership check inside the function already
-- fails closed, but Postgres grants EXECUTE to PUBLIC by default — remove that
-- so an anonymous caller cannot even reach the function body.
revoke execute on function public.billing_get_state(uuid) from public, anon;
grant execute on function public.billing_get_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. users_current_user — server-computed effective access
--
-- Same contract as before, with the paid source labelled 'stripe'. The
-- complimentary overlay is preserved exactly: an active grant yields
-- billing_state = 'active' regardless of Stripe state, and a cancelled/failed
-- Stripe subscription never removes complimentary access.
-- ---------------------------------------------------------------------------

create or replace function public.users_current_user()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_profile jsonb;
  v_tenant uuid;
  v_tenant_state text;
  v_sub_active boolean;
  v_comp jsonb;
  v_comp_active boolean;
  v_effective text;
  v_source text;
begin
  if v_user is null then
    return null;
  end if;

  select to_jsonb(p) into v_profile
  from public.profiles p
  where p._id = v_user;

  if v_profile is null then
    return null;
  end if;

  v_tenant := public.my_tenant_id();

  v_sub_active := false;
  v_comp_active := false;
  v_tenant_state := null;

  if v_tenant is not null then
    select t.billing_state into v_tenant_state
    from public.tenants t where t._id = v_tenant;

    v_sub_active := exists (
      select 1 from public.organization_subscriptions s
      where s.organization_id = v_tenant
        and s.status in ('active', 'trialing')
    );

    select to_jsonb(c) into v_comp
    from public.complimentary_access c
    where c.organization_id = v_tenant
      and c.status = 'active'
      and (c.expires_at is null or c.expires_at > (extract(epoch from now()) * 1000)::bigint)
      and (c.user_id is null or c.user_id = v_user)
    order by (c.user_id = v_user) desc, c.granted_at desc
    limit 1;

    v_comp_active := v_comp is not null;
  end if;

  if v_comp_active then
    v_source := 'complimentary';
    v_effective := 'active';
  elsif v_sub_active then
    v_source := 'stripe';
    v_effective := 'active';
  else
    v_source := null;
    v_effective := v_tenant_state;
  end if;

  return v_profile || jsonb_build_object(
    'billing_state', v_effective,
    'access_source', v_source,
    'complimentary', case when v_comp_active then v_comp else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. billing_apply_state — server-only entitlement writer (re-asserted)
-- ---------------------------------------------------------------------------

create or replace function public.billing_apply_state(
  p_tenantid uuid,
  p_billing_state text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_billing_state is null or p_billing_state not in (
    'pending_checkout', 'active', 'past_due', 'payment_failed', 'cancelled', 'suspended'
  ) then
    raise exception 'Invalid billing state.';
  end if;

  update public.tenants
  set billing_state = p_billing_state
  where _id = p_tenantid;
end;
$$;

-- Only the verified stripe-webhook (service role) may move entitlement.
revoke execute on function public.billing_apply_state(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_apply_state(uuid, text) to service_role;

-- Legacy Stripe-era RPCs stay service-role only (defence in depth).
revoke execute on function public.tenants_activate_after_payment(uuid) from public, anon, authenticated;
revoke execute on function public.tenants_handle_payment_failure(uuid) from public, anon, authenticated;
revoke execute on function public.tenants_handle_subscription_cancelled(uuid) from public, anon, authenticated;
grant execute on function public.tenants_activate_after_payment(uuid) to service_role;
grant execute on function public.tenants_handle_payment_failure(uuid) to service_role;
grant execute on function public.tenants_handle_subscription_cancelled(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Migration audit record
-- ---------------------------------------------------------------------------

select public.log_audit(
  'schema_migration_applied',
  'system',
  '20260919_atlas_stripe_billing',
  jsonb_build_object(
    'changes', ARRAY[
      'organization_subscriptions: payment_status, cancel_at_period_end, latest_invoice_id, latest_invoice_at',
      'organization_subscriptions.status CHECK widened to the Stripe lifecycle vocabulary',
      'organization_subscriptions.billing_provider default is now stripe',
      'billing_get_state reports the new fields and accessSource=stripe',
      'users_current_user labels paid access as stripe',
      'billing_apply_state validates the entitlement vocabulary'
    ],
    'paddle', jsonb_build_object(
      'status', 'inactive',
      'note', 'Historical rows keep billing_provider=paddle; no live Paddle path remains.'
    )
  )
);
