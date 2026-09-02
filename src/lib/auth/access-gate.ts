/**
 * Atlas access gate — the single, testable authorization decision layer.
 *
 * This is the EXACT logic the production RequireAuth/RequireAccess/RequireInternalAuth
 * guards enforce, extracted as a pure function so the authorization matrix can be
 * regression-tested directly (see access-gate.test.ts).
 *
 * FAIL-CLOSED BILLING RULE:
 *   Only super_admin bypasses billing checks.
 *   Every customer (regardless of role) must have:
 *     1. An authenticated profile (account_status != null)
 *     2. An active tenant membership (tenant_id != null)
 *     3. An allowed billing_state (= 'active')
 *
 *   billing_state = null, 'pending_checkout', 'cancelled',
 *   'payment_failed', 'suspended', or any unknown value → DENIED.
 *
 * The model:
 *   Roles (platform_role):
 *     super_admin     → full platform access (bypasses billing)
 *     atlas_admin     → Atlas + CRM + Mail + Users (no Pilot admin)
 *     customer_admin  → customer dashboard + company settings
 *     customer_user   → customer dashboard only
 *     pilot_user      → pilot experience only
 *     user            → default (treated as customer_user)
 *
 *   Account status (account_status):
 *     active          → proceeding to billing check
 *     pending         → denied
 *     suspended       → denied
 *     revoked         → denied
 *     null/missing    → denied (fail-closed)
 *
 *   Billing state (billing_state — from tenant):
 *     active          → ALLOW
 *     past_due        → ALLOW (grace period — customer has already paid)
 *     pending_checkout → DENY (has not completed checkout)
 *     payment_failed  → DENY
 *     cancelled       → DENY
 *     suspended       → DENY
 *     null / missing  → DENY (no tenant or no billing state)
 *     unknown         → DENY (fail-closed)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AtlasRole =
  | "super_admin"
  | "atlas_admin"
  | "customer_admin"
  | "customer_user"
  | "pilot_user"
  | "user";

export type AtlasAccountStatus = "active" | "pending" | "suspended" | "revoked";

export type AtlasAccessDecision =
  | { allowed: true; reason: "super_admin" | "active" | "past_due" }
  | {
      allowed: false;
      reason:
        | "missing_profile"
        | "pending"
        | "suspended"
        | "revoked"
        | "unknown_status"
        | "pending_checkout"
        | "payment_failed"
        | "cancelled"
        | "missing_tenant"
        | "unknown_billing_state";
    };

export interface AccessProfileLike {
  account_status?: string | null;
  platform_role?: string | null;
  billing_state?: string | null;
}

// ---------------------------------------------------------------------------
// Core access evaluation
// ---------------------------------------------------------------------------

/**
 * Decide Atlas access from a profile row.
 *
 * FAIL-CLOSED: null/undefined profile → denied.
 * Missing tenant (no membership) → denied.
 * NULL billing_state → denied.
 * Unknown billing_state → denied.
 * Only 'active' and 'past_due' grant customer access.
 * super_admin always passes (the only bypass).
 */
export function evaluateAtlasAccess(
  profile: AccessProfileLike | null | undefined,
): AtlasAccessDecision {
  if (!profile) {
    return { allowed: false, reason: "missing_profile" };
  }

  const platformRole = normalizeRole(profile.platform_role);
  if (platformRole === "super_admin") {
    return { allowed: true, reason: "super_admin" };
  }

  // --- Account status gate (fail-closed) ---
  const accountStatus = normalizeStatus(profile.account_status);
  switch (accountStatus) {
    case "pending":
      return { allowed: false, reason: "pending" };
    case "suspended":
      return { allowed: false, reason: "suspended" };
    case "revoked":
      return { allowed: false, reason: "revoked" };
    case "active":
      // Account is active — proceed to billing check
      break;
    default:
      return { allowed: false, reason: "unknown_status" };
  }

  // --- Tenant membership gate ---
  // If the user has no tenant membership, they cannot access the product.
  // billing_state is NULL when there is no tenant.
  const billingState = normalizeBillingState(profile.billing_state);

  // --- Billing state gate (fail-closed) ---
  // Only 'active' and 'past_due' (grace period) grant access.
  // Everything else — including NULL — is denied.
  switch (billingState) {
    case "active":
      return { allowed: true, reason: "active" };
    case "past_due":
      // Grace period: customer has paid before, subscription is past due
      // but Stripe may still be retrying. Allow access.
      return { allowed: true, reason: "past_due" };
    case "pending_checkout":
      return { allowed: false, reason: "pending_checkout" };
    case "cancelled":
      return { allowed: false, reason: "cancelled" };
    case "payment_failed":
      return { allowed: false, reason: "payment_failed" };
    case "suspended":
      return { allowed: false, reason: "suspended" };
    case null:
    default:
      // NULL = no tenant or no billing state = deny.
      // Unknown values = fail-closed = deny.
      return { allowed: false, reason: billingState === null ? "missing_tenant" : "unknown_billing_state" };
  }
}

