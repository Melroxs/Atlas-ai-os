// ---------------------------------------------------------------------------
// Ingestion-deletion authorization guard
//
// Two halves must agree, and neither is checked at runtime by the other:
//
//   * the SERVER guard lives in the ingestion_delete_archive_file /
//     ingestion_delete_archive RPCs (SECURITY INVOKER, so the body IS the
//     boundary), and
//   * the CLIENT gate is `canDeleteIngestedFiles` in src/lib/archive/deletion.ts,
//     which only decides whether to render a button.
//
// If the server stops allowing a role the client still shows the button, the
// user gets a button that always fails. If the client is stricter than the
// server, a permitted operator is told they cannot do something they can. No
// database is available here, so this reads the SQL that will ship and the
// module the UI imports, and pins that they name the same roles.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  INGESTION_DELETE_ORG_ROLES,
  canDeleteIngestedFiles,
} from "@/lib/archive/deletion";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");

/** The migration that last redefined each RPC — the definition in force. */
const SQL = readFileSync(
  resolve(MIGRATIONS, "20260930_atlas_ingested_file_deletion_super_admin.sql"),
  "utf8",
).replace(/--.*$/gm, "");

/** The client-side gate. */
const GATE = readFileSync(resolve(HERE, "../archive/deletion.ts"), "utf8");

/** The dollar-quoted body of a function in the migration. */
function fnBody(name: string): string {
  const at = SQL.search(
    new RegExp(String.raw`create or replace function (public\.)?` + name + String.raw`\s*\(`, "i"),
  );
  if (at === -1) throw new Error(`${name} not defined in the 20260930 migration`);
  const open = SQL.indexOf("$$", at);
  const close = SQL.indexOf("$$", open + 2);
  return SQL.slice(open + 2, close);
}

const RPCS = ["ingestion_delete_archive_file", "ingestion_delete_archive"] as const;

