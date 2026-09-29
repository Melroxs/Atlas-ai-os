// ---------------------------------------------------------------------------
// content_create tenant binding — regression tests
//
// The Content Studio creates a package by calling public.content_create from
// the browser, so the function itself is the tenant boundary. Two production
// defects came out of this:
//
//   1. 20260913 §5's content_create never set "organizationId". 20260935 added
//      that column plus contentitems_org_read ("organizationId" =
//      my_tenant_id()), so an org-less package was invisible to the
//      organization that created it, while contentitems_auth_read lets EVERY
//      authenticated user read an org-less row whose status is 'approved'.
//      20260940 re-specified the function so the database derives ownership.
//
//   2. 20260940 first trusted `atlas_is_trusted_server() or is_atlas_admin()`,
//      copying content_publication_upsert. is_atlas_admin() resolves through
//      auth.uid(), so any signed-in platform administrator reached the trusted
//      branch: they could create org-less content and could name a different
//      organization explicitly. Verified live against production, then fixed
//      in 20260941, which trusts ONLY the trusted server — a call with no
//      user session, which is the worker.
//
// The properties below are the ones that must never regress.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS, name), "utf8");
}

/** Drop comments so prose explaining the old approach is not read as code. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The live definition, which is the later of the two migrations. */
const SQL = stripComments(read("20260941_atlas_content_create_trusted_scope.sql"));

describe("content_create tenant binding", () => {
  it("derives the organization from my_tenant_id for any caller with a session", () => {
    expect(SQL).toMatch(/v_org\s*:=\s*public\.my_tenant_id\(\)/);
  });

  it("trusts only the trusted server, never is_atlas_admin", () => {
    // is_atlas_admin() resolves through auth.uid(), so a signed-in platform
    // admin would satisfy it and reach the org-less / cross-org branch.
    expect(SQL).toMatch(/v_trusted\s*:=\s*public\.atlas_is_trusted_server\(\)/);
    expect(SQL).not.toMatch(/v_trusted\s*:=\s*[^;]*is_atlas_admin/);
  });

  it("refuses a caller with no organization instead of creating an org-less row", () => {
    expect(SQL).toMatch(
      /if v_org is null then\s+raise exception 'Access denied: no active Atlas organization'\s+using errcode = '42501'/,
    );
  });

  it("never lets a caller name a different organization", () => {
    expect(SQL).toMatch(
      /if p_organization is not null and p_organization is distinct from v_org then\s+raise exception 'Access denied: cannot create content for another organization'\s+using errcode = '42501'/,
    );
  });

  it("writes the derived organization onto the row", () => {
    expect(SQL).toMatch(/"researchJobId", "organizationId"/);
    expect(SQL).toMatch(/p_parent_content_id, p_research_job_id, v_org/);
  });

  it("refuses to parent a package to another organization's content", () => {
    expect(SQL).toMatch(
      /if not v_trusted and v_parent_org is distinct from v_org then/,
    );
  });

  it("returns the organization it actually used", () => {
    expect(SQL).toMatch(/'organizationId', v_org/);
  });

  it("is revoked from PUBLIC as well as anon", () => {
    // A role-only revoke leaves the default PUBLIC grant intact, which is how
    // schedules_* became anonymously executable in production (20260936).
    expect(SQL).toMatch(
      /revoke execute on function public\.content_create\([\s\S]*?\) from public, anon;/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.content_create\([\s\S]*?\) to authenticated, service_role;/,
    );
  });

  it("keeps 20260913 §5 unapplied in the migration record", () => {
    // §5 is the source of the insecure contentprovenance_read policy and of
    // the org-less content_create. It is a repository file, not something
    // production has applied; the tenant-safe function lives in its own
    // forward migrations instead.
    const section5 = read("20260913_atlas_platform_infrastructure.sql");
    expect(section5).toMatch(
      /create policy contentprovenance_read[\s\S]*?for select to anon, authenticated using \(true\)/,
    );
    // ...and the forward migration must not reintroduce that policy.
    expect(SQL).not.toMatch(/contentprovenance_read/);
    expect(SQL).not.toMatch(/create policy/i);
  });

  it("20260940 is superseded by 20260941, not left as the live definition", () => {
    const prior = stripComments(read("20260940_atlas_content_create_tenant_safe.sql"));
    expect(prior).toMatch(/v_trusted\s*:=\s*public\.atlas_is_trusted_server\(\) or public\.is_atlas_admin\(\)/);
    // 20260941 sorts later and re-creates the function, so it is the live one.
    expect(
      "20260941_atlas_content_create_trusted_scope.sql" >
        "20260940_atlas_content_create_tenant_safe.sql",
    ).toBe(true);
  });
});
