# ATLAS — Final Live Deployment & Production Readiness Verification

**Date:** 2026-09-25
**Baseline claimed:** `main` @ `d6c2f70`
**Method:** every claim below came from a command run against the repository, the
live Supabase project, or the deployed Edge Functions in this session. Where
something could not be verified, it is marked **UNVERIFIED** and the reason is
given. No application code, migration, or grant was changed.

---

## 1. Repository

| Item | Result |
|---|---|
| Branch | `main` |
| HEAD | `d6c2f70f26c88f531eec9da517c09d3e3f1d8283` |
| `origin/main` | `d6c2f70f26c88f531eec9da517c09d3e3f1d8283` |
| `git diff HEAD origin/main` | identical (exit 0) |
| Ahead / behind | 0 / 0 |
| Working tree | **clean for tracked files** — `git diff` and `git diff --cached` both empty |
| TypeScript (`bunx tsc -b --noEmit`) | **PASS** (no diagnostics, exit 0) |
| Vitest (`bunx vitest run`) | **2188 passed / 5 skipped / 0 failed** (115 files) |

The previously reported baseline is **reproduced exactly** on this commit. The 5
skips are the live-gated `archive-live`, `phase15-live`, `reliability-live`,
`tenant-live` and `governance-live` e2e files.

**Untracked additions (verification tooling only, no application code):** eleven
read-only SQL scripts under `scripts/sql/` (`migration_reconciliation.sql`,
`privilege_posture.sql`, `anon_exposure.sql`, `anon_critical.sql`,
`exposed_fn_bodies.sql`, `email_accounts_columns.sql`, `ledger_dump.sql`,
`webhook_idempotency_probe.sql`, `webhook_events_columns.sql`,
`webhook_events_constraints.sql`, `rollback_and_caller_check.sql`). Nothing else
in the tree changed.

---

## 2. Supabase Migration State

### Repository endpoint vs live ledger endpoint

```text
repository: 52 migration files, newest 20260922_atlas_integration_foundation.sql
live ledger: 44 rows, newest version 20260909b
```

**Seven repository migrations are absent from the live ledger:**

```text
20260913_atlas_platform_infrastructure        <- not previously suspected
20260918_atlas_security_hardening
20260919_atlas_regulatory_schema_reconciliation
20260919_atlas_stripe_billing
20260920_atlas_blog_publishing
20260921_atlas_billing_subscription_merge
20260922_atlas_integration_foundation
```

Two further entries differ only by version string (same migration, renamed):
repo `20260906_atlas_regulatory_intelligence` ↔ ledger `20260906192230`, and repo
`20260909_atlas_findings_evidence_jsonb` ↔ ledger `20260909a`.

### Actual live schema (verified object-by-object, not inferred from the ledger)

| Migration | In repo | In ledger | Objects actually present | Verdict |
|---|---|---|---|---|
| 20260913 | YES | NO | **4/4** present (tables `atlasContentItems`, `atlasContentProvenance`, `connections`, `connectiontokens`) | applied out-of-band |
| 20260918 | YES | NO | **26/36** — all 10 objects it *introduces* are **ABSENT** | **NOT applied** |
| 20260919 (stripe) | YES | NO | **11/11** (3 functions, 4 indexes, 4 columns) | applied out-of-band |
| 20260919 (regulatory) | YES | NO | **19/19** (9 tables, 1 function, 9 indexes) | applied out-of-band |
| 20260920 | YES | NO | **14/14** (2 tables, 6 RPCs, 6 indexes) | applied out-of-band |
| 20260921 | YES | NO | **1/1** (`billing_upsert_subscription`) | applied out-of-band |
| 20260922 | YES | NO | **28/28** (5 tables, 13 RPCs, 10 indexes) | applied out-of-band |

**Why 20260918 is "not applied" and not "partially applied":** the 26 functions
reported present are objects that *earlier, already-applied* migrations created
(`0020_atlas_jobs`, `0021_atlas_human_reviews`, `202608241`, `20260824`) and that
20260918 would merely re-create. Every object 20260918 *adds* is missing:

