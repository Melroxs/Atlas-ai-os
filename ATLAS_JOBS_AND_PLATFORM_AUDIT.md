# Atlas — Jobs Authorization & Platform Ops Audit

**Scope:** investigation only. No migration executed, no grant changed, no function body changed, no remote `main` or tag touched.
**Baseline:** `b1271b5d48de3261c0750356b94665bc9b9e3b1b` (remote `main`), branch `fix/repair-truncated-files`.
**Verification:** `bun tsc -b --noEmit` → 0 errors · `bunx vitest run` → **1,979 passed / 5 skipped / 1 failed** (the pre-existing live-NVIDIA network test).

---

## JOBS SECURITY INVENTORY

### Correction to the brief: the backlog is 16, not 17

The previous pass hardened three functions, so the audited set shrank. Measured from the migration chain as it stands:

| | Count |
| --- | --- |
| `SECURITY DEFINER` public functions | **186** |
| …with no in-function authorization check | **44** |
| …of those, contained by a `service_role`-only grant | **24** |
| …of those, intentionally public (`anon` allowlist) | **4** |
| **…remaining: `authenticated`-reachable with no in-function check** | **16** |

The three that left the backlog: `jobs_resume_from_review` (guarded this pass), `jobs_list_jobs` and `jobs_get_events` (guarded this pass). `jobs_resume_from_review` is the one that appears in your "17".

### Structural context (this is why the numbers matter)

Three facts, all verified, together make the RPC **bodies** the entire authorization boundary:

1. **The RPCs are `SECURITY DEFINER` and the tables' owner bypasses RLS.** `grep "FORCE ROW LEVEL SECURITY" supabase/migrations/` → **no matches**. Without `FORCE`, the definer's role (table owner) is not subject to the policies.
2. **The `authenticated` policies on the job tables are effectively deny-all anyway.** They key off custom claims: `tenant_id = (auth.jwt() ->> 'tenant_id')::uuid`. No migration installs a claim hook (`grep "auth.hook.custom_access_token" supabase/migrations/` → none), and in `supabase/config.toml` the hook is **commented out** (line 284). So the claim is absent → the predicate is `NULL` → no rows. RLS is a fail-closed **deny**, not a backstop.
3. **`src/lib/jobs/rpc.ts` claims a guarantee it does not have.** Its header says *"Every function enforces tenant isolation by passing the authenticated user's tenant context through the RPC (the Postgres functions above read it from the JWT or the calling context)."* The Postgres functions read it from **caller-supplied parameters** and never validate membership. Documentation vs implementation gap.

`anon` escalation for this family is **already closed** by the previous pass (not in the allowlist, `PUBLIC` revoked). What remains is `authenticated` → cross-tenant.

### The 16 functions

`EXECUTE` for all 16: **`authenticated` + `service_role`** (none are in `v_service_only`; none in the `anon` allowlist). Callers below are from `src/` + `supabase/functions/` excluding tests and the `api.ts` descriptor registry.

