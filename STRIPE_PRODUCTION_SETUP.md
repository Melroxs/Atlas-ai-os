# Atlas — Stripe Billing Setup & Cutover Guide

Status: **DEPLOYED TO THE SUPABASE PROJECT; NOT YET EXERCISED AGAINST STRIPE.**
What has actually been observed on this project (`ibxvzxblyhzwokljkslt`):

- `20260919_atlas_stripe_billing.sql` applied to the live database (verified:
  new columns, widened status CHECK, unique indexes, `billing_provider` default
  `'stripe'`, `billing_get_state` / `users_current_user` / `billing_apply_state`
  re-created, `billing_apply_state` executable only by `service_role`,
  `billing_get_state` executable only by `authenticated`).
- `stripe-checkout`, `stripe-customer-portal`, `stripe-webhook` deployed
  (ACTIVE, v1) with `verify_jwt = true / true / false`.
- The retired `paddle-checkout` and `paddle-webhook` functions were **deleted**
  from the project (both returned 404 afterwards) and every `PADDLE_*` Edge
  secret was removed.
- A forged webhook delivery (unsigned body, fake `Stripe-Signature`) was
  rejected with **401 Signature verification failed** before any processing; an
  unauthenticated call to `stripe-checkout` / `stripe-customer-portal` was
  rejected with **401** by the platform's JWT verification.

Everything that requires the Stripe Dashboard, the six Price ids, or a real
test payment is still **UNVERIFIED** and is marked as a manual step below. This
document never claims a payment, subscription, webhook delivery or entitlement
change that has not actually been observed.

Architecture rule this implementation enforces:

```text
Stripe payment/subscription event
  → stripe-webhook (signature verified over the raw body)
  → idempotency ledger (processed_webhook_events, provider='stripe')
  → reconcileAtlasEntitlement()   ← the ONLY entitlement decision point
  → organization_subscriptions row + tenants.billing_state (billing_apply_state)
  → Atlas access gate (RequireAuth / RequireAccess)

NEVER: browser says "payment succeeded" → grant access.
```

---

## 1. What exists in the repository

| Piece | Path |
|---|---|
| Stripe server module (REST, signature verification, price map, lifecycle mapping) | `supabase/functions/_shared/stripe.ts` |
| Webhook processor (idempotency, ordering, reconciliation) | `supabase/functions/_shared/stripe-webhook.ts` |
| Row mapping for `organization_subscriptions` | `supabase/functions/_shared/stripe-rows.ts` |
| Customer/customer-reuse helpers | `supabase/functions/_shared/stripe-org.ts` |
| Service-role client + billing authorization | `supabase/functions/_shared/service-client.ts` |
| Checkout Session creator | `supabase/functions/stripe-checkout/index.ts` |
| Webhook endpoint | `supabase/functions/stripe-webhook/index.ts` |
| Billing Portal opener | `supabase/functions/stripe-customer-portal/index.ts` |
| DB changes (additive) | `supabase/migrations/20260919_atlas_stripe_billing.sql` |
| Frontend contract (plans, prices, checkout, portal) | `src/lib/billing/*` |
| Pricing / checkout / success / billing screens | `src/pages/Pricing.tsx`, `Checkout.tsx`, `PricingSuccess.tsx`, `BillingSettings.tsx` |

Deployment auth (already set in `supabase/config.toml`):

```toml
[functions.stripe-checkout]         verify_jwt = true
[functions.stripe-customer-portal]  verify_jwt = true
[functions.stripe-webhook]          verify_jwt = false   # signature is the auth
```

---

## 2. Canonical Atlas catalog (server-side truth)

| Plan | Monthly | Annual | Stripe Price variables |
|---|---|---|---|
| Starter | $10 | $100 | `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_STARTER_YEARLY` |
| Growth | $40 | $400 | `STRIPE_PRICE_GROWTH_MONTHLY`, `STRIPE_PRICE_GROWTH_YEARLY` |
| Scale | $120 | $1,200 | `STRIPE_PRICE_SCALE_MONTHLY`, `STRIPE_PRICE_SCALE_YEARLY` |

