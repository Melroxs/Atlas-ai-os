// ---------------------------------------------------------------------------
// Deletion SQL guard — user and organization deletion
//
// Both features the Super Admin surface offers ("delete user", "delete
// organization") are only real if the DATABASE allows them, and neither was
// executable before 20260929:
//
//   * Deleting a user was aborted by 25 NO ACTION foreign keys pointing at
//     auth.users / public.profiles, so it failed from the Supabase dashboard,
//     from the Admin API, and from the Super Admin handler alike.
//   * No migration defined a tenant delete at all.
//
// NO database is available in this environment, so the executed behaviour
// cannot be asserted here. These tests instead pin the properties the SQL
// must keep, read from the migration that will ship — the same approach as
// migration-privileges.test.ts, so a later edit that quietly re-blocks
// deletion fails the suite instead of shipping.
//
// The FK rule was validated against the live catalog (project
// ibxvzxblyhzwokljkslt, 2026-09-29) by running the migration inside a
// transaction that was rolled back; the counts asserted here come from that
// audit.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  HERE,
  "../../../supabase/migrations/20260929_atlas_user_and_organization_deletion.sql",
);

const SQL = readFileSync(MIGRATION, "utf8");

/** Remove `-- line comments` so commented-out SQL is not treated as active. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const BODY = stripComments(SQL);

/** The dollar-quoted body of `create or replace function <name>(`. */
function fnBody(name: string): string {
  const at = BODY.search(
    new RegExp(String.raw`create or replace function (public\.)?` + name + String.raw`\s*\(`, "i"),
  );
  if (at === -1) throw new Error(`${name} not defined in the deletion migration`);
  const open = BODY.indexOf("$$", at);
  const close = BODY.indexOf("$$", open + 2);
  if (open === -1 || close === -1) throw new Error(`${name} body not delimited`);
  return BODY.slice(open + 2, close);
}