```text
plan_seat_limits, org_seat_limit, org_seat_status,
atlas_is_trusted_server, atlas_assert_trusted_server,
atlas_is_internal_admin, atlas_assert_internal_admin,
atlas_can_access_tenant, atlas_assert_tenant_access, atlas_caller_tenants
```

That is a clean, un-applied migration — **not** a partial application. This
matches the deployment note already written into `20260921`, which inlines the
trusted-server predicate *because* `atlas_is_trusted_server` does not exist. That
inlining decision is confirmed correct, and was live-proven by the earlier
billing smoke test (cases G/H: `anon` and authenticated both refused).

### Exact action taken

**None.** No migration was applied, no ledger row was written, no grant changed.
This was a read-only audit by design — see §6 B1/B2 for why remediation needs an
operator decision. `supabase db push` was **not** run and must not be run against
this project as-is: it would attempt to re-apply seven migrations whose objects
already exist.

---

## 3. Edge Functions

Live evidence from HTTPS probes against
`https://ibxvzxblyhzwokljkslt.supabase.co/functions/v1/<fn>`. Response *bodies*
(not just status codes) were inspected, because a bare 404 is ambiguous.

| Function | Source exists | Deployed | Live response | Verdict |
|---|---|---|---|---|
| `integrations-oauth` | YES | **YES** | `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}` | JWT verification enforced at the gateway (`verify_jwt = true`) |
| `integrations-webhook` | YES | **YES** | unknown provider → `404 {"error":"Unknown integration provider …"}`; valid path, no/forged signature → `401 {"error":"Webhook signature verification failed.","reason":"missing_secret"}` | fail-closed; signature verification enforced |
| `stripe-webhook` | YES | **YES** | no signature → `401 {"error":"Signature verification failed."}` | live signature verification confirmed |
| `stripe-checkout` | YES | **YES** | `401` | JWT verification enforced (`verify_jwt = true`) |

An earlier bare `404` on `integrations-webhook` was **not** a missing function —
inspecting the body showed it was the function's own fail-closed reply to a
malformed provider path. Recorded because the status code alone would have led to
the wrong conclusion.

Structural audit of `integrations-webhook` against the required properties:

- **Authentication** — provider signature, verified *before* any work (source
  order: payload guard → signature verify → connection load); `verify_jwt = false`
  in `supabase/config.toml` with the config comment explaining why.
- **Authorization / tenant isolation** — the organization is taken from **Atlas's
  own connection row** (`p_organization_id: connection.tenantId`), never from the
  request: "A provider (or attacker) cannot choose the tenant."
- **Idempotency** — `integration_event_ingest` dedupes; duplicates log
  `webhook.duplicate_ignored` and are not re-processed.
- **Error handling** — missing/invalid signature is `401` and does **no** work;
  an unresolvable connection returns `202 organization_unresolved` (no work);
  Atlas-side failures return `500` so the provider retries.
- **Logging** — structured events (`webhook.signature_rejected`,
  `webhook.connection_unknown`, `webhook.duplicate_ignored`) carrying reasons, not
  payloads or secrets.
- **Secrets** — read server-side via `webhookSecretFor(provider)`; never returned.
  The live `reason` value is a category (`missing_secret`), not a secret.

Authority/authorization for `integrations-oauth`: gateway-enforced JWT, and the
repo ratchet `src/lib/security/migration-privileges.test.ts` pins
`integrations-webhook` as the single sanctioned `jobs_create_job` server producer.

```text
UNVERIFIED — that the deployed bundle byte-matches the current repository source.
             No Supabase CLI, Deno or Docker in this sandbox, so no deployment
             hash or local bundle could be compared. The deployed responses match
             the repository's own error strings, so drift is unlikely but is not
             proven.
```

**Deployment capability:** the repository's established mechanism
(`scripts/deploy-conversation-converse.mjs` → `supabase functions deploy`) cannot
run here — `supabase`, `deno` and `docker` are all absent. This did not block the
verification, because both functions are **already deployed**.

