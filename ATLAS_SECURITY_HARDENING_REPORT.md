# Atlas — Truncation Repair & Security Hardening Report

**Branch:** `fix/repair-truncated-files`
**Canonical baseline:** `b1271b5d48de3261c0750356b94665bc9b9e3b1b` (remote `main`)
**HEAD during this work:** `b1271b5d` (all changes left uncommitted for the Changes panel)
**Remote `main`:** unchanged, still `b1271b5d`. Nothing pushed. No tag touched.

---

## 1. CHANGES MADE

10 files. 3 repaired, 7 hardened. No UI, no refactor, no dependency change.

### Repairs (the three truncated files)

| File | Defect | Repair |
| --- | --- | --- |
| `src/components/RequireInternalAuth.tsx` | truncated mid-file: lost the `InternalSection` type, the `superadmin` case, the `default: return false` safety net, and every closing brace | restored the type union, the `superadmin` branch (`case → canAccessSuperAdmin(role)`), the fail-closed `default`, closers, and the `canAccessSuperAdmin` import |
| `src/main.tsx` | 11 lazy imports deleted while their `<Route>`s remained; one route body deleted leaving an orphaned `<Route …>` | restored the 10 imports whose components were still rendered, plus `SuperAdminOrgs` and its `/dashboard/orgs` route in place of the orphaned tag |
| `src/components/app-shell.tsx` | `Server`, `Send`, `isInternalRole` used but never imported | added `Server`/`Send` to the `lucide-react` import and `isInternalRole` to the `@/lib/auth/access-gate` import |

### Hardening

| File | Change |
| --- | --- |
| `supabase/migrations/20260913_atlas_platform_infrastructure.sql` | removed `grant execute on all functions in schema public to anon, authenticated, service_role;` and replaced its misleading rationale comment |
| `supabase/migrations/0007_grants.sql` | removed `anon` (and the `alter default privileges` re-application) from the routine grants — this is where the exposure actually originated |
| `supabase/migrations/20260918_atlas_security_hardening.sql` | **new.** Credential/outreach IDOR fixes, the seat authority, the corrected EXECUTE policy, tenant scoping for the human-approval and job RPCs, and the provenance read narrowing |
| `src/lib/billing/entitlements.ts` | **new.** Runtime enforcement of the existing plan-seat model (fail-closed, tenant-aware) |
| `src/lib/billing/entitlements.test.ts` | extended — allowed/denied behaviour, fail-closed paths, and a parity guard against `plans.ts` |
| `src/lib/security/migration-privileges.test.ts` | **new.** 62 regression tests that read the migration SQL directly and fail if the exposure returns |
| `supabase/functions/admin-provision-user/index.ts` | enforces the seat authority **before** any invitation email is sent |

---

## 2. SECURITY FINDINGS

### 2.1 CRITICAL — blanket EXECUTE to `anon` (fixed)

`20260913_atlas_platform_infrastructure.sql` ended with a blanket grant to `anon, authenticated, service_role`, and `0007_grants.sql` had already granted `all on all routines` to `anon` plus an `alter default privileges` that re-applied it to every future function.

Its stated rationale — *"Row Level Security remains the real gate"* — is **wrong for `SECURITY DEFINER` functions, which execute as the definer and therefore bypass RLS entirely.** With that grant, an unauthenticated caller could:

- `tenants_activate_after_payment(any_uuid)` — sets `billing_state = 'active'` for **any** organization, with no authorization check inside the function at all. Unauthenticated payment bypass.
- `email_accounts_get_credentials(any_uuid)` — returns the full `email_accounts` row **including `encrypted_credentials`**, for any id.
- `outreach_records_update_status(...)` — cross-tenant write to any tenant's outreach records.
- `billing_apply_state`, `tenants_handle_payment_failure`, `tenants_handle_subscription_cancelled` — billing-state tampering.

**Fix:** revoke EXECUTE from `PUBLIC`, `anon` and `authenticated` for every function in `public`, then re-grant by explicit policy (revoking from `anon` alone is insufficient — Postgres grants EXECUTE to `PUBLIC` by default and `anon` inherits through it). The re-grant loops are driven off `pg_proc`/`pg_namespace` at migration time, so **every overload is covered regardless of how a function is declared** — the static inventory below is a review aid, not the mechanism.