Each annual price is ten monthly payments (two months free ⇒ the pricing page
renders "Save 17%", computed from the catalog, never hardcoded).

**Trial policy: none.** Atlas creates no trial, no introductory period, no
one-time charge and no coupon. A Checkout Session carries exactly one recurring
line item (the selected plan price) and no `trial_period_days`. There is no
`STRIPE_TRIAL_PRICE_ID` or `STRIPE_TRIAL_PERIOD_DAYS` configuration — if those
variables exist in an old environment they are ignored. A legacy `trialing`
subscription created outside Atlas is still handled defensively (it maps to
paid access) but Atlas never creates one.

The browser may send only `plan` (`starter|growth|scale`) and `interval`
(`month|year`). Price ids, amounts, currencies, customer ids and statuses are
never accepted; an unknown plan/interval/price fails closed.

---

## 3. Manual steps — Stripe Dashboard

### 3.1 Test mode first (do not start with live keys)

In **Test mode**:

1. Products → **+ Add product** → `Atlas Starter`
   - `Atlas Starter Monthly` — recurring, monthly, **$10 USD**
   - `Atlas Starter Annual` — recurring, yearly, **$100 USD**
2. Product `Atlas Growth`
   - `Atlas Growth Monthly` — recurring, monthly, **$40 USD**
   - `Atlas Growth Annual` — recurring, yearly, **$400 USD**
3. Product `Atlas Scale`
   - `Atlas Scale Monthly` — recurring, monthly, **$120 USD**
   - `Atlas Scale Annual` — recurring, yearly, **$1,200 USD**
4. Copy the six `price_…` ids. (No trial product, no one-time price.)
6. **Verify each price is Active and its `recurring.interval` is
   `month`/`year`** — the server maps back from these ids, and a mismatch shows
   up as "price is not one of the configured Atlas prices" in
   `billing_audit_events`.

### 3.2 Webhook endpoint

1. Developers → Webhooks → **+ Add endpoint**
2. URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
3. Events to send (all are handled; unsupported extra events are ignored safely):

```text
checkout.session.completed
checkout.session.expired
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
invoice.finalized
invoice.payment_action_required
invoice.marked_uncollectible
charge.refunded            (recorded; never changes entitlement on its own)
charge.refund.updated
```

4. Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.

### 3.3 Customer Portal

Settings → Billing → **Customer portal** (configure for **both** test and live):

- Allow customers to **update payment methods**, **view invoice history**,
  **cancel subscriptions**, and **switch plans** between the six Atlas prices
  (if you want self-service plan changes).
- Set the business information / privacy + terms links Atlas displays.
- Cancellation: choose **at period end** (Atlas retains access until the paid
  period ends; `billing_state` stays `active`, `cancel_at_period_end` becomes
  true).
- Add a return URL: `https://atlas-ai-os.com/dashboard/billing`.

### 3.4 Live mode (only after the test matrix passes)

Repeat 3.1–3.3 in **Live mode** with live prices, a live webhook endpoint and a
live signing secret, then run one controlled real-card transaction (see
§6.4).

---

## 4. Manual steps — Supabase / Freebuff

### 4.1 Edge Function secrets

`supabase secrets set` (or the platform Keys/Environment UI) — **names only,
values never committed**:

```text
STRIPE_SECRET_KEY              sk_test_… / sk_live_…
STRIPE_WEBHOOK_SECRET          whsec_…
STRIPE_PRICE_STARTER_MONTHLY   price_…  ($10)
STRIPE_PRICE_STARTER_YEARLY    price_…  ($100)
STRIPE_PRICE_GROWTH_MONTHLY    price_…  ($40)
STRIPE_PRICE_GROWTH_YEARLY     price_…  ($400)
STRIPE_PRICE_SCALE_MONTHLY     price_…  ($120)
STRIPE_PRICE_SCALE_YEARLY      price_…  ($1,200)
ATLAS_APP_URL                  https://atlas-ai-os.com   (already set)
# optional
STRIPE_API_VERSION             2025-…   (pin the Stripe-Version header)
```