---

## 4. Stripe TEST E2E

**Not executed.** The required credential is not present in this workspace, so per
the rules the phase stopped rather than being simulated.

Configuration the code actually reads (verified by inspection, names only):

| Purpose | Variable | Present in workspace |
|---|---|---|
| Checkout / API auth | `STRIPE_SECRET_KEY` | **ABSENT** |
| Webhook signature | `STRIPE_WEBHOOK_SECRET` | **ABSENT** |
| Plan prices (6) | `STRIPE_PRICE_{STARTER,GROWTH,SCALE}_{MONTHLY,YEARLY}` | **ABSENT** |
| API version (optional) | `STRIPE_API_VERSION` | absent |

- **Mode is derived from the key itself:** `stripeSecretKey().startsWith("sk_live_") ? "live" : "test"`. There is no separate mode flag, so a live key with test price ids would fail at Stripe rather than silently billing — but there is nothing preventing a mixed-mode *configuration*.
- **Signature verification is enabled and working** — proven live by the deployed `stripe-webhook` returning `401 Signature verification failed.`, with a 300 s tolerance constant in `_shared/stripe.ts`.
- **The one Stripe-named variable in the environment, `STRIPE_TEST_SECRET_KEY`, is read by no code anywhere in the repository.** It is blank and inert; it proves nothing about Stripe readiness.

Not executed, therefore unverified: checkout session creation, test payment,
webhook receipt, subscription persistence, entitlement grant, access, and
cancellation / `past_due` / payment-failure transitions.

**What a real E2E additionally requires beyond the env vars:** the same keys set
as **Supabase Edge Function secrets** (workspace `.env` values do not reach
deployed functions), a Stripe webhook endpoint registered to the deployed
`stripe-webhook` URL with its signing secret, the six Price objects existing in
the Stripe account, and a browser session to complete hosted Checkout. A value
for the test secret key was shared earlier in this conversation; it is not in the
workspace, and I did not assume it is still valid.

**Idempotency was verified live without Stripe** (see §5).

---

## 5. Security

### CRITICAL — live, unauthenticated cross-tenant credential read

`public.email_accounts_get_credentials(uuid)` is executable by `anon`, and its
**live** definition carries no authorization check of any kind:

```sql
CREATE OR REPLACE FUNCTION public.email_accounts_get_credentials(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
 DECLARE v_account jsonb;
 BEGIN
   SELECT row_to_json(a) INTO v_account FROM public.email_accounts a WHERE a.id = p_id;
   RETURN v_account;
 END; $function$
```

Evidence: `proacl = "=X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres"` — the leading `=X/postgres` is **PUBLIC**, and
`has_function_privilege('anon', …)` returns **true**. `SECURITY DEFINER` bypasses
RLS. The returned row includes `encrypted_credentials`,
`encrypted_credentials_reference`, `email_address`, `imap_host`, `smtp_host`.

Because the anon key ships in the browser bundle, this is reachable by any
unauthenticated caller through PostgREST with an arbitrary account id. The
repository's own test header names this exact function as the reason 20260918
exists, and its ratchet asserts the *migration* scopes the function to the
caller's tenant — but that migration was never applied, so deployed reality and
repository intent disagree.

**Blast radius today: limited.** `select count(*) from public.email_accounts`
returned **0**, so there is currently no customer data to read. The exposure
becomes real the moment any mailbox is configured.

**I did not exploit it.** Proving reachability did not require reading customer
rows, and performing the read would itself have been a data breach.

Related, same root cause: **276 public functions are `anon`-executable**.

### The worst-possible case is CLOSED

Checked individually because a client-callable billing-state writer is the
severity ceiling:

| Function | `anon` | `authenticated` |
|---|---|---|
| `tenants_activate_after_payment` | false | false |
| `tenants_handle_payment_failure` | false | false |
| `tenants_handle_subscription_cancelled` | false | false |
| `billing_apply_state` | false | false |
| `billing_upsert_subscription` | false | false |
| `billing_get_state` | false | true (intended client read path) |

