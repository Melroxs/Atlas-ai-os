import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  allPricingPlans,
  checkoutReturnTo,
  isActiveBillingState,
  normalizeCheckoutRequest,
  openBillingPortal,
  pricingPlanData,
  startCheckout,
} from "./checkout";

const PRICE_ENV_KEYS = [
  "STRIPE_PRICE_STARTER_MONTHLY",
  "STRIPE_PRICE_STARTER_YEARLY",
  "STRIPE_PRICE_GROWTH_MONTHLY",
  "STRIPE_PRICE_GROWTH_YEARLY",
  "STRIPE_PRICE_SCALE_MONTHLY",
  "STRIPE_PRICE_SCALE_YEARLY",
  // Legacy trial vars: setting them must not affect checkout.
  "STRIPE_TRIAL_PRICE_ID",
  "STRIPE_TRIAL_PERIOD_DAYS",
] as const;

const originalEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of PRICE_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PRICE_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Pricing display (single source of truth)
// ---------------------------------------------------------------------------

describe("pricing plan data", () => {
  it("renders the canonical Atlas prices for each interval", () => {
    expect(pricingPlanData("ATLAS_STARTER", "monthly")).toMatchObject({
      slug: "starter",
      displayName: "Atlas Starter",
      price: 49,
      intervalPrice: 49,
      compareAtPrice: null,
      annualSavingsPercent: null,
    });
    expect(pricingPlanData("ATLAS_STARTER", "annual")).toMatchObject({
      price: 49,
      intervalPrice: 470,
      compareAtPrice: 49,
      // Two months free at the canonical price → 20%.
      annualSavingsPercent: 20,
    });
    expect(pricingPlanData("ATLAS_GROWTH", "monthly").intervalPrice).toBe(149);
    expect(pricingPlanData("ATLAS_GROWTH", "annual").intervalPrice).toBe(1430);
    expect(pricingPlanData("ATLAS_SCALE", "monthly").intervalPrice).toBe(299);
    expect(pricingPlanData("ATLAS_SCALE", "annual").intervalPrice).toBe(2870);
  });

  it("derives the annual saving from the canonical prices", () => {
    for (const plan of allPricingPlans("annual")) {
      expect(plan.annualSavingsPercent).toBe(20);
    }
  });

  it("advertises no trial anywhere in the pricing contract", () => {
    for (const interval of ["monthly", "annual"] as const) {
      for (const plan of allPricingPlans(interval)) {
        expect(JSON.stringify(plan)).not.toMatch(/trial/i);
      }
    }
  });

  it("lists all three plans in display order", () => {
    expect(allPricingPlans("monthly").map((p) => p.slug)).toEqual([
      "starter",
      "growth",
      "scale",
    ]);
  });

  it("never exposes a Stripe price id or an amount to the browser", () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_secret_looking_id";
    const json = JSON.stringify(allPricingPlans("monthly"));
    expect(json).not.toContain("price_secret_looking_id");
    expect(json).not.toContain("STRIPE_PRICE");
  });
});

// ---------------------------------------------------------------------------
// Request normalization (client-side, mirrored server-side)
// ---------------------------------------------------------------------------

describe("normalizeCheckoutRequest", () => {
  it("accepts the six supported plan/interval combinations", () => {
    const combos = [
      ["starter", "month"],
      ["starter", "year"],
      ["growth", "month"],
      ["growth", "year"],
      ["scale", "month"],
      ["scale", "year"],
    ] as const;
    for (const [plan, interval] of combos) {
      const normalized = normalizeCheckoutRequest({ plan, interval });
      expect(normalized).not.toBeNull();
      expect(normalized!.slug).toBe(plan);
    }
  });

  it("normalizes interval aliases", () => {
    expect(normalizeCheckoutRequest({ plan: "growth", interval: "monthly" })?.interval).toBe(
      "monthly",
    );
    expect(normalizeCheckoutRequest({ plan: "growth", interval: "annual" })?.interval).toBe(
      "annual",
    );
  });

  it("rejects unknown plans and intervals", () => {
    expect(normalizeCheckoutRequest({ plan: "enterprise", interval: "month" })).toBeNull();
    expect(normalizeCheckoutRequest({ plan: "starter", interval: "weekly" })).toBeNull();
    expect(normalizeCheckoutRequest({ plan: "", interval: "" })).toBeNull();
  });

  it("rejects a price id, an amount or a currency smuggled into the plan field", () => {
    expect(normalizeCheckoutRequest({ plan: "price_123", interval: "month" })).toBeNull();
    expect(normalizeCheckoutRequest({ plan: "4900", interval: "month" })).toBeNull();
    expect(normalizeCheckoutRequest({ plan: "usd", interval: "month" })).toBeNull();
  });

  it("builds the auth return path", () => {
    expect(checkoutReturnTo({ plan: "scale", interval: "year" })).toBe(
      "/checkout?plan=scale&interval=annual",
    );
    expect(checkoutReturnTo({ plan: "nope", interval: "nope" })).toBe(
      "/checkout?plan=starter&interval=monthly",
    );
  });
});