### 2.2 HIGH — credential IDOR (fixed)

`email_accounts_get_credentials` had no tenant scoping. Now: `service_role` only, and for any caller with a user JWT the row must belong to the caller's workspace (`get_current_tenant_id()`), otherwise `42501`.

### 2.3 HIGH — cross-tenant outreach write (fixed)

`outreach_records_update_status` updated by `provider_message_id` with no tenant scope and no status validation. Now validated against the table's own `CHECK` allowlist and restricted to `service_role` (its documented caller is a delivery-webhook callback).

### 2.4 HIGH — human-approval boundary was cross-tenant (fixed)

`atlas_human_reviews` has `tenant_id` and correct tenant RLS policies — but the eight `human_reviews_*` RPCs are `SECURITY DEFINER`, so **those policies never applied to them**. They filtered only by primary key or a caller-supplied id, and they were reachable straight from the browser by any signed-in user (`src/pages/Reviews.tsx` → `src/lib/jobs/review-rpc.ts`).

- `human_reviews_approve/reject/request_changes` took **`p_reviewer_id` as a parameter** and wrote it straight to `reviewer_user_id` — a caller could approve any tenant's review *and* attribute the decision to an arbitrary user. This is the human-approval gate itself.
- `human_reviews_get`, `human_reviews_list_job` — unscoped reads.
- `human_reviews_list`, `human_reviews_count_pending`, `human_reviews_create` — trusted a caller-supplied tenant id.

**Fix:** a fail-closed authorization layer (`atlas_is_trusted_server` / `atlas_caller_tenants` / `atlas_can_access_tenant` / `atlas_assert_tenant_access`), plus the reviewer identity now taken from `auth.uid()` — `coalesce(auth.uid(), p_reviewer_id)` keeps the server path working while making the parameter unusable for impersonation.

### 2.5 MEDIUM — cross-tenant job access (partially fixed — **fully resolved in §7.2**)

`atlas_jobs` is tenant-owned. `jobs_list_jobs`, `jobs_get_events` and `jobs_resume_from_review` were `SECURITY DEFINER` with no tenant scope. All three are now tenant-scoped. `jobs_resume_from_review` matters because the routed Reviews page calls it to re-queue or cancel a job.

### 2.6 MEDIUM — anonymous read of unpublished provenance (fixed)

The `20260913` policy was `contentprovenance_read … for select to anon using (true)`, so an anonymous caller could read provenance edges for **unpublished** content and learn which knowledge/source ids a draft was built from. Now anonymous callers see provenance only for `published` blog content; `approved` requires a signed-in user.

### 2.7 MEDIUM — plan limits were never enforced (fixed)

The plan-seat model was defined and unit-tested but had **no runtime caller**, so limits did nothing. Now enforced server-side by `org_seat_status` (tenant-aware, fail-closed: an unresolvable plan yields `allowed = false`), called from `admin-provision-user` **before** the invitation is sent. `super_admin` and active `complimentary_access` remain intentional bypasses.

### 2.8 EXECUTE policy — final state

`service_role` — every function. `authenticated` — every function except the service-only set. `anon` — an explicit 10-entry allowlist only: seven RLS predicate helpers (`get_current_tenant_id`, `my_tenant_id`, `is_super_admin`, `is_atlas_admin`, `is_approved_user`, `can_access_atlas`, `is_editor`, `is_manager`) plus the two genuinely public RPCs (`pilot_apply`, `content_public_list`). `PUBLIC` — revoked.

The anon allowlist exists because RLS policies default to `PUBLIC` and are evaluated while serving an anonymous query; without EXECUTE those queries would fail `42501` instead of returning zero rows. The helpers return booleans or the caller's own tenant id — no data access.

### 2.9 SECURITY DEFINER authorization inventory

302 public functions; **186 `SECURITY DEFINER`**; 141 carry an internal authorization check; **45 do not.** Of those 45:

| Exposure after this migration | Count | Functions |
| --- | --- | --- |
| Contained by a `service_role`-only grant (no client role can reach them) | 24 | `billing_apply_state`, `content_{create,get,list,list_provenance,transition}`, `industry_{ingest_corpus,seed_internal}`, `knowledge_{as_of,create_version,versions}`, `outreach_records_update_status`, `schedules_*` (4 of 5), `sources_*` (5), `tenants_{activate_after_payment,handle_payment_failure,handle_subscription_cancelled}`, `email_accounts_get_credentials` |
| Intentionally public (allowlisted) | 4 | `content_public_list`, `pilot_apply`, `is_editor`, `is_manager` |
| **Still `authenticated`, no in-function check** | **17** | the `jobs_*` queue family (14), `ensure_profile`, `handle_new_user`, `org_seat_limit` |

The 45 are the functions that have no internal check. All 186 `SECURITY DEFINER` functions are covered by the catalogue-driven revoke/re-grant regardless.

### 2.10 Corrected finding — `governance_*` is NOT exposed

An earlier automated heuristic flagged the six `governance_*` RPCs as unguarded. **That was a false positive.** They resolve the caller's tenant through `governance_resolve_tenant()`, which raises `caller is not a member of any workspace` unless the caller is a member of the tenant being touched, and permits a different tenant only for `super_admin`. Verified by reading the definitions; a regression test now pins all six to that resolver rather than to a guessing heuristic.

---

## 3. TEST RESULTS

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `bun tsc -b --noEmit` | **0 errors** (was 29 before the repair) |
| Full suite | `bunx vitest run` | **1,971 passed / 5 skipped / 1 failed** (111 files) |
| Security & billing | `bunx vitest run src/lib/security src/lib/billing` | **138 passed** |
| Production build | `bun run build` | **exit 0**, 29.6s |
| Client-bundle secret scan | grep over `dist/assets` | no server-only secret; the single `SUPABASE_SERVICE_ROLE_KEY` hit is the **env-var name** inside admin error copy |
| Blanket grant gone | `grep "grant execute on all functions"` | only in comments / `to service_role` |
| Duplicate `runOnce` | grep `src/lib/jobs/worker.ts` | **exactly 1 definition** — main's own, untouched |
| Competing blog/LinkedIn schema | file checks | absent — no `src/lib/blog`, no `blog-*`/`linkedin-*` edge functions, no `atlas_blog` migration |
| Migration structural check | dollar-quote pairing | 21 blocks (19 functions + 2 DO), all delimiters paired |
| Signature parity | override comparison | all 10 overridden functions keep identical parameters and return types |
| `anon` table grants | RLS coverage scan | all 98 tables have RLS enabled, so table grants stay gated by RLS |

**The one failure is pre-existing and unrelated:** `src/lib/voice-runtime/phase8-live.test.ts:85` — a live NVIDIA network smoke test timing out. Classified ENVIRONMENT/NETWORK. It fails identically at `b1271b5d` before any of this work.

The 62 new security tests are **structural** — they read the migration SQL and assert the authorization guards, the EXECUTE policy, and the provenance narrowing are present. They are not a database test; see §4.

---

## 4. REMAINING RISKS

1. **Nothing here has been executed against a live database.** The migration is code-reviewed and structurally validated only. No RLS behaviour, no tenant-isolation behaviour, and no EXECUTE policy has been observed in Postgres. Everything database-side is **CODE VERIFIED / DB UNVERIFIED**.
2. ~~17 unguarded `SECURITY DEFINER` functions remain reachable by `authenticated`.~~ **SUPERSEDED by §7.2 (2026-09-19).** All 16 remaining functions were closed: the job enqueue/read surface is tenant-guarded in-body, the worker-owned lifecycle plus `jobs_dequeue` are service-role only, `jobs_stats` is internal-operator only, and `handle_new_user` / `ensure_profile` / `org_seat_limit` are service-only.
3. **PlatformOps is deliberately left unwired** (see §5).
4. **The `20260906_atlas_regulatory_intelligence.sql` divergence** identified in the earlier audit is untouched by this task and remains unresolved.
5. **No live E2E** for Paddle, ElevenLabs, LinkedIn or the blog pipeline — no credentials, no browser, no microphone in this environment. No mocks were substituted.
6. The migration's `alter default privileges` only binds functions created by the role that runs it. If that does not apply, newly created functions would fall back to the Postgres default `EXECUTE … TO PUBLIC`. The guards are therefore written to be correct **even in that case** — an `anon` caller is detected via `auth.role()` and denied — so the fallback is fail-closed rather than a hole.