| # | Function (signature) | Tenant/user source | Validates membership | Reads RLS table / definer bypasses it | Read other tenant | Mutate other tenant | Queue ops | App callers | RPC route / page | Intended |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `jobs_create_job(p_tenant_id, p_job_type, p_idempotency_key, p_user_id, p_priority, p_payload, p_max_attempts, p_scheduled_at, p_parent_job_id, p_tags) → jsonb` | **caller param** `p_tenant_id`, `p_user_id` | **No** | `atlas_jobs`, `atlas_job_events` / **Yes** | No | **Yes — enqueue into any tenant** | enqueue | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/services.ts` | `api.jobs.createJob` (`api.ts:1602`) · no routed page | authenticated (client layer) |
| 2 | `jobs_create_step(p_job_id, p_step_type, p_sequence, p_input, p_max_attempts) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_job_steps` / **Yes** | No | **Yes — add a step to any job** | — | `jobs/rpc.ts`, `jobs/rpc-args.ts` | `api.jobs.createStep` (1605) · none | authenticated (client layer) |
| 3 | `jobs_dequeue(p_worker_id, p_job_types, p_max_jobs) → jsonb` | **none** — no tenant filter at all | **No** | `atlas_jobs`, `atlas_job_events`, `atlas_job_attempts` / **Yes** | **Yes — returns any tenant's job ids** | **Yes — claims/locks any tenant's jobs, increments `attempt_count`** | claim/start | `jobs/worker.ts`, `platform/runtime.ts` | `api.jobs.dequeue` (1606) · none | **background worker only** |
| 4 | `jobs_complete_job(p_job_id, p_result, p_ai_metadata) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_jobs`, `atlas_job_attempts`, `atlas_job_events` / **Yes** | No | **Yes — complete any job** | complete | `jobs/rpc.ts`, `jobs/worker.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.completeJob` (1607) · none | worker / service |
| 5 | `jobs_complete_step(p_step_id, p_output, p_ai_metadata) → jsonb` | **caller param** `p_step_id` | **No** | `atlas_job_steps`, `atlas_job_events` / **Yes** | No | **Yes** | — | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.completeStep` (1612) · none | worker / service |
| 6 | `jobs_fail_job(p_job_id, p_error, p_retryable) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_jobs`, `atlas_job_attempts`, `atlas_job_events` / **Yes** | No | **Yes** (incl. scheduling retries) | fail/retry | `jobs/rpc.ts`, `jobs/worker.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.failJob` (1609) · none | worker / service |
| 7 | `jobs_fail_step(p_step_id, p_error) → jsonb` | **caller param** `p_step_id` | **No** | `atlas_job_steps`, `atlas_job_events` / **Yes** | No | **Yes** | — | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.failStep` · none | worker / service |
| 8 | `jobs_retry_step(p_step_id) → jsonb` | **caller param** `p_step_id` | **No** | `atlas_job_steps`, `atlas_job_events` / **Yes** | No | **Yes** | retry | `jobs/rpc.ts`, `jobs/rpc-args.ts` | `api.jobs.retryStep` · none | worker / service |
| 9 | `jobs_cancel_job(p_job_id) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_jobs`, `atlas_job_steps`, `atlas_job_events` / **Yes** | No | **Yes — cancel any job + its pending steps** | cancel | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.cancelJob` · none | worker / service |
| 10 | `jobs_unlock_stuck(p_stale_after) → jsonb` | **none** — global `status='processing' AND lock_expires_at < now()` | **No** | `atlas_jobs`, `atlas_job_events` / **Yes** | No | **Yes — reclaims leases across ALL tenants** | reclaim | `platform/runtime.ts` | `api.jobs.unlockStuck` · none (dormant) | **server only** |
| 11 | `jobs_get_job(p_job_id) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_jobs`, `atlas_job_steps` / **Yes** | **Yes — full job row + steps (payload, result) for any id** | No | — | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.getJob` · none | authenticated (client layer) |
| 12 | `jobs_stats() → jsonb` | **none** — no tenant predicate | **No** | `atlas_jobs`, `atlas_job_attempts` / **Yes** | **Yes — global `total`, `by_status`, `by_type`, `queue_depth`, `processing_count`, `failed_24h` across every tenant** | No | — | `jobs/rpc.ts` | `api.jobs.stats` → **`PlatformOps.tsx:158`** | ops dashboard |
| 13 | `jobs_awaiting_review(p_job_id, p_review_id) → jsonb` | **caller param** `p_job_id` | **No** | `atlas_jobs`, `atlas_job_attempts`, `atlas_job_events` / **Yes** | No | **Yes — pause any job** | pause | `jobs/rpc.ts`, `jobs/rpc-args.ts`, `platform/runtime.ts` | `api.jobs.*` · none | worker / service |
| 14 | `ensure_profile(p_user uuid) → void` | **caller param** `p_user` | **No** | `public.profiles` (insert only) / **Yes** | No | Creates a `profiles` row for **any** auth user id — but insert-only (`ON CONFLICT DO NOTHING`), and it omits `account_status`/`platform_role`, so the column defaults `'pending'`/`'user'` from `20260820:8,13` apply — **identical to the legitimate signup path** | — | **`none`** in `src/`; internal callers `tenants_create_tenant:79`, `tenants_claim_invites:153` | not registered in `api.ts` | internal only |
| 15 | `handle_new_user() → trigger` | `NEW.*` (trigger context) | n/a | `public.profiles` / **Yes** | No | Inserts the new user's own profile | — | **`none`** — `RequireAuth.tsx:22` mentions it only in a comment | not registered | auth signup trigger |
| 16 | `org_seat_limit(p_plan text) → integer` | **caller param** `p_plan` | **No** | `plan_seat_limits` (RLS on, no policy, `revoke all` from all client roles) / **Yes** | **No tenant data** — returns an integer seat cap for a plan name | No | — | `none` in `src/`; internal caller `org_seat_status` | not registered | internal only |

