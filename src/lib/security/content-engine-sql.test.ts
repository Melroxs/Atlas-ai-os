/**
 * Content Engine SQL invariants.
 *
 * These tests read the migration that will ship — 20260935, still UNAPPLIED —
 * and fail if the security properties the audit required are not actually
 * present in the SQL. They are the regression guard for the two P0 defects:
 *
 *   1. an org-less content package was readable by ANY authenticated user;
 *   2. content_publication_upsert accepted a caller-supplied organization, so an
 *      org-less package could be attached to somebody's tenant.
 *
 * A textual test is the right tool here because the property IS textual: the
 * rule lives in the function body's WHERE clause and its raise blocks, and
 * there is no way to assert it that is more faithful than reading the SQL that
 * will run.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "../../../supabase/migrations/20260935_atlas_content_engine.sql");
const SQL = readFileSync(MIGRATION, "utf8");

/** The header of one `create or replace function` declaration. */
function functionHeader(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} must exist in the migration`).toBeGreaterThanOrEqual(0);
  return SQL.slice(start, SQL.indexOf("as $$", start));
}

/** The body of one `create or replace function` declaration. */
function functionBody(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} must exist in the migration`).toBeGreaterThanOrEqual(0);
  const asDollar = SQL.indexOf("as $$", start);
  const open = SQL.indexOf("$$", asDollar + "as ".length);
  const close = SQL.indexOf("$$;", open);
  return SQL.slice(open, close);
}

describe("content_package_get — org-less packages are not a cross-tenant read path", () => {
  const body = functionBody("content_package_get");

  it("grants an org-less package only to the trusted server and platform admins", () => {
    // The effective rule must be: trusted server OR platform admin OR the
    // package's OWN organization equals the caller's tenant.
    expect(body).toMatch(/public\.atlas_is_trusted_server\(\)/);
    expect(body).toMatch(/public\.is_atlas_admin\(\)/);
    expect(body).toMatch(/c\."organizationId" = public\.my_tenant_id\(\)/);
  });

  it("never treats 'organizationId is null' as readable", () => {
    // The original defect was exactly this: an `is null` branch that let any
    // signed-in user read the legacy platform content surface.
    expect(body).not.toMatch(/c\."organizationId"\s+is null/);
    expect(body).not.toMatch(/coalesce\(\s*c\."organizationId"/);
    // And the tenant comparison is guarded by an explicit not-null, so a NULL
    // organization can never satisfy `= my_tenant_id()`.
    expect(body).toMatch(/c\."organizationId" is not null/);
  });

  it("keeps the function SECURITY DEFINER with a pinned search_path", () => {
    const header = functionHeader("content_package_get");
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = public/);
  });
});

describe("content_publication_upsert — the package, not the caller, owns the tenant", () => {
  const body = functionBody("content_publication_upsert");

  it("refuses an org-less package for an ordinary organization member", () => {
    expect(body).toMatch(
      /if v_pkg_org is null then[\s\S]{0,200}raise exception 'Access denied: content package is not owned by your organization'[\s\S]{0,80}42501/,
    );
  });

  it("refuses a package that belongs to another organization", () => {
    expect(body).toMatch(/v_pkg_org is distinct from public\.my_tenant_id\(\)/);
    expect(body).toContain("content package belongs to another organization");
  });

  it("accepts p_organization ONLY for the trusted server or a platform admin", () => {
    // The frontend-supplied organization must be confined to the privileged
    // branch; the ordinary branch derives v_org from the package itself.
    expect(body).toMatch(
      /v_trusted := public\.atlas_is_trusted_server\(\) or public\.is_atlas_admin\(\);[\s\S]{0,200}if v_trusted then[\s\S]{0,120}v_org := coalesce\(p_organization, v_pkg_org\);[\s\S]{0,400}v_org := v_pkg_org;/,
    );
    // It must appear exactly once as an assignment, inside the trusted branch.
    expect(body.match(/v_org := coalesce\(p_organization, v_pkg_org\);/g)).toHaveLength(1);
  });

  it("refuses any publication with no organization at all", () => {
    expect(body).toMatch(
      /if v_org is null then[\s\S]{0,160}raise exception 'Access denied: content package has no organization'[\s\S]{0,60}42501/,
    );
  });

  it("keeps the package+provider+asset idempotency key on conflict", () => {
    expect(body).toMatch(/v_key := public\.content_publication_key\(p_package, p_provider, p_asset\)/);
    expect(body).toMatch(/on conflict \("idempotencyKey"\) do update/);
    // A re-queue must never undo a completed or in-flight publication.
    expect(body).toMatch(/when public\."atlasContentPublications"\.status in \('published', 'processing'\)/);
  });
});