Current state of the Edge secret store on this project (names only):
`ATLAS_APP_URL`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are already
set, but **the six canonical `STRIPE_PRICE_*` names are not**. Until they are
set, `stripe-checkout` answers `422 The selected Atlas plan is not configured
for billing.` Two things to confirm before testing:

1. `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` must be **TEST mode** values
   (`sk_test_…`, the signing secret of the TEST webhook endpoint). Their values
   are unreadable by design, so verify the mode in the Stripe Dashboard and
   replace them if they are live keys.
2. Stale price-id names from an earlier integration
   (`STRIPE_STARTER_MONTHLY_PRICE_ID`, `STRIPE_STARTER_ANNUAL_PRICE_ID`,
   `STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID`,
   `STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID`) are still present and are **not read
   by any code** — remove them to avoid confusion.

Never set these as `VITE_*`: Vite variables are baked into the browser bundle.
`SUPABASE_URL` and `SUPABASE_SECRET_KEYS`/`SUPABASE_SERVICE_ROLE_KEY` are
provided to Edge Functions by the platform.

### 4.2 Deploy the functions — DONE

All three are deployed and ACTIVE (v1) on `ibxvzxblyhzwokljkslt`:

```bash
supabase functions deploy stripe-checkout stripe-customer-portal stripe-webhook
# verify_jwt comes from supabase/config.toml: true / true / false
```

Re-run the same command after any change to `supabase/functions/**` or the
shared `_shared/` modules. If the CLI refuses to start because the workspace
`.env` is not parseable, deploy from a scratch directory that contains only
`supabase/config.toml` and `supabase/functions/`.

### 4.3 Apply the migration — DONE

`20260919_atlas_stripe_billing.sql` was applied to the live project and the
result verified (columns, constraints, indexes, function bodies, grants, RLS).
To re-apply after editing it, either push it again with your normal migration
convention or run it through `scripts/run-db-sql.mjs`. The migration is
therefore idempotent.

The migration is additive: it reuses `organization_subscriptions`,
`processed_webhook_events` and `billing_audit_events`, adds
`payment_status` / `cancel_at_period_end` / `latest_invoice_id` /
`latest_invoice_at`, widens the `status` CHECK to Stripe's lifecycle
vocabulary, defaults `billing_provider` to `'stripe'`, and re-creates
`billing_get_state`, `users_current_user` and `billing_apply_state` so the paid
access source is labelled `stripe`. Legacy rows keep
`billing_provider = 'paddle'` — they are history and are never rewritten.

### 4.4 Frontend

No new frontend env vars. `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` only.

---

## 5. Entitlement rules (single reconciliation path)

`reconcileAtlasEntitlement()` maps the subscription Stripe reports onto Atlas
state. Nothing else grants or revokes access.

| Stripe subscription status | Stored status | `tenants.billing_state` | Access | Plan association |
|---|---|---|---|---|
| `active` | `active` | `active` | ✅ | from the Stripe price |
| `trialing` | `trialing` | `active` | ✅ | from the Stripe price (defensive only — Atlas never creates a trial) |
| `past_due` | `past_due` | `past_due` | ✅ (grace — Stripe is retrying) | kept |
| `unpaid` | `unpaid` | `payment_failed` | ❌ | kept (recoverable) |
| `incomplete` | `incomplete` | `payment_failed` | ❌ | none |
| `incomplete_expired` | `incomplete_expired` | `cancelled` | ❌ | none |
| `paused` | `paused` | `suspended` | ❌ | kept (recoverable) |
| `canceled` (+ `customer.subscription.deleted`) | `canceled` | `cancelled` | ❌ | none |
| unknown | `unknown` | `payment_failed` | ❌ (fail closed) | none |

Other invariants:

- `cancel_at_period_end = true` **keeps access** until the real period end and
  clears `next_billed_at` (nothing will be charged).
