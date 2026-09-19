import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveBillingState } from "./provider";
import {
  resolvePlanEntitlements,
  PLAN_ENTITLEMENTS,
  ALL_INTERNAL_PLANS,
} from "./plans";
import {
  normalizeSeatStatus,
  evaluateSeatCapacity,
  resolveOrgEntitlements,
  canUseFeature,
  planEntitlements,
  fetchSeatStatus,
} from "./entitlements";
import type { OrganizationSubscription } from "./types";

function sub(overrides: Partial<OrganizationSubscription>): OrganizationSubscription {
  const now = Date.now();
  return {
    organization_id: "org-1",
    billing_provider: "stripe",
    provider_customer_id: "cus_1",
    provider_subscription_id: "sub_1",
    provider_price_id: "price_1",
    internal_plan: "ATLAS_STARTER",
    billing_interval: "monthly",
    status: "active",
    payment_status: "paid",
    trial_start: null,
    trial_end: null,
    current_period_start: now,
    current_period_end: now + 30 * 24 * 3600 * 1000,
    next_billed_at: now + 30 * 24 * 3600 * 1000,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    latest_invoice_id: null,
    latest_invoice_at: null,
    provider_event_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("plan entitlements", () => {
  it("resolves Starter → Starter entitlements", () => {
    const e = resolvePlanEntitlements("ATLAS_STARTER");
    expect(e).toEqual(PLAN_ENTITLEMENTS.ATLAS_STARTER);
    expect(e!.maxSeats).toBe(5);
    expect(e!.apiAccess).toBe(false);
  });

  it("resolves Growth → Growth entitlements", () => {
    const e = resolvePlanEntitlements("ATLAS_GROWTH");
    expect(e).toEqual(PLAN_ENTITLEMENTS.ATLAS_GROWTH);
    expect(e!.maxSeats).toBe(25);
    expect(e!.apiAccess).toBe(true);
  });

  it("resolves Scale → Scale entitlements", () => {
    const e = resolvePlanEntitlements("ATLAS_SCALE");
    expect(e).toEqual(PLAN_ENTITLEMENTS.ATLAS_SCALE);
    expect(e!.maxSeats).toBeNull();
    expect(e!.sso).toBe(true);
  });

  it("returns null for no plan", () => {
    expect(resolvePlanEntitlements(null)).toBeNull();
  });
});

describe("entitlement gating (server-authoritative)", () => {
  it("grants paid features for active subscriptions on any plan", () => {
    for (const plan of ["ATLAS_STARTER", "ATLAS_GROWTH", "ATLAS_SCALE"] as const) {
      const state = resolveBillingState(sub({ internal_plan: plan, status: "active" }));
      expect(state.isActive).toBe(true);
      expect(state.canUsePaidFeatures).toBe(true);
      expect(state.plan).toBe(plan);
    }
  });

  it("grants paid features during the paid Stripe trial", () => {
    const state = resolveBillingState(
      sub({ status: "trialing", trial_end: Date.now() + 24 * 3600 * 1000 }),
    );
    expect(state.isActive).toBe(true);
    expect(state.canUsePaidFeatures).toBe(true);
    expect(state.trialEnd).not.toBeNull();
  });

  it("does not grant paid features for past_due / unpaid / incomplete", () => {
    for (const status of ["past_due", "unpaid", "incomplete", "incomplete_expired"] as const) {
      const state = resolveBillingState(sub({ status }));
      expect(state.isActive).toBe(false);
      expect(state.canUsePaidFeatures).toBe(false);
    }
  });

  it("does not grant paid features for canceled / paused / unknown", () => {
    for (const status of ["canceled", "paused", "unknown"] as const) {
      const state = resolveBillingState(sub({ status }));
      expect(state.isActive).toBe(false);
      expect(state.canUsePaidFeatures).toBe(false);
    }
  });

  it("reports Stripe as the provider and exposes the stored Stripe identifiers", () => {
    const state = resolveBillingState(sub({}));
    expect(state.provider).toBe("stripe");
    expect(state.providerCustomerId).toBe("cus_1");
    expect(state.providerSubscriptionId).toBe("sub_1");
    expect(state.accessSource).toBe("stripe");
    expect(state.cancelAtPeriodEnd).toBe(false);
  });

  it("surfaces a pending cancellation and no next charge", () => {
    const state = resolveBillingState(
      sub({ cancel_at_period_end: true, cancel_at: Date.now() + 86400000, next_billed_at: null }),
    );
    expect(state.isActive).toBe(true);
    expect(state.cancelAtPeriodEnd).toBe(true);
    expect(state.nextBilledAt).toBeNull();
  });

  it("grants nothing when there is no subscription record", () => {
    const state = resolveBillingState(null);
    expect(state.isActive).toBe(false);
    expect(state.plan).toBeNull();
    expect(state.status).toBe("unknown");
    expect(state.canUsePaidFeatures).toBe(false);
  });

  it("never trusts browser-supplied plan/status (resolution is record-based)", () => {
    // Even if a client submitted { plan: "ATLAS_SCALE", status: "active" },
    // the resolver reads the server record only.
    const state = resolveBillingState(
      sub({ internal_plan: "ATLAS_STARTER", status: "past_due" }),
    );
    expect(state.plan).toBe("ATLAS_STARTER");
    expect(state.canUsePaidFeatures).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime entitlement access (plan limits need real callers)
// ---------------------------------------------------------------------------

describe("resolveOrgEntitlements", () => {
  it("resolves entitlements for an active paid plan", () => {
    const e = resolveOrgEntitlements({
      canUsePaidFeatures: true,
      plan: "ATLAS_GROWTH",
    });
    expect(e).toEqual(PLAN_ENTITLEMENTS.ATLAS_GROWTH);
    expect(e!.maxSeats).toBe(25);
  });

  it("fails closed when paid features are not granted", () => {
    expect(
      resolveOrgEntitlements({ canUsePaidFeatures: false, plan: "ATLAS_SCALE" }),
    ).toBeNull();
  });

  it("fails closed for a missing billing state or plan", () => {
    expect(resolveOrgEntitlements(null)).toBeNull();
    expect(resolveOrgEntitlements(undefined)).toBeNull();
    expect(resolveOrgEntitlements({ canUsePaidFeatures: true, plan: null })).toBeNull();
  });

  it("denies feature access without entitlements", () => {
    expect(canUseFeature(null, "apiAccess")).toBe(false);
    const starter = planEntitlements("ATLAS_STARTER");
    expect(canUseFeature(starter, "apiAccess")).toBe(false);
    expect(canUseFeature(starter, "sso")).toBe(false);
    const growth = planEntitlements("ATLAS_GROWTH");
    expect(canUseFeature(growth, "apiAccess")).toBe(true);
    expect(canUseFeature(growth, "sso")).toBe(false);
    expect(canUseFeature(planEntitlements("ATLAS_SCALE"), "sso")).toBe(true);
  });
});

describe("evaluateSeatCapacity", () => {
  it("allows while seats remain and reports remaining", () => {
    expect(evaluateSeatCapacity({ maxSeats: 5, used: 4 })).toEqual({
      allowed: true,
      remaining: 1,
    });
  });

  it("denies at and beyond the limit", () => {
    expect(evaluateSeatCapacity({ maxSeats: 5, used: 5 })).toEqual({
      allowed: false,
      remaining: 0,
    });
    expect(evaluateSeatCapacity({ maxSeats: 5, used: 9 })).toEqual({
      allowed: false,
      remaining: 0,
    });
  });

  it("treats a null limit as unlimited", () => {
    expect(evaluateSeatCapacity({ maxSeats: null, used: 1000 })).toEqual({
      allowed: true,
      remaining: null,
    });
  });

  it("clamps a negative usage count and never reports negative remaining", () => {
    expect(evaluateSeatCapacity({ maxSeats: 1, used: -5 })).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(evaluateSeatCapacity({ maxSeats: 2, used: 99 }).remaining).toBe(0);
  });
});

describe("normalizeSeatStatus (fail-closed)", () => {
  it("accepts a server-allowed payload", () => {
    expect(
      normalizeSeatStatus({
        plan: "ATLAS_STARTER",
        used: 2,
        limit: 5,
        remaining: 3,
        allowed: true,
        reason: "within_limit",
      }),
    ).toEqual({
      plan: "ATLAS_STARTER",
      used: 2,
      limit: 5,
      remaining: 3,
      allowed: true,
      reason: "within_limit",
    });
  });

  it("denies malformed payloads", () => {
    const bad: unknown[] = [
      null,
      undefined,
      0,
      "yes",
      {},
      { allowed: true },
      { allowed: true, reason: "made_up" },
    ];
    for (const payload of bad) {
      expect(normalizeSeatStatus(payload).allowed).toBe(false);
    }
  });

  it("cannot be tricked by an allowed flag on a denial reason", () => {
    expect(normalizeSeatStatus({ allowed: true, reason: "seat_limit_reached" }).allowed).toBe(
      false,
    );
    expect(normalizeSeatStatus({ allowed: true, reason: "no_plan" }).allowed).toBe(false);
    expect(normalizeSeatStatus({ allowed: true, reason: "not_a_member" }).allowed).toBe(false);
  });

  it("keeps the intentional super_admin / complimentary bypasses", () => {
    expect(normalizeSeatStatus({ allowed: true, reason: "super_admin" }).allowed).toBe(true);
    expect(normalizeSeatStatus({ allowed: true, reason: "complimentary" }).allowed).toBe(true);
    expect(normalizeSeatStatus({ allowed: true, reason: "unlimited" }).allowed).toBe(true);
  });
});

describe("fetchSeatStatus (fails closed)", () => {
  it("denies without a client or a tenant", async () => {
    expect((await fetchSeatStatus(null, "t")).allowed).toBe(false);
    expect(
      (await fetchSeatStatus({ rpc: async () => ({ data: null, error: null }) }, null)).allowed,
    ).toBe(false);
  });

  it("denies on an RPC error response", async () => {
    const s = await fetchSeatStatus(
      {
        rpc: async () => ({
          data: { allowed: true, reason: "within_limit" },
          error: { message: "boom" },
        }),
      },
      "t",
    );
    expect(s.allowed).toBe(false);
  });

  it("denies when the RPC throws", async () => {
    const s = await fetchSeatStatus(
      {
        rpc: async () => {
          throw new Error("network");
        },
      },
      "t",
    );
    expect(s.allowed).toBe(false);
  });

  it("returns the server payload for the caller's tenant", async () => {
    const s = await fetchSeatStatus(
      {
        rpc: async (fn, args) => {
          expect(fn).toBe("org_seat_status");
          expect(args).toEqual({ p_tenant: "t1" });
          return {
            data: {
              plan: "ATLAS_GROWTH",
              used: 1,
              limit: 25,
              remaining: 24,
              allowed: true,
              reason: "within_limit",
            },
            error: null,
          };
        },
      },
      "t1",
    );
    expect(s.allowed).toBe(true);
    expect(s.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Seat-limit parity guard
//
// Seat limits are ENFORCED server-side (`plan_seat_limits` in SQL, consumed by
// public.org_seat_status) and DISPLAYED from src/lib/billing/plans.ts (Deno Edge
// Functions cannot import from src/). They must never drift, so this test parses
// the migration and asserts the numbers agree.
// ---------------------------------------------------------------------------

describe("seat-limit parity (SQL enforcement vs TS display)", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(HERE, "../../../supabase/migrations/20260918_atlas_security_hardening.sql"),
    "utf8",
  );

  /** Parse `('PLAN', <n|null>)` out of the seed block. */
  function seededMaxSeats(plan: string): number | null {
    const marker = `('${plan}',`;
    const line = sql.split("\n").find((l) => l.includes(marker));
    if (!line) throw new Error(`plan_seat_limits seed missing for ${plan}`);
    const rest = line.slice(line.indexOf(marker) + marker.length);
    const value = rest.slice(0, rest.indexOf(")")).trim();
    return value === "null" ? null : Number(value);
  }

  it("seeds a seat limit identical to PLAN_ENTITLEMENTS for every plan", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      expect(seededMaxSeats(plan)).toBe(PLAN_ENTITLEMENTS[plan].maxSeats);
    }
  });
});