import { describe, expect, it } from "vitest";
import {
  evaluateAtlasAccess,
  normalizeRole,
  normalizeStatus,
  isInternalRole,
  canAccessPilotAdmin,
  canAccessCRM,
  canAccessMail,
  canAccessUserAdmin,
  canManageUsers,
  canAssignAdminRoles,
  getDefaultLandingPath,
} from "./access-gate";

/**
 * Regression tests for the Atlas access gate — the exact decision enforced by
 * RequireAuth/RequireAccess/RequireInternalAuth on every protected route.
 *
 * Guards the production regression where an authenticated-but-unapproved user
 * was (a) incorrectly denied when their profile was active, and later (b)
 * nearly shipped as a universal bypass that allowed ANY authenticated Clerk
 * user regardless of account_status. The gate must stay strict and
 * provider-independent: authentication ≠ authorization.
 */
describe("evaluateAtlasAccess", () => {
  it("allows a super_admin regardless of account_status", () => {
    expect(evaluateAtlasAccess({ platform_role: "super_admin", account_status: "active" })).toEqual({
      allowed: true,
      reason: "super_admin",
    });
    // Even a pending/suspended super_admin passes — the platform owner is
    // never locked out of the product they administer.
    expect(evaluateAtlasAccess({ platform_role: "super_admin", account_status: "pending" })?.allowed).toBe(true);
    expect(evaluateAtlasAccess({ platform_role: "super_admin", account_status: null })?.allowed).toBe(true);
  });

  it("allows an active regular user WITH billing_state=active", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "active" })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("allows an active atlas_admin WITH billing_state=active", () => {
    expect(evaluateAtlasAccess({ platform_role: "atlas_admin", account_status: "active", billing_state: "active" })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("allows an active customer_admin WITH billing_state=active", () => {
    expect(evaluateAtlasAccess({ platform_role: "customer_admin", account_status: "active", billing_state: "active" })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("allows an active customer_user WITH billing_state=active", () => {
    expect(evaluateAtlasAccess({ platform_role: "customer_user", account_status: "active", billing_state: "active" })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("allows an active pilot_user WITH billing_state=active", () => {
    expect(evaluateAtlasAccess({ platform_role: "pilot_user", account_status: "active", billing_state: "active" })).toEqual({
      allowed: true,
      reason: "active",
    });
  });

  it("denies a regular user with active account but no billing_state", () => {
    // billing_state = null means no tenant or no billing state → denied
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: null })).toEqual({
      allowed: false,
      reason: "missing_tenant",
    });
  });

  it("denies a regular user with pending_checkout billing state", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "pending_checkout" })).toEqual({
      allowed: false,
      reason: "pending_checkout",
    });
  });

  it("denies a regular user with cancelled billing state", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "cancelled" })).toEqual({
      allowed: false,
      reason: "cancelled",
    });
  });

  it("denies a regular user with payment_failed billing state", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "payment_failed" })).toEqual({
      allowed: false,
      reason: "payment_failed",
    });
  });

  it("allows a regular user with past_due billing state (grace period)", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "past_due" })).toEqual({
      allowed: true,
      reason: "past_due",
    });
  });

  it("denies a regular user with unknown billing state (fail-closed)", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "active", billing_state: "something_unknown" })).toEqual({
      allowed: false,
      reason: "unknown_billing_state",
    });
  });

  it("denies a pending user (pilot gating)", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "pending" })).toEqual({
      allowed: false,
      reason: "pending",
    });
  });

  it("denies suspended and revoked users", () => {
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "suspended" })).toEqual({
      allowed: false,
      reason: "suspended",
    });
    expect(evaluateAtlasAccess({ platform_role: "user", account_status: "revoked" })).toEqual({
      allowed: false,
      reason: "revoked",
    });
  });

  it("fails closed for a missing profile row", () => {
    expect(evaluateAtlasAccess(null)).toEqual({
      allowed: false,
      reason: "missing_profile",
    });
    expect(evaluateAtlasAccess(undefined)).toEqual({
      allowed: false,
      reason: "missing_profile",
    });
  });

  it("fails closed for null/unknown field values", () => {
    // Both fields null → defaults apply → pending → denied.
    expect(evaluateAtlasAccess({ account_status: null, platform_role: null })).toEqual({
      allowed: false,
      reason: "pending",
    });
    // Unknown status strings must never grant access.
    expect(evaluateAtlasAccess({ account_status: "something_else" })?.allowed).toBe(false);
    expect(evaluateAtlasAccess({ account_status: "" })?.allowed).toBe(false);
    // An unknown role is NOT super_admin — still gated by account_status.
    expect(evaluateAtlasAccess({ platform_role: "tenant_admin", account_status: "active" })?.allowed).toBe(false); // no billing_state → denied
    expect(evaluateAtlasAccess({ platform_role: "tenant_admin", account_status: "pending" })?.allowed).toBe(false);
  });

  it("matches the two verified production accounts", () => {
    // super_admin always passes regardless of billing_state
    expect(
      evaluateAtlasAccess({
        platform_role: "super_admin",
        account_status: "active",
      }).allowed,
    ).toBe(true); // Melissa (founder)
    // Regular customer requires billing_state = active
    expect(
      evaluateAtlasAccess({
        platform_role: "user",
        account_status: "active",
        billing_state: "active",
      }).allowed,
    ).toBe(true); // YC Demo
  });
});

