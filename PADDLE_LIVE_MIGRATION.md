# Atlas — Paddle Sandbox → Live migration

Paddle is the only payment provider. This document records what the code needs
in order to run against the **live** Paddle account, and what must be done in
the Paddle dashboard (the agent has no access to the Paddle account from this
project — no Paddle connector/MCP is available here).

## Code state

- All Paddle endpoints are environment-driven, not hard-coded:
  `PADDLE_ENVIRONMENT=live` → `https://api.paddle.com` and
  `https://checkout.paddle.com`; anything else → the sandbox hosts.
- No `Paddle.Environment.set('sandbox')`, no hard-coded `pri_`/`pro_`/discount
  ids, and no sandbox URLs exist in any active billing path. The only sandbox
  strings left in the repo are inside tests.
- Paddle.js is initialised with the publishable client token only, in
  `src/pages/Checkout.tsx`, with `environment: "production"` when the server
  reports a live environment.
- The client token is now validated against the environment: a `test_` token
  in live (or a `live_` token in sandbox) disables the overlay instead of
  opening an unusable checkout.
- Paddle Retain is not used by Atlas (`pwCustomer` appears nowhere). If Retain
  is enabled later it must receive the Paddle customer id (`ctm_...`), never an
  Atlas organization id, Supabase user id or email.
- Webhook handling (`supabase/functions/paddle-webhook`) verifies the Paddle
  signature with `PADDLE_WEBHOOK_SECRET`, rejects invalid signatures, is
  idempotent per event id, ignores out-of-order events, resolves the owning
  organization, and writes subscription status + billing state server-side.
- Webhook sender IP ranges are fetched from `https://api.paddle.com/ips` and
  cached — never hard-coded. Enforcement is opt-in with
  `PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST=1`. Signature verification is always on.
- Entitlements come only from the stored backend billing state; the success
  page polls that state and never grants access from the redirect.
- Complimentary/demo access is independent of Paddle and untouched.

## Environment variables (all Supabase Edge Function secrets/config)

| Name | Secret? |
| --- | --- |
| `PADDLE_ENVIRONMENT` = `live` | no |
| `PADDLE_API_KEY` (live key) | yes |
| `PADDLE_CLIENT_TOKEN` (must start with `live_`) | publishable |
| `PADDLE_WEBHOOK_SECRET` (from the existing live destination) | yes |
| `ATLAS_APP_URL` (real production https origin) | no |
| `PADDLE_STARTER_PRICE_ID_MONTHLY` | no |
| `PADDLE_STARTER_PRICE_ID_ANNUAL` | no |
| `PADDLE_GROWTH_PRICE_ID_MONTHLY` (Pro) | no |
| `PADDLE_GROWTH_PRICE_ID_ANNUAL` (Pro) | no |
| `PADDLE_SCALE_PRICE_ID_MONTHLY` (Advanced) | no |
| `PADDLE_SCALE_PRICE_ID_ANNUAL` (Advanced) | no |

No Paddle value belongs in a `VITE_` variable; the client token reaches the
browser only through the `paddle-checkout` response.

Canonical pricing that the live catalog must match: Starter $10 / $100,
Pro (Growth) $40 / $400, Advanced (Scale) $120 / $1200.

## Readiness check

```
PADDLE_ENVIRONMENT=live PADDLE_API_KEY=... \
PADDLE_CLIENT_TOKEN=... PADDLE_WEBHOOK_SECRET=... ATLAS_APP_URL=... \
PADDLE_STARTER_PRICE_ID_MONTHLY=... (…all six…) \
node scripts/verify-paddle-live-readiness.mjs
```

Read-only. It reports variable presence (never values), checks the token
prefix, verifies each live price exists, is active, recurring and priced
correctly, lists live notification destinations without their secrets, and
prints Paddle's current webhook IP ranges. It creates nothing and charges
nothing.

## Dashboard work that cannot be done from code

1. Create a **live** API key (Developer tools → Authentication) and store it as
   `PADDLE_API_KEY`.
2. Create/copy the **live** client-side token (`live_…`) → `PADDLE_CLIENT_TOKEN`.
3. Live catalog: create the three products and six recurring prices at the
   amounts above if they do not already exist. Never edit or archive a live
   price that customers already use — create a new one and update the variable.
4. Notifications: reuse the existing live destination pointing at
   `https://<project-ref>.supabase.co/functions/v1/paddle-webhook`
   (events: `transaction.completed`, `transaction.payment_failed`,
   `subscription.created`, `subscription.activated`, `subscription.updated`,
   `subscription.resumed`, `subscription.past_due`, `subscription.paused`,
   `subscription.canceled`). Copy its signing secret into
   `PADDLE_WEBHOOK_SECRET`. Do not recreate a destination just for a new secret.
5. Checkout settings → approved domains: add and get approval for the real
   production Atlas domain (not localhost, not a preview URL).
6. Complete business/identity verification and payout (bank) details.
7. Confirm the live default payment link (dashboard-only setting).