// ---------------------------------------------------------------------------
// Role normalization
// ---------------------------------------------------------------------------

const VALID_ROLES: AtlasRole[] = [
  "super_admin",
  "atlas_admin",
  "customer_admin",
  "customer_user",
  "pilot_user",
  "user",
];

export function normalizeRole(raw?: string | null): AtlasRole {
  const r = (raw ?? "user").toLowerCase().trim();
  if ((VALID_ROLES as string[]).includes(r)) return r as AtlasRole;
  return "user";
}

const VALID_STATUSES: AtlasAccountStatus[] = [
  "active",
  "pending",
  "suspended",
  "revoked",
];

export function normalizeStatus(raw?: string | null): AtlasAccountStatus {
  const s = (raw ?? "pending").toLowerCase().trim();
  if ((VALID_STATUSES as string[]).includes(s)) return s as AtlasAccountStatus;
  return "pending";
}

// ---------------------------------------------------------------------------
// Billing state normalization
// ---------------------------------------------------------------------------

export type AtlasBillingState = "pending_checkout" | "active" | "past_due" | "payment_failed" | "cancelled" | "suspended" | null;

const VALID_BILLING_STATES: string[] = [
  "pending_checkout",
  "active",
  "past_due",
  "payment_failed",
  "cancelled",
  "suspended",
];

/**
 * Normalize a raw billing_state value.
 * Returns null only when the input is null/undefined (no tenant).
 * Unknown non-null values are returned as-is so the access gate
 * can return "unknown_billing_state" rather than "missing_tenant".
 */
export function normalizeBillingState(raw?: string | null): AtlasBillingState {
  if (raw === null || raw === undefined) return null;
  const s = raw.toLowerCase().trim();
  if (VALID_BILLING_STATES.includes(s)) return s as AtlasBillingState;
  // Preserve unknown values so fail-closed logic can identify them.
  return s as AtlasBillingState;
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Is this role an internal Atlas operator (not a customer)?
 */
export function isInternalRole(role: AtlasRole): boolean {
  return role === "super_admin" || role === "atlas_admin";
}

/**
 * Can this role access the Pilot admin section?
 * Only super_admin has Pilot admin access.
 */
export function canAccessPilotAdmin(role: AtlasRole): boolean {
  return role === "super_admin";
}

/**
 * Can this role access the CRM section?
 * super_admin and atlas_admin.
 */
export function canAccessCRM(role: AtlasRole): boolean {
  return role === "super_admin" || role === "atlas_admin";
}

/**
 * Can this role access the Mail/outreach section?
 * super_admin and atlas_admin.
 */
export function canAccessMail(role: AtlasRole): boolean {
  return role === "super_admin" || role === "atlas_admin";
}

/**
 * Can this role access the Users & Access admin section?
 * super_admin and atlas_admin.
 */
export function canAccessUserAdmin(role: AtlasRole): boolean {
  return role === "super_admin" || role === "atlas_admin";
}

/**
 * Can this role manage other users (change roles, suspend, etc.)?
 * Only super_admin can assign admin-level roles.
 * atlas_admin can manage customer roles only.
 */
export function canManageUsers(role: AtlasRole): boolean {
  return role === "super_admin" || role === "atlas_admin";
}

/**
 * Can this role assign admin-level roles (super_admin, atlas_admin)?
 * Only super_admin.
 */
export function canAssignAdminRoles(role: AtlasRole): boolean {
  return role === "super_admin";
}

/**
 * Can this role access the normal Atlas customer dashboard?
 * Access is controlled by evaluateAtlasAccess (billing gate), not by role alone.
 * This helper is used for UI navigation hints only — the actual gate is
 * evaluateAtlasAccess in RequireAuth.
 */
export function canAccessAtlasDashboard(role: AtlasRole): boolean {
  return role !== "super_admin" || true; // All roles can attempt; billing gate decides
}

/**
 * Given a role, what is the default landing path after login?
 */
export function getDefaultLandingPath(role: AtlasRole): string {
  switch (role) {
    case "super_admin":
    case "atlas_admin":
      return "/dashboard";
    case "customer_admin":
    case "customer_user":
      return "/dashboard";
    case "pilot_user":
      return "/dashboard/pilot";
    default:
      return "/dashboard";
  }
}