---

## 5. PLATFORM MODULE / PLATFORMOPS — blocker, not wired

Per instruction, this was investigated and **not** wired.

- `src/lib/platform/*` is imported by **zero** application files.
- `PlatformOps.tsx` exists and **consumes** the module (`api.platform.failedJobs/listDueSources/listSchedules/listContent`), but it is imported by nothing and `main.tsx` has **no `/dashboard/platform` route**, while `app-shell.tsx` still renders a nav link to it. The route was never present — this is a missing-feature gap, not truncation.
- `PlatformOps.tsx` has **no internal guard of its own** (no `RequireInternalAuth`, no role check) — it relies entirely on route-level wrapping.

**Exact blocker:** the page's queries depend on RPCs that are now `service_role`-only (`schedules_list`, `sources_list_due`, `content_list`, …) because those functions have no authorization check of their own. Wiring the route as-is would either fail with `42501` or, if the grants were simply restored, re-expose unguarded platform administration to every signed-in user.

**Safe path, in order:** (1) add an in-function admin guard to each platform RPC; (2) wrap the route in `RequireInternalAuth` with a new `platform` section; (3) only then grant `authenticated` EXECUTE. The migration records this constraint inline so a future change cannot silently re-grant.

---

## 6. PRODUCTION STATUS

**NOT READY — two blockers, both narrow and well defined.**

The repaired commit is a strict improvement on `b1271b5d`: it compiles (29 → 0 typecheck errors), the full suite passes, the build succeeds, the critical anonymous-privilege escalation is closed, and the human-approval IDOR is closed. But it is **not production-ready**, because:

1. **The security migration has never been executed.** Until it runs against a real database, the IDOR fixes and the seat authority are code-reviewed assertions, not verified behaviour. RLS and tenant isolation remain unproven against Postgres.
2. **17 unguarded `SECURITY DEFINER` functions remain reachable by `authenticated`** — **closed in §7.2**; see §7.8 for the current status.

Both are followed by the PlatformOps decision and the unresolved `20260906` migration divergence. What is *done* — the repair, the blanket-grant removal, the credential/outreach/human-approval IDOR fixes, the seat authority, and the regression coverage that keeps them done — was done surgically, without redesign, without a parallel implementation, and without touching `main`.

---

# 7. 2026-09-18/19 — Job authorization + regulatory reconciliation

This section **supersedes** the job-authorization status in §2.5 and §2.9 and the
remaining-risk / production-status claims in §4.2, §5 and §6. Everything below is
still **CODE VERIFIED / DB UNVERIFIED**: no migration in this task was executed
against production.

## 7.1 CHANGES MADE

| File | Change |
| --- | --- |
| `supabase/migrations/20260918_atlas_security_hardening.sql` | Added §3b (job enqueue/read/lifecycle authorization), §5b helpers (`atlas_assert_trusted_server`, `atlas_is_internal_admin`, `atlas_assert_internal_admin`), extended `v_service_only`, extended the audit payload. |
| `supabase/migrations/20260909_atlas_complimentary_access.sql` | `admin_prepare_user_deletion` no longer references the orphan `public.regulatory_contradictions`; the resolved-by column is resolved from the catalog against the canonical `atlas_regulatory_contradictions`. |
| `supabase/migrations/20260919_atlas_regulatory_schema_reconciliation.sql` | **New.** Drops the five orphan unprefixed draft tables, creates the nine canonical `atlas_regulatory_*` tables (columns, indexes, RLS, `regulatory*` policies, 51-jurisdiction seed), and re-creates `admin_prepare_user_deletion` against the canonical schema. |
| `src/lib/security/migration-privileges.test.ts` | Guard detector extended; ratchet allowlist is now empty; +36 tests for the job boundary and the regulatory reconciliation. Existing tests preserved. |

No application/UI code, billing code, or schema parallel to an existing one was
added. Remote `main`, preview, and deployments were not modified.

## 7.2 JOBS AUTHORIZATION MODEL — function-by-function

The job tables are tenant-owned, but every job RPC is `SECURITY DEFINER`, so the
table RLS never applies to them. Each function now authorizes the caller itself.
Identity always derives from `auth.uid()`; `p_user_id`/`p_tenant_id` never grant
access on their own.