### Two findings that need emphasis

- **#3 `jobs_dequeue` is the worst of the family.** It has *no tenant predicate whatsoever* — it claims the next available job globally (`ORDER BY priority, scheduled_at, created_at ... FOR UPDATE SKIP LOCKED`), and it is reachable by any signed-in user. An authenticated caller can drain and lock another tenant's queue.
- **#12 `jobs_stats` is reachable from a routed surface's data path** (`api.jobs.stats` is consumed by `PlatformOps.tsx:158`), and it returns cross-tenant aggregates.

### Intended audience (determined from the bodies, not the names)

- **Background worker / server:** #3, #4, #5, #6, #7, #8, #9, #10, #13 — these are the worker's own lifecycle calls. The worker drives them via an **injected** client (`worker.ts:553`: `supabase: null, // Will be injected by the Edge Function wrapper`), i.e. intended to be `service_role`.
- **Authenticated client layer:** #1, #2, #11 (enqueue/step/read) — the client RPC layer exposes them, though no currently routed page uses them.
- **Internal only:** #14, #15, #16.
- **Ops dashboard:** #12.

### The job queue currently has no production entry point

Verified: `grep -rln "AtlasWorker\|runOnce" supabase/functions/` → **no matches**; and `src/lib/platform/*` is imported by no application file (asserted in the new test suite). So **none of #1–#13 has a live production caller today**. The only browser-reachable job call in routed code is `jobs_resume_from_review` (via `Reviews.tsx` → `jobs/resumeFromReview`), which is already guarded. That materially widens the safe options in Part C — but see the caution there.

---

## JOBS RECOMMENDED POLICY

Proposed only. **Not implemented.**

### SERVICE_ONLY

| Function | Why |
| --- | --- |
| `jobs_dequeue` | Global, no tenant predicate, claims and locks jobs. Only legitimate caller is the worker. Nothing in `src/` outside the dormant platform runtime calls it. |
| `jobs_complete_job` | Closes out a job by id with no scope. Worker-owned. |
| `jobs_complete_step` | Same, for steps. |
| `jobs_fail_job` | Mutates job state + schedules retries. Worker-owned. |
| `jobs_fail_step` | Same, for steps. |
| `jobs_retry_step` | Resets any failed step. Worker-owned. |
| `jobs_cancel_job` | Cancels any job and its pending steps. Worker/human-approval-owned; the human path already has its own guarded RPC (`jobs_resume_from_review`). |
| `jobs_unlock_stuck` | Global lease reclamation across all tenants. Strictly a server duty. |
| `jobs_awaiting_review` | Pauses any job. Worker-owned; the human-facing transition is `jobs_resume_from_review`. |
| `ensure_profile` | No browser caller exists; its only callers are `tenants_create_tenant` / `tenants_claim_invites`, which are themselves `SECURITY DEFINER` and therefore invoke it **as the owner** — so revoking `authenticated` cannot break them. Removes "materialize a profile for an arbitrary user id" from the client surface. |
| `handle_new_user` | Zero application callers; it is the signup trigger. It returns `trigger`, so a direct RPC invocation is rejected by Postgres regardless (expected behaviour; not verifiable in this environment). Revoke for hygiene. |
| `org_seat_limit` | Internal lookup called only by `org_seat_status`. No client need. |

