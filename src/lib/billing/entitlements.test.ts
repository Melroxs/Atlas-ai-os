import { describe, it, expect } from "vitest";
import { resolveBillingState } from "./provider";
import { resolvePlanEntitlements, PLAN_ENTITLEMENTS } from "./plans";
import type { OrganizationSubscription } from "./types";

function sub(overrides: Partial<OrganizationSubscription>): OrganizationSubscription {
  const now = Date.now();
  return {
    organization_id: "org-1",
    billing_provider: "paddle",
    provider_customer_id: "ctm_1",
    provider_subscription_id: "sub_1",
    provider_price_id: "pri_1",
    internal_plan: "ATLAS_STARTER",
    billing_interval: "monthly",
    status: "active",
    trial_start: null,
    trial_end: null,
    current_period_start: now,
    current_period_end: now + 30 * 24 * 3600 * 1000,
    next_billed_at: now + 30 * 24 * 3600 * 1000,
    cancel_at: null,
    canceled_at: null,
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

  it("grants paid features during a paid Paddle trial", () => {
    const state = resolveBillingState(
      sub({ status: "trialing", trial_end: Date.now() + 24 * 3600 * 1000 }),
    );
    expect(state.isActive).toBe(true);
    expect(state.canUsePaidFeatures).toBe(true);
    expect(state.trialEnd).not.toBeNull();
  });

  it("does not grant paid features for past_due", () => {
    const state = resolveBillingState(sub({ status: "past_due" }));
    expect(state.isActive).toBe(false);
    expect(state.canUsePaidFeatures).toBe(false);
  });

  it("does not grant paid features for canceled / paused / unknown", () => {
    for (const status of ["canceled", "paused", "unknown"] as const) {
      const state = resolveBillingState(sub({ status }));
      expect(state.isActive).toBe(false);
      expect(state.canUsePaidFeatures).toBe(false);
    }
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