describe("user deletion is not blocked by foreign keys", () => {
  it("converts every blocking user reference to ON DELETE SET NULL", () => {
    // The audit found 9 columns referencing auth.users and 16 referencing
    // public.profiles with NO ACTION. The loop is driven by the catalog, not a
    // hand-written list, so it covers all 25 and any future one.
    expect(BODY).toMatch(/confrelid in \('auth\.users'::regclass, 'public\.profiles'::regclass\)/);
    expect(BODY).toMatch(/c\.confdeltype in \('a', 'r'\)/);
    expect(BODY).toMatch(/add constraint %I %s on delete set null/);
  });

  it("rebuilds the constraint from the catalog instead of guessing its columns", () => {
    // Hand-rebuilding a FK definition is how a multi-column or quoted
    // constraint silently loses a column.
    expect(BODY).toMatch(/pg_get_constraintdef\(c\.oid\)/);
  });

  it("strips the old delete rule whether or not Postgres printed it", () => {
    // pg_get_constraintdef omits ON DELETE when it is the default, so the
    // rewrite must work with the clause present AND absent.
    expect(BODY).toMatch(/regexp_replace\([\s\S]*?on delete \(no action\|restrict\)/);
  });

  it("relaxes NOT NULL on the two attribution columns that cannot accept NULL", () => {
    // These were the only NOT NULL columns among the 25 blockers. Both are
    // "who did this", so a deleted user nulls them instead of blocking.
    expect(BODY).toMatch(
      /alter table public\.invites alter column "invitedBy" drop not null/i,
    );
    expect(BODY).toMatch(
      /alter table public\.user_provisions alter column provisioned_by drop not null/i,
    );
  });

  it("keeps organization-owned rows: the references are nulled, not cascaded", () => {
    // set null, never cascade — the documents, claims and audit rows an
    // organization owns must survive the deletion of the person who made them.
    expect(BODY).not.toMatch(/on delete cascade/i);
  });
});

describe("admin_delete_organization", () => {
  const body = fnBody("admin_delete_organization");

  it("is super-admin only, with the trusted server as the single other caller", () => {
    expect(body).toMatch(
      /if not \(public\.is_super_admin\(\) or v_trusted\) then\s*\n\s*raise exception 'Access denied: super_admin required'/,
    );
  });

  it("pins search_path and is SECURITY DEFINER", () => {
    const at = BODY.search(
      /create or replace function (public\.)?admin_delete_organization\s*\(/i,
    );
    const declaration = BODY.slice(at, BODY.indexOf("$$", at));
    expect(declaration).toMatch(/security\s+definer/i);
    expect(declaration).toMatch(/set search_path = public/i);
  });

  it("refuses to delete an organization that is still being charged for", () => {
    expect(body).toMatch(
      /and s\.status in \('active', 'trialing', 'past_due', 'unpaid', 'incomplete'\)/,
    );
    expect(body).toMatch(/still has a live subscription/);
  });

  it("only lets the trusted server assert that billing was cancelled", () => {
    // A signed-in super admin must not be able to clear this gate from the
    // browser, or a paying customer could be deleted from under Stripe.
    expect(body).toMatch(/if v_live_status is not null and not \(p_billing_cancelled and v_trusted\) then/);
  });

  it("only honours a passed-in actor on the service-role path", () => {
    // coalesce(auth.uid(), p_actor_id) means a signed-in caller can never
    // spoof the audited actor, because its JWT uid wins.
    expect(body).toMatch(/v_actor := coalesce\(auth\.uid\(\), p_actor_id\)/);
  });

  it("audits the deletion before it happens, and the record survives it", () => {
    const auditAt = body.indexOf("insert into public.atlas_audit_log");
    const deleteAt = body.indexOf("delete from public.tenants");
    expect(auditAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(auditAt).toBeLessThan(deleteAt);
    expect(body).toMatch(/'organization_deleted'/);
  });

  it("clears the one tenant reference that does not cascade", () => {
    // user_provisions.tenant_id is NO ACTION, so the delete would abort on it.
    // Every other tenant reference already cascades or sets null.
    expect(body).toMatch(
      /delete from public\.user_provisions where tenant_id = p_tenant_id/,
    );
  });

  it("keeps billing history instead of deleting it", () => {
    // billing_audit_events, processed_webhook_events, stripe_customers and
    // subscriptions are SET NULL by existing constraints; the RPC must not
    // delete them.
    expect(body).not.toMatch(/delete from public\.subscriptions/);
    expect(body).not.toMatch(/delete from public\.stripe_customers/);
    expect(body).not.toMatch(/delete from public\.billing_audit_events/);
  });

  it("returns the storage paths so the server can purge the bytes", () => {
    // The rows cascade away; the objects in Supabase Storage would not.
    expect(body).toMatch(/d\."storageId"/);
    expect(body).toMatch(/f\."storageId"/);
    expect(body).toMatch(/a\."rawStorageId"/);
    expect(body).toMatch(/'storage_paths', coalesce\(to_jsonb\(v_storage\), '\[\]'::jsonb\)/);
  });

  it("returns the member ids, but never deletes an account from SQL", () => {
    // auth.users can only be deleted through the Auth Admin API, which the
    // Edge Function calls. The RPC must hand the ids over, not act on them.
    expect(body).toMatch(/'member_user_ids', to_jsonb\(v_user_ids\)/);
    expect(body).not.toMatch(/delete from auth\./);
  });

  it("never runs `delete users` itself — that stays an explicit opt-in", () => {
    expect(body).toMatch(/'delete_users', coalesce\(p_delete_users, false\)/);
  });

  it("is not executable by anon", () => {
    expect(BODY).toMatch(
      /revoke execute on function public\.admin_delete_organization\(uuid, text, boolean, boolean, uuid\) from public, anon/i,
    );
  });
});

describe("the Super Admin surface matches what the database enforces", () => {
  const page = readFileSync(resolve(HERE, "../../pages/SuperAdminOrgs.tsx"), "utf8");
  const client = readFileSync(resolve(HERE, "../actions/org-admin.ts"), "utf8");
  const edge = readFileSync(
    resolve(HERE, "../../../supabase/functions/admin-provision-user/index.ts"),
    "utf8",
  );

  it("sends every field the server requires", () => {
    // The server re-checks the name, so the client must send it.
    expect(client).toMatch(/confirmName: params\.confirmName/);
    expect(client).toMatch(/reason: params\.reason/);
  });

  it("wires the action into the edge function's action switch", () => {
    expect(edge).toMatch(/case "delete_organization":/);
    expect(edge).toMatch(/result = await handleDeleteOrganization\(ctx, body\)/);
  });

  it("cancels Stripe billing before the tenant is deleted", () => {
    const cancelAt = edge.search(/stripeRequest\(\s*"DELETE"/);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(edge.indexOf('"admin_delete_organization"')).toBeGreaterThan(cancelAt);
  });

  it("re-checks the typed name server-side instead of trusting the UI", () => {
    expect(edge).toMatch(/if \(confirmName !== orgName\) \{/);
  });

  it("keeps the last-active-owner guard on user deletion", () => {
    // Deleting an organization's owner would orphan it; deleting a user must
    // still refuse when they are the last active owner somewhere.
    expect(edge).toMatch(
      /Cannot delete the last active owner of an organization/,
    );
  });
});
