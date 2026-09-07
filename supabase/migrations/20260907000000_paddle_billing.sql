-- ===========================================================================
-- Atlas — Paddle Billing schema
--
-- Adds the provider-agnostic billing tables the Paddle webhook synchronizes
-- into, plus the server-side RPCs the frontend uses to read billing state.
--
-- Design:
--   * `organization_subscriptions` — one row per organization; written ONLY by
--     the verified paddle-webhook Edge Function (service role). Clients never
--     write it; reads go through the `billing_get_state` RPC.
--   * `processed_webhook_events` — idempotency ledger (unique provider event
--     id). The same Paddle event is never applied twice.
--   * `billing_audit_events` — append-only structured audit trail.
--
-- Assumptions (matches the existing Atlas schema): the tenants table is
-- `public.tenants` (id uuid, billing_state text), and memberships live in
-- `public.memberships` (user_id uuid, tenant_id uuid). The access gate reads
-- tenant.billing_state through the profile query — the webhook flips that
-- value, so entitlement remains server-authoritative.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- organization_subscriptions
-- ---------------------------------------------------------------------------

create table if not exists public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (id) on delete cascade,
  billing_provider text not null default 'paddle'
    check (billing_provider in ('paddle', 'stripe')),
  provider_customer_id text,
  provider_subscription_id text,
  provider_price_id text,
  internal_plan text
    check (internal_plan in ('ATLAS_STARTER', 'ATLAS_GROWTH', 'ATLAS_SCALE')),
  billing_interval text
    check (billing_interval in ('monthly', 'annual')),
  status text not null default 'unknown'
    check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'unknown')),
  trial_start bigint,
  trial_end bigint,
  current_period_start bigint,
  current_period_end bigint,
  next_billed_at bigint,
  cancel_at bigint,
  canceled_at bigint,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- One subscription per organization; provider subscription ids are unique so
-- a duplicate delivery can never insert a second row.
create unique index if not exists organization_subscriptions_org_idx
  on public.organization_subscriptions (organization_id);
create unique index if not exists organization_subscriptions_provider_sub_idx
  on public.organization_subscriptions (provider_subscription_id)
  where provider_subscription_id is not null;
create index if not exists organization_subscriptions_provider_customer_idx
  on public.organization_subscriptions (provider_customer_id)
  where provider_customer_id is not null;

alter table public.organization_subscriptions enable row level security;

-- No client policies: the table is written by the webhook (service role) and
-- read through the billing_get_state security-definer RPC, which checks the
-- caller's membership. Revoke direct access from client roles as a belt-and-
-- braces measure.
revoke all on table public.organization_subscriptions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- processed_webhook_events (idempotency ledger)
-- ---------------------------------------------------------------------------

create table if not exists public.processed_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null,
  provider text not null default 'paddle',
  event_type text not null,
  organization_id uuid references public.tenants (id) on delete set null,
  provider_customer_id text,
  provider_subscription_id text,
  result text not null
    check (result in ('processed', 'ignored', 'rejected', 'duplicate')),
  provider_event_at bigint,
  processed_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create unique index if not exists processed_webhook_events_provider_event_idx
  on public.processed_webhook_events (provider, provider_event_id);

alter table public.processed_webhook_events enable row level security;
revoke all on table public.processed_webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- billing_audit_events (structured audit trail)
-- ---------------------------------------------------------------------------

create table if not exists public.billing_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.tenants (id) on delete set null,
  provider text not null default 'paddle',
  provider_event_id text,
  event_type text,
  provider_customer_id text,
  provider_subscription_id text,
  result text,
  note text,
  provider_event_at bigint,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists billing_audit_events_org_idx
  on public.billing_audit_events (organization_id);
create index if not exists billing_audit_events_provider_event_idx
  on public.billing_audit_events (provider_event_id);

alter table public.billing_audit_events enable row level security;
revoke all on table public.billing_audit_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- billing_get_state — client-readable billing state (security definer)
--
-- Returns the caller's organization subscription state ONLY when the caller
-- is a member of the organization. Clients can never pass an arbitrary
-- organization id and read someone else's billing row, and they can never
-- write subscription state (no write RPC exists for clients).
-- ---------------------------------------------------------------------------

create or replace function public.billing_get_state(p_tenantid uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'isActive', s.status in ('active', 'trialing'),
    'plan', s.internal_plan,
    'status', s.status,
    'billingInterval', s.billing_interval,
    'provider', s.billing_provider,
    'providerCustomerId', s.provider_customer_id,
    'providerSubscriptionId', s.provider_subscription_id,
    'providerPriceId', s.provider_price_id,
    'trialStart', s.trial_start,
    'trialEnd', s.trial_end,
    'currentPeriodStart', s.current_period_start,
    'currentPeriodEnd', s.current_period_end,
    'nextBilledAt', s.next_billed_at,
    'cancelAt', s.cancel_at,
    'canceledAt', s.canceled_at,
    'canUsePaidFeatures', s.status in ('active', 'trialing'),
    'subscription', to_jsonb(s)
  )
  from public.organization_subscriptions s
  where s.organization_id = p_tenantid
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.tenant_id = p_tenantid
    )
$$;

grant execute on function public.billing_get_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- billing_apply_state — server-only transition of tenant.billing_state
--
-- Called by the paddle-webhook Edge Function (service role). Maps the Paddle
-- subscription state into the Atlas access-gate state. Revoked from client
-- roles so the browser can never flip its own access.
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
  update public.tenants
  set billing_state = p_billing_state
  where id = p_tenantid;
end;
$$;

revoke execute on function public.billing_apply_state(uuid, text) from public, anon, authenticated;