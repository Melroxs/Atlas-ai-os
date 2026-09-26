# ATLAS — Vercel Environment Variable Manifest

Complete inventory of every environment variable referenced by the Atlas V1
codebase, where each one must be configured, and where to obtain the value.

**Where things run:**
- **Vercel** — builds the frontend (`vite build`) and serves the static site.
  `VITE_*` variables are baked into the bundle at build time.
- **Supabase** — Postgres schema, RLS, RPCs and Auth are managed in the
  Supabase project (via `supabase/migrations/`). Edge Functions read their
  secrets from the Supabase dashboard (Project Settings → Edge Functions →
  Secrets).
- **Both** — variables the build needs *and* the backend needs at runtime.

## Variable table

| Variable | Environment | Required | Secret | Purpose | Where to obtain |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Vercel (Prod, Preview, Dev) | ✅ Required | No | Supabase project URL (`https://<ref>.supabase.co`) | Supabase dashboard → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Vercel (Prod, Preview, Dev) | ✅ Required | No* | Public anon key for the browser client; RLS gates all data | Supabase dashboard → Project Settings → API |
| `VLY_INTEGRATION_KEY` | Supabase edge secrets (build plugin may also read it) | ✅ Required for AI | **Yes** | Freebuff/VLY gateway key for AI completions, embeddings and usage billing | Freebuff platform / integration settings |
| `VLY_INTEGRATION_BASE_URL` | Supabase edge secrets | Optional | No | VLY gateway base URL override (default `https://integrations.freebuff.com/`) | Freebuff platform (rarely needed) |
| `GOOGLE_CLIENT_ID` | Supabase edge secrets | Optional | Yes* | Google Drive OAuth client ID | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_CLIENT_SECRET` | Supabase edge secrets | Optional | **Yes** | Google Drive OAuth client secret | Google Cloud Console → APIs & Services → Credentials |
| `NODE_ENV` | Runtime (auto) | — | No | Set by the runtime; enables VLY debug logging in dev | Auto-provided |

\* The anon key and `GOOGLE_CLIENT_ID` are not "secrets" per se, but treat all
non-`VITE_` values as secrets and never expose them to the browser.

## Environment scoping

### Production (Vercel: `Production` scope)
| Variable | Configured in |
|---|---|
| `VITE_SUPABASE_URL` | Vercel |
| `VITE_SUPABASE_ANON_KEY` | Vercel |
| `VLY_INTEGRATION_KEY` | Supabase edge secrets |
| `VLY_INTEGRATION_BASE_URL` | Supabase edge secrets |
| `GOOGLE_CLIENT_ID` | Supabase edge secrets (only when Drive is enabled) |
| `GOOGLE_CLIENT_SECRET` | Supabase edge secrets (only when Drive is enabled) |

### Preview (Vercel: `Preview` scope)
Same set as Production. Preview deployments can point at a separate Supabase
project by overriding `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Google
Drive credentials may be omitted on preview unless you want Drive to work
there too (each environment resolves its own redirect URI).