### AUTHENTICATED_SAFE

**None of the 16 qualify today.** Every one of them either takes the tenant/job id from a parameter without validation, or has no scope at all. Several could *become* authenticated-safe with a one-line guard (see `REQUIRES_FUNCTION_HARDENING`), but none is safe as written.

### INTERNAL_ONLY

| Function | Why |
| --- | --- |
| `jobs_stats` | It is an **operations** metric, not a tenant metric. Either scope it to the caller's tenant(s) or gate it to internal/admin (super_admin / atlas_admin). Making it tenant-scoped changes its meaning for the ops dashboard it was written for, so internal-only is the more faithful choice. |

### REQUIRES_FUNCTION_HARDENING

Preferred over revocation for these, because they are the *enqueue/read* surface a client layer legitimately uses and because guarding is behaviour-preserving:

| Function | Required change |
| --- | --- |
| `jobs_create_job` | `perform atlas_assert_tenant_access(p_tenant_id);` before the idempotency lookup, and derive `p_user_id` from `auth.uid()` rather than trusting the parameter. |
| `jobs_create_step` | Resolve the job's `tenant_id` and assert access before inserting the step. |
| `jobs_get_job` | Resolve the job's `tenant_id` and return `NULL` (not an error) for a job the caller may not see — preserves the existing "missing job returns null" contract that `runtime.test.ts` already asserts. |

### The one thing to be careful about

A blanket `SERVICE_ONLY` for the mutators is **currently** safe by evidence — no edge function calls them, and the only routed browser call is the guarded resume path. But it would silently break the queue the moment `src/lib/platform/runtime.ts` is wired (the wiring PlatformOps needs). Because `AtlasWorker` is designed to receive an **injected** client, the correct sequence is: harden the bodies first (behaviour-preserving), then tighten grants once the platform route's authorization model is settled. Revoking first would trade an authorization hole for an availability landmine.

---

## REQUIRED TESTS

### Tests that already exist

| File | What it actually asserts |
| --- | --- |
| `src/lib/jobs/rpc-args.test.ts` | The **wire contract only** — snake_case parameter names, no camelCase folding, unknown keys passed through. No authorization. |
| `src/lib/platform/runtime.test.ts` | Mocked worker behaviour — `runOnce` on an empty queue, one claimed job completes, unknown job type fails without retrying, `{jobs:[…]}` → `{id}` mapping, `getJob` returning `null` for a missing job, reclaim window. No authorization. |
| `src/lib/security/migration-privileges.test.ts` | 65 structural assertions (previous pass + this one). |
| `src/lib/billing/entitlements.test.ts` | Seat/entitlement decisions, fail-closed parsing, parity with `plans.ts`. |

**Before this pass, no test anywhere asserted a tenant-isolation boundary for jobs.**

### Added in this pass (isolated, DB-free, and the only artefact I created)

`src/lib/security/migration-privileges.test.ts` §7 — `jobs/auth authorization boundary (audit baseline)`. It parses the real migration chain (latest definition per function, comment-stripped, dollar-quote delimited) so the "is it guarded?" question is answered from the SQL that will ship rather than a hand-written list. Six tests:

1. **No NEW unguarded `authenticated`-reachable `SECURITY DEFINER` function** — subset check against the audited baseline. Catches exactly this class of regression; hardening only shrinks the list, so improving the code never fails the build.
2. The backlog check is **not vacuous** (still finds entries).
3. **Records that `jobs_stats` aggregates across every tenant** (asserts no tenant predicate in the body).
4. **Records that the job tables are tenant-owned but their RLS reads a JWT claim no migration populates** (asserts `tenant_id uuid NOT NULL`, the `auth.jwt() ->> 'tenant_id'` predicate, and the absence of a claim hook in the chain).
5. **Records that the claim hook exists only commented-out in `supabase/config.toml`.**
6. **The job queue has no server-side entry point** (no file under `supabase/functions/` mentions any `jobs_*` function) — this is the tripwire that forces the SERVICE_ONLY analysis to be revisited if a server caller appears. Plus `src/lib/platform` remains imported by no application code.