// ---------------------------------------------------------------------------
// Role normalization tests
// ---------------------------------------------------------------------------
describe("normalizeRole", () => {
  it("normalizes known roles", () => {
    expect(normalizeRole("super_admin")).toBe("super_admin");
    expect(normalizeRole("atlas_admin")).toBe("atlas_admin");
    expect(normalizeRole("customer_admin")).toBe("customer_admin");
    expect(normalizeRole("customer_user")).toBe("customer_user");
    expect(normalizeRole("pilot_user")).toBe("pilot_user");
    expect(normalizeRole("user")).toBe("user");
  });

  it("defaults unknown roles to 'user'", () => {
    expect(normalizeRole("tenant_admin")).toBe("user");
    expect(normalizeRole("random")).toBe("user");
    expect(normalizeRole("")).toBe("user");
    expect(normalizeRole(null)).toBe("user");
    expect(normalizeRole(undefined)).toBe("user");
  });

  it("handles case insensitivity", () => {
    expect(normalizeRole("SUPER_ADMIN")).toBe("super_admin");
    expect(normalizeRole("User")).toBe("user");
  });
});

describe("normalizeStatus", () => {
  it("normalizes known statuses", () => {
    expect(normalizeStatus("active")).toBe("active");
    expect(normalizeStatus("pending")).toBe("pending");
    expect(normalizeStatus("suspended")).toBe("suspended");
    expect(normalizeStatus("revoked")).toBe("revoked");
  });

  it("defaults unknown statuses to 'pending'", () => {
    expect(normalizeStatus("unknown")).toBe("pending");
    expect(normalizeStatus("")).toBe("pending");
    expect(normalizeStatus(null)).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Permission helper tests
// ---------------------------------------------------------------------------
describe("isInternalRole", () => {
  it("returns true for super_admin and atlas_admin", () => {
    expect(isInternalRole("super_admin")).toBe(true);
    expect(isInternalRole("atlas_admin")).toBe(true);
  });

  it("returns false for customer/pilot/user roles", () => {
    expect(isInternalRole("customer_admin")).toBe(false);
    expect(isInternalRole("customer_user")).toBe(false);
    expect(isInternalRole("pilot_user")).toBe(false);
    expect(isInternalRole("user")).toBe(false);
  });
});

describe("canAccessPilotAdmin", () => {
  it("allows only super_admin", () => {
    expect(canAccessPilotAdmin("super_admin")).toBe(true);
    expect(canAccessPilotAdmin("atlas_admin")).toBe(false);
    expect(canAccessPilotAdmin("customer_admin")).toBe(false);
    expect(canAccessPilotAdmin("user")).toBe(false);
  });
});

describe("canAccessCRM", () => {
  it("allows super_admin and atlas_admin", () => {
    expect(canAccessCRM("super_admin")).toBe(true);
    expect(canAccessCRM("atlas_admin")).toBe(true);
  });

  it("denies customer and pilot roles", () => {
    expect(canAccessCRM("customer_admin")).toBe(false);
    expect(canAccessCRM("user")).toBe(false);
  });
});

describe("canAccessMail", () => {
  it("allows super_admin and atlas_admin", () => {
    expect(canAccessMail("super_admin")).toBe(true);
    expect(canAccessMail("atlas_admin")).toBe(true);
  });

  it("denies customer and pilot roles", () => {
    expect(canAccessMail("customer_user")).toBe(false);
    expect(canAccessMail("pilot_user")).toBe(false);
  });
});

describe("canAccessUserAdmin", () => {
  it("allows super_admin and atlas_admin", () => {
    expect(canAccessUserAdmin("super_admin")).toBe(true);
    expect(canAccessUserAdmin("atlas_admin")).toBe(true);
  });

  it("denies customer roles", () => {
    expect(canAccessUserAdmin("customer_admin")).toBe(false);
    expect(canAccessUserAdmin("user")).toBe(false);
  });
});

describe("canManageUsers", () => {
  it("allows super_admin and atlas_admin", () => {
    expect(canManageUsers("super_admin")).toBe(true);
    expect(canManageUsers("atlas_admin")).toBe(true);
  });

  it("denies customer and pilot roles", () => {
    expect(canManageUsers("customer_user")).toBe(false);
    expect(canManageUsers("pilot_user")).toBe(false);
  });
});

describe("canAssignAdminRoles", () => {
  it("allows only super_admin", () => {
    expect(canAssignAdminRoles("super_admin")).toBe(true);
    expect(canAssignAdminRoles("atlas_admin")).toBe(false);
    expect(canAssignAdminRoles("user")).toBe(false);
  });
});

describe("getDefaultLandingPath", () => {
  it("returns /dashboard for admin and customer roles", () => {
    expect(getDefaultLandingPath("super_admin")).toBe("/dashboard");
    expect(getDefaultLandingPath("atlas_admin")).toBe("/dashboard");
    expect(getDefaultLandingPath("customer_admin")).toBe("/dashboard");
    expect(getDefaultLandingPath("customer_user")).toBe("/dashboard");
    expect(getDefaultLandingPath("user")).toBe("/dashboard");
  });

  it("returns /dashboard/pilot for pilot_user", () => {
    expect(getDefaultLandingPath("pilot_user")).toBe("/dashboard/pilot");
  });
});