describe("ingestion deletion — server authorization", () => {
  it.each(RPCS)("%s still refuses an anonymous caller", (name) => {
    // The first guard, before any tenant is resolved.
    expect(fnBody(name)).toMatch(/if v_user is null then\s*\n\s*raise exception 'You must be signed in/);
  });

  it.each(RPCS)("%s still allows the original org roles", (name) => {
    // The 20260930 change ADDED a platform role. It must not have narrowed
    // the set that shipped in 20260928.
    expect(fnBody(name)).toMatch(
      /if not v_super and public\.my_member_role\(\) not in \('owner', 'admin', 'manager'\) then/,
    );
  });

  it.each(RPCS)("%s now also allows a platform super_admin", (name) => {
    const body = fnBody(name);
    expect(body).toMatch(/v_super := public\.is_super_admin\(\)/);
    // The allowance is expressed as "skip the membership check", not as a
    // wider role list, so the org-role branch stays readable.
    expect(body).toMatch(/if not v_super and public\.my_member_role\(\)/);
  });

  it.each(RPCS)("%s resolves the tenant from the TARGET ROW only for a super admin", (name) => {
    const body = fnBody(name);
    // This is the whole point: my_tenant_id() is NULL for a non-member
    // super_admin, so they need the row; everyone else keeps membership scope.
    expect(body).toMatch(/if v_super then[\s\S]*?select [af]\."tenantId" into v_tenant/);
    expect(body).toMatch(/else\s*\n\s*v_tenant := public\.my_tenant_id\(\)/);
  });

  it.each(RPCS)("%s never takes the organization from the request", (name) => {
    // The target id is a file/archive uuid, never a tenant. A function that
    // read p_tenant_id here would be an IDOR.
    const body = fnBody(name);
    expect(body).not.toMatch(/p_tenant/i);
  });

  it.each(RPCS)("%s scopes every write to the resolved organization", (name) => {
    const body = fnBody(name);
    // 20260928's per-file UPDATE was keyed on the id alone. Once the tenant
    // can be resolved from the row, that has to be scoped too.
    const updates = body.match(/update public\.archiveFiles[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u).toMatch(/"tenantId" = v_tenant/);
    }
  });

  it.each(RPCS)("%s keeps the not-found message, so no cross-tenant existence leaks", (name) => {
    // A file in another organization must be indistinguishable from one that
    // does not exist.
    expect(fnBody(name)).toMatch(
      /if v_file\._id is null then raise exception 'Archive file not found\.'|if v_archive\._id is null then raise exception 'Archive not found\.'/,
    );
  });

  it.each(RPCS)("%s records whether a super admin performed the deletion", (name) => {
    // Auditing who actually did it matters more once a platform operator can.
    expect(fnBody(name)).toMatch(/'by_super_admin', v_super/);
  });

  it.each(RPCS)("%s is not executable by anon", (name) => {
    const argList = name === "ingestion_delete_archive_file" ? "uuid, text" : "uuid, text";
    expect(SQL).toMatch(
      new RegExp(
        String.raw`revoke execute on function public\.` + name + String.raw`\(` + argList + String.raw`\) from public, anon`,
      ),
    );
  });
});

describe("ingestion deletion — the bytes actually go away", () => {
  it("widens the storage delete policy to a super admin", () => {
    // Without this the RPC succeeds and the browser's storage.remove() is
    // silently rejected: the rows are gone and the bytes remain, reported as
    // a successful deletion.
    expect(SQL).toMatch(/public\.is_super_admin\(\)\s*\n\s*or \(storage\.foldername\(name\)\)\[1\] = public\.my_tenant_id\(\)::text/);
  });

  it("keeps the storage allowance inside the ingested-file buckets", () => {
    // email-attachments has its own policy and must not be widened.
    const policy = SQL.slice(SQL.lastIndexOf("create policy documents_storage_delete"));
    expect(policy).toMatch(/bucket_id = 'documents'::text or bucket_id = 'archives'::text/);
    expect(policy).not.toMatch(/email-attachments/);
  });

  it("replaces the previous policy instead of stacking a second one", () => {
    expect(SQL).toMatch(/drop policy if exists documents_storage_delete on storage\.objects/);
  });
});

describe("ingestion deletion — client gate matches the server", () => {
  it("names exactly the org roles the RPCs allow", () => {
    // The RPCs hard-code ('owner','admin','manager'). If the UI list drifts,
    // one side lies about who can delete.
    const rpcRoles = fnBody("ingestion_delete_archive_file").match(
      /my_member_role\(\) not in \(([^)]*)\)/,
    )?.[1];
    expect(rpcRoles).toBeDefined();
    const fromSql = (rpcRoles as string)
      .split(",")
      .map((r) => r.trim().replace(/'/g, ""))
      .filter(Boolean);
    expect(fromSql).toEqual([...INGESTION_DELETE_ORG_ROLES]);
  });

  it("recognizes exactly the platform role the RPCs special-case", () => {
    expect(GATE).toMatch(/INGESTION_DELETE_PLATFORM_ROLE = "super_admin"/);
    expect(fnBody("ingestion_delete_archive_file")).toMatch(
      /v_super := public\.is_super_admin\(\)/,
    );
    // is_super_admin() itself is platform_role='super_admin' AND active.
    const accessControl = readFileSync(
      resolve(MIGRATIONS, "202608221_atlas_user_management.sql"),
      "utf8",
    );
    expect(accessControl).toMatch(/platform_role = 'super_admin'/);
    expect(accessControl).toMatch(/account_status = 'active'/);
  });

  it("does not let the UI widen past the server for atlas_admin", () => {
    // atlas_admin is an internal operator role, not a super_admin. If someone
    // later "helpfully" adds it to the client list, this fails.
    expect(canDeleteIngestedFiles({ platformRole: "atlas_admin", memberRole: null })).toBe(false);
  });
});
