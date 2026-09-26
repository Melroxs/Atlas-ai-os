# ATLAS — Production Blocker Resolution (B1 / B2)

**Date:** 2026-09-26
**Baseline:** `main` @ `d6c2f70` (working tree clean for tracked files)
**Method:** every statement below is backed by a command run against the linked
Supabase project (`ibxvzxblyhzwokljkslt`) or the repository in this session.
Anything that could not be verified is marked **UNVERIFIED** with the reason.

---

## 1. Production migration result

| Item | Result |
|---|---|
| B1 — credential-read exposure | **RESOLVED** |
| B2 — migration ledger divergence | **RESOLVED** (all fully-live migrations recorded) |
| Migration applied | `20260918_atlas_security_hardening.sql` (in full, atomic) |
| Ledger repaired | `20260918`, `20260919`, `20260920`, `20260921`, `20260922` |
| Ledger size | 44 → **49** rows |
| Still absent from ledger | `20260913_atlas_platform_infrastructure` (see §6 — not safely reconcilable) |

### How 20260918 was applied

`supabase db push` was **not** used (it would attempt to re-apply six migrations
whose objects already exist). The migration was applied atomically through
`scripts/apply-migration.mjs`, which wraps the file in an explicit
`begin; … commit;` and posts it to the Supabase Management API
(`POST /v1/projects/{ref}/database/query`). A trivial probe confirmed the API
honours the explicit transaction before the real apply. Result: `HTTP 201`.

### Apply-order compensation (required, and important)

`20260918` sorts **before** `20260919`–`20260922`, which were already live. Two
of its statements therefore fought the later migrations, and both were
compensated immediately:

1. **`content_public_get(text)` lost its `anon` grant.** 20260918's blanket
   `revoke execute … from public, anon, authenticated` strips the grant 20260920
   makes. Restored (`scripts/sql/apply_20260918_ordering_fix.sql`). The function
   is SECURITY INVOKER and reads only published blog rows — no new data access.
   (It is also called by **no** code; the public blog reads the table directly.)

2. **11 functions later made service-only were re-opened to `authenticated`.**
   20260918 section 4c blind-grants `authenticated` to every function that is not
   in *its own* service-only list — a list written before 20260921/20260922.
   Applying it after them re-opened:
   `billing_upsert_subscription` (20260921) and `connections_register`,
   `connections_set_status`, `connections_raw`, `integration_oauth_state_create`,
   `integration_oauth_state_consume`, `integration_event_ingest`,
   `integration_event_finish`, `integration_external_ref_upsert`,
   `integration_sync_state_upsert`, `integration_provider_settings_upsert`
   (20260922). Restored
   (`scripts/sql/apply_20260918_serviceonly_compensation.sql`), driven off
   `pg_proc` exactly like 20260918's own section 4e.

   This regression was **confirmed live before the fix** (`connections_register`
   and `integration_event_ingest` showed `authenticated=true`) and **confirmed
   gone after** (`scripts/sql/service_only_verification.sql` → `violations: []`).

Both compensation scripts reproduce the exact end state that applying all
migrations in order would produce; neither adds any grant beyond that.

---

## 2. Security result

`email_accounts_get_credentials(uuid)` — the anon-executable, unguarded
`SECURITY DEFINER` reader of `encrypted_credentials`:

| Role | Before | After |
|---|---|---|
| `anon` | **true** | **false** |
| `authenticated` | **true** | **false** |
| `PUBLIC` grant | **true** (`=X/postgres`) | **false** |
| `service_role` | true | true |

`proacl` after: `postgres=X/postgres | service_role=X/postgres`.
**The anonymous exposure is closed.**

Other live results:

- `anon`-executable public functions: **276 → 18**, all benign
  (`scripts/sql/anon_allowlist_check.sql` → `not_in_allowlist: []`,
  `allowlist_not_granted: []`). The 18 are the 8 RLS predicate helpers,
  `pilot_apply`, `content_public_list`, `content_public_get`, and 7 new
  `atlas_*` predicates.
- Note: the 7 `atlas_*` helpers are `PUBLIC`-granted because they are created in
  section 5b, after section 4's privilege normalisation, and inherit the
  pre-existing default ACL (20260918's `alter default privileges` change does not
  affect the creating role). They expose **no data** — each returns a boolean or
  an empty array and evaluates to false/empty for a non-server caller — and RLS
  policies on tenant tables may need to evaluate them during an anon query. They
  are accepted deliberately and listed explicitly in the allowlist check.
- Billing-state writers (`billing_apply_state`, `tenants_activate_after_payment`,
  `tenants_handle_payment_failure`, `tenants_handle_subscription_cancelled`,
  `billing_upsert_subscription`): `anon=false`, `authenticated=false`,
  `service_role=true`.
- Worker-owned job lifecycle (`jobs_dequeue`, `jobs_complete_job`,
  `jobs_fail_job`, `jobs_*`): `service_role` only.
- Integration RPCs (`connections_register`, `integration_event_ingest`, …):
  `service_role` only.
- `billing_get_state` / `users_current_user` / `admin_update_user_role` keep
  `authenticated` exactly as designed.

No customer data was read: `email_accounts` row count stayed **0** before and
after. The vulnerability was proven reachable, never exploited.

---

## 3. Schema verification (20260918)

