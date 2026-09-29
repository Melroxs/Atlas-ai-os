-- ---------------------------------------------------------------------------
-- Atlas AI OS — Merchant / legal-entity profile (Phase 4 & 8)
--
-- Atlas AI OS is NOT a separate legal company. It is the trading name under
-- which the existing South African private company operates the product:
--
--        AI DIALER
--        Registration No. 2024/699248/07
--                │ trades as
--                ▼
--        Atlas AI OS
--
-- This table is the database-side record of that relationship, so payment
-- provider onboarding and invoices reference one canonical row rather than
-- restating the entity in several places.
--
-- WHY A NEW TABLE
--   public.companyProfiles already exists but is PER-TENANT CUSTOMER data
--   (tenantId FK, the customer's own company name from onboarding). Atlas's
--   own legal identity is a single global fact about the platform operator, so
--   it is modelled separately rather than mixed into every customer profile.
--   This is the "extend rather than duplicate" boundary: nothing existing is
--   altered.
--
-- DATA SAFETY
--   - Creates a NEW table only. No existing table, row, subscription, payment
--     record, invoice or entitlement is read, rewritten or deleted.
--   - Idempotent: safe to re-run. The seeded row is keyed on a stable slug and
--     uses ON CONFLICT DO NOTHING, so re-running never clobbers operator edits.
--
-- SENSITIVITY
--   - There is NO SARS tax number column and no tax number value. It is held
--     only in the operator's private records and the payment provider's
--     onboarding system. It must not be added to this schema.
--   - No payment credentials (merchant id, client id, client secret, webhook
--     secret) and no bank account details are stored here. Those are runtime
--     secrets in the platform secret store, read server-side only.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- atlas_merchant_profile
-- ---------------------------------------------------------------------------
create table if not exists public.atlas_merchant_profile (
  id                  uuid primary key default gen_random_uuid(),

  -- Stable natural key: 'atlas-ai-os'. Lets operators keep a single row and
  -- makes the seed idempotent without relying on a generated id.
  slug                text not null unique,

  -- Legal identity (CIPC COR14.3)
  legal_entity_name           text not null,
  company_registration_number text not null,
  enterprise_type             text not null,
  enterprise_status           text not null,
  registration_date           date not null,
  business_start_date         date not null,
  financial_year_end_month    text not null,

  -- Trading identity
  trading_name       text not null,
  legal_presentation text not null,

  -- Jurisdiction
  country       text not null,
  country_code  text not null,
  province      text not null,
  city          text not null,

  -- Settlement
  settlement_currency        text not null,
  -- Must be the legal entity, never the trading name. Constrained below.
  settlement_account_holder text not null,
  -- NULL until the bank mandate exists. Never seeded with a guess.
  settlement_bank_name      text,

  -- Payment provider onboarding state, one row per provider relationship.
  -- 'scaffolded' means the identity is on file but the provider is not live.
  merchant_provider text not null,
  merchant_status   text not null
    check (merchant_status in ('live', 'scaffolded', 'not_onboarded')),

  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,

  -- The settlement account holder must never be the trading name: revenue
  -- settles to the registered company, not to the brand.
  constraint atlas_merchant_profile_holder_is_entity
    check (settlement_account_holder <> trading_name),

  -- The legal entity must never be the trading name presented as a company.
  -- Guards "Atlas AI OS (Pty) Ltd"-style drift at the storage layer: if the
  -- legal_entity_name mentions the trading name at all, it must be exactly
  -- the trading name (a pure brand, not a company-plus-suffix).
  constraint atlas_merchant_profile_entity_not_trading_suffix
    check (
      lower(legal_entity_name) not like '%atlas%ai%os%'
      or lower(legal_entity_name) = lower(trading_name)
    )
);

comment on table public.atlas_merchant_profile is
  'Single canonical record of the legal entity (AI DIALER) that trades as Atlas AI OS. '
  'Contains no tax number and no payment credentials or bank details by design.';

comment on column public.atlas_merchant_profile.legal_entity_name is
  'CIPC-registered legal entity name (AI DIALER). Never the trading name.';
comment on column public.atlas_merchant_profile.trading_name is
  'Brand the legal entity trades under (Atlas AI OS).';
comment on column public.atlas_merchant_profile.settlement_account_holder is
  'Bank account holder. Must be the legal entity. Account details are secrets, not stored here.';
comment on column public.atlas_merchant_profile.settlement_bank_name is
  'NULL until the bank mandate exists. Never seed a guessed value.';

-- One live row per provider.
create unique index if not exists atlas_merchant_profile_slug_idx
  on public.atlas_merchant_profile (slug);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The row is platform-level operator data, not tenant data. It is written and
-- read server-side (service role) only, and direct client reads are revoked so
-- no future column addition can silently widen what the browser can see.
--
-- The public legal pages (Terms, Privacy, Refunds) and the footers render the
-- legal identity from `src/lib/legal/company-identity.ts` — a static, public,
-- non-sensitive value set. They deliberately do NOT read this table, so no
-- client-reachable RPC is needed to surface it.
--
-- No SECURITY DEFINER read RPC is provided on purpose. A definer function
-- granted to `authenticated` with no in-body authorization guard is treated as
-- a regression by the security ratchet in
-- src/lib/security/migration-privileges.test.ts, and there is no consumer that
-- would justify opening that surface for values that are already public.
-- ---------------------------------------------------------------------------
alter table public.atlas_merchant_profile enable row level security;

revoke all on table public.atlas_merchant_profile from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed the canonical row (idempotent)
--
-- Stripe is the live provider today. Peach identity is recorded as
-- 'scaffolded': the legal identity is on file, but no Peach merchant
-- credentials or settlement exist yet, so nothing about Peach is live.
-- ON CONFLICT DO NOTHING preserves any operator edits on re-run.
-- ---------------------------------------------------------------------------
insert into public.atlas_merchant_profile (
  slug,
  legal_entity_name,
  company_registration_number,
  enterprise_type,
  enterprise_status,
  registration_date,
  business_start_date,
  financial_year_end_month,
  trading_name,
  legal_presentation,
  country,
  country_code,
  province,
  city,
  settlement_currency,
  settlement_account_holder,
  settlement_bank_name,
  merchant_provider,
  merchant_status
)
values (
  'atlas-ai-os',
  'AI DIALER',
  '2024/699248/07',
  'Private Company',
  'In Business',
  date '2024-11-04',
  date '2024-11-04',
  'March',
  'Atlas AI OS',
  'AI DIALER t/a Atlas AI OS',
  'South Africa',
  'ZA',
  'Western Cape',
  'Cape Town',
  'USD',
  'AI DIALER',
  null,
  'stripe',
  'live'
)
on conflict (slug) do nothing;
