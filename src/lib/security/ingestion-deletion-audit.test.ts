// ---------------------------------------------------------------------------
// Ingestion-deletion AUDIT guard
//
// A destructive action that is not recorded is not auditable, and the failure
// is silent: the delete succeeds and the operator sees a success message.
//
// The bug this pins was found live during the 2026-09-29 production
// reconciliation. Both deletion RPCs recorded through `public.log_audit()`,
// which starts:
//
//     declare v_tenant uuid := public.my_tenant_id();
//     if v_tenant is null then return; end if;
//
// `my_tenant_id()` is NULL for exactly the platform super_admin that the
// super-admin allowance is for, so a super-admin deletion returned from
// log_audit WITHOUT WRITING ANYTHING. Verified live: a super-admin deletion
// of a cross-organization file succeeded and left public.auditLogs untouched.
//
// `public.auditLogs` has RLS enabled and NO policies, so a SECURITY INVOKER
// RPC cannot insert into it directly — which is why log_audit is SECURITY
// DEFINER. The replacement, `ingestion_write_audit`, is a narrow SECURITY
// DEFINER helper that takes the organization explicitly and authorizes it
// in-body, so the super-admin branch is auditable without widening anything.
//
// No database is available here, so this reads the SQL that will ship.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");

const SQL = readFileSync(
  resolve(MIGRATIONS, "20260930_atlas_ingested_file_deletion_super_admin.sql"),
  "utf8",
).replace(/--.*$/gm, "");

function fnBody(name: string): string {
  const at = SQL.search(
    new RegExp(String.raw`create or replace function (public\.)?` + name + String.raw`\s*\(`, "i"),
  );
  if (at === -1) throw new Error(`${name} not defined in the 20260930 migration`);
  const open = SQL.indexOf("$$", at);
  const close = SQL.indexOf("$$", open + 2);
  return SQL.slice(open + 2, close);
}

const LOG_AUDIT = readFileSync(
  resolve(MIGRATIONS, "0001_schema.sql"),
  "utf8",
).replace(/--.*$/gm, "");

describe("the audit hole that made super-admin deletions unaudited", () => {
  it("confirms log_audit really does skip a caller with no workspace", () => {
    // Pinned against the real shared helper, not a copy of it, so if
    // log_audit is ever fixed to accept an explicit organization this test
    // tells us the workaround can be revisited.
    const at = LOG_AUDIT.search(/create or replace function public\.log_audit\s*\(/i);
    expect(at).toBeGreaterThan(-1);
    const body = LOG_AUDIT.slice(at, at + 1200);
    expect(body).toMatch(/declare v_tenant uuid := public\.my_tenant_id\(\)/);
    expect(body).toMatch(/if v_tenant is null then return; end if;/);
    // ...and it writes to auditLogs, the RLS-locked table.
    expect(body).toMatch(/insert into public\.auditLogs/);
  });

  it("does not route either deletion RPC through log_audit any more", () => {
    for (const name of ["ingestion_delete_archive_file", "ingestion_delete_archive"]) {
      expect(fnBody(name)).not.toMatch(/perform public\.log_audit\(/);
    }
  });

  it("records the deletion on BOTH paths, not only the member path", () => {
    for (const name of ["ingestion_delete_archive_file", "ingestion_delete_archive"]) {
      const body = fnBody(name);
      expect(body).toMatch(/perform public\.ingestion_write_audit\(/);
      // The organization passed is the RESOLVED one, which is the whole point:
      // for a super admin it is the target row's org, not my_tenant_id().
      expect(body).toMatch(/perform public\.ingestion_write_audit\(\s*\n\s*v_tenant,\s*\n\s*v_user,/);
    }
  });

  it("distinguishes a super-admin deletion in the record itself", () => {
    for (const name of ["ingestion_delete_archive_file", "ingestion_delete_archive"]) {
      const body = fnBody(name);
      expect(body).toMatch(/case when v_super then 'super_admin' else 'user' end/);
      expect(body).toMatch(/'by_super_admin', v_super/);
    }
  });
});

describe("ingestion_write_audit authorizes itself", () => {
  const body = fnBody("ingestion_write_audit");

  it("is SECURITY DEFINER, because auditLogs RLS denies every direct insert", () => {
    const at = SQL.search(
      /create or replace function (public\.)?ingestion_write_audit\s*\(/i,
    );
    const declaration = SQL.slice(at, SQL.indexOf("$$", at));
    expect(declaration).toMatch(/security\s+definer/i);
    expect(declaration).toMatch(/set search_path = public/i);
  });

  it("refuses to attribute the record to anybody but the signed-in caller", () => {
    expect(body).toMatch(
      /if p_actor <> auth\.uid\(\) then\s*\n\s*raise exception 'Audit actor must be the signed-in caller\.'/,
    );
  });

  it("refuses to record an entry for an organization the caller does not act for", () => {
    // The critical guard: without it, any authenticated user could forge audit
    // rows for arbitrary organizations, which is worse than no audit at all.
    expect(body).toMatch(
      /if not \(p_tenant = public\.my_tenant_id\(\) or public\.is_super_admin\(\)\) then\s*\n\s*raise exception 'Access denied: cannot record an audit entry for another organization\.'/,
    );
  });

  it("rejects incomplete audit context rather than writing a partial row", () => {
    expect(body).toMatch(
      /if p_tenant is null or p_actor is null then\s*\n\s*raise exception 'Audit context is incomplete\.'/,
    );
  });

  it("checks the actor before the organization, so attribution is never guessed", () => {
    expect(body.indexOf("p_actor <> auth.uid()")).toBeLessThan(
      body.indexOf("p_tenant = public.my_tenant_id()"),
    );
  });

  it("is not executable by anon", () => {
    expect(SQL).toMatch(
      /revoke execute on function public\.ingestion_write_audit\(uuid, uuid, text, text, text, text, jsonb\) from public, anon/i,
    );
  });

  it("is not one of the unguarded authenticated-reachable definer functions", () => {
    // The privilege ratchet in migration-privileges.test.ts fails on a new
    // unguarded SECURITY DEFINER function; this is the same guard stated here
    // so the intent is explicit at the point of definition.
    expect(body).toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(/public\.my_tenant_id\(\)/);
    expect(body).toMatch(/public\.is_super_admin\(\)/);
  });
});
