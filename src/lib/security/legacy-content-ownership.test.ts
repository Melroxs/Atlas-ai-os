// ---------------------------------------------------------------------------
// Legacy blog ownership backfill — regression tests
//
// The 20 pre-Content-Engine blog packages carried organizationId = NULL, so
// `content_engine_enqueue` handed a NULL tenant to `jobs_create_job`, which
// refuses it with `raise exception 'Tenant is required.' using errcode = '22004'`.
// No atlas_jobs row could be created for an existing post, so generation never
// started. 20260944 repairs the ROWS; it must not repair them by weakening the
// tenant model, and it must never guess which workspace owns the content.
//
// The properties below are textual because the property IS textual: the rule
// lives in the migration's predicate, its abort branches and its column list,
// and reading the SQL that runs is the most faithful way to assert it.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");
const BACKFILL_FILE = "20260944_atlas_legacy_content_ownership.sql";
const CONTENT_ENGINE_FILE = "20260935_atlas_content_engine.sql";
const JOBS_FILE = "20260918_atlas_security_hardening.sql";

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS, name), "utf8");
}

/** Drop comments so prose explaining the defect is not read as the fix. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const SQL = stripComments(read(BACKFILL_FILE));

describe("legacy blog ownership backfill — ownership is derived, never guessed", () => {
  it("resolves the workspace from the internal-role records, not from a literal", () => {
    expect(SQL).toMatch(/from public\.memberships m/);
    expect(SQL).toMatch(/join public\.profiles p on p\."_id" = m\."userId"/);
    expect(SQL).toMatch(/m\.status = 'active'/);
    expect(SQL).toMatch(/p\.account_status = 'active'/);
    expect(SQL).toMatch(/p\.platform_role in \('super_admin', 'atlas_admin'\)/);
    // The database mirrors the Content Studio's own gate (canAccessCRM).
    expect(SQL).not.toMatch(/canAccessCRM/);
  });

  it("carries no hardcoded organization id", () => {
    // A literal uuid here would be a guess that is wrong in every environment
    // but the one it was copied from.
    expect(SQL).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("aborts instead of choosing when the owner is missing or ambiguous", () => {
    expect(SQL).toMatch(/if v_orgs is null or array_length\(v_orgs, 1\) is null then\s+raise exception/);
    expect(SQL).toMatch(/if array_length\(v_orgs, 1\) > 1 then\s+raise exception/);
    // Both aborts carry an errcode and run before the UPDATE.
    const firstUpdate = SQL.indexOf('update public."atlasContentItems"');
    expect(firstUpdate).toBeGreaterThanOrEqual(0);
    expect(SQL.slice(0, firstUpdate)).toMatch(/errcode = '42501'/);
  });
});

describe("legacy blog ownership backfill — narrow and non-destructive", () => {
  it("matches only orphan blog packages", () => {
    expect(SQL).toMatch(/where c\."organizationId" is null\s+and c\."contentType" = 'blog'\s+and c\."parentContentId" is null/);
  });

  it("writes one column and leaves every other column and timestamp alone", () => {
    const update = SQL.slice(SQL.indexOf('update public."atlasContentItems"'));
    const setClause = update.slice(update.indexOf("set "), update.indexOf("where"));
    expect(setClause).toMatch(/"organizationId" = v_org/);
    for (const column of [
      "title",
      "slug",
      "body",
      "seo",
      "status",
      "publishedAt",
      "heroImage",
      "socialImage",
      "metadata",
      "_creationTime",
      "updatedAt",
    ]) {
      expect(setClause).not.toMatch(new RegExp(`"${column}"`));
    }
  });

  it("is idempotent and refuses to commit a partial adoption", () => {
    // Idempotency comes from the predicate: an already-adopted row is not matched.
    expect(SQL).toMatch(/c\."organizationId" is null/);
    expect(SQL).toMatch(/get diagnostics v_adopted = row_count/);
    expect(SQL).toMatch(/raise exception 'Legacy content adoption incomplete: % orphan blog package\(s\) remain after the backfill\.'/);
  });

  it("is a single data-only DO block: no schema, no function, no grant", () => {
    expect(SQL).toMatch(/^do \$\$/m);
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(SQL).not.toMatch(/create\s+table/i);
    expect(SQL).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(SQL).not.toMatch(/alter\s+table/i);
    expect(SQL).not.toMatch(/\bgrant\b/i);
    expect(SQL).not.toMatch(/\brevoke\b/i);
    expect(SQL).not.toMatch(/\bdrop\b/i);
    expect(SQL).not.toMatch(/set\s+not\s+null/i);
    expect(SQL).not.toMatch(/create\s+policy|enable\s+row\s+level\s+security/i);
  });
});

describe("legacy blog ownership backfill — the tenant model is not relaxed", () => {
  it("still requires a tenant from the job queue", () => {
    // The fix repairs the rows. It must never be "solved" by letting
    // jobs_create_job accept a NULL tenant.
    const jobs = stripComments(read(JOBS_FILE));
    expect(jobs).toMatch(/if p_tenant_id is null then\s+raise exception 'Tenant is required\.' using errcode = '22004'/);
    expect(SQL).not.toMatch(/jobs_create_job/);
    expect(SQL).not.toMatch(/jobs_dequeue|jobs_complete_job|jobs_fail_job/);
  });

  it("leaves content_engine_enqueue's authorization guard intact", () => {
    const engine = stripComments(read(CONTENT_ENGINE_FILE));
    expect(engine).toMatch(/public\.atlas_is_trusted_server\(\)\s+or public\.is_atlas_admin\(\)/);
    expect(engine).toMatch(/raise exception 'Access denied: not a member of this organization'\s+using errcode = '42501'/);
    expect(SQL).not.toMatch(/content_engine_enqueue/);
  });

  it("runs after the migration that added organizationId", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(files).toContain(BACKFILL_FILE);
    expect(
      BACKFILL_FILE > CONTENT_ENGINE_FILE,
      "the backfill must sort after the Content Engine migration that created the column",
    ).toBe(true);
  });
});