**Authenticated + tenant member (or `super_admin`) — in-body guard, still granted to `authenticated`:**

| Function | Decision |
| --- | --- |
| `jobs_create_job` | Identity from `auth.uid()`; `p_user_id` honoured only behind `atlas_is_trusted_server()`; `atlas_assert_tenant_access(p_tenant_id)`. Fixes the identity-spoof on the old `p_user_id` path. |
| `jobs_create_step` | Resolves the job's tenant, then `atlas_assert_tenant_access(v_tenant)`. Also repairs a latent bug (old body wrote `returning id into p_step_id`, an undeclared variable). |
| `jobs_get_job` | Resolves the job's tenant, then asserts; unknown id → `NULL`, foreign tenant → `42501`. |
| `jobs_list_jobs`, `jobs_get_events` | Already tenant-guarded in §5b-vii (unchanged). |
| `jobs_resume_from_review` | Kept authenticated because `src/pages/Reviews.tsx` is routed and calls it; already tenant-guarded in §5b-viii. |

**Trusted server only (service_role / direct superuser) — asserted in-body AND revoked from every client role.** No authenticated application caller exists for any of these (`AtlasWorker` drives them through `createSupabaseWorkerRPC`, which is handed a service-role client):

| Function | Decision |
| --- | --- |
| `jobs_dequeue` | `atlas_assert_trusted_server()` before draining. Intentionally tenant-agnostic — the worker is cross-tenant infrastructure — so the boundary is the authorization check, not a tenant predicate. |
| `jobs_complete_job`, `jobs_complete_step`, `jobs_fail_job`, `jobs_fail_step`, `jobs_retry_step`, `jobs_cancel_job`, `jobs_unlock_stuck`, `jobs_awaiting_review` | The old bodies called `perform public.atlas_is_trusted_server();`, which discards the boolean and guarded nothing. Now a real assert, plus service-only EXECUTE. |

**Internal operator only (`platform_role` `super_admin`/`atlas_admin`, or trusted server):**

| Function | Decision |
| --- | --- |
| `jobs_stats` | INTERNAL_ONLY. Cross-tenant operational aggregate; guarded by `atlas_is_internal_admin()` in-body so ordinary tenant users get `42501`. Still granted to `authenticated` (internal operators need it) but guarded. |

**Auth / tenancy internals:**

| Function | Decision |
| --- | --- |
| `handle_new_user` | Trigger on `auth.users`; trigger invocation performs no EXECUTE check, so revoking it from client roles is safe and closes direct RPC invocation. Service-only. |
| `ensure_profile` | Called only internally by `tenants_create_tenant()`; no client caller. Service-only. |
| `org_seat_limit` | Pure lookup called only by `org_seat_status()`; no client caller. Service-only. |

## 7.3 REGULATORY SCHEMA MODEL

**Canonical (production) tables — nine, all prefixed:**
`atlas_regulatory_jurisdictions`, `atlas_regulatory_sources`,
`atlas_regulatory_source_versions`, `atlas_regulatory_propositions`,
`atlas_regulatory_proposition_versions`, `atlas_regulatory_contradictions`,
`atlas_regulatory_review_queue`, `atlas_regulatory_coverage`,
`atlas_regulatory_acquisition_jobs`.

This is the shape `src/lib/regulatory/store.ts` reads, `src/lib/regulatory/legacy.ts`
types, `scripts/verify-regulatory-schema.ts` verifies, and
`supabase/verification/20260906_atlas_regulatory_verification.sql` asserts
(`wave`/`code`, `verification_state`, `resolution_status`).

**The draft** `20260906_atlas_regulatory_intelligence.sql` creates five
**unprefixed** tables (`regulatory_*`) that exist nowhere in production and that
no code reads. It was **not** renamed to the production version
`20260906192230`, and it is **not** marked applied anywhere.

**Strategy:** `20260919_atlas_regulatory_schema_reconciliation.sql` drops the
five orphan tables (child-first, `if exists`; a no-op in production) and creates
the nine canonical tables with `if not exists` — a no-op where production
already has them, the reproducible shape everywhere else. It also re-creates
`admin_prepare_user_deletion` so environments that already applied the obsolete
body are repaired without rewriting history. No regulatory data is deleted and
no production table is renamed.