So an unauthenticated caller **cannot** grant itself paid access. The billing
surface is correctly locked; the exposure is confined to the pre-hardening RPCs.

`admin_update_user_role` is `anon`-executable **but guards itself** — its live body
begins `IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Access denied…'`. The
in-function check holds, so it is not exploitable (defence in depth worked here).

### Other security results

| Check | Result |
|---|---|
| Webhook signature verification | **enforced live** — `stripe-webhook` 401 on unsigned; `integrations-webhook` 401 on missing/forged |
| New integration RPCs (`integration_event_ingest`, `connections_register`, `integration_oauth_state_*`) | service_role-only, `anon`/`authenticated` denied |
| New content RPCs | public read anon+authenticated; admin RPCs authenticated-only |
| CORS | origin allowlist in `_shared/edge-auth.ts`; unknown origins receive **no** `Access-Control-Allow-Origin` header |
| Webhook idempotency | **live-proven**: duplicate `(provider, provider_event_id)` insert rejected by the unique index → `IDEM_OK`; enforced by a unique *index* (hence absent from `pg_constraint`) |
| Probe hygiene | probe rows left behind: **0**; `processed_webhook_events` unchanged (19 rows) |
| Repo secret scan | only deliberate non-production fixtures (`sk_live_ABCDEFGHIJKLMNOP` as a redaction input in `content-publish.test.ts`, `whsec_*_test_*`, `sk_test_atlas`) |
| Logging | categories/reasons only; no secrets in responses or logs |
| Unsafe dynamic SQL | none introduced by the verified workstreams |

**Hygiene finding (not a credential leak):** `.freebuff/` is **tracked** and
contains local artefacts — debug scripts holding a JWT-shaped *demo* anon key
(`"iss": "supabase-demo"`), `desktop-v2.db`, and a `.log.err`. An anon key is
public by design, but the directory is scratch space and should not be in version
control.

---

## 6. Remaining Blockers

### B1 — Live unauthenticated credential-read exposure (CRITICAL)

- **Issue:** `email_accounts_get_credentials` is `anon`-executable, `SECURITY DEFINER`, and unguarded; 276 RPCs are likewise `anon`-executable. The migration that revokes this (`20260918`) was never applied.
- **Why it matters:** any unauthenticated caller can read any mailbox row including its encrypted credential blob, by id. Not shippable.
- **Prevents production deployment:** **YES.**
- **Next action (operator decision — I stopped rather than guess):** either
  1. apply `20260918_atlas_security_hardening.sql` deliberately (its own objects must all appear; note that its `jobs_create_job` body calls `atlas_is_trusted_server()`, which the same file defines ~800 lines later — fine for `plpgsql` resolution at run time, since both land in one transaction), **or**
  2. authorise a surgical, reversible `revoke execute … from public, anon, authenticated` + `grant execute … to service_role` for the exposed functions.

  I did **not** apply option 2 on my own: a one-function revoke would create exactly the *partially applied* 20260918 state this task forbids, and would deepen the divergence between the live schema and the ledger. Choosing between the options is yours, not mine. Note there is **no client caller** of `email_accounts_get_credentials` in `src/`, so either option is app-safe.

### B2 — Migration ledger divergence (7 migrations)

- **Issue:** 20260913, 20260918, 20260919 ×2, 20260920, 20260921, 20260922 are absent from `supabase_migrations.schema_migrations`; six of them have their objects live, one (20260918) does not.
- **Why it matters:** `supabase db push` would try to re-apply all seven. Any future migration sorted below `20260922` is invisible to the tracked path, so the ledger can no longer be trusted as a statement about production.
- **Prevents production deployment:** **YES** — it blocks every future tracked migration.
- **Next action:** after B1 is decided, record reality for the six already-live migrations — `supabase migration repair --status applied 20260913 20260919 20260920 20260921 20260922` — and apply **20260918** for real. **Never** `db push` first. Verify afterwards with `scripts/sql/migration_reconciliation.sql`; the correct end state is every listed migration reporting `missing_count: 0`.