- An unknown/inactive Stripe price **never** grants a plan. For a customer who
  is still paying, the previously recorded plan is kept and the mismatch is
  audited for an operator rather than silently downgraded.
- `charge.refunded` is recorded for observability and does **not** change
  entitlement (Stripe does not cancel a subscription on refund).
- Complimentary/demo access stays fully independent:
  `effective_access = valid_complimentary_access OR valid_stripe_entitlement`.
  A Stripe cancellation never removes a complimentary grant, and complimentary
  organizations never get a synthetic Stripe subscription.

---

## 6. Verification

### 6.1 Automated (runs in the repo, no Stripe account needed)

```bash
bunx vitest run supabase/functions/_shared src/lib/billing \
  src/lib/auth/access-gate.test.ts src/pages/BillingSettings.test.tsx \
  src/pages/PricingSuccess.test.tsx
bun tsc -b --noEmit
```

Covered: the six plan/interval price resolutions, price-id reverse mapping,
client input rejection, signature verification against an independent HMAC
implementation (valid / wrong secret / tampered body / stale timestamp /
malformed header / non-JSON body), Stripe REST error surfacing without the
secret, checkout session parameter shape, hosted-checkout URL response, portal
session creation, idempotency (duplicate delivery), event taxonomy
(unknown/informational/refund), organization resolution, all eight subscription
statuses, plan changes, scheduled cancellation, deletion, invoice paid/failed/
finalized/action-required/uncollectible, unknown and inactive prices, stale
subscription and invoice watermarks, Stripe API failure, database failure,
malformed envelopes, and `organization_subscriptions` row round-tripping.

### 6.2 Stripe test mode — card + clock matrix (manual)

Use test cards in **Test mode** (`4242 4242 4242 4242`, `4000 0000 0000 0002`
declined, `4000 0025 0000 3155` 3-D Secure).

| # | Scenario | Expected Atlas result |
|---|---|---|
| 1–6 | Checkout for each of the six plan/interval combinations | Session created; after webhook: `billing_state=active`, correct `internal_plan` + `billing_interval` |
| 7 | Signed-out POST to `stripe-checkout` | 401, no session |
| 8 | Member/analyst POSTs for the org | 403, no session |
| 9 | Owner/admin POSTs | Checkout URL returned |
| 10 | Replay a webhook with the same event id | `duplicate`, no state change |
| 11 | Send a webhook with a bad signature | 401, nothing written |
| 12 | Deliver an older subscription event after a newer one | `ignored` (out-of-order), state unchanged |
| 13 | Send an unknown event type | `ignored`, audited, state unchanged |
| 14 | `customer.subscription.deleted` | `billing_state=cancelled`, plan association cleared |
| 15 | Cancel in the portal (at period end) | access retained, `cancel_at_period_end=true`, `next_billed_at=null` |
| 16 | Renewal (`invoice.paid`) | period advanced, `payment_status=paid` |
| 17 | `invoice.payment_failed` | `status=past_due`, `billing_state=past_due` (grace) |
| 18 | Dunning exhausted (`unpaid`) | `billing_state=payment_failed` |
| 19 | 3-D Secure required | `payment_status=requires_action` |
| 20 | Portal for owner/admin | portal URL |
| 21 | Portal for a non-billing member | 403 |
| 22 | Portal with no stored customer | 404 with a clear message |
| 23–26 | Complimentary org, demo user, admin bypass, expired grant | unchanged by any Stripe event |
| 27 | Double-click "Subscribe" | one Checkout Session (same idempotency bucket) |
| 28 | Return from Stripe before the webhook | success page shows "payment submitted", access stays denied until the webhook lands |
| 29 | Close the browser mid-checkout | no state change |
| 30 | Click "Manage Billing" while already subscribed | portal (a second checkout is refused with 409) |

### 6.3 Failure injection

- Revoke the Stripe key → `stripe-checkout` returns 503/502, no partial state.
- Point the webhook at an unreachable subscription → 500 so Stripe retries;
  nothing is recorded as processed, so the retry re-applies full state.
- Stop Postgres grants for the function → 500, retried.

