import { describe, expect, it } from "vitest";
import {
  canPerformSuperAdminAction,
  validateInvite,
  resolveComplimentaryDuration,
  complimentaryGrantStatus,
  computeEffectiveAccess,
  ORG_ROLES,
} from "./super-admin";

const NOW = Date.parse("2026-09-08T00:00:00Z");

// ---------------------------------------------------------------------------
// Authorization — only super_admin (active) may act
// ---------------------------------------------------------------------------
describe("canPerformSuperAdminAction", () => {
  it("allows an active super_admin", () => {
    expect(canPerformSuperAdminAction({ platform_role: "super_admin", account_status: "active" })).toBe(true);
  });

  it("denies normal users", () => {
    expect(canPerformSuperAdminAction({ platform_role: "user", account_status: "active" })).toBe(false);
    expect(canPerformSuperAdminAction({ platform_role: "customer_admin", account_status: "active" })).toBe(false);
    expect(canPerformSuperAdminAction({ platform_role: "pilot_user", account_status: "active" })).toBe(false);
  });

  it("denies atlas_admin (spec: only super_admin may administer)", () => {
    expect(canPerformSuperAdminAction({ platform_role: "atlas_admin", account_status: "active" })).toBe(false);
  });

  it("denies inactive / missing actors (fail-closed)", () => {
    expect(canPerformSuperAdminAction({ platform_role: "super_admin", account_status: "pending" })).toBe(false);
    expect(canPerformSuperAdminAction({ platform_role: "super_admin", account_status: "suspended" })).toBe(false);
    expect(canPerformSuperAdminAction({ platform_role: "super_admin", account_status: "revoked" })).toBe(false);
    expect(canPerformSuperAdminAction(null)).toBe(false);
    expect(canPerformSuperAdminAction(undefined)).toBe(false);
    expect(canPerformSuperAdminAction({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
describe("validateInvite", () => {
  it("accepts a valid invitation", () => {
    expect(
      validateInvite({ email: "teammate@company.com", orgRole: "analyst", tenantId: "tenant-1" }),
    ).toEqual({ ok: true });
  });

  it("accepts all organization roles", () => {
    for (const role of ORG_ROLES) {
      expect(validateInvite({ email: "a@b.com", orgRole: role, tenantId: "t" }).ok).toBe(true);
    }
  });

  it("rejects invalid emails", () => {
    expect(validateInvite({ email: "", orgRole: "analyst", tenantId: "t" })).toEqual({
      ok: false,
      error: "A valid email is required.",
    });
    expect(validateInvite({ email: "not-an-email", orgRole: "analyst", tenantId: "t" }).ok).toBe(false);
    expect(validateInvite({ email: "a@b", orgRole: "analyst", tenantId: "t" }).ok).toBe(false);
  });

  it("rejects invalid organization roles (no platform roles)", () => {
    expect(validateInvite({ email: "a@b.com", orgRole: "super_admin", tenantId: "t" }).ok).toBe(false);
    expect(validateInvite({ email: "a@b.com", orgRole: "atlas_admin", tenantId: "t" }).ok).toBe(false);
    expect(validateInvite({ email: "a@b.com", orgRole: "", tenantId: "t" }).ok).toBe(false);
  });

  it("rejects a missing organization", () => {
    expect(validateInvite({ email: "a@b.com", orgRole: "analyst", tenantId: "" })).toEqual({
      ok: false,
      error: "Organization is required.",
    });
  });
});

// ---------------------------------------------------------------------------
// Complimentary access durations
// ---------------------------------------------------------------------------
describe("resolveComplimentaryDuration", () => {
  it("resolves 7d / 30d / 90d / 1y from now", () => {
    expect(resolveComplimentaryDuration("7d", NOW)?.expiresAtMs).toBe(NOW + 7 * 86400000);
    expect(resolveComplimentaryDuration("30d", NOW)?.expiresAtMs).toBe(NOW + 30 * 86400000);
    expect(resolveComplimentaryDuration("90d", NOW)?.expiresAtMs).toBe(NOW + 90 * 86400000);
    expect(resolveComplimentaryDuration("1y", NOW)?.expiresAtMs).toBe(NOW + 365 * 86400000);
  });

  it("represents lifetime as NO expiration (null), never a far-future date", () => {
    expect(resolveComplimentaryDuration("lifetime", NOW)).toEqual({
      duration: "lifetime",
      label: "Lifetime",
      expiresAtMs: null,
    });
  });

  it("rejects unknown durations", () => {
    expect(resolveComplimentaryDuration("2d", NOW)).toBeNull();
    expect(resolveComplimentaryDuration("", NOW)).toBeNull();
    expect(resolveComplimentaryDuration("forever", NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Grant status — expired / revoked deny
// ---------------------------------------------------------------------------
describe("complimentaryGrantStatus", () => {
  it("is active before expiration and lifetime grants never expire", () => {
    expect(complimentaryGrantStatus({ status: "active", expires_at: NOW + 86400000 }, NOW)).toBe("active");
    expect(complimentaryGrantStatus({ status: "active", expires_at: null }, NOW + 10 * 365 * 86400000)).toBe("active");
  });

  it("expires when now passes expires_at", () => {
    expect(complimentaryGrantStatus({ status: "active", expires_at: NOW - 1 }, NOW)).toBe("expired");
    expect(complimentaryGrantStatus({ status: "active", expires_at: NOW }, NOW)).toBe("expired");
  });

  it("is revoked when the grant was revoked", () => {
    expect(complimentaryGrantStatus({ status: "revoked", expires_at: NOW + 86400000 }, NOW)).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// Effective access — paid Paddle OR complimentary = access
// ---------------------------------------------------------------------------
describe("computeEffectiveAccess", () => {
  it("grants access via an active Paddle subscription", () => {
    expect(
      computeEffectiveAccess({
        subscriptionStatus: "active",
        complimentaryGrant: null,
        tenantBillingState: "active",
        nowMs: NOW,
      }),
    ).toEqual({ allowed: true, billingState: "active", source: "paddle" });
    expect(
      computeEffectiveAccess({
        subscriptionStatus: "trialing",
        complimentaryGrant: null,
        tenantBillingState: "active",
        nowMs: NOW,
      }).source,
    ).toBe("paddle");
  });

  it("grants access via complimentary access with NO Paddle subscription", () => {
    const result = computeEffectiveAccess({
      subscriptionStatus: null,
      complimentaryGrant: { status: "active", expires_at: NOW + 30 * 86400000 },
      tenantBillingState: null,
      nowMs: NOW,
    });
    expect(result).toEqual({ allowed: true, billingState: "active", source: "complimentary" });
  });

  it("complimentary access survives Paddle cancellation / payment failure / pause", () => {
    for (const paddleState of ["cancelled", "payment_failed", "suspended", "unknown", null]) {
      const result = computeEffectiveAccess({
        subscriptionStatus: paddleState === null ? null : "cancelled",
        complimentaryGrant: { status: "active", expires_at: null },
        tenantBillingState: paddleState,
        nowMs: NOW,
      });
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("complimentary");
    }
  });

  it("denies expired complimentary access even if status is still 'active'", () => {
    // Expired grant + no other entitlement -> denied. (A stale tenant
    // billing_state='active' would only exist while a Paddle subscription is
    // genuinely active, which is handled by the subscription branch above.)
    expect(
      computeEffectiveAccess({
        subscriptionStatus: null,
        complimentaryGrant: { status: "active", expires_at: NOW - 1 },
        tenantBillingState: "cancelled",
        nowMs: NOW,
      }).allowed,
    ).toBe(false);
    expect(
      computeEffectiveAccess({
        subscriptionStatus: null,
        complimentaryGrant: { status: "active", expires_at: NOW - 1 },
        tenantBillingState: null,
        nowMs: NOW,
      }).allowed,
    ).toBe(false);
  });

  it("denies revoked complimentary access", () => {
    expect(
      computeEffectiveAccess({
        subscriptionStatus: null,
        complimentaryGrant: { status: "revoked", expires_at: NOW + 86400000 },
        tenantBillingState: null,
        nowMs: NOW,
      }).allowed,
    ).toBe(false);
  });

  it("denies when there is neither Paddle nor complimentary access", () => {
    expect(
      computeEffectiveAccess({
        subscriptionStatus: "cancelled",
        complimentaryGrant: null,
        tenantBillingState: "cancelled",
        nowMs: NOW,
      }),
    ).toEqual({ allowed: false, billingState: "cancelled", source: null });
    expect(
      computeEffectiveAccess({
        subscriptionStatus: null,
        complimentaryGrant: null,
        tenantBillingState: null,
        nowMs: NOW,
      }),
    ).toEqual({ allowed: false, billingState: null, source: null });
  });

  it("keeps past_due as a grace-period allow for paid access", () => {
    expect(
      computeEffectiveAccess({
        subscriptionStatus: "past_due",
        complimentaryGrant: null,
        tenantBillingState: "past_due",
        nowMs: NOW,
      }).allowed,
    ).toBe(true);
  });
});