import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    // Simulate "no price ids configured" explicitly — the runtime may carry
    // the real PADDLE_*_PRICE_ID_* vars. This is the intended gating
    // behavior: the checkout UI should not advertise prices that cannot be
    // purchased.
    const prior = snapshotPriceEnv();
    try {
      clearEnv();
      expect(purchasablePlans()).toEqual([]);
    } finally {
      restorePriceEnv(prior);
    }

    // The shape is still stable — it returns an array of internal plans
    // and does not throw when the provider is not configured.
    expect(Array.isArray(purchasablePlans())).toBe(true);
  });
});

const PRICE_IDS = {
  starterMonthly: "pri_test_starter_monthly",
  starterAnnual: "pri_test_starter_annual",
  growthMonthly: "pri_test_growth_monthly",
  growthAnnual: "pri_test_growth_annual",
  scaleMonthly: "pri_test_scale_monthly",
  scaleAnnual: "pri_test_scale_annual",
} as const;

function setPriceEnv() {
  process.env.PADDLE_STARTER_PRICE_ID_MONTHLY = PRICE_IDS.starterMonthly;
  process.env.PADDLE_STARTER_PRICE_ID_ANNUAL = PRICE_IDS.starterAnnual;
  process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY = PRICE_IDS.growthMonthly;
  process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL = PRICE_IDS.growthAnnual;
  process.env.PADDLE_SCALE_PRICE_ID_MONTHLY = PRICE_IDS.scaleMonthly;
  process.env.PADDLE_SCALE_PRICE_ID_ANNUAL = PRICE_IDS.scaleAnnual;
}

function clearEnv() {
  delete process.env.PADDLE_STARTER_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_STARTER_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_SCALE_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_SCALE_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_API_KEY;
}

const PRICE_ENV_KEYS = [
  "PADDLE_STARTER_PRICE_ID_MONTHLY",
  "PADDLE_STARTER_PRICE_ID_ANNUAL",
  "PADDLE_GROWTH_PRICE_ID_MONTHLY",
  "PADDLE_GROWTH_PRICE_ID_ANNUAL",
  "PADDLE_SCALE_PRICE_ID_MONTHLY",
  "PADDLE_SCALE_PRICE_ID_ANNUAL",
  "PADDLE_API_KEY",
] as const;

/**
 * Snapshot the Paddle env vars so a test can simulate "no provider
 * configured" regardless of what the runtime environment provides (the
 * deployed sandbox may legitimately set the real PADDLE_* price ids).
 */
function snapshotPriceEnv(): Record<string, string | undefined> {
  const prior: Record<string, string | undefined> = {};
  for (const key of PRICE_ENV_KEYS) prior[key] = process.env[key];
  return prior;
}

function restorePriceEnv(prior: Record<string, string | undefined>): void {
  for (const key of PRICE_ENV_KEYS) {
    const value = prior[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("initiateCheckout (real Paddle transaction path)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setPriceEnv();
    process.env.PADDLE_API_KEY = "test_api_key";
  });

  afterEach(() => {
    clearEnv();
    globalThis.fetch = originalFetch;
  });

  it("creates a valid checkout with the mapped price id and custom_data (no secrets in the body)", async () => {
    let sentBody: Record<string, unknown> | null = null;
    let sentHeaders: Headers | null = null;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sentHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: { id: "txn_01test", checkout: { url: "https://checkout.paddle.com/checkout/txn_01test" } },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const response = await initiateCheckout({
      organizationId: "org-11111111-1111-1111-1111-111111111111",
      plan: "ATLAS_GROWTH",
      billingInterval: "annual",
    });

    expect(response.canCheckout).toBe(true);
    expect(response.providerConfigured).toBe(true);
    expect(response.checkoutUrl).toBe(
      "https://checkout.paddle.com/checkout/txn_01test",
    );
    expect(response.plan).toBe("ATLAS_GROWTH");
    expect(response.billingInterval).toBe("annual");

    // Price id is resolved server-side from the environment — the mapped
    // Growth annual price, never a client-supplied value.
    expect(sentBody).not.toBeNull();
    expect((sentBody!.items as Array<{ price_id: string }>)[0].price_id).toBe(
      PRICE_IDS.growthAnnual,
    );
    expect(
      (sentBody!.custom_data as Record<string, unknown>).atlas_organization_id,
    ).toBe("org-11111111-1111-1111-1111-111111111111");
    expect(
      (sentBody!.custom_data as Record<string, unknown>).atlas_internal_plan,
    ).toBe("ATLAS_GROWTH");

    // The Paddle create-transaction API has no top-level description field;
    // sending one risks a 400, so it must never appear in the body.
    expect(sentBody).not.toHaveProperty("description");
  });

  it("fails cleanly when PADDLE_API_KEY is missing", async () => {
    delete process.env.PADDLE_API_KEY;
    const response = await initiateCheckout({
      organizationId: "org-1",
      plan: "ATLAS_STARTER",
      billingInterval: "monthly",
    });
    expect(response.canCheckout).toBe(false);
    expect(response.checkoutUrl).toBe("");
    expect(response.serverNote).toContain("not configured");
  });

  it("fails cleanly when Paddle is unavailable (network error)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const response = await initiateCheckout({
      organizationId: "org-1",
      plan: "ATLAS_STARTER",
      billingInterval: "monthly",
    });
    expect(response.canCheckout).toBe(false);
    expect(response.checkoutUrl).toBe("");
    expect(response.serverNote).toBeTruthy();
  });

  it("fails cleanly when Paddle rejects the transaction", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const response = await initiateCheckout({
      organizationId: "org-1",
      plan: "ATLAS_STARTER",
      billingInterval: "monthly",
    });
    expect(response.canCheckout).toBe(false);
    expect(response.serverNote).toContain("Paddle");
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
    // Explicitly remove price ids + API key so the runtime environment's
    // real Paddle config cannot make this test pass for the wrong reason.
    const prior = snapshotPriceEnv();
    try {
      clearEnv();
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
    } finally {
      restorePriceEnv(prior);
    }
  });
});