**This is necessary-only work.** It is a characterization/ratchet suite: with no database in this environment, it is the only way to make the audited boundary executable. Items 1 and 6 are genuine guards; items 3–5 are executable documentation of the structural findings.

### Tests that still need to be added (all require a live database — BLOCKED here)

1. Tenant A `jobs_get_job(tenantB_job)` → `NULL` / denied.
2. Tenant A `jobs_cancel_job` / `jobs_complete_job` / `jobs_fail_job` / `jobs_awaiting_review` on a tenant B job → denied, and **B's row unchanged**.
3. Tenant A `jobs_create_job(p_tenant_id => tenantB, …)` → denied.
4. Tenant A `jobs_dequeue(…)` → claims **nothing** from tenant B.
5. Tenant A `jobs_list_jobs` / `jobs_stats` → own tenant only.
6. `anon` cannot execute any of the 16 → `42501` for each.
7. `service_role` can run `dequeue` → `complete_job` / `fail_job` across tenants (the worker path must keep working).
8. `Reviews.tsx` flow as `authenticated`: `listReviews`, `approve`, `reject`, `requestChanges`, `resumeFromReview` on an **own-tenant** review → succeed (regression guard for the previous pass).
9. `admin_prepare_user_deletion` succeeds on a database matching production (see the regulatory section — today it cannot).
10. RLS probe: authenticate a real user and confirm the `atlas_jobs` `tenant_read` outcome, documenting the JWT-claim gap rather than assuming it.

---

## PLATFORMOPS SECURITY INVENTORY

### Every RPC `PlatformOps.tsx` calls

| Line | RPC | Route | `SECURITY DEFINER` | Current `EXECUTE` | In-function guard | Other callers |
| --- | --- | --- | --- | --- | --- | --- |
| 158 | `jobs_stats` | `api.jobs.stats` | **Yes** | authenticated + service_role | **No** — global aggregates | `jobs/rpc.ts` |
| 159 | `jobs_list_jobs` | `api.platform.failedJobs` | **Yes** | authenticated + service_role | **Yes** (tenant-scoped, this pass) | `jobs/rpc.ts`, `platform/rpc.ts` |
| 160 | `sources_list_due` | `api.platform.listDueSources` | **Yes** | **service_role only** | **No** | `platform/*` (dormant) |
| 161 | `schedules_list` | `api.platform.listSchedules` | **Yes** | **service_role only** | **No** | `platform/*` (dormant) |
| 162 | `content_list` | `api.platform.listContent` | **Yes** | **service_role only** | **No** | `platform/*` (dormant) |

The full platform surface registered in `api.ts` (`platform:` block, lines 1627+) is larger — `schedules_upsert/set_enabled/fire_due/record_result`, `sources_get/list_checks/record_check/set_check_frequency`, `knowledge_versions/as_of/create_version/verify`, `content_create/transition/get/list_provenance/public_list`. PlatformOps today uses only the five reads above.

### Route protection and reachability

| Question | Finding |
| --- | --- |
| Frontend route protection on `PlatformOps` | **None inside the component.** No `RequireInternalAuth`, no `useAuth`, no role check, no `InternalSection` usage. It relies entirely on route-level wrapping that does not exist. |
| Is the page reachable? | **No.** `main.tsx` contains **no** `/dashboard/platform` route (grep → 0 matches). |
| Is it linked? | **Yes — to a dead route.** `app-shell.tsx:223` renders a "Platform Operations" nav item and `:289` registers the title, so authorized-looking users see a link that 404s. |
| Guarded variant available? | Yes — `RequireInternalAuth` + `InternalSection` (`"pilot" \| "crm" \| "mail" \| "users" \| "superadmin"`) already exist and are used by five other routes. There is **no `"platform"` section** today. |
| Other application callers of these RPCs | `src/lib/platform/*` (itself imported by nothing) and `src/lib/jobs/rpc.ts` for `jobs_stats`. |

