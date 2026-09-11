/**
 * Tests for the schema-aware user-deletion cleanup
 * (supabase/functions/_shared/user-deletion.ts).
 *
 * The module is pure (no Deno/env access), so it runs directly under vitest.
 * A mock service-role client records every query so the tests pin:
 *   - both naming conventions (camelCase dev + lowercase production) are
 *     attempted for every profile reference;
 *   - missing-table/column errors are tolerated (schema-era divergence);
 *   - unexpected errors fail closed;
 *   - only user-owned rows are deleted; billing/audit/tenant tables are never
 *     touched;
 *   - coverage matches the live production FK audit (every NO ACTION
 *     profile-reference column is nulled).
 */
import { describe, expect, it } from "vitest";
import {
  cleanupUserData,
  deleteProfileRow,
  NULL_TARGETS,
  type DeletionAdminClient,
} from "./user-deletion.ts";

interface RecordedCall {
  table: string;
  op: "update" | "delete";
  column?: string;
  value?: unknown;
  payload?: Record<string, unknown>;
  filter?: string;
}

interface MockOptions {
  missingTables?: Set<string>;
  failTables?: Map<string, { message: string; code?: string }>;
}

function mockAdmin(opts: MockOptions = {}): {
  client: DeletionAdminClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const resultFor = (table: string) => {
    if (opts.missingTables?.has(table)) {
      return { error: { message: `Could not find the table '${table}' in the schema cache`, code: "PGRST205" } };
    }
    const fail = opts.failTables?.get(table);
    return fail ? { error: fail } : { error: null };
  };
  const client: DeletionAdminClient = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              calls.push({ table, op: "update", column, value, payload });
              return resultFor(table);
            },
          };
        },
        delete() {
          return {
            async eq(column: string, value: unknown) {
              calls.push({ table, op: "delete", column, value });
              return resultFor(table);
            },
            async or(filter: string) {
              calls.push({ table, op: "delete", filter });
              return resultFor(table);
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

describe("cleanupUserData", () => {
  it("nulls every profile reference against BOTH naming conventions", async () => {
    const { client, calls } = mockAdmin();
    await cleanupUserData(client, "user-1", "jane@example.com");

    for (const target of NULL_TARGETS) {
      for (const table of target.tables) {
        for (const column of target.columns) {
          expect(calls).toContainEqual({
            table,
            op: "update",
            column,
            value: "user-1",
            payload: { [column]: null },
          });
        }
      }
    }
  });

  it("covers every NO ACTION profile-reference column found in the production FK audit", () => {
    // Live production audit (2026-09): FKs referencing public.profiles with
    // delete_rule NO ACTION. Nullable columns are nulled (organization-owned
    // rows preserved); NOT NULL columns are covered by deleting the row.
    const auditedNoAction: Array<[string, string, "null" | "delete"]> = [
      ["archiveingestions", "uploadedBy", "null"],
      ["auditlogs", "actorId", "null"],
      ["claimsupplements", "createdBy", "null"],
      ["documents", "uploadedBy", "null"],
      ["impactassessments", "decidedBy", "null"],
      ["insuranceclaims", "createdBy", "null"],
      ["invites", "invitedBy", "delete"],
      ["memberships", "invitedBy", "null"],
      ["notifications", "recipientId", "null"],
      ["recommendations", "decidedBy", "null"],
      ["tenantpacks", "activatedBy", "null"],
      ["toolactions", "actorId", "null"],
      ["toolactions", "confirmedBy", "null"],
      ["workflowapprovals", "decidedBy", "null"],
    ];
    for (const [table, column, mechanism] of auditedNoAction) {
      const coveredByNull = NULL_TARGETS.some(
        (t) => t.tables.includes(table) && t.columns.includes(column),
      );
      const coveredByDelete =
        mechanism === "delete" &&
        (table === "invites" || table === "user_provisions");
      expect(
        coveredByNull || coveredByDelete,
        `${table}.${column} must be covered (${mechanism})`,
      ).toBe(true);
    }
  });

  it("tolerates missing tables/columns from the naming-era divergence", async () => {
    // Production has lowercase tables only — the camelCase candidates are
    // missing and must be skipped without failing.
    const missing = new Set([
      "tenantPacks",
      "toolActions",
      "workflowApprovals",
      "impactAssessments",
      "auditLogs",
      "insuranceClaims",
      "claimSupplements",
      "archiveIngestions",
      "regulatory_contradictions",
    ]);
    const { client, calls } = mockAdmin({ missingTables: missing });
    await expect(cleanupUserData(client, "user-1", null)).resolves.toBeDefined();

    // The lowercase fallbacks were still attempted.
    expect(calls.some((c) => c.table === "tenantpacks")).toBe(true);
    expect(calls.some((c) => c.table === "toolactions")).toBe(true);
  });

  it("fails closed on unexpected database errors", async () => {
    const { client } = mockAdmin({
      failTables: new Map([["documents", { message: "permission denied for table documents", code: "42501" }]]),
    });
    await expect(cleanupUserData(client, "user-1", null)).rejects.toThrow(/documents/);
  });

  it("deletes invitation rows for the user id AND email when the email is known", async () => {
    const { client, calls } = mockAdmin();
    await cleanupUserData(client, "user-1", "jane@example.com");
    expect(calls).toContainEqual({
      table: "invites",
      op: "delete",
      filter: "invitedBy.eq.user-1,email.eq.jane@example.com",
    });
  });

  it("deletes invitation rows by user id only when the email is unknown", async () => {
    const { client, calls } = mockAdmin();
    await cleanupUserData(client, "user-1", null);
    expect(calls).toContainEqual({
      table: "invites",
      op: "delete",
      filter: "invitedBy.eq.user-1",
    });
  });

  it("deletes user provisioning rows", async () => {
    const { client, calls } = mockAdmin();
    await cleanupUserData(client, "user-1", "jane@example.com");
    expect(calls).toContainEqual({
      table: "user_provisions",
      op: "delete",
      filter: "provisioned_by.eq.user-1,provisioned_user.eq.user-1",
    });
  });

  it("never touches billing, audit, or tenant tables", async () => {
    const { client, calls } = mockAdmin();
    await cleanupUserData(client, "user-1", "jane@example.com");
    const touched = new Set(calls.map((c) => c.table));
    for (const forbidden of [
      "organization_subscriptions",
      "billing_audit_events",
      "processed_webhook_events",
      "atlas_audit_log",
      "tenants",
      "complimentary_access",
      "plans",
    ]) {
      expect(touched.has(forbidden), `${forbidden} must never be touched`).toBe(false);
    }
  });
});

describe("deleteProfileRow", () => {
  it("deletes the user's profile row", async () => {
    const { client, calls } = mockAdmin();
    await deleteProfileRow(client, "user-1");
    expect(calls).toContainEqual({ table: "profiles", op: "delete", column: "_id", value: "user-1" });
  });

  it("throws when the profile cannot be deleted", async () => {
    const { client } = mockAdmin({
      failTables: new Map([["profiles", { message: 'null value in column "uploadedBy" violates not-null constraint', code: "23502" }]]),
    });
    await expect(deleteProfileRow(client, "user-1")).rejects.toThrow(/profile/);
  });
});