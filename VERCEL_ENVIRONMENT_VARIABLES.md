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

## Paddle billing variables

Atlas uses **Paddle Billing** as the payment provider. Checkout is created
server-side by the `paddle-checkout` Edge Function; subscription state is
synchronized by the `paddle-webhook` Edge Function. All Paddle values are
**server-only** (Edge Function secrets / production environment) — never
`VITE_` prefixed, never in the browser bundle.

| Variable | Environment | Required | Secret | Purpose |
|---|---|---|---|---|
| `PADDLE_ENVIRONMENT` | Supabase edge secrets + prod | ✅ | No | `sandbox` or `live` (production MUST be `live`) |
| `PADDLE_API_KEY` | Supabase edge secrets | ✅ | **Yes** | Server API key for creating transactions |
| `PADDLE_CLIENT_TOKEN` | Supabase edge secrets | Optional | No | Client token; only needed for the Paddle.js overlay checkout |
| `PADDLE_SELLER_ID` | Supabase edge secrets | Optional | **Yes** | Vendor id (kept for configuration compatibility) |
| `PADDLE_WEBHOOK_SECRET` | Supabase edge secrets | ✅ | **Yes** | Verifies webhook signatures (`Paddle-Signature` header) |
| `ATLAS_APP_URL` | Supabase edge secrets | Optional | No | Public Atlas base URL for checkout success/cancel redirects (default `https://atlas-ai-os.com`) |
| `PADDLE_STARTER_PRICE_ID_MONTHLY` | Supabase edge secrets | ✅ prod | No | Price id for Starter monthly (1-day/$10 trial configured on the price) |
| `PADDLE_STARTER_PRICE_ID_ANNUAL` | Supabase edge secrets | ✅ prod | No | Price id for Starter annual |
| `PADDLE_GROWTH_PRICE_ID_MONTHLY` | Supabase edge secrets | ✅ prod | No | Price id for Growth monthly |
| `PADDLE_GROWTH_PRICE_ID_ANNUAL` | Supabase edge secrets | ✅ prod | No | Price id for Growth annual |
| `PADDLE_SCALE_PRICE_ID_MONTHLY` | Supabase edge secrets | ✅ prod | No | Price id for Scale monthly |
| `PADDLE_SCALE_PRICE_ID_ANNUAL` | Supabase edge secrets | ✅ prod | No | Price id for Scale annual |

Price ids are **not** secrets (they are catalog identifiers), but they are
kept server-side so the plan → price mapping stays authoritative and the six
price ids are not scattered through the frontend bundle.

Deployment notes:
- `paddle-checkout` deploys with default JWT verification (caller must be
  authenticated).
- `paddle-webhook` deploys with `--no-verify-jwt` (Paddle does not send a
  Supabase JWT); the signature header is verified inside the function.
- Point the Paddle notification destination at
  `https://<ref>.supabase.co/functions/v1/paddle-webhook`.

## Notes

- **Never** put secrets in `.env.example` (it is committed to GitHub).
- The committed `.env.example` template is managed by the platform guard;
  the Paddle variable list above is the canonical reference.
- All database access is via RLS-gated Postgres RPCs — there are no backend
  database credentials in the frontend.
- Storage (file uploads) uses Supabase Storage buckets with tenant-scoped
  RLS policies — **no** env vars.
- OCR: no engine is configured, so **no** OCR env vars exist today. When an
  engine is wired in, add its key here.