## 7.4 SECURITY TEST RESULTS

- Security suite: **101 passed / 0 failed** (was 65). The ratchet allowlist is
  now empty and the 16 historically-unguarded functions are asserted closed.
- Full suite: **2015 passed / 5 skipped / 1 failed** — the failure is the
  pre-existing live-NVIDIA timeout in `src/lib/voice-runtime/phase8-live.test.ts`.
- `bun tsc -b --noEmit`: 0 errors. `bun run build`: passes.
- Structural searches: no blanket `EXECUTE` to `anon`/`PUBLIC`; no `grant … to
  PUBLIC`; no unguarded authenticated-reachable `SECURITY DEFINER` function; no
  reference to the orphan `regulatory_contradictions` outside the draft and its
  reconciliation drop.

## 7.5 REMAINING RISKS

1. **DB UNVERIFIED.** Nothing here was executed against a database. Tenant
   isolation, the trusted-server boundary and the internal-operator guard are
   asserted from the SQL and the tests, not observed in Postgres.
2. **Latent anon grants in `0004`/`0008`/`0014`.** Several older migrations
   explicitly grant EXECUTE to `anon` (`archive_*`, `ingestion_patch_document`,
   `recommendations_decide`). They are neutralised because
   `20260918` runs last and blanket-revokes from `public, anon, authenticated`
   before re-granting only the anon allowlist — but the guard is ordering +
   revoke, so any change that drops the final revoke re-exposes them.
3. **`jobs_create_job` for a trusted server** accepts a caller-supplied
   `p_user_id` with no membership check (by design — the worker is trusted).
   Only reachable with a service-role connection.
4. **PlatformOps remains unwired** (below).
5. No live E2E for the migration path; no browser, no production DB.

## 7.6 DATABASE EXECUTION PLAN (not executed)

Apply in lexicographic migration order, after the preflight checks:

1. **Preflight** — confirm the nine canonical `atlas_regulatory_*` tables exist
   and run `supabase/verification/20260906_atlas_regulatory_verification.sql`.
   Confirm the five `regulatory_*` tables do **not** exist (if any exists,
   stop: the drop in step 3 would remove data and must be reviewed).
2. `20260909_atlas_complimentary_access.sql` — only if not already applied.
3. `20260918_atlas_security_hardening.sql` — the last word on function
   privileges; must run after every migration that creates a function.
4. `20260919_atlas_regulatory_schema_reconciliation.sql` — runs after step 3;
   drops the orphan tables, (re)creates the nine canonical tables, re-creates
   `admin_prepare_user_deletion`.
5. **Postflight** — re-run the regulatory verification; then, as each role,
   confirm an `authenticated` (non-admin) caller gets `42501` from
   `jobs_dequeue`, the worker-only lifecycle RPCs and `jobs_stats`, and that a
   member can call `jobs_create_job`/`jobs_get_job` for its own tenant only.

Do **not** run this against production during this task.

## 7.7 PLATFORMOPS — still unwired (Phase 7)

The server-side authorization boundary is prepared but `/dashboard/platform` is
still not routed and no authenticated EXECUTE was granted.

Per-RPC disposition:

| RPC | Boundary | State |
| --- | --- | --- |
| `jobs_stats` | internal operator (`atlas_is_internal_admin`) | guarded in-function |
| `jobs_list_jobs` | authenticated tenant member | tenant-guarded in-function |
| `sources_list_due`, `schedules_list`, `content_list` | trusted server | service-only, **no in-function guard** |

**Exact remaining dependency:** the three platform-engine RPCs above have no
in-function authorization check and are therefore `service_role`-only. To wire
PlatformOps safely: (1) add `atlas_assert_internal_admin()` to each; (2) wrap the
route in `RequireInternalAuth` with a new `platform` section; (3) only then grant
`authenticated`. Until then the route stays unwired.

## 7.8 PRODUCTION STATUS

**NOT READY — DB UNVERIFIED.** Every code/migration blocker identified in the
earlier audit is now resolved in the repository (blanket grant removed, the 16
unguarded functions closed, the regulatory divergence reconciled, the deletion
path canonical). The remaining blocker is that none of it has been executed or
observed against a database, and PlatformOps is deliberately still unwired.