All 10 objects 20260918 *introduces* are present live
(`scripts/sql/migration_reconciliation.sql` → `20260918: expected 10, present 10`):

`plan_seat_limits`, `org_seat_limit`, `org_seat_status`,
`atlas_is_trusted_server`, `atlas_assert_trusted_server`,
`atlas_is_internal_admin`, `atlas_assert_internal_admin`,
`atlas_can_access_tenant`, `atlas_assert_tenant_access`, `atlas_caller_tenants`.

---

## 4. Regression verification

| Check | Result |
|---|---|
| `bunx tsc -b --noEmit` | **clean** (exit 0) |
| `bunx vitest run` | **2188 passed / 5 skipped / 0 failed** (115 files) — baseline reproduced |
| `anon_critical.sql` | all billing writers `anon=false`, `authenticated=false` |
| `service_only_verification.sql` | `checked: 50`, `violations: []`, `not_service_role: []` |
| `client_rpc_access_check.sql` | `checked: 43`, `denied: []`, `absent: []` (no over-revocation) |
| `anon_allowlist_check.sql` | `not_in_allowlist: []`, `allowlist_not_granted: []` |
| `migration_reconciliation.sql` | only `20260913` has missing objects; every other migration `missing_count: 0` |
| Data counts | `tenants 23`, `email_accounts 0`, `organization_subscriptions 2` — unchanged |

19 objects the previous reconciliation script omitted were added to it and are
now checked: all of 20260913's functions/index/nullability change, two 20260913
tables, and all 11 of 20260922's added columns (all 11 present).

---

## 5. Git result

| Item | Value |
|---|---|
| HEAD (before) | `d6c2f70` |
| Files changed | verification/report artifacts only — **no application source changed** |
| Working tree | see commit below |

Committed artifacts: this report, `ATLAS_LIVE_DEPLOYMENT_VERIFICATION.md`, the
read-only SQL checks under `scripts/sql/`, the two write compensations, the
ledger repair, and `scripts/apply-migration.mjs`. No credentials, no
`.freebuff/` artifacts, no build output.

---

## 6. Remaining blockers

### R1 — `20260913_atlas_platform_infrastructure` is only PARTIALLY applied (operator decision)

- **Exact issue:** the live database contains only **4** of its objects
  (`atlasContentItems`, `atlasContentProvenance`, `connections`,
  `connectiontokens`). **Absent:** tables `atlas_schedules` and
  `authoritativeSourceChecks`; index `idx_atlas_jobs_platform_idempotency`; the
  `atlas_jobs.tenant_id` nullability relaxation (still `NOT NULL`); and all 20 of
  its functions (`schedules_*`, `sources_*`, `knowledge_*`, `content_*`).
  Reconciliation: **5 / 27** objects present.
- **Why it matters:** the previous report classified it "applied out-of-band"
  because its object list was incomplete. It is not applied. Recording it as
  applied would be false (rule: never mark a migration applied unless its schema
  changes are demonstrably present), so it was deliberately **left unrecorded**.
- **Prevents production deployment:** **NO** — the missing objects are unused
  (`src/lib/platform` is imported by no application code; `PlatformOps.tsx` is
  not routed). The tables 20260920/20260922 depend on are present.
- **Exact next action:** decide between (a) applying 20260913 for real — noting
  its functions are unguarded and would then need the 20260918 privilege model
  re-asserted for them (they sit in its `v_service_only` list), or (b) treating
  the platform infrastructure as intentionally retired and deleting
  `20260913`/`20260920`'s dead dependency. Do **not** simply mark it applied.

### R2 — Stripe TEST-mode E2E (pre-existing, unchanged)

- No `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_*` in the
  workspace; a value for `STRIPE_TEST_SECRET_KEY` is read by no code.
- **Prevents production deployment:** **YES** for paid billing.
- **Next action:** set the six `STRIPE_PRICE_*` (+ `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`) as **Supabase Edge Function secrets**, register a test
  webhook endpoint, then drive the E2E. Not touched by this task.

### R3 — integration webhook per-provider secrets unset (pre-existing)

`integrations-webhook` returns `missing_secret` and fails closed. Not a code
defect; sets when each connector is implemented.

### R4 — deployed Edge Function bundle vs repository source (pre-existing)

`UNVERIFIED` — no `supabase`/`deno`/`docker` in this sandbox, so no bundle hash
comparison. Behavioural probes pass. Not affected by this task.

### R5 — the 7 `atlas_*` helpers are `PUBLIC`-granted (benign, noted)

See §2. No data access. Closing this properly would be a **new** security policy
(not part of 20260918), so it was intentionally not applied.

---

## 7. Final status

### BLOCKED — SAFE STOP

**B1 is fully resolved:** `email_accounts_get_credentials` is no longer
executable by `anon`, `authenticated` or `PUBLIC`, and the 276-function anon
exposure is reduced to a benign 18-function allowlist — verified live.
**B2 is resolved for every migration proven live:** the ledger now records
`20260918`, `20260919`, `20260920`, `20260921`, `20260922`, and the corrected
reconciliation reports `missing_count: 0` for all of them.

The stop is for one item: **`20260913` is partially applied** and cannot be
reconciled without an operator decision (§6 R1) — recording it would be false,
and applying it is a separate change with its own privilege implications. No
unsafe or partial change was left behind: the migration applied cleanly, both
order-compensation steps are in place, and every security probe passes.
