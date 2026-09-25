# ATLAS — Production Verification & Sign-Off

**Date:** 2026-09-25
**Scope:** Verification of the in-flight workstreams (Stripe billing D1/D2/D3, blog
publishing, integration foundation, OAuth/webhook security, Edge Functions,
migrations/privileges, SEO, tests, deployment safety). No product expansion.
**Method:** Every statement below was produced by a command run in this session.
Nothing is carried over from a previous agent's claim without being re-checked.

---

## 1. Verdict

```text
CONDITIONALLY READY — code and database behaviour are verified; two deployment
blockers remain and are NOT engineering defects:

  B1. The live migration ledger does not contain 20260918–20260922 even though
      the objects those migrations create DO exist in the database.
  B2. No automated live Stripe TEST-mode end-to-end test exists in the repo, and
      none could be executed here (no Stripe key is configured).
```

Everything on the application side (typecheck, tests, live SQL/RPC behaviour,
privilege posture, signature-verification posture) is **verified green**.

---

## 2. Repository state (verified)

```text
branch          fix/repair-truncated-files
HEAD            5ffd6d9
origin/main     369a62b
ahead            2 commits / behind 0
working tree    29 changed or untracked paths (the billing/blog/integration/SEO workstreams)
```

Matches the previously claimed state exactly. No unrelated or unexplained
changes found; nothing was reset, reverted or force-pushed.

---

## 3. Automated gates (re-run in this session)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc -b --noEmit` | **clean** (no diagnostics) |
| Full suite | `bunx vitest run` | **2188 passed / 5 skipped / 0 failed** (115 files) |
| Scoped billing+integration+blog+platform | `bunx vitest run src/lib/billing src/lib/integrations src/lib/blog src/lib/platform src/lib/security supabase/functions/_shared/stripe-subscription-merge.test.ts` | **413 passed / 0 failed** |

The 5 skipped tests are exactly the five `*-live.e2e.test.ts` files
(`archive-live`, `phase15-live`, `reliability-live`, `tenant-live`,
`governance-live`). They are live-gated by design and need a database +
credentials; they are not silently passing.

The 2183 count previously claimed is now 2188 because this session added 5 new
tests (§5).

---

## 4. Live database verification — the D2/D3 gap is now CLOSED

Previously reported as: *"SQL/RPC behavior has NOT yet been exercised against a
live/test database."* That is no longer true. Two read-only/rolled-back scripts
now do it, and both were executed against the linked project.

Tooling:

```bash
bun scripts/run-db-sql.mjs scripts/sql/billing_state_check.sql
bun scripts/run-db-sql.mjs scripts/sql/billing_upsert_subscription_smoke.sql
```

### 4.1 `billing_upsert_subscription` — live behavioural smoke test

Result, verbatim from the live project:

```text
SMOKE_OK
A_insert              created=true  status=active    payment=paid
B_newer_full          status=past_due  invoice=in_1002  payment=paid  cape=true
C_stale_ignored       sub_applied=false  inv_applied=false
                      status=past_due  payment=paid  invoice=in_1002     <- the D1 race
D_invoice_family      status=past_due  invoice=in_1003  payment=failed
E_resume_carries_state status=active  cape=false  period_end=2592000900  payment=failed
F_reverse_order       status=past_due  invoice=in_1002  cape=true  event_at=2000
G_anon                refused
H_authenticated       refused
```

What this proves against the real RPC (not the TypeScript mirror):

- **A** — the insert path creates a row and reports `created=true`.
- **B** — a newer full event is applied, including the invoice family and `cancel_at_period_end`.
- **C** — **the D1/RACE fix is real in SQL**: a stale snapshot
  (`provider_event_at` 1000 < stored 2000) carrying `payment_status='unknown'`
  and no invoice id changes **nothing** — `subscription_applied=false`,
  `invoice_applied=false`, status stays `past_due`, payment stays `paid`,
  `latest_invoice_id` stays `in_1002`, and the watermark does not move backwards.
- **D** — the invoice family advances independently of the subscription family
  (`payment_status` → `failed`, `latest_invoice_id` → `in_1003`) while
  `provider_event_at` is correctly carried forward (2000, not 3000).
- **E** — a later subscription event after a resume restores `status=active`,
  clears `cancel_at_period_end`, carries the periods forward, and does **not**
  invent or discard an invoice outcome (`payment_status` stays `failed`).
- **F** — **arrival-order equivalence**: replaying `B then A(stale)` reaches the
  same final state as `A then B`. This is the D2 requirement, verified in SQL
  rather than only in the TypeScript merge.
