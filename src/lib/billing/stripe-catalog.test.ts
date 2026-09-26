// ---------------------------------------------------------------------------
// Canonical Atlas pricing ➜ STRIPE_PRICE_* mapping
//
// Pins the two halves that must never drift apart:
//   1. the amounts the catalog advertises (what the landing/pricing pages show)
//   2. the environment variable each plan/interval resolves its Stripe Price id
//      from (server-side only — the browser never sees or sends either)
// The live amounts behind each Stripe Price id remain a production concern.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_INTERNAL_PLANS,
  PLAN_METADATA,
  configuredStripePrices,
  stripePriceEnvKey,
  stripePriceId,
} from "./plans";
import { normalizeCheckoutRequest, startCheckout } from "./checkout";
import type { BillingInterval, InternalPlan } from "./types";

const CANONICAL: Record<InternalPlan, { monthly: number; annual: number }> = {
  ATLAS_STARTER: { monthly: 49, annual: 470 },
  ATLAS_GROWTH: { monthly: 149, annual: 1430 },
  ATLAS_SCALE: { monthly: 299, annual: 2870 },
};

const ENV_KEY: Record<InternalPlan, { monthly: string; annual: string }> = {
  ATLAS_STARTER: {
    monthly: "STRIPE_PRICE_STARTER_MONTHLY",
    annual: "STRIPE_PRICE_STARTER_YEARLY",
  },
  ATLAS_GROWTH: {
    monthly: "STRIPE_PRICE_GROWTH_MONTHLY",
    annual: "STRIPE_PRICE_GROWTH_YEARLY",
  },
  ATLAS_SCALE: {
    monthly: "STRIPE_PRICE_SCALE_MONTHLY",
    annual: "STRIPE_PRICE_SCALE_YEARLY",
  },
};

const ALL_KEYS = Object.values(ENV_KEY).flatMap((entry) => [entry.monthly, entry.annual]);
const INTERVALS: BillingInterval[] = ["monthly", "annual"];

const originalEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ALL_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ALL_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("canonical Atlas amounts", () => {
  it("prices Starter $49/$470, Growth $149/$1,430, Scale $299/$2,870", () => {
    expect(PLAN_METADATA.ATLAS_STARTER.billingIntervalPrice).toEqual({ monthly: 49, annual: 470 });
    expect(PLAN_METADATA.ATLAS_GROWTH.billingIntervalPrice).toEqual({ monthly: 149, annual: 1430 });
    expect(PLAN_METADATA.ATLAS_SCALE.billingIntervalPrice).toEqual({ monthly: 299, annual: 2870 });
  });

  it("contains no other amount anywhere in the catalog", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      expect(PLAN_METADATA[plan].billingIntervalPrice).toEqual(CANONICAL[plan]);
    }
  });
});

describe("STRIPE_PRICE_* env key mapping", () => {
  it("names the intended variable for every plan/interval", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      expect(stripePriceEnvKey(plan, "monthly")).toBe(ENV_KEY[plan].monthly);
      expect(stripePriceEnvKey(plan, "annual")).toBe(ENV_KEY[plan].annual);
    }
  });

  it("resolves a plan/interval only from its own variable", () => {
    process.env[ENV_KEY.ATLAS_GROWTH.annual] = "price_growth_year";
    expect(stripePriceId("ATLAS_GROWTH", "annual")).toBe("price_growth_year");
    for (const plan of ALL_INTERNAL_PLANS) {
      for (const interval of INTERVALS) {
        if (plan === "ATLAS_GROWTH" && interval === "annual") continue;
        expect(stripePriceId(plan, interval)).toBeNull();
      }
    }
  });

  it("reports all six variables and fails closed when unset", () => {
    const configured = configuredStripePrices();
    expect(configured.map((entry) => entry.envKey)).toEqual([
      "STRIPE_PRICE_STARTER_MONTHLY",
      "STRIPE_PRICE_STARTER_YEARLY",
      "STRIPE_PRICE_GROWTH_MONTHLY",
      "STRIPE_PRICE_GROWTH_YEARLY",
      "STRIPE_PRICE_SCALE_MONTHLY",
      "STRIPE_PRICE_SCALE_YEARLY",
    ]);
    expect(configured.every((entry) => entry.configured === false)).toBe(true);
  });

  it("maps every slug/interval to the intended plan", () => {
    const expected: Array<[string, BillingInterval, InternalPlan]> = [
      ["starter", "monthly", "ATLAS_STARTER"],
      ["starter", "annual", "ATLAS_STARTER"],
      ["growth", "monthly", "ATLAS_GROWTH"],
      ["growth", "annual", "ATLAS_GROWTH"],
      ["scale", "monthly", "ATLAS_SCALE"],
      ["scale", "annual", "ATLAS_SCALE"],
    ];
    for (const [slug, interval, plan] of expected) {
      expect(normalizeCheckoutRequest({ plan: slug, interval })).toMatchObject({
        plan,
        interval,
        slug,
      });
    }
  });

  it("keeps the annual price below twelve monthly payments", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      const { monthly, annual } = CANONICAL[plan];
      expect(annual).toBeLessThan(monthly * 12);
    }
  });
});

describe("no browser-supplied billing value", () => {
  it("rejects a price id, an amount or a currency sent as the plan", () => {
    for (const hostile of ["price_123", "price_test_starter", "4900", "49", "$49", "usd", "eur"]) {
      expect(normalizeCheckoutRequest({ plan: hostile, interval: "month" })).toBeNull();
    }
  });

  it("sends plan + interval only and never a price id, amount or currency", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ data: { url: "https://checkout.stripe.com/c/pay/cs_test", sessionId: "cs_test" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await startCheckout({
      plan: "scale",
      interval: "annual",
      accessToken: "jwt_test",
      functionsBaseUrl: "https://project.supabase.co",
      tenantId: "org-1",
      companyName: "Acme Restoration",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(Object.keys(sent).sort()).toEqual(["companyName", "interval", "plan", "tenantId"].sort());
    for (const forbidden of ["priceId", "price", "amount", "unitAmount", "currency", "productId", "customerId"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
    expect(sent.plan).toBe("scale");
    expect(sent.interval).toBe("annual");
  });
});
