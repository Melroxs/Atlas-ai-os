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

### 2.5 MEDIUM — cross-tenant job access (partially fixed)

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
2. **17 unguarded `SECURITY DEFINER` functions remain reachable by `authenticated`.** The 14-function `jobs_*` queue family is the substantive part. They cannot simply be revoked — `src/pages/Reviews.tsx` is routed and calls `jobs_resume_from_review` — and they cannot be safely scoped without reading each body's own tenant source, which was not done. This needs a follow-up pass. `handle_new_user` is a trigger function (not meaningfully callable as an RPC); `org_seat_limit` returns a plan's seat count, no tenant data.
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
2. **17 unguarded `SECURITY DEFINER` functions remain reachable by `authenticated`**, chiefly the `jobs_*` queue family.

Both are followed by the PlatformOps decision and the unresolved `20260906` migration divergence. What is *done* — the repair, the blanket-grant removal, the credential/outreach/human-approval IDOR fixes, the seat authority, and the regression coverage that keeps them done — was done surgically, without redesign, without a parallel implementation, and without touching `main`.
