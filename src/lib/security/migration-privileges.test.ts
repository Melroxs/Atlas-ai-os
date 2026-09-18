// ---------------------------------------------------------------------------
// SQL privilege guard — regression tests for the blanket EXECUTE exposure
//
// Context: `0007_grants.sql` granted `all on all routines` to `anon` (plus an
// `alter default privileges` that re-applies it to every future function), and
// `20260913_atlas_platform_infrastructure.sql` re-declared
// `grant execute on all functions in schema public to anon, authenticated,
// service_role`. Because SECURITY DEFINER functions bypass RLS and several have
// no authorization check of their own, that combination let an unauthenticated
// caller activate paid access for any organization
// (`tenants_activate_after_payment`) and read any organization's encrypted
// mailbox credentials (`email_accounts_get_credentials`).
//
// These tests read the migration SQL directly and fail if the exposure is
// reintroduced or if the privileged functions lose their service-role-only
// posture. They need no database.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");
const HARDENING = "20260918_atlas_security_hardening.sql";

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS, name), "utf8");
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
}

/** Remove `-- line comments` so commented-out grants are not treated as active. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Extract a plpgsql `array['a','b']` literal assigned to a variable. */
function arrayLiteral(sql: string, varName: string): string[] {
  const re = new RegExp(
    varName + String.raw`\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]`,
  );
  const m = sql.match(re);
  if (!m) throw new Error(`array literal ${varName} not found in ${HARDENING}`);
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// 1. The blanket grant must not come back
// ---------------------------------------------------------------------------

/**
 * Every role named in a blanket `GRANT ... ON ALL FUNCTIONS/ROUTINES` statement,
 * across all migrations.
 *
 * Inspects the GRANTEE list specifically — a naive "does `anon` appear nearby"
 * check produces false positives, because the legitimate
 * `grant execute on all functions ... to service_role;` sits a few lines above
 * the `revoke execute on all functions ... from public, anon, authenticated;`
 * that removes the exposure.
 */
function blanketGrantees(sql: string): string[] {
  const out: string[] = [];
  const patterns = [
    /grant\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public\s+to\s+([^;]*);/gi,
    /grant\s+all\s+on\s+all\s+routines\s+in\s+schema\s+public\s+to\s+([^;]*);/gi,
  ];
  for (const re of patterns) {
    for (const m of sql.matchAll(re)) {
      out.push(
        ...m[1]
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
    }
  }
  return out;
}

describe("SQL privilege guard — no blanket EXECUTE for anon", () => {
  it("no migration grants blanket EXECUTE on all functions/routines to anon", () => {
    const offenders = migrationFiles().filter((f) =>
      blanketGrantees(stripComments(read(f))).includes("anon"),
    );
    expect(offenders).toEqual([]);
  });

  it("every blanket grant names only trusted roles (never anon or PUBLIC)", () => {
    const seen = new Set<string>();
    for (const f of migrationFiles()) {
      for (const role of blanketGrantees(stripComments(read(f)))) {
        seen.add(role);
        expect(["authenticated", "service_role"]).toContain(role);
      }
    }
    // The trusted grants must actually exist, or the app cannot call its RPCs.
    expect(seen.has("service_role")).toBe(true);
  });

  it("20260913 no longer carries the blanket function grant", () => {
    const body = stripComments(read("20260913_atlas_platform_infrastructure.sql"));
    expect(body).not.toMatch(/grant\s+execute\s+on\s+all\s+functions/i);
  });

  it("the hardening migration revokes the inherited blanket from PUBLIC and anon", () => {
    const sql = stripComments(read(HARDENING));
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    // Postgres grants EXECUTE to PUBLIC by default and anon inherits through it,
    // so the revoke must name PUBLIC — revoking from anon alone is insufficient.
    expect(sql).toMatch(/revoke\s+execute\s+on\s+functions\s+from\s+public,\s*anon/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Privileged functions are service-role only
// ---------------------------------------------------------------------------

describe("privileged functions are service-role only", () => {
  const sql = read(HARDENING);
  const serviceOnly = arrayLiteral(sql, "v_service_only");
  const anonAllow = [
    ...arrayLiteral(sql, "v_anon_helpers"),
    ...arrayLiteral(sql, "v_anon_public"),
  ];

  const mustBeServiceOnly = [
    // credential disclosure
    "email_accounts_get_credentials",
    // cross-tenant write
    "outreach_records_update_status",
    // billing-state writers with no in-function authorization
    "billing_apply_state",
    "tenants_activate_after_payment",
    "tenants_handle_payment_failure",
    "tenants_handle_subscription_cancelled",
    // corpus / knowledge ingestion
    "industry_ingest_corpus",
    "industry_seed_internal",
    // content publish path
    "content_transition",
  ];

  it.each(mustBeServiceOnly)("%s is in the service-only set", (fn) => {
    expect(serviceOnly).toContain(fn);
  });

  it.each(mustBeServiceOnly)("%s is NOT granted to anon", (fn) => {
    expect(anonAllow).not.toContain(fn);
  });

  it("the service-only set is explicitly revoked from every client role", () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+%s\s+from\s+public,\s*anon,\s*authenticated/i,
    );
  });

  it("anon keeps EXECUTE only on predicate helpers and public RPCs", () => {
    const allowed = /^(is_|can_|get_current_tenant_id$|my_tenant_id$)/;
    const publicRpcs = ["pilot_apply", "content_public_list"];
    for (const fn of anonAllow) {
      expect(allowed.test(fn) || publicRpcs.includes(fn)).toBe(true);
    }
  });

  it("does not grant anon any credential, outreach or billing RPC", () => {
    for (const fn of anonAllow) {
      expect(/credential|outreach|billing|tenants_|_apply_state/.test(fn)).toBe(false);
    }
  });

  it("the public content RPC stays reachable for anon (published-only by design)", () => {
    expect(anonAllow).toContain("content_public_list");
  });
});

// ---------------------------------------------------------------------------
// 3. The two IDOR fixes are present in the forward migration
// ---------------------------------------------------------------------------

describe("IDOR fixes (tenant isolation + validation)", () => {
  const sql = read(HARDENING);

  function bodyStartingAt(marker: string): string {
    const i = sql.indexOf(marker);
    expect(i).toBeGreaterThan(-1);
    return sql.slice(i, i + 2200);
  }

  it("email_accounts_get_credentials scopes to the caller's tenant", () => {
    const body = bodyStartingAt("function public.email_accounts_get_credentials");
    expect(body).toMatch(/tenant_id\s*=\s*public\.get_current_tenant_id\(\)/);
    expect(body).toMatch(/Access denied/);
    // service_role (no auth.uid()) keeps the trusted Edge Function path intact
    expect(body).toMatch(/auth\.uid\(\)\s+is\s+not\s+null/);
    expect(body).toMatch(/set search_path = public/);
  });

  it("outreach_records_update_status validates the status value", () => {
    const body = bodyStartingAt("function public.outreach_records_update_status");
    expect(body).toMatch(/Invalid status/);
    expect(body).toMatch(/p_status\s+not\s+in\s*\(/);
    expect(body).toMatch(/set search_path = public/);
    // no tenant-crossing escape hatch: the update stays keyed on the message id
    expect(body).toMatch(/where provider_message_id = p_provider_message_id/);
  });
});

// ---------------------------------------------------------------------------
// 4. Seat authority is server-side, tenant-scoped and fail-closed
// ---------------------------------------------------------------------------

describe("seat authority SQL", () => {
  const sql = read(HARDENING);
  const seatBody = sql.slice(sql.indexOf("function public.org_seat_status"));

  it("is tenant-scoped (non-members cannot inspect an org)", () => {
    expect(seatBody).toMatch(/not_a_member/);
    expect(seatBody).toMatch(/m\."userId" = auth\.uid\(\)/);
    expect(seatBody).toMatch(/m\."tenantId" = p_tenant/);
  });

  it("fails closed when no plan can be resolved", () => {
    expect(seatBody).toMatch(/'reason',\s*'no_plan'/);
    expect(seatBody).toMatch(/allowed',\s*false/);
  });

  it("keeps the intentional super_admin and complimentary bypasses", () => {
    expect(seatBody).toMatch(/'reason',\s*'super_admin'/);
    expect(seatBody).toMatch(/'reason',\s*'complimentary'/);
  });

  it("denies when seats are exhausted", () => {
    expect(seatBody).toMatch(/seat_limit_reached/);
    expect(seatBody).toMatch(/v_remaining > 0/);
  });

  it("the limits table is not readable by client roles", () => {
    expect(sql).toMatch(
      /revoke all on table public\.plan_seat_limits from public, anon, authenticated/i,
    );
    expect(sql).toMatch(/enable row level security/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Anonymous content exposure
// ---------------------------------------------------------------------------

describe("content visibility for anonymous callers", () => {
  const hardening = read(HARDENING);
  const platform = read("20260913_atlas_platform_infrastructure.sql");

  it("article rows are only readable anonymously when published", () => {
    const policy = platform.slice(platform.indexOf("contentitems_public_read"));
    expect(policy).toMatch(/to anon, authenticated/);
    expect(policy).toMatch(/"status" = 'published' and "contentType" = 'blog'/);
  });

  it("the hardening migration narrows the provenance read policy", () => {
    expect(hardening).toMatch(/drop policy if exists contentprovenance_read/i);
    // lastIndexOf: the policy name also appears in the explanatory comment above
    const policy = hardening.slice(hardening.lastIndexOf("create policy contentprovenance_read"));
    // must no longer be an unconditional `using (true)` for anon
    expect(policy).not.toMatch(/using \(true\)/i);
    expect(policy).toMatch(/c\."status" = 'published' and c\."contentType" = 'blog'/);
    expect(policy).toMatch(/auth\.uid\(\) is not null and c\."status" in \('approved', 'published'\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. Tenant scoping for SECURITY DEFINER RPCs reachable from the browser
//
// `human_reviews_*` (called from src/pages/Reviews.tsx) and the job read RPCs
// are SECURITY DEFINER, so the tenant RLS policies on the tables they touch do
// not apply. They must therefore authorise the caller themselves.
// ---------------------------------------------------------------------------

/** Extract the dollar-quoted body of `create or replace function <name>(`. */
function fnBody(sql: string, name: string): string {
  const at = sql.search(
    new RegExp(String.raw`create or replace function (public\.)?` + name + String.raw`\s*\(`, "i"),
  );
  if (at === -1) throw new Error(`${name} not defined in ${HARDENING}`);
  const open = sql.indexOf("$$", at);
  const close = sql.indexOf("$$", open + 2);
  if (open === -1 || close === -1) throw new Error(`${name} body not delimited`);
  return sql.slice(open + 2, close);
}

describe("tenant scoping of browser-reachable SECURITY DEFINER RPCs", () => {
  const hardening = read(HARDENING);

  it("does not treat an anon key as a trusted server caller", () => {
    const body = fnBody(hardening, "atlas_is_trusted_server");
    // anon also has a NULL auth.uid(), so NULL uid alone must not be enough
    expect(body).toMatch(/auth\.uid\(\) is null/);
    expect(body).toMatch(/coalesce\(auth\.role\(\), 'service_role'\) <> 'anon'/);
  });

  it("fails closed: only trusted server, a member, or super_admin may pass", () => {
    const body = fnBody(hardening, "atlas_can_access_tenant");
    expect(body).toMatch(/atlas_is_trusted_server\(\)/);
    expect(body).toMatch(/auth\.uid\(\) is not null/);
    expect(body).toMatch(/is_super_admin\(\)/);
    expect(body).toMatch(/p_tenant = any \(public\.atlas_caller_tenants\(\)\)/);
  });

  it("membership is read from memberships by the JWT subject", () => {
    const body = fnBody(hardening, "atlas_caller_tenants");
    expect(body).toMatch(/from public\.memberships m/);
    expect(body).toMatch(/m\."userId" = auth\.uid\(\)/);
  });

  it("assert helper raises 42501 rather than returning quietly", () => {
    const body = fnBody(hardening, "atlas_assert_tenant_access");
    expect(body).toMatch(/not public\.atlas_can_access_tenant\(p_tenant\)/);
    expect(body).toMatch(/raise exception 'Access denied' using errcode = '42501'/);
  });

  const guarded = [
    "human_reviews_get",
    "human_reviews_list",
    "human_reviews_list_job",
    "human_reviews_count_pending",
    "human_reviews_create",
    "human_reviews_approve",
    "human_reviews_reject",
    "human_reviews_request_changes",
    "jobs_list_jobs",
    "jobs_get_events",
    "jobs_resume_from_review",
  ];

  it.each(guarded)("%s authorises the caller before touching rows", (name) => {
    const body = fnBody(hardening, name);
    expect(body).toMatch(/atlas_can_access_tenant|atlas_assert_tenant_access/);
  });

  it.each([
    "human_reviews_approve",
    "human_reviews_reject",
    "human_reviews_request_changes",
  ])("%s derives the reviewer identity from the JWT, not the parameter", (name) => {
    const body = fnBody(hardening, name);
    expect(body).toMatch(/reviewer_user_id = coalesce\(auth\.uid\(\), p_reviewer_id\)/);
    // the raw parameter must never be written straight through
    expect(body).not.toMatch(/reviewer_user_id = p_reviewer_id/);
  });

  it("jobs_resume_from_review authorises before changing job state", () => {
    const body = fnBody(hardening, "jobs_resume_from_review");
    // the assert must run before any status branch can fire
    const assertAt = body.indexOf("atlas_assert_tenant_access");
    const firstUpdate = body.indexOf("update public.atlas_jobs");
    expect(assertAt).toBeGreaterThan(-1);
    expect(firstUpdate).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(firstUpdate);
    expect(body).toMatch(/atlas_assert_tenant_access\(v_job\.tenant_id\)/);
  });

  it("the job reads filter by the job's tenant, not just its id", () => {
    expect(fnBody(hardening, "jobs_list_jobs")).toMatch(/atlas_can_access_tenant\(j\.tenant_id\)/);
    const events = fnBody(hardening, "jobs_get_events");
    expect(events).toMatch(/join public\.atlas_jobs j on j\.id = e\.job_id/);
    expect(events).toMatch(/atlas_can_access_tenant\(j\.tenant_id\)/);
  });

  it("pins search_path on the guards so they cannot be hijacked", () => {
    for (const name of ["atlas_can_access_tenant", "atlas_assert_tenant_access", "human_reviews_approve", "jobs_list_jobs"]) {
      const at = hardening.search(new RegExp(String.raw`create or replace function (public\.)?` + name + String.raw`\s*\(`, "i"));
      const declaration = hardening.slice(at, at + 4000);
      expect(declaration).toMatch(/set search_path = public/);
    }
  });

  it("the routed Reviews page's job resume path is tenant-guarded", () => {
    // Reviews.tsx is a ROUTED page and calls resumeFromReview -> jobs_resume_from_review,
    // which is why the jobs_* family cannot simply be revoked from `authenticated`.
    const reviews = readFileSync(
      resolve(HERE, "../../pages/Reviews.tsx"),
      "utf8",
    );
    expect(reviews).toMatch(/resumeFromReview/);
    const rpcLayer = readFileSync(resolve(HERE, "../../lib/jobs/rpc.ts"), "utf8");
    expect(rpcLayer).toMatch(/jobs_resume_from_review/);
    // ...and the guard must stay in the function body.
    expect(fnBody(hardening, "jobs_resume_from_review")).toMatch(
      /atlas_assert_tenant_access\(v_job\.tenant_id\)/,
    );
  });

  it("the governance RPCs are scoped by their own resolver (verified, not assumed)", () => {
    const governance = read("20260904_atlas_governance.sql");
    // resolver raises unless the caller is a member of the tenant it touches
    const resolver = governance.slice(governance.indexOf("FUNCTION governance_resolve_tenant"));
    expect(resolver).toMatch(/m\."userId" = auth\.uid\(\)/);
    expect(resolver).toMatch(/RAISE EXCEPTION 'caller is not a member of any workspace'/);
    expect(resolver).toMatch(/RAISE EXCEPTION 'not authorized for tenant %'/);
    // and every governance RPC routes through it
    for (const fn of [
      "governance_record_decision",
      "governance_get_decision",
      "governance_list_decisions",
      "governance_latest_decision",
      "governance_list_actionable",
      "governance_list_events",
    ]) {
      const at = governance.indexOf(`FUNCTION ${fn}(`);
      expect(at).toBeGreaterThan(-1);
      const nextFn = governance.indexOf("CREATE OR REPLACE FUNCTION", at + 10);
      const body = governance.slice(at, nextFn === -1 ? undefined : nextFn);
      expect(body).toMatch(/governance_resolve_tenant\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Jobs / auth authorization boundary — the audit baseline
//
// NO database is available in this environment, so the tenant-isolation
// behaviour of the SECURITY DEFINER RPCs cannot be executed here. These tests
// therefore pin the *audited* boundary in code:
//
//   * the job RPC bodies are parsed from the real migration chain, so the
//     "is it guarded?" question is answered from the SQL that will ship,
//     not from a hand-maintained list;
//   * a NEW unguarded, `authenticated`-reachable SECURITY DEFINER function
//     fails the suite — that is the regression this class of bug arrives as;
//   * hardening a function is allowed to shrink the baseline, and the test
//     says so, so improving the code never breaks the build.
//
// Executable tenant-isolation tests still require a live database; see the
// REQUIRED TESTS section of the audit report.
// ---------------------------------------------------------------------------

type FnDef = { file: string; declaration: string; body: string };

/** Any of these calls in a body means the function authorizes the caller itself. */
const GUARD_CALLS = [
  "is_super_admin",
  "is_atlas_admin",
  "is_approved_user",
  "can_access_atlas",
  "get_current_tenant_id",
  "my_tenant_id",
  "auth.uid()",
  "auth.role()",
  "auth.jwt()",
  "governance_resolve_tenant",
  "atlas_can_access_tenant",
  "atlas_assert_tenant_access",
  // Trusted-server / internal-operator primitives added by the 2026-09
  // hardening migration (20260918). A function that calls one of these in its
  // body authorizes the caller itself.
  "atlas_is_trusted_server",
  "atlas_assert_trusted_server",
  "atlas_is_internal_admin",
  "atlas_assert_internal_admin",
];

/** Latest definition of every public function across the migration chain. */
function collectFunctions(): Map<string, FnDef> {
  const out = new Map<string, FnDef>();
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
  for (const file of migrationFiles().sort()) {
    const src = stripComments(read(file));
    for (const m of src.matchAll(re)) {
      const name = m[1].toLowerCase();
      const from = (m.index ?? 0) + m[0].length;
      const tagMatch = src.slice(from).match(/\$[a-zA-Z_]*\$/);
      if (!tagMatch || tagMatch.index === undefined) continue;
      const bodyStart = from + tagMatch.index + tagMatch[0].length;
      const close = src.indexOf(tagMatch[0], bodyStart);
      if (close === -1) continue;
      const semi = src.indexOf(";", close);
      if (semi === -1) continue;
      out.set(name, {
        file,
        declaration: src.slice(m.index ?? 0, semi),
        body: src.slice(bodyStart, close),
      });
    }
  }
  return out;
}

const FUNCS = collectFunctions();
const HARDENING_SQL = read(HARDENING);
const SERVICE_ONLY = new Set(arrayLiteral(HARDENING_SQL, "v_service_only"));
const ANON_ALLOWED = new Set([
  ...arrayLiteral(HARDENING_SQL, "v_anon_helpers"),
  ...arrayLiteral(HARDENING_SQL, "v_anon_public"),
]);

function isDefiner(name: string): boolean {
  return /security\s+definer/i.test(FUNCS.get(name)?.declaration ?? "");
}

function guardsItself(name: string): boolean {
  const body = (FUNCS.get(name)?.body ?? "").toLowerCase();
  return GUARD_CALLS.some((g) => body.includes(g.toLowerCase()));
}

/** SECURITY DEFINER, granted to `authenticated`, with no in-function check. */
function authenticatedReachableUnguarded(): string[] {
  return [...FUNCS.keys()]
    .filter((n) => isDefiner(n) && !guardsItself(n))
    .filter((n) => !SERVICE_ONLY.has(n) && !ANON_ALLOWED.has(n))
    .sort();
}

/**
 * The 16 functions the 2026-09 audit recorded as reachable by `authenticated`
 * with no in-function authorization check. Kept as a historical record: the
 * ratchet below proves none of them is unguarded any more — each has either
 * gained an in-body guard or been moved into the service-only set.
 */
const HISTORICALLY_UNGUARDED = [
  "ensure_profile",
  "handle_new_user",
  "jobs_awaiting_review",
  "jobs_cancel_job",
  "jobs_complete_job",
  "jobs_complete_step",
  "jobs_create_job",
  "jobs_create_step",
  "jobs_dequeue",
  "jobs_fail_job",
  "jobs_fail_step",
  "jobs_get_job",
  "jobs_retry_step",
  "jobs_stats",
  "jobs_unlock_stuck",
  "org_seat_limit",
];

/**
 * Ratchet allowlist. Intentionally EMPTY: the audited backlog is fully closed,
 * so ANY unguarded, authenticated-reachable SECURITY DEFINER function is now a
 * regression. Add an entry only together with a written reason.
 */
const DOCUMENTED_ALLOWLIST: Record<string, string> = {};

/** Unguarded, authenticated-reachable SECURITY DEFINER functions with no
 *  documented exception. Must stay empty. */
function unguardedRegressions(): string[] {
  return authenticatedReachableUnguarded().filter(
    (n) => !(n in DOCUMENTED_ALLOWLIST),
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(resolve(dir, d.name)) : [resolve(dir, d.name)],
  );
}

describe("jobs/auth authorization boundary (ratchet)", () => {
  it("introduces no NEW unguarded authenticated-reachable SECURITY DEFINER function", () => {
    expect(unguardedRegressions()).toEqual([]);
  });

  it("keeps the ratchet honest — the scanner still detects real shapes", () => {
    // the parser must have walked the whole migration chain...
    expect(FUNCS.size).toBeGreaterThan(50);
    // ...SECURITY DEFINER detection must work...
    expect(isDefiner("jobs_dequeue")).toBe(true);
    expect(isDefiner("jobs_list_jobs")).toBe(true);
    // ...the guard detector must recognise an in-body tenant authorization...
    expect(guardsItself("jobs_create_job")).toBe(true);
    expect(guardsItself("jobs_list_jobs")).toBe(true);
    // ...the service-only allowlist must actually exclude functions...
    expect(SERVICE_ONLY.has("jobs_dequeue")).toBe(true);
    expect(SERVICE_ONLY.has("jobs_awaiting_review")).toBe(true);
    expect(SERVICE_ONLY.has("handle_new_user")).toBe(true);
    // ...and the anon allowlist must be non-empty.
    expect(ANON_ALLOWED.size).toBeGreaterThan(0);
  });

  it("has closed every function the 2026-09 audit flagged as unguarded", () => {
    const still = authenticatedReachableUnguarded().filter((n) =>
      HISTORICALLY_UNGUARDED.includes(n),
    );
    expect(still).toEqual([]);
  });

  it("records that jobs_stats aggregates across EVERY tenant", () => {
    const body = FUNCS.get("jobs_stats")?.body ?? "";
    // global aggregates, no tenant predicate at all
    expect(body).toMatch(/FROM atlas_jobs\s*\)/);
    expect(body).not.toMatch(/tenant/i);
  });

  it("records that the job tables are tenant-owned but their RLS reads a JWT claim nobody sets", () => {
    const jobs = read("0020_atlas_jobs.sql");
    expect(jobs).toMatch(/CREATE TABLE IF NOT EXISTS atlas_jobs \(/);
    expect(jobs).toMatch(/tenant_id\s+uuid NOT NULL/);
    // The tenant policies do not use memberships — they read custom claims...
    expect(jobs).toMatch(/\(auth\.jwt\(\) ->> 'tenant_id'\)::uuid/);
    // ...and no migration installs the hook that would populate them, so the
    // policies resolve to NULL (deny) and the RPC bodies ARE the whole boundary.
    const chain = migrationFiles()
      .map(read)
      .join("\n");
    expect(chain).not.toMatch(/auth\.hook\.custom_access_token/);
  });

  it("records that the claim hook is only present commented-out in supabase/config.toml", () => {
    const config = readFileSync(
      resolve(HERE, "../../../supabase/config.toml"),
      "utf8",
    );
    expect(config).toMatch(/#\s*\[auth\.hook\.custom_access_token\]/);
  });

  it("leaves the job queue with no server-side entry point (no edge function calls it)", () => {
    const functionsDir = resolve(HERE, "../../../supabase/functions");
    const files = walk(functionsDir).filter((f) => f.endsWith(".ts"));
    const jobNames = [...FUNCS.keys()].filter((n) => n.startsWith("jobs_"));
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return jobNames.some((n) => new RegExp(`\\b${n}\\b`).test(src));
    });
    // If this ever fails, the worker gained a server-side caller and the
    // SERVICE_ONLY analysis for the jobs_* family must be revisited.
    expect(offenders).toEqual([]);
  });

  it("records that src/lib/platform is imported by no application code", () => {
    const srcDir = resolve(HERE, "../../");
    const files = walk(srcDir).filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes("/lib/platform/"),
    );
    const importers = files.filter((f) =>
      /from\s+"@\/lib\/platform/.test(readFileSync(f, "utf8")),
    );
    expect(importers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Job authorization boundary (2026-09 hardening)
//
// The job RPCs are SECURITY DEFINER, so the tenant RLS policies on atlas_jobs
// never apply to them. These tests pin the boundary the functions now enforce
// themselves, read from the SQL that will ship.
// ---------------------------------------------------------------------------

const WORKER_ONLY_JOBS = [
  "jobs_dequeue",
  "jobs_complete_job",
  "jobs_complete_step",
  "jobs_fail_job",
  "jobs_fail_step",
  "jobs_retry_step",
  "jobs_cancel_job",
  "jobs_unlock_stuck",
  "jobs_awaiting_review",
];

const TENANT_GUARDED_JOBS = [
  "jobs_create_job",
  "jobs_create_step",
  "jobs_get_job",
  "jobs_list_jobs",
  "jobs_get_events",
  "jobs_resume_from_review",
];

describe("job authorization boundary", () => {
  it("jobs_create_job derives identity from auth.uid(), never from p_user_id alone", () => {
    const body = fnBody(HARDENING_SQL, "jobs_create_job");
    expect(body).toMatch(/v_user := auth\.uid\(\)/);
    // p_user_id is only reached behind the trusted-server branch
    expect(body).toMatch(/atlas_is_trusted_server\(\) then\s*\n\s*v_user := p_user_id/);
    // the caller-supplied tenant id is the target, never the grant
    expect(body).toMatch(/atlas_assert_tenant_access\(p_tenant_id\)/);
    expect(body).not.toMatch(/m\."tenantId" = p_tenant_id/);
  });

  it("jobs_create_step authorises through the owning job's tenant", () => {
    const body = fnBody(HARDENING_SQL, "jobs_create_step");
    expect(body).toMatch(/select j\.tenant_id into v_tenant\s*\n\s*from public\.atlas_jobs/);
    expect(body).toMatch(/atlas_assert_tenant_access\(v_tenant\)/);
  });

  it("jobs_get_job authorises before reading tenant-owned rows", () => {
    const body = fnBody(HARDENING_SQL, "jobs_get_job");
    expect(body).toMatch(/atlas_assert_tenant_access\(v_tenant\)/);
    expect(body.indexOf("atlas_assert_tenant_access")).toBeGreaterThan(-1);
    expect(body.indexOf("atlas_assert_tenant_access")).toBeLessThan(
      body.indexOf("to_jsonb(j.*)"),
    );
  });

  it.each(WORKER_ONLY_JOBS)(
    "%s asserts a trusted server before any work",
    (name) => {
      expect(fnBody(HARDENING_SQL, name)).toMatch(/atlas_assert_trusted_server\(\)/);
    },
  );

  it.each(WORKER_ONLY_JOBS)("%s is service-role only", (name) => {
    expect(SERVICE_ONLY.has(name)).toBe(true);
    expect(ANON_ALLOWED.has(name)).toBe(false);
    expect(guardsItself(name)).toBe(true);
  });

  it("jobs_dequeue validates trust before it touches the queue", () => {
    const body = fnBody(HARDENING_SQL, "jobs_dequeue");
    const assertAt = body.indexOf("atlas_assert_trusted_server");
    const drainAt = body.indexOf("from public.atlas_jobs");
    expect(assertAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(drainAt);
  });

  it("jobs_stats is INTERNAL_ONLY and refuses ordinary tenant users", () => {
    const body = fnBody(HARDENING_SQL, "jobs_stats");
    expect(body).toMatch(/atlas_is_internal_admin\(\)/);
    expect(body).toMatch(/raise exception 'Access denied: internal operator required'/);
    // still an authenticated RPC (internal operators use it) but guarded
    expect(SERVICE_ONLY.has("jobs_stats")).toBe(false);
    expect(guardsItself("jobs_stats")).toBe(true);
    expect(body.indexOf("atlas_is_internal_admin")).toBeLessThan(
      body.indexOf("jsonb_build_object"),
    );
  });

  it("the internal-operator guard matches the app's internal role model", () => {
    const body = fnBody(HARDENING_SQL, "atlas_is_internal_admin");
    expect(body).toMatch(/is_super_admin\(\)/);
    expect(body).toMatch(/is_atlas_admin\(\)/);
    expect(body).toMatch(/auth\.uid\(\) is not null/);
  });

  it.each(TENANT_GUARDED_JOBS)(
    "%s stays reachable by authenticated members but is guarded",
    (name) => {
      expect(SERVICE_ONLY.has(name)).toBe(false);
      expect(ANON_ALLOWED.has(name)).toBe(false);
      expect(guardsItself(name)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Regulatory schema reconciliation (Phase 6)
//
// Production carries nine `atlas_regulatory_*` tables (verified by
// supabase/verification/20260906_atlas_regulatory_verification.sql). The
// repository draft 20260906_atlas_regulatory_intelligence.sql instead creates
// five unprefixed `regulatory_*` tables that exist nowhere in production, and
// the deletion path referenced one of them. These tests pin the reconciliation.
// ---------------------------------------------------------------------------

const REG_RECON = "20260919_atlas_regulatory_schema_reconciliation.sql";

const CANONICAL_REG_TABLES = [
  "atlas_regulatory_jurisdictions",
  "atlas_regulatory_sources",
  "atlas_regulatory_source_versions",
  "atlas_regulatory_propositions",
  "atlas_regulatory_proposition_versions",
  "atlas_regulatory_contradictions",
  "atlas_regulatory_review_queue",
  "atlas_regulatory_coverage",
  "atlas_regulatory_acquisition_jobs",
];

const ORPHAN_REG_TABLES = [
  "regulatory_jurisdictions",
  "regulatory_sources",
  "regulatory_propositions",
  "regulatory_contradictions",
  "regulatory_acquisition_jobs",
];

describe("regulatory schema reconciliation", () => {
  it("admin_prepare_user_deletion no longer references the obsolete unprefixed table", () => {
    const sql = stripComments(read("20260909_atlas_complimentary_access.sql"));
    const at = sql.indexOf("function public.admin_prepare_user_deletion");
    expect(at).toBeGreaterThan(-1);
    const body = sql.slice(at);
    // \b does NOT match inside atlas_regulatory_contradictions (the preceding
    // underscore is a word character), so this fires only on the orphan.
    expect(body).not.toMatch(/\bregulatory_contradictions\b/);
    expect(body).toMatch(/atlas_regulatory_contradictions/);
  });

  it("the forward reconciliation migration drops the orphan unprefixed tables", () => {
    const sql = stripComments(read(REG_RECON));
    for (const t of ORPHAN_REG_TABLES) {
      expect(sql).toMatch(
        new RegExp(String.raw`drop table if exists public\.` + t + String.raw`\b`, "i"),
      );
    }
  });

  it("the reconciliation migration creates all nine canonical tables with RLS", () => {
    const sql = read(REG_RECON);
    for (const t of CANONICAL_REG_TABLES) {
      expect(sql).toMatch(
        new RegExp(String.raw`create table if not exists public\.` + t + String.raw`\b`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(String.raw`alter table public\.` + t + String.raw`\s+enable row level security`, "i"),
      );
    }
    expect(sql).toMatch(/policy[\s\S]*for select to authenticated/i);
  });

  it("does not falsely claim the production migration version was applied", () => {
    // 20260906192230 is the PRODUCTION version key. The repository must not
    // make its draft look applied there by adopting that version.
    expect(migrationFiles().some((f) => f.startsWith("20260906192230"))).toBe(false);
    // the draft stays present under its own (different) version key
    expect(migrationFiles()).toContain(
      "20260906_atlas_regulatory_intelligence.sql",
    );
  });

  it("the production verification script still asserts the nine canonical tables", () => {
    const verification = readFileSync(
      resolve(
        HERE,
        "../../../supabase/verification/20260906_atlas_regulatory_verification.sql",
      ),
      "utf8",
    );
    for (const t of CANONICAL_REG_TABLES) {
      expect(verification).toContain(`'${t}'`);
    }
  });
});
