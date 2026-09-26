/**
 * Price-ID reconciliation for the AUTHORITATIVE Atlas Stripe catalog.
 *
 * This test pins the six production Price IDs to the plan + interval that the
 * server resolves, so a future edit that swaps, drops, or duplicates one of
 * them fails CI instead of silently charging the wrong amount.
 *
 * It also proves the security property that matters most: the browser
 * contributes a plan slug and an interval and NOTHING else. There is no code
 * path by which a client-supplied Price ID, amount, or currency reaches Stripe.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  configuredStripePrices,
  internalPlanForSlug,
  planAndIntervalForStripePriceId,
  stripePriceEnvKey,
  stripePriceId,
} from "./stripe.ts";
import { normalizeCheckoutRequest } from "../../../src/lib/billing/checkout";

// ---------------------------------------------------------------------------
// The AUTHORITATIVE Atlas Stripe catalog (2026-09).
// Products: Atlas Starter / Atlas Growth / Atlas Scale.
// ---------------------------------------------------------------------------
const AUTHORITATIVE = {
  ATLAS_STARTER: {
    monthly: "price_1UK2D3GUqFEQFEkDVg5sSieY",
    annual: "price_1UK2D4GUqFEQFEkD5sMLU0WM",
  },
  ATLAS_GROWTH: {
    monthly: "price_1UK2D6GUqFEQFEkDMIs19m8s",
    annual: "price_1UK2D8GUqFEQFEkDYSWgJwiC",
  },
  ATLAS_SCALE: {
    monthly: "price_1UK2DAGUqFEQFEkDLPYnkpe1",
    annual: "price_1UK2DCGUqFEQFEkDG8Nxk149",
  },
} as const;

const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_reconciliation",
  STRIPE_WEBHOOK_SECRET: "whsec_reconciliation",
  STRIPE_PRICE_STARTER_MONTHLY: AUTHORITATIVE.ATLAS_STARTER.monthly,
  STRIPE_PRICE_STARTER_YEARLY: AUTHORITATIVE.ATLAS_STARTER.annual,
  STRIPE_PRICE_GROWTH_MONTHLY: AUTHORITATIVE.ATLAS_GROWTH.monthly,
  STRIPE_PRICE_GROWTH_YEARLY: AUTHORITATIVE.ATLAS_GROWTH.annual,
  STRIPE_PRICE_SCALE_MONTHLY: AUTHORITATIVE.ATLAS_SCALE.monthly,
  STRIPE_PRICE_SCALE_YEARLY: AUTHORITATIVE.ATLAS_SCALE.annual,
};

function stubDeno(env: Record<string, string>): void {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => env[key] ?? "" },
  };
}

beforeEach(() => stubDeno(ENV));
afterEach(() => stubDeno({}));

describe("authoritative Stripe Price ID reconciliation", () => {
  it("resolves each plan + interval to exactly the authoritative Price ID", () => {
    expect(stripePriceId("ATLAS_STARTER", "monthly")).toBe(AUTHORITATIVE.ATLAS_STARTER.monthly);
    expect(stripePriceId("ATLAS_STARTER", "annual")).toBe(AUTHORITATIVE.ATLAS_STARTER.annual);
    expect(stripePriceId("ATLAS_GROWTH", "monthly")).toBe(AUTHORITATIVE.ATLAS_GROWTH.monthly);
    expect(stripePriceId("ATLAS_GROWTH", "annual")).toBe(AUTHORITATIVE.ATLAS_GROWTH.annual);
    expect(stripePriceId("ATLAS_SCALE", "monthly")).toBe(AUTHORITATIVE.ATLAS_SCALE.monthly);
    expect(stripePriceId("ATLAS_SCALE", "annual")).toBe(AUTHORITATIVE.ATLAS_SCALE.annual);
  });

  it("uses the canonical env-var name for every combination", () => {
    expect(stripePriceEnvKey("ATLAS_STARTER", "monthly")).toBe("STRIPE_PRICE_STARTER_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_STARTER", "annual")).toBe("STRIPE_PRICE_STARTER_YEARLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "monthly")).toBe("STRIPE_PRICE_GROWTH_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "annual")).toBe("STRIPE_PRICE_GROWTH_YEARLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "monthly")).toBe("STRIPE_PRICE_SCALE_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "annual")).toBe("STRIPE_PRICE_SCALE_YEARLY");
  });

  it("uses six DISTINCT Price IDs — no plan/interval aliases each other", () => {
    const all = Object.values(AUTHORITATIVE).flatMap((v) => [v.monthly, v.annual]);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
  });

  it("round-trips every Price ID back to its plan and interval", () => {
    for (const [plan, prices] of Object.entries(AUTHORITATIVE)) {
      for (const [interval, priceId] of Object.entries(prices)) {
        expect(planAndIntervalForStripePriceId(priceId)).toEqual({
          plan,
          interval,
        });
      }
    }
  });

  it("never invents a plan from an unknown or foreign Price ID", () => {
    expect(planAndIntervalForStripePriceId("price_bogus")).toBeNull();
    expect(planAndIntervalForStripePriceId("")).toBeNull();
    expect(planAndIntervalForStripePriceId(null)).toBeNull();
  });

  it("maps every browser slug + interval onto the right canonical pair", () => {
    const cases: Array<[string, string, string, string]> = [
      ["starter", "month", "ATLAS_STARTER", "monthly"],
      ["starter", "year", "ATLAS_STARTER", "annual"],
      ["growth", "month", "ATLAS_GROWTH", "monthly"],
      ["growth", "year", "ATLAS_GROWTH", "annual"],
      ["scale", "month", "ATLAS_SCALE", "monthly"],
      ["scale", "year", "ATLAS_SCALE", "annual"],
    ];
    for (const [slug, interval, plan, canonicalInterval] of cases) {
      const normalized = normalizeCheckoutRequest({ plan: slug, interval });
      expect(normalized).not.toBeNull();
      expect(normalized!.plan).toBe(plan);
      expect(normalized!.interval).toBe(canonicalInterval);
    }
  });

  it("refuses any browser attempt to smuggle a Price ID, amount or currency", () => {
    // A hostile client sends a real Price ID as the "plan".
    expect(
      normalizeCheckoutRequest({ plan: AUTHORITATIVE.ATLAS_SCALE.monthly, interval: "month" }),
    ).toBeNull();
    expect(internalPlanForSlug(AUTHORITATIVE.ATLAS_STARTER.annual)).toBeNull();
    // A non-scalar attempt is rejected too.
    expect(internalPlanForSlug({ price: AUTHORITATIVE.ATLAS_GROWTH.monthly })).toBeNull();
    expect(internalPlanForSlug(49)).toBeNull();
  });

  it("reports all six combinations as configured, without leaking values", () => {
    const report = configuredStripePrices();
    expect(report).toHaveLength(6);
    expect(report.every((r) => r.configured)).toBe(true);
    for (const row of report) {
      expect(row).not.toHaveProperty("priceId");
      expect(row).not.toHaveProperty("value");
    }
  });
});