### Development (Vercel: `Development` scope / local)
Same set, plus locally:
- `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from
  `supabase start` (or your project's API keys).

## Stripe billing variables

Atlas uses **Stripe Billing** as its only payment provider. Checkout is created
server-side by the `stripe-checkout` Edge Function, subscription state is
synchronized by the `stripe-webhook` Edge Function, and self-service billing is
opened by `stripe-customer-portal`. All Stripe values are **server-only** (Edge
Function secrets) — never `VITE_` prefixed, never in the browser bundle. There
is no Stripe.js integration: Checkout is Stripe-hosted, so no publishable key
is required.

| Variable | Environment | Required | Secret | Purpose |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Supabase edge secrets (test + live) | ✅ | **Yes** | Stripe API secret key (`sk_test_…` / `sk_live_…`) used by all three functions |
| `STRIPE_WEBHOOK_SECRET` | Supabase edge secrets (test + live) | ✅ | **Yes** | Verifies the `Stripe-Signature` header (HMAC-SHA256 over `<t>.<rawBody>`) |
| `STRIPE_PRICE_STARTER_MONTHLY` | Supabase edge secrets | ✅ | No | Starter monthly Price id — $49/month |
| `STRIPE_PRICE_STARTER_YEARLY` | Supabase edge secrets | ✅ | No | Starter annual Price id — $470/year |
| `STRIPE_PRICE_GROWTH_MONTHLY` | Supabase edge secrets | ✅ | No | Growth monthly Price id — $149/month |
| `STRIPE_PRICE_GROWTH_YEARLY` | Supabase edge secrets | ✅ | No | Growth annual Price id — $1,430/year |
| `STRIPE_PRICE_SCALE_MONTHLY` | Supabase edge secrets | ✅ | No | Scale monthly Price id — $299/month |
| `STRIPE_PRICE_SCALE_YEARLY` | Supabase edge secrets | ✅ | No | Scale annual Price id — $2,870/year |
| `STRIPE_API_VERSION` | Supabase edge secrets | Optional | No | Pins the `Stripe-Version` header; unset ⇒ the account default is used |
| `ATLAS_APP_URL` | Supabase edge secrets | ✅ | No | Public Atlas base URL for checkout success/cancel + portal return URLs (default `https://atlas-ai-os.com`) |
| `SUPABASE_URL` | Supabase edge secrets (auto) | ✅ | No | Provided to Edge Functions by the platform |
| `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase edge secrets (auto) | ✅ | **Yes** | Service-role client used to write billing rows / the webhook ledger. Auto-provided |

Price ids are **not** secrets (they are catalog identifiers), but they are kept
server-side so the plan → price mapping stays authoritative and the six price
ids are never shipped in the frontend bundle.

Atlas sells **no trials**: no `STRIPE_TRIAL_PRICE_ID`, no
`STRIPE_TRIAL_PERIOD_DAYS`, no trial on the Checkout Session. A legacy
`trialing` subscription created outside Atlas is still handled (it maps to paid
access), but Atlas itself never creates one.

Stale names that earlier Paddle/Stripe attempts left in the Edge secret store
and that **no code reads** — delete them once the six canonical names above are
configured: `STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID`,
`STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID`, `STRIPE_STARTER_MONTHLY_PRICE_ID`,
`STRIPE_STARTER_ANNUAL_PRICE_ID` (these use the old `<PLAN>_PRICE_ID_<INTERVAL>`
spelling, not `STRIPE_PRICE_<PLAN>_<INTERVAL>`).

Deployment notes:
- `stripe-checkout` and `stripe-customer-portal` deploy with default JWT
  verification (caller must be authenticated and authorized for the org).
- `stripe-webhook` deploys with `verify_jwt = false` (Stripe does not send a
  Supabase JWT); the Stripe signature is verified inside the function, and the
  function refuses to run without `STRIPE_WEBHOOK_SECRET`.
- Point the Stripe webhook endpoint at
  `https://<ref>.supabase.co/functions/v1/stripe-webhook`.
- Webhook security stack: mandatory signature verification with a 5-minute
  replay tolerance, a durable per-event idempotency ledger, an out-of-order
  watermark per lifecycle, and a single entitlement reconciliation path.

## Notes

- **Never** put secrets in `.env.example` (it is committed to GitHub).
- The committed `.env.example` template is managed by the platform guard and
  lists only the two `VITE_` variables the browser needs; the Stripe variable
  list above is the canonical reference, and every Stripe value belongs in
  Supabase Edge Function secrets (or the platform Keys UI), never in a
  `VITE_` variable.
- All database access is via RLS-gated Postgres RPCs — there are no backend
  database credentials in the frontend.
- Storage (file uploads) uses Supabase Storage buckets with tenant-scoped
  RLS policies — **no** env vars.
- OCR: no engine is configured, so **no** OCR env vars exist today. When an
  engine is wired in, add its key here.