### 6.4 Live cutover (manual, after 6.1–6.3 pass)

1. Create the live products/prices and copy the six live ids (§3.1 in Live mode).
2. Set the live `STRIPE_SECRET_KEY`, live `STRIPE_WEBHOOK_SECRET`, live price ids.
3. Create the live webhook endpoint and confirm a delivery returns 2xx.
4. Configure the live Customer Portal.
5. Run one controlled real-card purchase; verify in order: Stripe Dashboard →
   webhook delivery → `organization_subscriptions` row → `tenants.billing_state`
   → `billing_get_state` RPC in the app → Billing page → Customer Portal.
6. Cancel it and confirm the documented cancellation behaviour.

---

## 7. Observability

`stripe-webhook` logs one identifier-only line per event (`stripe_event_id`,
`event_type`, `result`, `changed`, `organization_id`, `stripe_customer_id`,
`stripe_subscription_id`) and one warning line per rejection. `stripe-checkout`
and `stripe-customer-portal` log the org, user, plan/interval, customer id and
result. Card data, secrets and request bodies are never logged; a persisted
audit row is written to `billing_audit_events` for every processed, ignored,
rejected or duplicate event.

Operator queries:

```sql
select event_type, result, note, provider_event_at
from public.billing_audit_events
where organization_id = '<org-uuid>'
order by provider_event_at desc limit 50;

select provider_event_id, event_type, result
from public.processed_webhook_events
where provider = 'stripe' order by processed_at desc limit 50;
```

A Stripe event id present in `processed_webhook_events` but **not** in
`billing_audit_events` cannot happen by design (the ledger row is written last);
if `billing_audit_events` shows `result = 'rejected'`, the message explains why
(usually a missing `atlas_org_id`).

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 503 "Billing isn't configured" | `STRIPE_SECRET_KEY` missing in Edge secrets |
| 503 from the webhook, Stripe shows failed deliveries | `STRIPE_WEBHOOK_SECRET` missing |
| 401 on every delivery | Wrong signing secret (test vs live) or a body-altering proxy in front of the function |
| `ignored` + "not one of the configured Atlas prices" | Price ids in secrets don't match the live/test prices, or the price was archived/deactivated |
| `rejected` + "Could not resolve the Atlas organization" | Checkout metadata `atlas_org_id` was missing (legacy session) or the event belongs to another Stripe account |
| 409 "already has an active subscription" | The org is already subscribed — plan changes belong in the Customer Portal |
| Subscribed but still no access | Check `tenants.billing_state` (`billing_get_state`); if it is `past_due` access is allowed, `payment_failed`/`cancelled` is not — fix the payment in the portal |
| Paddle rows still in the table | Expected: legacy history keeps `billing_provider='paddle'` and is never rewritten |

---

## 9. Known limitations / remaining risks

- **UNVERIFIED**: nothing in this guide has been executed against a real Stripe
  account, a live Supabase project, or production. All test-mode and live
  results above are a matrix to run, not a record of results.
- **Paddle cutover is a human step.** Existing Paddle subscriptions are not
  migrated automatically: those customers must be subscribed in Stripe (or
  switched to complimentary access) before Paddle is fully retired. Atlas will
  no longer grant access from Paddle events, so a live Paddle subscriber whose
  `tenants.billing_state` is only kept `active` by Paddle webhooks will need an
  explicit decision.
- **Plan changes** are intentionally routed through the Stripe Billing Portal
  (`stripe-checkout` refuses a second subscription with 409). If instant
  in-app upgrades are required later, that must be implemented as a
  subscription-update call, still server-side.
- **`invoice.marked_uncollectible`** maps to `unpaid` → `payment_failed`; if the
  business wants a longer grace period there, change one row of
  `resolveAtlasBillingState` and the table in §5 together.
- The Supabase **migration history has a known divergence** in this repo; apply
  `20260919_atlas_stripe_billing.sql` with whatever convention the project uses
  for pending migrations and verify the functions were actually replaced
  (`select prosrc from pg_proc where proname = 'billing_get_state';`).
