// ---------------------------------------------------------------------------
// Atlas — schema-aware user-deletion cleanup (server-side, Edge Function code)
//
// Super Admin `delete_user` used to rely on the `admin_prepare_user_deletion`
// DB RPC, whose cleanup references camelCase table names ("tenantPacks",
// "toolActions", ...). The production database predates that naming and uses
// lowercase tables (tenantpacks, toolactions, ...) with the same camelCase
// columns, so the RPC fails on production and user deletion is blocked.
//
// This module performs the SAME FK-safe cleanup from the Edge Function
// (service-role, RLS-bypassing — matching the definer RPC's privileges)
// WITHOUT any schema change:
//
//   * Every reference is attempted against BOTH naming conventions and
//     missing-table/column errors (PostgREST PGRST205 / PGRST204) are
//     tolerated, so the same code works on camelCase dev and lowercase prod.
//   * Organization-owned rows are PRESERVED: their profile references are
//     set to NULL (history retained); they are never deleted.
//   * User-owned rows that must go are deleted (invites, provisioning rows).
//   * Billing/audit tables are never touched (legal/operational retention).
//
// The caller then deletes the profile row (which cascades memberships,
// sessions, and user-scoped complimentary grants) and finally removes the
// auth account. Nothing here reads or logs secrets.
// ---------------------------------------------------------------------------

/** Minimal structural surface of the service-role supabase-js client used
 *  here. The real client satisfies it; tests provide a mock. */
export interface DeletionAdminClient {
  from(table: string): {
    update(partial: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{
        error: { message: string; code?: string } | null;
      }>;
    };
    delete(): {
      eq(column: string, value: unknown): Promise<{
        error: { message: string; code?: string } | null;
      }>;
      or(filter: string): Promise<{
        error: { message: string; code?: string } | null;
      }>;
    };
  };
}

interface NullTarget {
  /** Table-name candidates: camelCase first, lowercase fallback. */
  tables: string[];
  /** Column-name candidates (same name in both eras except regulatory). */
  columns: string[];
}

/**
 * Profile-reference columns that are nullable and reference profiles without
 * ON DELETE CASCADE. Nulling them preserves the organization-owned row while
 * severing the link to the deleted user. Coverage is pinned by tests against
 * the live production FK audit (2026-09).
 */
export const NULL_TARGETS: NullTarget[] = [
  { tables: ["tenantPacks", "tenantpacks"], columns: ["activatedBy"] },
  { tables: ["documents"], columns: ["uploadedBy"] },
  { tables: ["recommendations"], columns: ["decidedBy"] },
  { tables: ["toolActions", "toolactions"], columns: ["actorId"] },
  { tables: ["toolActions", "toolactions"], columns: ["confirmedBy"] },
  { tables: ["notifications"], columns: ["recipientId"] },
  { tables: ["workflowApprovals", "workflowapprovals"], columns: ["decidedBy"] },
  { tables: ["impactAssessments", "impactassessments"], columns: ["decidedBy"] },
  { tables: ["auditLogs", "auditlogs"], columns: ["actorId"] },
  { tables: ["insuranceClaims", "insuranceclaims"], columns: ["createdBy"] },
  { tables: ["claimSupplements", "claimsupplements"], columns: ["createdBy"] },
  { tables: ["archiveIngestions", "archiveingestions"], columns: ["uploadedBy"] },
  { tables: ["memberships"], columns: ["invitedBy"] },
  // No FK in either schema today, but null the link when the table exists so
  // a future FK cannot silently break deletion.
  {
    tables: ["regulatory_contradictions", "atlas_regulatory_contradictions"],
    columns: ["resolved_by_id", "resolved_by"],
  },
];

/** PostgREST "table/column not found" codes — tolerated (schema divergence). */
const MISSING_OBJECT_CODES = new Set(["PGRST205", "PGRST204"]);

function isMissingObject(
  e: { message: string; code?: string } | null | undefined,
): boolean {
  if (!e) return false;
  if (e.code && MISSING_OBJECT_CODES.has(e.code)) return true;
  const m = e.message.toLowerCase();
  return (
    m.includes("could not find the table") ||
    m.includes("could not find the column") ||
    (m.includes("does not exist") && (m.includes("table") || m.includes("column") || m.includes("relation")))
  );
}

/**
 * FK-safe cleanup of everything that would block deleting the user's profile
 * and auth account. Preserves organization-owned data (references nulled),
 * removes user-owned invitation/provisioning rows, and never touches
 * billing/audit tables. Throws on unexpected errors; missing tables/columns
 * (naming-era divergence) are skipped.
 */
export async function cleanupUserData(
  admin: DeletionAdminClient,
  userId: string,
  email: string | null,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  // 1. Null profile references on organization-owned rows (both naming eras).
  for (const target of NULL_TARGETS) {
    for (const table of target.tables) {
      for (const column of target.columns) {
        const { error } = await admin
          .from(table)
          .update({ [column]: null })
          .eq(column, userId);
        if (error && !isMissingObject(error)) {
          throw new Error(
            `User data cleanup failed on ${table}.${column}: ${error.message}`,
          );
        }
      }
    }
  }

  // 2. User-owned invitation rows (invitedBy NOT NULL, NO ACTION FK).
  const inviteFilter = email
    ? `invitedBy.eq.${userId},email.eq.${email}`
    : `invitedBy.eq.${userId}`;
  const { error: inviteError } = await admin
    .from("invites")
    .delete()
    .or(inviteFilter);
  if (inviteError && !isMissingObject(inviteError)) {
    throw new Error(`User data cleanup failed on invites: ${inviteError.message}`);
  }

  // 3. User-owned provisioning rows (provisioned_by NOT NULL, no FK).
  const { error: provisioningError } = await admin
    .from("user_provisions")
    .delete()
    .or(`provisioned_by.eq.${userId},provisioned_user.eq.${userId}`);
  if (provisioningError && !isMissingObject(provisioningError)) {
    throw new Error(
      `User data cleanup failed on user_provisions: ${provisioningError.message}`,
    );
  }

  return { warnings };
}

/**
 * Delete the user's profile row. On production the profile has no FK to
 * auth.users, so the cascade chain (memberships.userId, sessions, user-scoped
 * complimentary grants) only fires when this row is removed explicitly.
 * Must be called AFTER cleanupUserData (all NO ACTION references are nulled).
 */
export async function deleteProfileRow(
  admin: DeletionAdminClient,
  userId: string,
): Promise<void> {
  const { error } = await admin.from("profiles").delete().eq("_id", userId);
  if (error) {
    throw new Error(`Could not delete the user's profile: ${error.message}`);
  }
}