- **G/H** — the `anon` role and a real `authenticated` session (with a JWT
  `sub` present) are both **refused** — the EXECUTE revoke and the in-function
  trusted-server guard both hold. A browser cannot rewrite its own subscription row.

**Rollback proven:** the smoke test's `DO` block ends in a `RAISE EXCEPTION`,
and the counts taken afterwards confirm nothing persisted:
`smoke_tenants = 0`, `smoke_subscriptions = 0`, `total_tenants = 23`,
`total_org_subscriptions = 2` (unchanged). Production data was not touched.

### 4.2 Migration privileges actually deployed

Verified from `pg_proc.proacl`, not from the migration text:

| RPC | Live ACL | Intended |
|---|---|---|
| `billing_upsert_subscription(uuid, jsonb)` | `postgres, service_role` (SECURITY DEFINER) | server-only ✅ |
| `connections_register(...)` / `connections_set_status(...)` | `postgres, service_role` | server-only ✅ |
| `integration_event_ingest(...)` / `integration_oauth_state_create/consume(...)` | `postgres, service_role` | server-only ✅ |
| `content_admin_list` / `content_review_decide` / `content_publish_blog` | `authenticated, service_role` | authenticated-guarded ✅ |
| `content_public_list` / `content_public_get` | `anon, authenticated, service_role` | public read ✅ |

No `PUBLIC` grant remains on any of them. All eight expected tables exist with
RLS enabled, including `organization_subscriptions`, `atlasContentItems`,
`atlasContentProvenance` and the five `integration_*` tables.

### 4.3 Finding — the trusted-server primitives are genuinely absent

`atlas_is_trusted_server` and `atlas_assert_trusted_server` (20260918) **do not
exist** in the live database. The deployment note in
`20260921_atlas_billing_subscription_merge.sql` anticipated exactly this and
inlined the predicate instead of calling them. That decision is **correct and
load-bearing** — had the migration called the helper, `billing_upsert_subscription`
would not compile against this database. The inline predicate was independently
proven by cases G and H above.

---

## 5. Edge Function coverage — gap closed as far as this environment allows

**Confirmed defect in the CI configuration:** `tsconfig.app.json` includes only
`src`, and `tsconfig.node.json` only `vite.config.ts`. Nothing under
`supabase/functions/` was compiled by `bunx tsc -b --noEmit`, so a truncated or
mis-imported Edge Function source passed every gate. The branch is literally
named `fix/repair-truncated-files`, and this class of defect had no guard.

**Fix added:** `src/lib/security/edge-functions-integrity.test.ts` (5 tests,
static, no Deno, no network, no database):

1. every `[functions.<name>]` in `supabase/config.toml` has a real `index.ts`;
2. every `.ts` file under `supabase/functions` parses as TypeScript;
3. every relative import resolves to an existing file;
4. every function deployed with `verify_jwt = false` performs its own signature
   verification in non-comment code (derived from the config, so a new
   JWT-exempt function is automatically covered);
5. a self-check asserting the syntax detector can actually fail.

**Mutation-proven, not assumed.** A probe file containing a syntax error *and* a
missing import was added under `supabase/functions/_shared/` and the suite was
re-run:

```text
× parses every edge function source without syntax errors
× resolves every relative import inside supabase/functions
  "_shared/__ratchet_probe.ts: ':' expected."
  "_shared/__ratchet_probe.ts -> ./this-module-does-not-exist.ts"
```

The probe was then deleted (verified: 0 matches) and the suite returns to green.
An anti-vacuity assertion (`scanned > 20` relative specifiers) stops the import
scan from silently checking nothing after a future refactor.

### Residual limit — stated, not hidden

```text
UNVERIFIED — supabase/functions/** is not semantically type-checked.
               Deno is not installed in this workspace and the entry points use
               Deno.env / Deno.serve / https: / jsr: specifiers, so neither
               `tsc` nor execution can cover them here. The pure shared modules
               ARE executed by unit tests (primitives parity, stripe merge,
               stripe, stripe-webhook, elevenlabs, email, user-deletion).
```

This test catches truncation, missing modules and broken imports — the defects
it was written for — but it is **not** a substitute for `deno check`. Run
`supabase functions deploy` (or `deno check`) against the functions before a
production cutover.

---

## 6. Deployment blocker B1 — migration ledger divergence

**This is the single most important finding of this session.**

Verified live:

