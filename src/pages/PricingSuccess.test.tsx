// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  resolveCheckoutConfirmation,
  tenantIdFromWorkspace,
  type CheckoutConfirmationStatus,
} from "./PricingSuccess";

describe("resolveCheckoutConfirmation", () => {
  it("confirms only when the SERVER-reported billing state is active", () => {
    expect(
      resolveCheckoutConfirmation({ isActive: true }, false),
    ).toBe("confirmed");
    expect(
      resolveCheckoutConfirmation({ isActive: true }, true),
    ).toBe("confirmed");
  });

  it("never confirms from a redirect back or client-side shape without server state", () => {
    // A Paddle redirect with no server state yet → still activating.
    expect(resolveCheckoutConfirmation(undefined, false)).toBe("activating");
    expect(resolveCheckoutConfirmation(null, false)).toBe("activating");
    // Even a plausible client-side shape ({plan, status}) is NOT confirmation
    // unless the server's billing_get_state reports isActive.
    expect(
      resolveCheckoutConfirmation(
        { plan: "ATLAS_SCALE", status: "active", isActive: undefined },
        false,
      ),
    ).toBe("activating");
  });

  it("reports unconfirmed (never spins forever) after the stall window", () => {
    expect(resolveCheckoutConfirmation(undefined, true)).toBe("unconfirmed");
    expect(
      resolveCheckoutConfirmation({ isActive: false }, true),
    ).toBe("unconfirmed");
  });

  it("only ever returns the three documented states", () => {
    const status = resolveCheckoutConfirmation({ isActive: true }, false);
    const valid: CheckoutConfirmationStatus[] = [
      "activating",
      "confirmed",
      "unconfirmed",
    ];
    expect(valid).toContain(status);
  });
});

describe("tenantIdFromWorkspace", () => {
  it("extracts tenants._id (the serialized tenants column)", () => {
    expect(
      tenantIdFromWorkspace({
        tenant: { _id: "tenant-abc" },
        membership: { tenantId: "tenant-abc" },
      }),
    ).toBe("tenant-abc");
  });

  it("falls back to memberships.\"tenantId\" (quoted camelCase column)", () => {
    expect(
      tenantIdFromWorkspace({
        tenant: null,
        membership: { tenantId: "tenant-def" },
      }),
    ).toBe("tenant-def");
  });

  it("returns null when there is no workspace or membership", () => {
    expect(tenantIdFromWorkspace(null)).toBeNull();
    expect(tenantIdFromWorkspace(undefined)).toBeNull();
    expect(tenantIdFromWorkspace({})).toBeNull();
  });
});