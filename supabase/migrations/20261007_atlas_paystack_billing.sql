-- ===========================================================================
-- Atlas — Paystack billing (additive, Stripe-preserving)
--
-- Master Prompt 2, phase: Paystack as a SECOND provider alongside Stripe.
-- Nothing is dropped, nothing is rewritten, no historical migration is
-- modified, and no Stripe object is touched.
--
-- PRE-FLIGHT VERIFICATION (section 2 — performed before writing this file):
--   * live migration ledger: 68 rows via the Management API query endpoint
--     (the repository verification doc's "44 rows / 20260918 missing" is
--     stale — 20260918 IS applied live; details in the implementation report)
--   * live organization_subscriptions constraints match repo 20260919 exactly,
--     including `organization_subscriptions_billing_provider_check`
--     CHECK (paddle, stripe) — the constraint widened below
--   * live RPC bodies md5-identical to repo sources:
--       billing_get_state         38b1ab61f8562ce3262dfe7df8ec062c (20260919)
--       users_current_user        dcf392009397374d8b80ee4e6c60ed15 (20260919)
--       billing_apply_state       bb3fee9b27f6c56617acb38e274e2707 (20260919)
--       billing_upsert_subscription d3cc764c83d82952ae91514d11cd752f (20260921)
--     so the re-created functions below are based on the TRUE live bodies.
--   * `supabase db push` is NOT run; this migration is applied on its own
--     through the Management API query endpoint, statement-group by group.
--
-- WHAT THIS ADDS
--   A. billing_provider CHECK widened paddle|stripe → +paystack (no rows
--      are modified; historical providers keep their value)
--   B. organization_subscriptions.provider_subscription_token — the stored
--      Paystack email token required by POST /subscription/disable
--   C. billing_transactions — the durable Atlas payment attempt
--      (organization ↔ reference ↔ Paystack transaction ↔ subscription),
--      created BEFORE checkout so webhook verification has an expected
--      amount/currency/organization/plan to validate against
--   D. billing_get_state / users_current_user re-created with ONLY the
--      access-source label made provider-aware ('paystack' instead of a
--      hardcoded 'stripe' for Paystack subscriptions). Every security
--      property is preserved verbatim: SECURITY DEFINER, search_path,
--      membership check, complimentary overlay, fail-closed semantics,
--      EXECUTE grants (public/anon revoked; authenticated granted).
--      billing_apply_state and billing_upsert_subscription are NOT touched.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A. Provider constraint — widen only, never rewrite rows
-- ---------------------------------------------------------------------------

alter table public.organization_subscriptions
  drop constraint if exists organization_subscriptions_billing_provider_check;
alter table public.organization_subscriptions
  add constraint organization_subscriptions_billing_provider_check
  check (billing_provider in ('paddle', 'stripe', 'paystack'));

-- ---------------------------------------------------------------------------
-- B. Stored Paystack subscription-management token
--    POST /subscription/disable requires { code, token }. The token comes
--    from the verified webhook / subscription fetch — never from a client.
-- ---------------------------------------------------------------------------

alter table public.organization_subscriptions
  add column if not exists provider_subscription_token text;

-- ---------------------------------------------------------------------------
-- C. billing_transactions — durable Atlas payment attempts
-- ---------------------------------------------------------------------------

create table if not exists public.billing_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.tenants (_id) on delete cascade,
  provider text not null default 'paystack'
    check (provider in ('paddle', 'stripe', 'paystack')),
  -- Server-generated Atlas reference (allowed chars per Paystack docs:
  -- alnum, '-', '.', '='). Unique per provider so a double-click cannot
  -- create a second billing attempt inside the reference window.
  provider_reference text not null,
  provider_transaction_id bigint,
  internal_plan text
    check (internal_plan in ('ATLAS_STARTER', 'ATLAS_GROWTH', 'ATLAS_SCALE')),
  billing_interval text
    check (billing_interval in ('monthly', 'annual')),
  -- Expected charge amount in the currency's SUBUNITS (fixed catalog value,
  -- configured server-side — never computed from a live FX rate).
  amount bigint not null,
  currency text not null,
  status text not null default 'pending'
    check (status in ('pending', 'initialized', 'success', 'failed', 'abandoned', 'unknown')),
  verified boolean not null default false,
  verified_at bigint,
  -- Identity of the last webhook delivery applied to this attempt.
  webhook_event_key text,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create unique index if not exists billing_transactions_provider_reference_idx
  on public.billing_transactions (provider, provider_reference);
create index if not exists billing_transactions_org_idx
  on public.billing_transactions (organization_id);

-- Server-only table: written by the checkout function and the webhook
-- (service role), read for verification. Clients never touch it.
alter table public.billing_transactions enable row level security;
revoke all on table public.billing_transactions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- D. RPC re-creation — provider-aware access-source LABEL only.
--    Body is the verified-live 20260919 definition with the single `case`
--    that produced 'stripe' made provider-aware. All other logic — including
--    the complimentary overlay and the membership gate — is byte-identical.
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
        when s.status in ('active', 'trialing') then
          -- Provider-aware label (was a hardcoded 'stripe'). Display only:
          -- the authorization decision still comes from tenants.billing_state
          -- via evaluateAtlasAccess.
          case when s.billing_provider = 'paystack' then 'paystack' else 'stripe' end
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

-- Signed-in members only. Postgres grants EXECUTE to PUBLIC by default —
-- re-assert the hardening from 20260919 after the re-creation above.
revoke execute on function public.billing_get_state(uuid) from public, anon;
grant execute on function public.billing_get_state(uuid) to authenticated;

-- Same contract as 20260919 with the paid access source labelled from the
-- row's actual provider (was a hardcoded 'stripe'). The complimentary
-- overlay, the effective-state computation and every fail-closed branch are
-- preserved verbatim.
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
  v_sub_provider text;
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
  v_sub_provider := null;
  v_comp_active := false;
  v_tenant_state := null;

  if v_tenant is not null then
    select t.billing_state into v_tenant_state
    from public.tenants t where t._id = v_tenant;

    select s.billing_provider into v_sub_provider
    from public.organization_subscriptions s
    where s.organization_id = v_tenant
      and s.status in ('active', 'trialing')
    limit 1;

    v_sub_active := v_sub_provider is not null;

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
    v_source := case when v_sub_provider = 'paystack' then 'paystack' else 'stripe' end;
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
-- Migration audit record
-- ---------------------------------------------------------------------------

select public.log_audit(
  'schema_migration_applied',
  'system',
  '20261007_atlas_paystack_billing',
  jsonb_build_object(
    'changes', ARRAY[
      'organization_subscriptions: billing_provider CHECK widened to include paystack',
      'organization_subscriptions: provider_subscription_token column (stored disable token)',
      'billing_transactions: new server-only payment attempt table (RLS revoked from clients)',
      'billing_get_state: accessSource label is provider-aware (paystack/stripe); rules unchanged',
      'users_current_user: access_source label is provider-aware; complimentary overlay unchanged'
    ],
    'stripe', jsonb_build_object(
      'status', 'preserved',
      'note', 'No Stripe table, column, RPC rule, function or migration was modified.'
    )
  )
);
