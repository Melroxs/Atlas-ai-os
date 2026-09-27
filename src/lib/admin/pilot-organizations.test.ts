import { describe, it, expect } from "vitest";
import {
  PILOT_ACCOUNT_TYPES,
  PILOT_STATUSES,
  PILOT_STATUS_LABELS,
  PILOT_LIMIT_KEYS,
  computePilotStatus,
  isPilotActive,
  isPilotOrganization,
  formatPilotExpiration,
  parsePilotExpiration,
  normalizePilotLimits,
  describePilotBilling,
  describePilotLimits,
  computeEffectiveAccess,
  complimentaryGrantStatus,
} from "./super-admin";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const pilotTenant = (overrides: Record<string, unknown> = {}) => ({
  account_type: "free_pilot",
  pilot_converted_at: null,
  ...overrides,
});

const orgGrant = (overrides: Record<string, unknown> = {}) => ({
  id: "g1",
  user_id: null,
  status: "active",
  expires_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("pilot vocabulary", () => {
  it("keeps the account type distinct from the entitlement states", () => {
    expect(PILOT_ACCOUNT_TYPES).toEqual(["standard", "free_pilot"]);
    // 'standard' here means "not a pilot org" — it is not a pilot lifecycle
    // state, it is the absence of one.
    expect(PILOT_STATUSES).toEqual(["standard", "active", "expired", "suspended", "converted"]);
  });

  it("labels every lifecycle state", () => {
    for (const status of PILOT_STATUSES) {
      expect(PILOT_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("names limit keys that are entitlement configuration, not constants", () => {
    expect(PILOT_LIMIT_KEYS).toEqual(["claims", "storageMb", "teamMembers", "aiRuns"]);
  });
});

// ---------------------------------------------------------------------------
// Derived status (mirrors atlas_pilot_status in SQL)
// ---------------------------------------------------------------------------

describe("computePilotStatus", () => {
  it("returns standard for a non-pilot organization", () => {
    expect(computePilotStatus({ account_type: "standard" }, orgGrant(), NOW)).toBe("standard");
    expect(computePilotStatus({}, orgGrant(), NOW)).toBe("standard");
    expect(computePilotStatus(null, orgGrant(), NOW)).toBe("standard");
  });

  it("returns active for a live pilot grant", () => {
    expect(computePilotStatus(pilotTenant(), orgGrant(), NOW)).toBe("active");
  });

  it("returns active when the pilot never expires", () => {
    expect(computePilotStatus(pilotTenant(), orgGrant({ expires_at: null }), NOW)).toBe("active");
  });

  it("returns expired once the expiration passes", () => {
    expect(computePilotStatus(pilotTenant(), orgGrant({ expires_at: NOW - 1 }), NOW)).toBe("expired");
  });

  it("stays active right up to the expiration instant", () => {
    expect(computePilotStatus(pilotTenant(), orgGrant({ expires_at: NOW + 1 }), NOW)).toBe("active");
  });

  it("returns suspended when there is no active grant at all", () => {
    expect(computePilotStatus(pilotTenant(), null, NOW)).toBe("suspended");
    expect(computePilotStatus(pilotTenant(), orgGrant({ status: "revoked" }), NOW)).toBe("suspended");
  });

  it("returns converted once converted_at is set, regardless of grants", () => {
    const converted = pilotTenant({ pilot_converted_at: NOW - 1000 });
    expect(computePilotStatus(converted, null, NOW)).toBe("converted");
    expect(computePilotStatus(converted, orgGrant(), NOW)).toBe("converted");
  });

  it("keeps the organization a pilot while suspended or expired", () => {
    // The account type does not change when access lapses — only the
    // entitlement does. That is what makes extend/reactivate possible.
    expect(isPilotOrganization(pilotTenant())).toBe(true);
    expect(isPilotOrganization({ account_type: "standard" })).toBe(false);
  });
});

describe("isPilotActive", () => {
  it("only an active pilot confers access", () => {
    expect(isPilotActive("active")).toBe(true);
    for (const status of ["standard", "expired", "suspended", "converted"] as const) {
      expect(isPilotActive(status)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Expiration formatting and parsing
// ---------------------------------------------------------------------------

describe("formatPilotExpiration", () => {
  it("renders no expiration as Never, never a far-future date", () => {
    expect(formatPilotExpiration(null)).toBe("Never");
    expect(formatPilotExpiration(undefined)).toBe("Never");
  });

  it("renders a real date", () => {
    expect(formatPilotExpiration(Date.UTC(2026, 5, 1))).toBe("2026-06-01");
  });
});

describe("parsePilotExpiration", () => {
  it("treats empty input as no expiration", () => {
    expect(parsePilotExpiration("", NOW)).toEqual({ ok: true, expiresAt: null });
    expect(parsePilotExpiration(null, NOW)).toEqual({ ok: true, expiresAt: null });
    expect(parsePilotExpiration("   ", NOW)).toEqual({ ok: true, expiresAt: null });
  });

  it("accepts a future date-only value and keeps it valid for the whole day", () => {
    const r = parsePilotExpiration("2026-02-01", NOW);
    expect(r.ok).toBe(true);
    expect(r.expiresAt).toBe(Date.UTC(2026, 1, 1, 23, 59, 59, 999));
    // End-of-day, so the pilot does not expire mid-day from timezone drift.
    expect(r.expiresAt!).toBeGreaterThan(Date.UTC(2026, 1, 1, 12, 0, 0));
  });

  it("accepts a full ISO timestamp", () => {
    const r = parsePilotExpiration(new Date(NOW + 30 * DAY).toISOString(), NOW);
    expect(r.ok).toBe(true);
    expect(r.expiresAt).toBe(NOW + 30 * DAY);
  });

  it("rejects a past date", () => {
    const r = parsePilotExpiration("2025-01-01", NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/future/i);
  });

  it("rejects the current instant", () => {
    const r = parsePilotExpiration(new Date(NOW).toISOString(), NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects nonsense input rather than silently granting lifetime access", () => {
    for (const bad of ["not-a-date", "2026-13-45", "tomorrow", "13/45/2026"]) {
      const r = parsePilotExpiration(bad, NOW);
      expect(r.ok).toBe(false);
      expect(r.expiresAt).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("normalizePilotLimits", () => {
  it("returns null when nothing is set, meaning unrestricted", () => {
    expect(normalizePilotLimits(null)).toBeNull();
    expect(normalizePilotLimits(undefined)).toBeNull();
    expect(normalizePilotLimits({})).toBeNull();
  });

  it("keeps positive numeric limits and drops everything else", () => {
    expect(
      normalizePilotLimits({ claims: 25, storageMb: 0, teamMembers: -3, aiRuns: "10" }),
    ).toEqual({ claims: 25, aiRuns: 10 });
  });

  it("ignores unknown keys rather than persisting arbitrary configuration", () => {
    expect(normalizePilotLimits({ claims: 5, somethingElse: 99 })).toEqual({ claims: 5 });
  });

  it("truncates fractional limits", () => {
    expect(normalizePilotLimits({ claims: 7.9 })).toEqual({ claims: 7 });
  });

  it("is reserved metadata — the documented posture is unrestricted", () => {
    // normalizePilotLimits is retained for future, deliberate use, but no
    // entitlement path reads it. Free Pilot orgs are exempt from plan limits
    // through the existing complimentary-access bypass, so this never becomes
    // a hidden cap: the admin view states the posture truthfully.
    const described = describePilotLimits();
    expect(described).toMatch(/unrestricted/i);
    expect(described).toMatch(/complimentary/i);
    expect(described).not.toMatch(/claims|storage cap|seat cap/i);
  });
});

// ---------------------------------------------------------------------------
// Internal billing description
// ---------------------------------------------------------------------------

describe("describePilotBilling", () => {
  it("reports no Stripe subscription for a pilot", () => {
    expect(describePilotBilling(null)).toBe("No Stripe subscription");
    expect(describePilotBilling({})).toBe("No Stripe subscription");
    expect(describePilotBilling({ has_stripe_subscription: false })).toBe(
      "No Stripe subscription",
    );
  });

  it("reports the real subscription status after conversion", () => {
    expect(describePilotBilling({ has_stripe_subscription: true, status: "active" })).toBe(
      "Stripe: active",
    );
  });
});

// ---------------------------------------------------------------------------
// Access: a pilot is granted by the entitlement, with no Stripe involvement
// ---------------------------------------------------------------------------

describe("pilot access with no Stripe anything", () => {
  it("allows access from the complimentary grant alone", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: null, // no organization_subscriptions row at all
      complimentaryGrant: orgGrant(),
      tenantBillingState: null, // tenants.billing_state is NULL for a pilot
      nowMs: NOW,
    });
    expect(access.allowed).toBe(true);
    expect(access.billingState).toBe("active");
    expect(access.source).toBe("complimentary");
  });

  it("denies access once the pilot grant expires, without deleting anything", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: null,
      complimentaryGrant: orgGrant({ expires_at: NOW - 1 }),
      tenantBillingState: null,
      nowMs: NOW,
    });
    expect(access.allowed).toBe(false);
    expect(access.source).toBeNull();
  });

  it("denies access once the pilot grant is revoked (suspended)", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: null,
      complimentaryGrant: orgGrant({ status: "revoked" }),
      tenantBillingState: null,
      nowMs: NOW,
    });
    expect(access.allowed).toBe(false);
  });

  it("denies access when the pilot has no grant at all", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: null,
      complimentaryGrant: null,
      tenantBillingState: null,
      nowMs: NOW,
    });
    expect(access.allowed).toBe(false);
  });

  it("does not let a Stripe cancellation revoke an active pilot entitlement", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: "canceled",
      complimentaryGrant: orgGrant(),
      tenantBillingState: "cancelled",
      nowMs: NOW,
    });
    expect(access.allowed).toBe(true);
    expect(access.source).toBe("complimentary");
  });

  it("prefers the pilot entitlement while it is active, even if a paid sub exists", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: "active",
      complimentaryGrant: orgGrant(),
      tenantBillingState: "active",
      nowMs: NOW,
    });
    expect(access.allowed).toBe(true);
    expect(access.source).toBe("complimentary");
  });

  it("falls back to Stripe once the pilot grant is gone (post-conversion)", () => {
    const access = computeEffectiveAccess({
      subscriptionStatus: "active",
      complimentaryGrant: orgGrant({ status: "revoked" }),
      tenantBillingState: "active",
      nowMs: NOW,
    });
    expect(access.allowed).toBe(true);
    expect(access.source).toBe("stripe");
  });

  it("agrees with complimentaryGrantStatus on every grant state", () => {
    const cases = [
      { grant: null, expected: false },
      { grant: orgGrant({ status: "revoked" }), expected: false },
      { grant: orgGrant({ expires_at: NOW - 1 }), expected: false },
      { grant: orgGrant({ expires_at: NOW + 1 }), expected: true },
      { grant: orgGrant({ expires_at: null }), expected: true },
    ];
    for (const c of cases) {
      const active = complimentaryGrantStatus(c.grant, NOW) === "active";
      expect(active).toBe(c.expected);
      expect(isPilotActive(computePilotStatus(pilotTenant(), c.grant, NOW))).toBe(c.expected);
    }
  });
});
