# Merchant Identity & Payment Provider Setup

Canonical record of **who legally operates Atlas AI OS**, and what a payment
provider must be told during onboarding.

Source of truth in code: `src/lib/legal/company-identity.ts`
Tests: `src/lib/legal/company-identity.test.ts`, `src/lib/legal/merchant-config.test.ts`
Database record: `supabase/migrations/20260943_atlas_merchant_profile.sql`

---

## The one rule

**AI DIALER is the legal company. Atlas AI OS is the trading name.**

```
AI DIALER
Registration No. 2024/699248/07
        │
        │ trades as
        ▼
Atlas AI OS
```

Atlas AI OS is **not** a separately incorporated company. Never enter or
generate any of these as the legal entity:

```
Atlas AI OS (Pty) Ltd
Atlas AI OS (Pty)
Atlas AI OS Ltd
```

Those names do not correspond to a CIPC registration. If a company is later
registered under such a name through the proper CIPC process, this document and
`company-identity.ts` must be updated together.

Where a single field is required, use:

```
AI DIALER t/a Atlas AI OS
```

---

## Canonical values

| Field | Value |
|---|---|
| Legal entity name | `AI DIALER` |
| Company registration number | `2024/699248/07` |
| Enterprise type | `Private Company` |
| Enterprise status | `In Business` |
| Registration date | `2024-11-04` |
| Business start date | `2024-11-04` |
| Financial year end | `March` |
| Trading name | `Atlas AI OS` |
| Combined presentation | `AI DIALER t/a Atlas AI OS` |
| Country | `South Africa` (`ZA`) |
| Province | `Western Cape` |
| City | `Cape Town` |
| Settlement currency | `USD` |
| Statement descriptor | `ATLAS AI OS` |

> **The SARS tax number is deliberately absent from this repository.** It is
> held only in the operator's private records and in the payment provider's
> onboarding system. Do not add it to source, client bundles, logs, analytics,
> public API responses or migrations.

---

## Provider status

| Provider | Status | Notes |
|---|---|---|
| **Stripe** | **live** | Sole live paid provider. Checkout, webhook and customer portal all run through `supabase/functions/stripe-*`. |
| **Peach** | **scaffolded** | Identity is canonical and on file. **No** API client, checkout, webhook, credentials or settlement exist. |

`merchantStatusFor()` and `isLiveProvider()` in
`src/lib/legal/merchant-config.ts` encode this, and are tested. Do not
represent Peach as processing payments until real credentials exist and an
integration has actually been built and verified.

---

## Bank / settlement entity

Intended Peach settlement chain:

```
Peach Merchant
    ↓
AI DIALER              <- settlement account holder (the legal entity)
    ↓
AI DIALER business bank account
    ↓
Atlas AI OS business revenue
```

The bank account must be held by **AI DIALER**, the same legal entity as the
Peach merchant. `Atlas AI OS` is never a bank-account holder.

No account number, branch code, or banking credential is stored anywhere in
this repository, and none is guessed. `settlementBankName` is `null` until the
mandate exists. The database stores the account *holder* only.

---

## Environment variables

Non-secret merchant identity. All are **optional**; the canonical values in
`company-identity.ts` apply when unset. Read server-side only.

| Variable | Default | Purpose |
|---|---|---|
| `PEACH_LEGAL_ENTITY_NAME` | `AI DIALER` | Legal entity on provider records |
| `PEACH_TRADING_NAME` | `Atlas AI OS` | Trading / brand name |
| `PEACH_COMPANY_REGISTRATION_NUMBER` | `2024/699248/07` | CIPC registration number |
| `PEACH_COUNTRY` | `South Africa` | Country name |
| `PEACH_COUNTRY_CODE` | `ZA` | ISO country code |
| `PEACH_SETTLEMENT_ACCOUNT_HOLDER` | `AI DIALER` | Bank account holder |
| `PEACH_SETTLEMENT_CURRENCY` | `USD` | Settlement currency |
| `PEACH_STATEMENT_DESCRIPTOR` | `ATLAS AI OS` | What customers see on a charge |

An override that would set the legal entity to a trading-name-plus-suffix form
(e.g. `Atlas AI OS (Pty) Ltd`) is **rejected at runtime** by
`peachMerchantConfig()`. Configuration cannot be used to accidentally represent
the product as its own company.

### Secrets — do NOT create placeholders

These must come from the operator's real Peach/Capitec onboarding. They are
**not** defined in this repository and must never be committed:

```
PEACH_MERCHANT_ID
PEACH_CLIENT_ID
PEACH_CLIENT_SECRET
PEACH_WEBHOOK_SECRET
PEACH_SETTLEMENT_ACCOUNT
```

Add them through the project's secret-management mechanism once they exist.
Never add a default, a fake value, or a placeholder to make code "work".

---

## Manual actions still required

Not done in code, and outside this repository:

**Peach / Capitec**
- [ ] Create the Peach merchant account under **AI DIALER**
- [ ] Submit CIPC registration certificate (COR14.3) for 2024/699248/07
- [ ] Confirm the settlement bank account is in the AI DIALER name
- [ ] Obtain merchant id, client id, client secret and webhook secret
- [ ] Confirm the supported statement-descriptor format and length limits, then
      set `PEACH_STATEMENT_DESCRIPTOR` to a value Peach accepts
- [ ] Obtain the webhook signing secret and its rotation policy

**SARS / eFiling**
- [ ] Confirm the registered income-tax details match the CIPC record
- [ ] Note: the tax number is deliberately not stored in this repo

**Production environment**
- [ ] Set the non-secret `PEACH_*` identity variables if the defaults ever need
      overriding
- [ ] Add the secrets above once Peach is live

**Engineering, if Peach goes live**
- [ ] Build the Peach checkout session client (none exists)
- [ ] Build the webhook endpoint with signature verification and idempotency,
      mirroring `supabase/functions/stripe-webhook`
- [ ] Extend `BILLING_PROVIDERS` / `organization_subscriptions.billing_provider`
      check constraints to accept `peach`
- [ ] Decide the migration path for existing Stripe subscriptions (do **not**
      break existing paying customers)
- [ ] Confirm refund/cancellation behaviour against Peach's capabilities

Until those exist, **Stripe remains the live provider** and the current
checkout, webhook verification and entitlement flow are unchanged.