### B3 — Stripe TEST-mode E2E never executed

- **Issue:** no Stripe credentials in the workspace; no browser; the edge secrets, Stripe Prices and webhook endpoint are not confirmed to exist.
- **Why it matters:** the complete billing lifecycle is unproven end-to-end against real Stripe.
- **Prevents production deployment:** **YES** for paid billing; the rest of the product is unaffected.
- **Next action:** provide `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (test) and the six `STRIPE_PRICE_*` ids **as Supabase Edge Function secrets**, confirm the six Prices exist in the Stripe test account and a webhook endpoint is registered to the deployed `stripe-webhook`, then I will drive the E2E. The blank `STRIPE_TEST_SECRET_KEY` should be deleted — no code reads it.

### B4 — Integration webhook provider secrets unconfigured

- **Issue:** `integrations-webhook` returns `reason: "missing_secret"` for Stripe, i.e. no per-provider webhook secret is set, so it rejects **all** deliveries.
- **Why it matters:** the integration platform cannot receive events.
- **Prevents production deployment:** **NO** — fail-closed is the correct default and the feature is not yet reachable from the UI.
- **Next action:** set the per-provider webhook secrets when each connector is implemented.

### B5 — Deployed bundle vs repository source

- **Issue:** no CLI/Deno/Docker, so the deployed Edge Function code could not be hash-compared with `main`.
- **Why it matters:** a deployed function could be older than the repository.
- **Prevents production deployment:** **NO** (behavioural probes passed) — but closing it is cheap.
- **Next action:** run `supabase functions deploy` from an environment with the CLI, then re-probe.

---

## 7. Final Status

### BLOCKED — SAFE STOP

The code and the automated gates are genuinely green (TypeScript clean;
2188 passed / 5 skipped / 0 failed, reproduced). Live verification also passed
where it could run: the deployed Stripe webhook verifies signatures, the deployed
integration webhook fails closed, all four Edge Functions are live, and Stripe
webhook idempotency was proven against the real unique index with nothing
persisted.

But I stopped before changing production infrastructure, for two reasons: a
**live, unauthenticated credential-read exposure exists** (B1) whose fix is a
migration-versus-surgical-revoke decision that must not be guessed, and the
**migration ledger is diverged** (B2) such that `db push` would re-apply seven
migrations. Closing B1 without deciding B2 would produce a partially applied
migration — the exact condition this task forbids. Stripe's E2E (B3) remains
unverified for want of credentials.

Six of the seven diverged migrations exist live and only need recording; the
seventh, `20260918`, genuinely needs applying. Resolve B1 + B2 and supply the
Stripe test credentials, and this becomes **VERIFIED — READY FOR PRODUCTION
DEPLOYMENT**. Nothing else outstanding is a code defect.

---

## Appendix — reproducible commands

```bash
# repository gates
bunx tsc -b --noEmit
bunx vitest run

# live, read-only
bun scripts/run-db-sql.mjs scripts/sql/ledger_dump.sql
bun scripts/run-db-sql.mjs scripts/sql/migration_reconciliation.sql
bun scripts/run-db-sql.mjs scripts/sql/privilege_posture.sql
bun scripts/run-db-sql.mjs scripts/sql/anon_critical.sql
bun scripts/run-db-sql.mjs scripts/sql/exposed_fn_bodies.sql

# live, self-rolling-back
bun scripts/run-db-sql.mjs scripts/sql/billing_upsert_subscription_smoke.sql   # SMOKE_OK
bun scripts/run-db-sql.mjs scripts/sql/webhook_idempotency_probe.sql           # IDEM_OK
bun scripts/run-db-sql.mjs scripts/sql/rollback_and_caller_check.sql           # probe_rows_left = 0

# live edge-function probes
REF=ibxvzxblyhzwokljkslt
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://$REF.supabase.co/functions/v1/stripe-webhook -d '{}'
curl -s -X POST https://$REF.supabase.co/functions/v1/integrations-webhook/00000000-0000-0000-0000-000000000000/stripe -d '{"id":"evt_probe"}'
```