// ---------------------------------------------------------------------------
// Checkout request
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return await responder(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BASE_INPUT = {
  accessToken: "jwt_test",
  functionsBaseUrl: "https://project.supabase.co/",
  anonKey: "anon_test",
  tenantId: "org-1",
  companyName: "Acme Restoration",
};

describe("startCheckout", () => {
  it("sends plan + interval ONLY and returns the Stripe-hosted URL", async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        data: { url: "https://checkout.stripe.com/c/pay/cs_test_123", sessionId: "cs_test_123" },
      }),
    );

    const result = await startCheckout({
      plan: "growth",
      interval: "year",
      fetchImpl: impl,
      ...BASE_INPUT,
    });

    expect(result).toMatchObject({
      ok: true,
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      sessionId: "cs_test_123",
      plan: "ATLAS_GROWTH",
      interval: "annual",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://project.supabase.co/functions/v1/stripe-checkout");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt_test",
    );

    // The request body must not carry any client-controlled billing value.
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["companyName", "interval", "plan", "tenantId"].sort(),
    );
    expect(body.plan).toBe("growth");
    expect(body.interval).toBe("annual");
    for (const forbidden of [
      "priceId",
      "price",
      "amount",
      "currency",
      "customerId",
      "subscriptionId",
      "status",
      "planId",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("never calls the server for an invalid plan or interval", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ data: null }, 200));
    const result = await startCheckout({
      plan: "enterprise",
      interval: "month",
      fetchImpl: impl,
      ...BASE_INPUT,
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(calls).toHaveLength(0);
  });

  it("routes an already-subscribed organization to Manage Billing", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(
        { data: null, error: "This organization already has an active subscription." },
        409,
      ),
    );
    const result = await startCheckout({
      plan: "starter",
      interval: "month",
      fetchImpl: impl,
      ...BASE_INPUT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.alreadySubscribed).toBe(true);
    expect(result.message).toMatch(/already has an active subscription/i);
  });

  it("maps authorization and configuration failures to safe messages", async () => {
    const cases: Array<[number, string | null, RegExp]> = [
      [401, null, /session expired/i],
      [403, null, /session expired/i],
      [422, null, /isn't available for billing/i],
      [503, null, /temporarily unavailable/i],
      [500, null, /could not start checkout/i],
    ];
    for (const [status, error, pattern] of cases) {
      const { impl } = mockFetch(() => jsonResponse({ data: null, error }, status));
      const result = await startCheckout({
        plan: "starter",
        interval: "month",
        fetchImpl: impl,
        ...BASE_INPUT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toMatch(pattern);
    }
  });

  it("prefers the server error message when one is provided", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse({ data: null, error: "Billing isn't configured for this environment yet." }, 503),
    );
    const result = await startCheckout({
      plan: "starter",
      interval: "month",
      fetchImpl: impl,
      ...BASE_INPUT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("Billing isn't configured for this environment yet.");
  });

  it("fails safely when the network throws or the body is not JSON", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const network = await startCheckout({
      plan: "starter",
      interval: "month",
      fetchImpl: throwing,
      ...BASE_INPUT,
    });
    expect(network).toMatchObject({ ok: false, status: 0 });

    const notJson = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const malformed = await startCheckout({
      plan: "starter",
      interval: "month",
      fetchImpl: notJson.impl,
      ...BASE_INPUT,
    });
    expect(malformed).toMatchObject({ ok: false, status: 502 });
  });

  it("fails safely when a successful response carries no URL", async () => {
    const { impl } = mockFetch(() => jsonResponse({ data: { sessionId: "cs_1" } }, 200));
    const result = await startCheckout({
      plan: "starter",
      interval: "month",
      fetchImpl: impl,
      ...BASE_INPUT,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});

// ---------------------------------------------------------------------------
// Billing portal
// ---------------------------------------------------------------------------

describe("openBillingPortal", () => {
  it("returns the portal URL without sending a customer id", async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({ data: { url: "https://billing.stripe.com/p/session/test_123" } }),
    );
    const result = await openBillingPortal({
      accessToken: "jwt_test",
      functionsBaseUrl: "https://project.supabase.co",
      fetchImpl: impl,
    });
    expect(result).toEqual({
      ok: true,
      url: "https://billing.stripe.com/p/session/test_123",
    });
    expect(calls[0].url).toBe("https://project.supabase.co/functions/v1/stripe-customer-portal");
    expect(String(calls[0].init.body)).not.toMatch(/cus_/);
  });

  it("reports a missing billing profile without leaking internals", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(
        { data: null, error: "This organization doesn't have a billing profile yet." },
        404,
      ),
    );
    const result = await openBillingPortal({
      accessToken: "jwt_test",
      functionsBaseUrl: "https://project.supabase.co",
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
    expect(result.message).toMatch(/billing profile/i);
  });

  it("reports a network failure", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await openBillingPortal({
      accessToken: "jwt_test",
      functionsBaseUrl: "https://project.supabase.co",
      fetchImpl: throwing,
    });
    expect(result).toMatchObject({ ok: false, status: 0 });
  });
});

// ---------------------------------------------------------------------------
// Billing state helper
// ---------------------------------------------------------------------------

describe("isActiveBillingState", () => {
  it("reads only the server-authored isActive flag", () => {
    expect(isActiveBillingState({ isActive: true } as never)).toBe(true);
    expect(isActiveBillingState({ isActive: false } as never)).toBe(false);
    expect(isActiveBillingState(null)).toBe(false);
    expect(isActiveBillingState(undefined)).toBe(false);
  });
});