describe("publication lease — a crash is recoverable, a live worker is not", () => {
  const claim = functionBody("content_publication_claim");
  const complete = functionBody("content_publication_complete");
  const fail = functionBody("content_publication_fail");

  it("stores the lease the way atlas_jobs does", () => {
    expect(SQL).toMatch(/"lockedAt"\s+bigint/);
    expect(SQL).toMatch(/"lockExpiresAt"\s+bigint/);
    expect(SQL).toMatch(/contentpublications_stale_lease_idx/);
    // A partial index over exactly the rows a sweeper has to find.
    expect(SQL).toMatch(
      /on public\."atlasContentPublications" \("lockExpiresAt"\)\s*\n\s*where status = 'processing'/,
    );
  });

  it("claims a queued or failed row, and a processing row only with an expired lease", () => {
    expect(claim).toMatch(/status in \('queued', 'failed'\)/);
    expect(claim).toMatch(
      /status = 'processing'\s*\n\s*and \("lockExpiresAt" is null or "lockExpiresAt" <= v_now\)/,
    );
    // Terminal states are never claimable: the whole predicate is a
    // disjunction over two branches, neither of which includes them.
    expect(claim).not.toMatch(/status in \('published', 'cancelled'\)\s*\n\s*or/);
  });

  it("always takes a lease with a floor, so a caller cannot request an instant one", () => {
    expect(claim).toMatch(/greatest\(coalesce\(p_lease_ms, ?\d+\), ?\d+\)/);
  });

  it("releases the lease on completion and on failure", () => {
    expect(complete).toMatch(/"lockedAt" = null/);
    expect(complete).toMatch(/"lockExpiresAt" = null/);
    expect(fail).toMatch(/"lockedAt" = null/);
    expect(fail).toMatch(/"lockExpiresAt" = null/);
  });

  it("never lets a completion or failure move a published row", () => {
    expect(complete).toMatch(/status in \('queued', 'processing', 'failed'\)/);
    expect(fail).toMatch(/status in \('queued', 'processing', 'failed'\)/);
    expect(complete).not.toMatch(/where .*status = 'processing' *\)/);
  });

  it("exposes a reclaimable listing for the crash sweeper", () => {
    const body = functionBody("content_publications_reclaimable");
    expect(body).toMatch(/p\.status = 'processing'/);
    expect(body).toMatch(
      /p\."lockExpiresAt" is null or p\."lockExpiresAt" <= public\.epoch_ms\(\)/,
    );
    // Tenant-safe: the same trusted-server / admin / own-org rule as every
    // other content read.
    expect(body).toMatch(/public\.is_atlas_admin\(\)/);
    expect(body).toMatch(/public\.atlas_is_trusted_server\(\)/);
    expect(body).toMatch(/p\."organizationId" = public\.my_tenant_id\(\)/);
  });
});

describe("topic selection — deterministic and tenant-scoped", () => {
  const next = functionBody("content_next_topic");

  it("lets only the trusted server or a platform admin name another organization", () => {
    expect(next).toMatch(
      /if public\.atlas_is_trusted_server\(\) or public\.is_atlas_admin\(\) then[\s\S]{0,120}v_org := p_organization;[\s\S]{0,300}else[\s\S]{0,200}if p_organization is not null and p_organization <> v_org then[\s\S]{0,200}42501/,
    );
  });

  it("reads only the named organization's own covered topics", () => {
    expect(next).toMatch(/"organizationId" is not distinct from v_org/);
    // Never the union of every tenant's coverage.
    expect(next).not.toMatch(/atlas_is_trusted_server\(\)\s*\n?\s*or\s+public\.is_atlas_admin\(\)\s*\n?\s*or/);
  });

  it("returns NULL rather than recycling a covered topic", () => {
    expect(next).toMatch(/not \(b\.topic = any \(v_topics\)\)/);
    expect(next).toMatch(/limit 1/);
  });
});

describe("grants, RLS and destructive DDL", () => {
  it("enables RLS on every new table", () => {
    for (const table of [
      "atlasContentPublications",
      "atlasContentAutomation",
      "atlasContentTopicBank",
    ]) {
      expect(SQL).toMatch(
        new RegExp(`alter table public\\."${table}" enable row level security`),
      );
    }
  });

  it("revokes anon from every new table and function", () => {
    expect(SQL).toMatch(/revoke all on table public\."atlasContentPublications" from anon/);
    expect(SQL).toMatch(/revoke all on table public\."atlasContentAutomation" from anon/);
    expect(SQL).toMatch(/revoke all on table public\."atlasContentTopicBank" from anon/);
    for (const fn of [
      "content_next_topic",
      "content_topic_remaining",
      "content_publications_reclaimable",
      "content_automation_list_due",
      "content_engine_enqueue",
    ]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`));
    }
  });

  it("never grants a blanket execute to anon or PUBLIC", () => {
    expect(SQL).not.toMatch(/grant execute on all functions/i);
    expect(SQL).not.toMatch(/grant all on all routines/i);
    expect(SQL).not.toMatch(/alter default privileges[\s\S]{0,200}grant all on functions to anon/i);
  });

  it("contains no destructive DDL", () => {
    // An unapplied migration is still the last chance to notice a DROP.
    for (const destructive of [
      /\bdrop table\b/i,
      /\bdrop schema\b/i,
      /\bdrop column\b/i,
      /\btruncate\b/i,
      /\bdrop owned by\b/i,
    ]) {
      expect(SQL, `migration must not contain ${destructive}`).not.toMatch(destructive);
    }
    // The only permitted drops are idempotency guards, not deletions of user
    // data: `drop policy if exists` (a re-run guard) and the one contentType
    // CHECK that is re-created immediately below with the new asset types.
    const drops = SQL.match(/drop\s+[a-z ]+[^;]*;/gi) ?? [];
    for (const statement of drops) {
      expect(statement.toLowerCase()).toMatch(/^drop (policy|constraint) if exists/);
    }
    expect(SQL).toMatch(/add constraint "atlasContentItems_contentType_check"/);
  });

  it("does not widen the public blog read path", () => {
    // The public published-blog surface belongs to migration 20260926 and is
    // untouched here: this migration grants anon nothing and revokes it from
    // every function it introduces, so the public behaviour cannot have
    // changed as a side effect of this repair.
    expect(SQL).not.toMatch(/grant execute on function public\.content_publish_blog to anon/i);
    expect(SQL).not.toMatch(/grant select on public\."atlasContentItems" to anon/i);
  });
});