### Authorization model the platform operations actually require

The platform RPCs administer **global, non-tenant** infrastructure — schedules, authoritative sources, knowledge versions, the content engine. They are not tenant-scoped operations, so tenant membership is the wrong gate. They require **Atlas internal admin** (`super_admin` / `atlas_admin`), which is `RequireInternalAuth`'s existing model.

### Exactly what needs to change

1. **In-function admin guard on each platform RPC** (`schedules_*`, `sources_*`, `content_*`, `knowledge_*`, `jobs_stats`) — e.g. `if not (public.is_super_admin() or public.is_atlas_admin()) then raise exception …`. Without this, step 4 is the same hole as before.
2. **A `"platform"` section** added to `InternalSection` and its access mapping in `src/lib/auth/access-gate.ts`, restricted to super_admin/atlas_admin.
3. **The route**, wrapped: `/dashboard/platform` → `RequireInternalAuth section="platform"` → `PlatformOps`.
4. **Only then** grant `authenticated` `EXECUTE` on those RPCs (today they are `service_role`-only, so the page cannot work at all).
5. **Gate the nav link** (`app-shell.tsx:223`) on the same section so unauthorized users stop seeing a dead link, and keep `:289`'s title map consistent.
6. `jobs_stats` must be decided as part of this: tenant-scope it or fold it into the internal-only admin gate.

**Nothing here is implemented.**

---

## REGULATORY MIGRATION DIVERGENCE

### Exact finding

The divergence is **structural and behavioural**, not merely historical or redundant.

**What the file claims (its own header, lines 15–42, "verified against production 2026-09-13"):**

- Production history has version **`20260906192230`**, name `atlas_regulatory_intelligence`, applied through the Management API via `scripts/apply-regulatory-migration.mjs` (confirmed: that script POSTs to `/v1/projects/{ref}/database/migrations` with `Idempotency-Key: atlas-regulatory-20260906` and a **server-generated** 14-digit version — that is why the version differs from the filename).
- Production contains **nine** `atlas_regulatory_*` tables: `jurisdictions`, `sources`, `source_versions`, `propositions`, `proposition_versions`, `contradictions`, `review_queue`, `coverage`, `acquisition_jobs`.
- **This repo file creates five differently-named, unprefixed tables** that exist nowhere in production and that no code reads.

**Verified independently:**

- `20260906_atlas_regulatory_intelligence.sql` creates exactly five, all unprefixed: `regulatory_jurisdictions` (53), `regulatory_sources` (70), `regulatory_propositions` (111), `regulatory_contradictions` (170), `regulatory_acquisition_jobs` (198) — with RLS enabled on each (`enable row level security` × 5).
- **No file in the repository creates the nine `atlas_regulatory_*` tables.** `grep -rn "create table.*atlas_regulatory_"` across the whole repo → **no matches**. In migrations, `atlas_regulatory_` appears **only inside this file's header comment**. So the canonical migration chain **cannot reproduce the schema production actually has**.
- The application reads the *prefixed* names: `src/lib/regulatory/store.ts` queries eight of the nine (`atlas_regulatory_jurisdictions`, `sources`, `source_versions`, `propositions`, `proposition_versions`, `contradictions`, `review_queue`, `coverage`), and `supabase/verification/20260906_atlas_regulatory_verification.sql` asserts all **nine**. Those objects are created by **no migration**.
- Three of the five unprefixed tables are genuinely orphaned (`regulatory_jurisdictions`, `regulatory_sources`, `regulatory_propositions`, `regulatory_acquisition_jobs` have **zero** references anywhere outside the file itself).

### The behavioural consequence (the real defect)

`regulatory_contradictions` is **not** orphaned. A **later** migration depends on it:

`supabase/migrations/20260909_atlas_complimentary_access.sql:592`, inside `admin_prepare_user_deletion(p_user_id)`:

```sql
  -- Direct auth.users references without cascade
  update public.pilot_applications set reviewed_by = null where reviewed_by = p_user_id;
  update public.atlas_audit_log set actor_id = null where actor_id = p_user_id;
  update public.regulatory_contradictions set resolved_by_id = null where resolved_by_id = p_user_id;   -- ← line 592
  delete from public.user_provisions ...
```

That statement is **unguarded** — no `to_regclass` check, no `DO` block, not conditional. Therefore:

- On a database matching production (nine prefixed tables; the unprefixed ones absent), `admin_prepare_user_deletion` raises **`42P01 relation "public.regulatory_contradictions" does not exist`** every time a super admin prepares a user deletion. **User deletion is broken.**
- On a clean database with the repo's chain applied in filename order, `20260906` creates the table first, so the statement succeeds — and the chain converges to the **orphan** schema, not to production.

Corroborating evidence that the ambiguity is known: `supabase/functions/_shared/user-deletion.ts:77` lists **both** names defensively — `tables: ["regulatory_contradictions", "atlas_regulatory_contradictions"]`.

### The other questions asked

| Question | Answer |
| --- | --- |
| What differs from the canonical schema? | Production: nine `atlas_regulatory_*` tables. Repo file: five unprefixed `regulatory_*` tables. Different names, different count, and the nine are created nowhere. |
| Does it conflict with later migrations? | **Yes, hard.** `20260909` (later this pass) writes to `public.regulatory_contradictions`. The dependency runs **draft → canonical migration**, in that direction. |
| Are any objects missing? | **Yes — nine.** The `atlas_regulatory_*` tables are created by no migration, yet the app reads them and the verification script asserts them. |
| Does applying it to a clean database succeed? | By inspection: **yes** — it is replay-safe (`create table if not exists`, `on conflict … do nothing`, `drop policy if exists`), and its dependencies are satisfied in filename order. **Not executed here — UNVERIFIED.** |
| Does the current migration chain succeed? | **UNVERIFIED** (no database). The `20260906 → 20260909` ordering is internally consistent by filename, so that specific dependency would resolve. But the chain cannot converge on production's schema. |
| Structural, behavioural, or historical/redundant? | **Structural** (five vs nine tables, different names; the nine are unreproducible) **+ behavioural** (`admin_prepare_user_deletion` fails against production) **+ partially redundant** (four of the five draft tables are unreferenced). The version-key mismatch is the historical part. |

### Do not do the tempting thing

Renaming this file to `20260906192230_atlas_regulatory_intelligence.sql` would mark SQL as applied that **never ran** — the exact hazard the header warns about. The resolution is a human decision: **commit the real nine-table body** (under `20260906192230` or a new version) **and delete/replace this draft**, then repair the `20260909:592` reference.

---

## RECOMMENDED PATCH

Not implemented. Ordered by risk-reduction per unit of blast radius.

**A. Job family — guard first (behaviour-preserving), do not revoke first**

1. `jobs_create_job` — `perform atlas_assert_tenant_access(p_tenant_id);` before the idempotency lookup; take `p_user_id` from `auth.uid()`.
2. `jobs_create_step` — resolve the job's `tenant_id`, assert, then insert.
3. `jobs_get_job` — assert on the job's tenant; return `NULL` (not an error) when denied, preserving the existing contract.
4. `jobs_dequeue` — **the highest-value fix**: add an explicit scope predicate for non-server callers (its only legitimate caller is the worker), or move it to `SERVICE_ONLY` once step 12 is settled.
5. `jobs_unlock_stuck` — same treatment as `jobs_dequeue` (global by design, server-only duty).
6. `jobs_complete_job`, `jobs_complete_step`, `jobs_fail_job`, `jobs_fail_step`, `jobs_retry_step`, `jobs_cancel_job`, `jobs_awaiting_review` — assert on the job/step's tenant; these are worker-owned, so `SERVICE_ONLY` is the alternative once the worker's execution context is pinned down.
7. `jobs_stats` — tenant-scope it, or gate it to internal admin (ties into D).

