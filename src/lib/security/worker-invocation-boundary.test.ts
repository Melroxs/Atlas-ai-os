// ---------------------------------------------------------------------------
// Worker invocation boundary — regression tests
//
// The Content Engine worker is drained by an invocation that the platform
// cannot currently authenticate without a service-role-capable credential
// somewhere. Until that is resolved, the important property to pin is that
// the worker is NOT reachable by anything weaker than a genuine service
// caller, and that no shortcut has been introduced to make the drain work.
//
// These are static tests: they read the repository, not production, so they
// run in CI. The live behaviour is verified separately against the deployed
// function (see the report) — anon, malformed JWT and arbitrary bearer token
// are all rejected by the gateway with verify_jwt = true.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const CONFIG = read("supabase/config.toml");
const WORKER = read("supabase/functions/content-engine-worker/index.ts");

describe("worker invocation boundary", () => {
  it("1. the worker keeps JWT verification enabled", () => {
    expect(CONFIG).toMatch(
      /\[functions\.content-engine-worker\][\s\S]{0,200}?verify_jwt\s*=\s*true/,
    );
  });

  it("2. the worker still refuses anything that is not a service caller or an admin", () => {
    // authorize() must run BEFORE any work, and must reject a non-admin,
    // non-service caller.
    expect(WORKER).toMatch(
      /const authorized = await authorize\(req\);\s*\n\s*if \(!authorized\.ok\) return authorized\.response;/,
    );
    expect(WORKER).toMatch(
      /if \(isServiceCall\(request\)\) return \{ ok: true, mode: "service" \};/,
    );
    expect(WORKER).toMatch(/Platform administrator access required\./);
  });

  it("3. isServiceCall still requires the service role and was not weakened", () => {
    const start = WORKER.indexOf("function isServiceCall");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = WORKER.slice(start, WORKER.indexOf("}", start) + 1);
    // It must still be an exact comparison against the service role key.
    expect(body).toMatch(/token === SERVICE_ROLE/);
    // No static/shared token path may be added alongside it.
    expect(body).not.toMatch(/INTERNAL_TOKEN|WORKER_TOKEN|SHARED_SECRET/);
  });

  it("4. no static bearer token or service key is embedded in the worker source", () => {
    // A literal JWT (header.payload.signature) or an sb_/service key literal.
    expect(WORKER).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(WORKER).not.toMatch(/sb_secret_[A-Za-z0-9_-]{10,}/);
    expect(WORKER).not.toMatch(/service_role\s*=\s*["'][A-Za-z0-9._-]{20,}/i);
  });

  it("5. the worker reads its credentials from the environment only", () => {
    expect(WORKER).toMatch(/Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  });

  it("6. the scheduler driver cannot reach the worker without a configured token", () => {
    const driver = read("supabase/migrations/20260939_atlas_scheduler_driver_vault_token.sql");
    // It must read a dedicated token, and it must fail honestly when absent.
    expect(driver).toMatch(/atlas_service_token/);
    expect(driver).toMatch(/'skipped', 'service_token_not_configured'/);
    // It must never fall back to the service role key.
    expect(driver).not.toMatch(/service_role_key/i);
  });

  it("7. no new public RPC can drive the worker", () => {
    // Anything that could invoke a worker must not be anon-reachable. The
    // driver is the only entry point and is service-role only.
    const driver = read("supabase/migrations/20260938_atlas_scheduler_driver.sql");
    expect(driver).toMatch(
      /revoke execute on function public\.atlas_platform_tick\([\s\S]*?\)\s*\n?\s*from public, anon, authenticated/,
    );
    // And no migration may create a function that calls the worker URL.
    const migrations = read("supabase/migrations/20260941_atlas_content_create_trusted_scope.sql");
    expect(migrations).not.toMatch(/functions\/v1\//);
  });

  it("8. the job claim path remains service-role only", () => {
    // jobs_dequeue is what actually drains the queue, so it must keep its
    // in-body trusted-server assertion and its service-only grants.
    const hardening = read("supabase/migrations/20260918_atlas_security_hardening.sql");
    const start = hardening.indexOf("create or replace function public.jobs_dequeue");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = hardening.slice(start, hardening.indexOf("$$;", start));
    expect(body).toMatch(/perform public\.atlas_assert_trusted_server\(\);/);
    expect(body).toMatch(/for update of j skip locked/);
    expect(hardening).toMatch(/'jobs_dequeue'/);
  });

  it("9. overlapping worker invocations cannot claim the same job", () => {
    // Concurrency authority is the database, not the scheduler cadence.
    const hardening = read("supabase/migrations/20260918_atlas_security_hardening.sql");
    const start = hardening.indexOf("create or replace function public.jobs_dequeue");
    const body = hardening.slice(start, hardening.indexOf("$$;", start));
    expect(body).toMatch(/for update of j skip locked/);
    expect(body).toMatch(/lock_expires_at = now\(\) \+ v_lock_timeout/);
    expect(body).toMatch(/attempt_count = attempt_count \+ 1/);
  });
});
