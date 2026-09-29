// ---------------------------------------------------------------------------
// Function EXECUTE grant hygiene — regression tests for the PUBLIC-grant hole
//
// THE DEFECT THIS EXISTS TO CATCH
// ------------------------------
// PostgreSQL grants EXECUTE on every new function to PUBLIC. Every role,
// including `anon`, reaches a function *through* PUBLIC. So:
//
//     revoke all on function public.foo(...) from anon;
//
// is a NO-OP whenever the function was created after the last blanket
// `revoke execute on all functions in schema public from public`, because the
// PUBLIC grant is still in place and `anon` still holds it.
//
// This reached production and was verified live, not inferred. Two migrations
// were applied out of file order and so re-created functions AFTER 20260918 §4a
// had run, silently restoring the PUBLIC grant:
//
//   * 20260913 §1-§2 (the scheduler foundation) re-created schedules_*;
//   * 20260935 (the Content Engine) created content_*.
//
// With `set role anon`, all of schedules_upsert / schedules_fire_due /
// schedules_list / schedules_set_enabled / schedules_record_result EXECUTED
// successfully. Those functions have NO in-function authorization check by
// design, so that was an unauthenticated path to create arbitrary recurring
// schedules, force-fire them, enumerate every tenant's schedules and mutate
// their state.
//
// The existing content-engine SQL test asserted only that a revoke mentioning
// `anon` was present. It passed the whole time the revokes were ineffective.
// These tests assert the property that actually matters: the PUBLIC grant is
// gone too. They need no database.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");

const allFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/**
 * 20260918 §4a already ran `revoke execute on all functions in schema public
 * from public, anon, authenticated`, which closed the PUBLIC grant on every
 * function that existed at that point. Files at or before it are therefore
 * covered by that sweep even where they revoke a client role without naming
 * PUBLIC, and re-litigating them would be noise. Files AFTER it are held to
 * the stricter rule, because those are the ones that re-introduce the grant.
 */
const BASELINE = "20260918";
const files = allFiles.filter((f) => f > BASELINE);

/** Client roles: the ones an attacker or an ordinary signed-in user holds. */
const CLIENT_ROLES = ["anon", "authenticated"];

/**
 * Drop `--` line comments and `/* ... *\/` block comments.
 *
 * These migrations document the exact revoke they are describing inside a
 * comment (that is how the PUBLIC-grant defect is explained in 20260936), so
 * the scanners below must not read prose as executable SQL.
 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Every `revoke ... on function <sig> from <roles>` statement in a file.
 * Only single-line statements are considered; a multi-line one is reported by
 * the "multi-line revoke" test below rather than silently skipped.
 */
function functionRevokes(sql: string): Array<{ sig: string; roles: string[] }> {
  const out: Array<{ sig: string; roles: string[] }> = [];
  const re = /revoke\s+(?:all|execute)\s+on\s+function\s+([^\s]+)\s+from\s+([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    // Skip dynamic SQL: `execute format('revoke ... on function %s from ...')`
    // carries a `%s` placeholder, not a real signature, and the repair
    // migration's dynamic form already names public, anon and authenticated.
    if (m[1].includes("%") || m[1].includes("$")) continue;
    out.push({
      sig: m[1],
      roles: m[2]
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    });
  }
  return out;
}

describe("function EXECUTE grant hygiene", () => {
  it("finds migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // The core rule. A revoke that names a client role but not PUBLIC leaves the
  // function callable by that role, because PUBLIC still grants it.
  it.each(files)("%s: every function revoke of a client role also revokes PUBLIC", (file) => {
    const sql = stripComments(readFileSync(resolve(MIGRATIONS, file), "utf8"));
    const offenders = functionRevokes(sql).filter(
      (r) =>
        r.roles.some((role) => CLIENT_ROLES.includes(role)) &&
        !r.roles.includes("public"),
    );
    expect(
      offenders.map((o) => `${o.sig} from ${o.roles.join(",")}`),
      `${file} revokes a client role without revoking PUBLIC, so the PUBLIC grant ` +
        `survives and the revoke is a no-op`,
    ).toEqual([]);
  });

  // Guard against the regex above quietly missing a wrapped statement.
  it.each(files)("%s: no multi-line function revoke escapes the check", (file) => {
    const sql = stripComments(readFileSync(resolve(MIGRATIONS, file), "utf8"));
    const unwrapped = sql.match(
      /revoke\s+(?:all|execute)\s+on\s+function\s+[^;]*?from\s+(?:anon|authenticated)[\s\S]{0,200}?;/gi,
    ) ?? [];
    // Every revoke that ends on a different line than it started is either
    // matched by the single-line parser or must be inspected by hand.
    for (const statement of unwrapped) {
      const sig = statement.match(/on\s+function\s+([^\s(]+)/i)?.[1] ?? "";
      if (sig.includes("%") || sig.includes("$")) continue;
      const roles = (statement.match(/from\s+([^;]+);/i)?.[1] ?? "")
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
      if (roles.some((r) => CLIENT_ROLES.includes(r))) {
        expect(
          roles,
          `${file}: revoke of ${sig} must include PUBLIC in its role list`,
        ).toContain("public");
      }
    }
  });

  // The hardening migration is the authority for the service-only set, and it
  // gets this right. Pin it so the pattern cannot regress.
  it("20260918 revokes the service-only set from public, anon and authenticated", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS, "20260918_atlas_security_hardening.sql"),
      "utf8",
    );
    expect(sql).toMatch(
      /revoke execute on function %s from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /revoke execute on all functions in schema public from public, anon, authenticated/i,
    );
    // The Content Engine functions the Studio calls must stay reachable by a
    // signed-in user, or the browser path breaks.
    expect(sql).toMatch(/grant execute on function %s to authenticated/i);
  });

  // The repairs that closed the live hole must keep the sweep in place.
  it("20260936 re-applies the blanket PUBLIC revoke", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS, "20260936_atlas_function_grants_repair.sql"),
      "utf8",
    );
    expect(sql).toMatch(
      /revoke execute on all functions in schema public from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /alter default privileges in schema public\s+revoke execute on functions from public, anon/i,
    );
  });

  it("20260938/20260939 keep the scheduler driver off the client roles", () => {
    for (const file of [
      "20260938_atlas_scheduler_driver.sql",
      "20260939_atlas_scheduler_driver_vault_token.sql",
    ]) {
      const sql = readFileSync(resolve(MIGRATIONS, file), "utf8");
      expect(
        sql,
        `${file} must revoke the driver from public, not just the client roles`,
      ).toMatch(
        /revoke execute on function public\.atlas_platform_tick\([^)]*\)\s*\n?\s*from public, anon, authenticated/i,
      );
    }
  });
});