**B. Remaining non-job functions**

8. `ensure_profile` — `SERVICE_ONLY`. Safe: no browser caller, and internal callers run as the owner.
9. `handle_new_user` — revoke `authenticated` (hygiene; uncallable as an RPC anyway).
10. `org_seat_limit` — `SERVICE_ONLY` (internal lookup only).

**C. Governance/regulatory**

11. `20260909_atlas_complimentary_access.sql:592` — point at the real table, or wrap in a `to_regclass` guard so user deletion cannot fail on a schema mismatch.
12. `20260906_atlas_regulatory_intelligence.sql` — commit the real nine-table body and delete the draft; do **not** rename it. Re-run `supabase/verification/20260906_atlas_regulatory_verification.sql` against the result.

**D. PlatformOps**

13. In-function `is_super_admin() or is_atlas_admin()` guard on every platform RPC (`schedules_*`, `sources_*`, `knowledge_*`, `content_*`, `jobs_stats`).
14. Add a `"platform"` `InternalSection` + access-gate mapping.
15. Add the `RequireInternalAuth section="platform"` route in `main.tsx`; gate the `app-shell.tsx:223` nav link.
16. Only then grant `authenticated` `EXECUTE` on those RPCs.

**E. Verification**

17. Execute the `20260918` hardening migration against a real database, then run the ten DB-backed tests listed under REQUIRED TESTS.
18. Re-run `bun tsc -b --noEmit`, the full suite, and `bun run build` after each group.

---

## PRODUCTION BLOCKERS

Only what the evidence supports.

1. **Cross-tenant job access — HIGH, exploited-by-construction.** 16 `SECURITY DEFINER` functions are reachable by any signed-in user and take the tenant/job id from a parameter (`jobs_create_job`, `jobs_create_step`, `jobs_get_job`) or have no scope at all (`jobs_dequeue`, `jobs_unlock_stuck`, `jobs_stats`). There is **no RLS backstop**: no `FORCE ROW LEVEL SECURITY` anywhere, and the `authenticated` policies read a JWT claim that no migration populates. Evidence: the function bodies above; `grep FORCE ROW LEVEL SECURITY` → none; `config.toml:284` hook commented out. *Mitigating fact, not a defence: the queue has no live caller today, so this is latent rather than actively exercised.*
2. **`admin_prepare_user_deletion` cannot run against production — HIGH, user-facing.** It unconditionally updates `public.regulatory_contradictions`, which no migration creates and which the divergence note says does not exist in production → `42P01` on every super-admin user deletion. Evidence: `20260909:592`; no `create table … atlas_regulatory_` anywhere; the file's own divergence note; `user-deletion.ts:77` listing both names.
3. **The regulatory schema is unreproducible from the repo — MEDIUM.** Nine tables that `src/lib/regulatory/store.ts` reads and the verification script asserts are created by no migration. Any environment rebuilt from this chain has a broken regulatory feature.
4. **No database-side verification has ever run — MEDIUM.** The `20260918` hardening migration has never been executed. Every RLS, tenant-isolation, and grant claim in the two audit reports is code-review only.

**Explicitly not blockers** (evidence-backed):
- `handle_new_user` — zero application callers, and a `trigger`-returning function cannot be invoked as an RPC.
- `org_seat_limit` — returns a plan's integer seat cap; no tenant data.
- `ensure_profile` — insert-only, `ON CONFLICT DO NOTHING`, and lands the same `'pending'`/`'user'` defaults as the legitimate signup path. Least-privilege cleanup, not a hole.
- The PlatformOps dead nav link — cosmetic; the page is unreachable and only becomes a security question once wired.

**Not production-ready.** Two independent HIGH findings above, plus four systems (Paddle, ElevenLabs, LinkedIn, blog) still without live E2E, and no executed migration.
