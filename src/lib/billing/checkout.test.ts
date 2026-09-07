import { describe, it, expect } from "vitest";
import {
  ALL_INTERNAL_PLANS,
  PLAN_METADATA,
  type InternalPlan,
  type PlanMetadata,
} from "./plans";
import type { BillingInterval } from "./types";
import {
  pricingPlanData,
  allPricingPlans,
  purchasablePlans,
  CheckoutRequest,
  CheckoutResponse,
  initiateCheckout,
  buildCheckoutResponse,
  linksForCheckoutResponse,
  planForCheckout,
} from "./checkout";

describe("billing/checkout plan shapes", () => {
  it("keeps the three canonical internal plans in a stable order", () => {
    expect(ALL_INTERNAL_PLANS).toEqual([
      "ATLAS_STARTER",
      "ATLAS_GROWTH",
      "ATLAS_SCALE",
    ] as InternalPlan[]);
  });

  it("exposes metadata for every internal plan", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      const meta = PLAN_METADATA[plan];
      expect(meta).toBeDefined();
      expect(meta.displayName).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(typeof meta.billingIntervalPrice.monthly).toBe("number");
      expect(typeof meta.billingIntervalPrice.annual).toBe("number");
    }
  });

  it("derives monthly/annual price from the canonical metadata", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      for (const interval of ["monthly", "annual"] as BillingInterval[]) {
        const data = pricingPlanData(plan, interval);
        expect(data.internalPlan).toBe(plan);
        expect(data.displayName).toBe(PLAN_METADATA[plan].displayName);
        expect(data.billingIntervalPrice).toBe(
          PLAN_METADATA[plan].billingIntervalPrice[interval],
        );
        if (interval === "annual") {
          expect(data.compareAtPrice).toBe(
            PLAN_METADATA[plan].billingIntervalPrice.monthly,
          );
        } else {
          expect(data.compareAtPrice).toBeNull();
        }
      }
    }
  });

  it("produces a stable list for a billing interval", () => {
    const monthly = allPricingPlans("monthly");
    const annual = allPricingPlans("annual");

    expect(monthly).toHaveLength(ALL_INTERNAL_PLANS.length);
    expect(annual).toHaveLength(ALL_INTERNAL_PLANS.length);

    for (const plan of ALL_INTERNAL_PLANS) {
      expect(monthly.find((p) => p.internalPlan === plan)).toBeDefined();
      expect(annual.find((p) => p.internalPlan === plan)).toBeDefined();
    }
  });

  it("only returns purchasable plans when a price id is configured", () => {
    // PADDLE_*_PRICE_ID_* env vars are not set in tests, so nothing is
    // purchasable right now. This is the intended gating behavior: the
    // checkout UI should not advertise prices that cannot be purchased.
    expect(purchasablePlans()).toEqual([]);

    // The shape is still stable — it returns an array of internal plans
    // and does not throw when the provider is not configured.
    expect(Array.isArray(purchasablePlans())).toBe(true);
  });
});

describe("billing/checkout request/response contract", () => {
  it("defines a CheckoutRequest with the expected fields", () => {
    const request = {
      organizationId: "org-1",
      plan: "ATLAS_STARTER",
      billingInterval: "monthly",
      accountEmail: "ops@contractor.example",
      companyName: "Contractor Co",
    } satisfies CheckoutRequest;

    expect(request.organizationId).toBe("org-1");
    expect(request.plan).toBe("ATLAS_STARTER");
    expect(request.billingInterval).toBe("monthly");
    expect(request.accountEmail).toBe("ops@contractor.example");
    expect(request.companyName).toBe("Contractor Co");
  });

  it("defines a CheckoutResponse with links and provider state", () => {
    const response = buildCheckoutResponse(
      {
        organizationId: "org-1",
        plan: "ATLAS_STARTER",
        billingInterval: "monthly",
      },
      "https://checkout.paddle.com/?items=%5B%5D",
    );

    expect(response.checkoutUrl).toBeTruthy();
    expect(response.successUrl).toBe("/pricing-success");
    expect(response.cancelUrl).toBe("/pricing");
    expect(response.plan).toBe("ATLAS_STARTER");
    expect(response.providerType).toBe("paddle");
    // A response carrying a real checkout URL is a configured checkout.
    expect(response.providerConfigured).toBe(true);
    expect(response.canCheckout).toBe(true);
  });

  it("exposes links derived from the checkout response", () => {
    const response = buildCheckoutResponse(
      {
        organizationId: "org-1",
        plan: "ATLAS_STARTER",
        billingInterval: "monthly",
      },
      "https://checkout.paddle.com/?items=%5B%5D",
    );

    const links = linksForCheckoutResponse(response);

    expect(links.checkout).toBe(response.checkoutUrl);
    expect(links.success).toBe(response.successUrl);
    expect(links.cancel).toBe(response.cancelUrl);
    expect(links.checkout).toContain("checkout.paddle.com");
  });

  it("maps a checkout request into the plan/interval quartet", () => {
    const request = {
      organizationId: "org-1",
      plan: "ATLAS_GROWTH",
      billingInterval: "annual",
    } satisfies CheckoutRequest;

    const quartet = planForCheckout(request);

    expect(quartet.plan).toBe("ATLAS_GROWTH");
    expect(quartet.interval).toBe("annual");
  });

  it("returns a gated checkout response when no price id is configured", async () => {
    // PADDLE_*_PRICE_ID_* env vars are not set in tests → no checkout.
    const response = await initiateCheckout({
      organizationId: "org-1",
      plan: "ATLAS_STARTER",
      billingInterval: "monthly",
    });

    expect(response.providerConfigured).toBe(false);
    expect(response.canCheckout).toBe(false);
    expect(response.serverNote).toBe(
      "The selected Atlas plan is not configured for billing.",
    );
    expect(response.checkoutUrl).toBe("");
  });
});