```text
ledger total            44
ledger newest version   20260909b
absent_of_expected      ["20260918","20260919","20260920","20260921","20260922"]
```

…yet every object those five migrations create **exists** in the database
(§4.1–4.3). The inescapable conclusion is that they were applied by direct SQL
(the Management API query endpoint does not write migration history) rather than
through the tracked migration path.

**Consequence:** `supabase db push` from this repository would attempt to apply
`20260918`–`20260922` a second time. Depending on how idempotent each statement
is, that ranges from harmless to a hard failure part-way through, and it would
leave the ledger claiming a history that does not match what actually ran.

**Not fixed here, deliberately.** Choosing between "apply through the tracked
path" and "record the already-applied versions as applied" is a decision about
production data that needs the operator's intent, and the standing rule for this
phase is to avoid blind re-application to production. Recommended resolution,
in order of preference:

1. `supabase migration repair --status applied 20260918 20260919 20260920 20260921 20260922`
   (records what is already true, changes no data — preferred), **or**
2. diff the live schema against the migrations and re-apply only what is missing.

Either way, verify with `scripts/sql/billing_state_check.sql` afterwards.

---

## 7. Deployment blocker B2 — no live Stripe TEST-mode E2E

There is **no automated** live Stripe test anywhere in the repository
(`grep -rl "api.stripe.com"` matches only `supabase/functions/_shared/stripe.ts`
and its unit test, which stubs the network). `STRIPE_PRODUCTION_SETUP.md` §6.2 /
§6.3 / §6.4 describe the card + clock matrix, failure injection and live cutover
as **manual** procedures.

No outbound Stripe call was made in this session and no test-mode key is
configured, so:

```text
UNVERIFIED — Stripe TEST-mode end-to-end (checkout → webhook → entitlement →
             UI → customer portal → cancellation/renewal/payment failure)
             has not been executed by me against a real Stripe account.
```

**Configuration defect found while checking this.** A blank key named
`STRIPE_TEST_SECRET_KEY` is present in `.env.local`, but **no code in this
repository reads that name**. The server reads `STRIPE_SECRET_KEY`
(`supabase/functions/_shared/stripe.ts`), alongside `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_*` and `SUPABASE_*`. To run the §6.2 matrix, the correct key name
must be used, and for deployed functions the value must be set as a **Supabase
Edge Function secret** (the workspace `.env` only feeds local processes and the
preview).

---

## 8. What was verified vs. what was not

| Item | Status |
|---|---|
| Branch / HEAD / ahead-behind / tree contents | **VERIFIED** |
| `bunx tsc -b --noEmit` clean | **VERIFIED** |
| Full suite 2188 passed / 5 skipped / 0 failed | **VERIFIED** |
| Billing SQL merge: insert, newer, stale-ignored, invoice family, resume, reverse order | **VERIFIED live** |
| anon + authenticated refused by the live RPC | **VERIFIED live** |
| Smoke test persists nothing | **VERIFIED live** |
| Live RPC ACLs (billing, content, integration) | **VERIFIED live** |
| Expected tables exist with RLS | **VERIFIED live** |
| `billing_state` column present on `tenants` | **VERIFIED live** |
| Migration ledger contains 20260918–20260922 | **FALSE — blocker B1** |
| Edge Function static integrity (truncation / imports / signature posture) | **VERIFIED, mutation-proven** |
| Edge Function semantic type-check (`deno check`) | **UNVERIFIED — deno unavailable** |
| Edge Function runtime behaviour of entry points | **UNVERIFIED — requires Deno/remote modules** |
| Stripe TEST-mode live E2E | **UNVERIFIED — blocker B2** |
| Production deploy / live-mode cutover | **NOT PERFORMED** (out of scope for this phase) |
| `integration.process_event` consumer | **Still absent** (intentionally not built) |
| Connector implementations (Gmail, WhatsApp, JobNimbus, Xactimate, …) | **Intentionally unimplemented** |

---

## 9. Files added this session

| File | Purpose |
|---|---|
| `src/lib/security/edge-functions-integrity.test.ts` | Edge Function CI ratchet (5 tests, mutation-proven) |
| `scripts/sql/billing_state_check.sql` | Reusable read-only live state + rollback proof |
| `ATLAS_PRODUCTION_SIGNOFF.md` | This report |

`scripts/sql/billing_upsert_subscription_smoke.sql` already existed in the tree
from the previous turn and is what produced the §4.1 results.

No application, billing, UI, authentication or migration file was modified. The
two blockers are configuration/operational, not code defects.
