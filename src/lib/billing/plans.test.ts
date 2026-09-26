import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ALL_INTERNAL_PLANS,
  PLAN_ENTITLEMENTS,
  PLAN_METADATA,
  billingIntervalForStripePriceId,
  configuredStripePrices,
  intervalForInput,
  internalPlanForStripePriceId,
  planAndIntervalForStripePriceId,
  planForSlug,
  planSlug,
  purchasablePlans,
  stripePriceEnvKey,
  stripePriceId,
} from "./plans";

const PRICE_ENV_KEYS = [
  "STRIPE_PRICE_STARTER_MONTHLY",
  "STRIPE_PRICE_STARTER_YEARLY",
  "STRIPE_PRICE_GROWTH_MONTHLY",
  "STRIPE_PRICE_GROWTH_YEARLY",
  "STRIPE_PRICE_SCALE_MONTHLY",
  "STRIPE_PRICE_SCALE_YEARLY",
  // Legacy trial configuration: must have NO effect on the catalog anymore.
  "STRIPE_TRIAL_PRICE_ID",
  "STRIPE_TRIAL_PERIOD_DAYS",
] as const;

const PRICE_IDS = {
  starterMonthly: "price_test_starter_monthly",
  starterYearly: "price_test_starter_yearly",
  growthMonthly: "price_test_growth_monthly",
  growthYearly: "price_test_growth_yearly",
  scaleMonthly: "price_test_scale_monthly",
  scaleYearly: "price_test_scale_yearly",
};

const originalEnv: Record<string, string | undefined> = {};

function setPriceEnv() {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = PRICE_IDS.starterMonthly;
  process.env.STRIPE_PRICE_STARTER_YEARLY = PRICE_IDS.starterYearly;
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = PRICE_IDS.growthMonthly;
  process.env.STRIPE_PRICE_GROWTH_YEARLY = PRICE_IDS.growthYearly;
  process.env.STRIPE_PRICE_SCALE_MONTHLY = PRICE_IDS.scaleMonthly;
  process.env.STRIPE_PRICE_SCALE_YEARLY = PRICE_IDS.scaleYearly;
}

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

describe("plan ➜ Stripe price id mapping (all 6 combinations)", () => {
  it("names the environment variables STRIPE_PRICE_<PLAN>_<INTERVAL>", () => {
    expect(stripePriceEnvKey("ATLAS_STARTER", "monthly")).toBe("STRIPE_PRICE_STARTER_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_STARTER", "annual")).toBe("STRIPE_PRICE_STARTER_YEARLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "monthly")).toBe("STRIPE_PRICE_GROWTH_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "annual")).toBe("STRIPE_PRICE_GROWTH_YEARLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "monthly")).toBe("STRIPE_PRICE_SCALE_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "annual")).toBe("STRIPE_PRICE_SCALE_YEARLY");
  });

  it("resolves every configured plan/interval to its Stripe price id", () => {
    setPriceEnv();
    expect(stripePriceId("ATLAS_STARTER", "monthly")).toBe(PRICE_IDS.starterMonthly);
    expect(stripePriceId("ATLAS_STARTER", "annual")).toBe(PRICE_IDS.starterYearly);
    expect(stripePriceId("ATLAS_GROWTH", "monthly")).toBe(PRICE_IDS.growthMonthly);
    expect(stripePriceId("ATLAS_GROWTH", "annual")).toBe(PRICE_IDS.growthYearly);
    expect(stripePriceId("ATLAS_SCALE", "monthly")).toBe(PRICE_IDS.scaleMonthly);
    expect(stripePriceId("ATLAS_SCALE", "annual")).toBe(PRICE_IDS.scaleYearly);
  });

  it("fails closed (null) when a price id is not configured", () => {
    expect(stripePriceId("ATLAS_STARTER", "monthly")).toBeNull();
    setPriceEnv();
    delete process.env.STRIPE_PRICE_SCALE_YEARLY;
    expect(stripePriceId("ATLAS_SCALE", "annual")).toBeNull();
    expect(planAndIntervalForStripePriceId(PRICE_IDS.starterMonthly)).toEqual({
      plan: "ATLAS_STARTER",
      interval: "monthly",
    });
  });

  it("never invents a plan or interval from an unknown price id", () => {
    setPriceEnv();
    expect(internalPlanForStripePriceId("price_not_atlas")).toBeNull();
    expect(billingIntervalForStripePriceId("price_not_atlas")).toBeNull();
    expect(planAndIntervalForStripePriceId("price_not_atlas")).toBeNull();
    // A price id that is configured for another plan must not resolve here.
    expect(internalPlanForStripePriceId(PRICE_IDS.growthYearly)).toBe("ATLAS_GROWTH");
  });

  it("reports configuration status without leaking values", () => {
    setPriceEnv();
    const configured = configuredStripePrices();
    expect(configured).toHaveLength(6);
    expect(configured.every((entry) => entry.configured)).toBe(true);
    expect(configured.map((entry) => entry.envKey)).toEqual([
      "STRIPE_PRICE_STARTER_MONTHLY",
      "STRIPE_PRICE_STARTER_YEARLY",
      "STRIPE_PRICE_GROWTH_MONTHLY",
      "STRIPE_PRICE_GROWTH_YEARLY",
      "STRIPE_PRICE_SCALE_MONTHLY",
      "STRIPE_PRICE_SCALE_YEARLY",
    ]);
    expect(JSON.stringify(configured)).not.toContain(PRICE_IDS.starterMonthly);
  });

  it("lists purchasable plans from configured prices only", () => {
    expect(purchasablePlans()).toEqual([]);
    process.env.STRIPE_PRICE_STARTER_MONTHLY = PRICE_IDS.starterMonthly;
    expect(purchasablePlans()).toEqual(["ATLAS_STARTER"]);
  });
});

describe("no trials", () => {
  it("exposes no trial configuration at all", async () => {
    const plans = await import("./plans");
    expect("stripeTrialPriceId" in plans).toBe(false);
    expect("stripeTrialPeriodDays" in plans).toBe(false);
  });

  it("ignores legacy trial env vars when resolving prices", () => {
    setPriceEnv();
    process.env.STRIPE_TRIAL_PRICE_ID = "price_test_trial_10";
    process.env.STRIPE_TRIAL_PERIOD_DAYS = "1";
    expect(stripePriceId("ATLAS_STARTER", "monthly")).toBe(PRICE_IDS.starterMonthly);
    expect(configuredStripePrices()).toHaveLength(6);
  });
});

describe("client input validation", () => {
  it("accepts the three canonical plan slugs and nothing else", () => {
    expect(planForSlug("starter")).toBe("ATLAS_STARTER");
    expect(planForSlug("GROWTH")).toBe("ATLAS_GROWTH");
    expect(planForSlug("Scale")).toBe("ATLAS_SCALE");
    expect(planForSlug("enterprise")).toBeNull();
    expect(planForSlug("price_123")).toBeNull();
    expect(planForSlug("")).toBeNull();
    expect(planForSlug(null)).toBeNull();
  });

  it("accepts month/year spellings and rejects everything else", () => {
    expect(intervalForInput("month")).toBe("monthly");
    expect(intervalForInput("monthly")).toBe("monthly");
    expect(intervalForInput("year")).toBe("annual");
    expect(intervalForInput("annual")).toBe("annual");
    expect(intervalForInput("yearly")).toBe("annual");
    expect(intervalForInput("weekly")).toBeNull();
    expect(intervalForInput("999")).toBeNull();
    expect(intervalForInput(null)).toBeNull();
  });

  it("maps internal plans back to their slug", () => {
    expect(planSlug("ATLAS_STARTER")).toBe("starter");
    expect(planSlug("ATLAS_GROWTH")).toBe("growth");
    expect(planSlug("ATLAS_SCALE")).toBe("scale");
    expect(planSlug(null)).toBeNull();
  });
});

describe("canonical Atlas catalog", () => {
  it("keeps the canonical list prices (monthly / annual)", () => {
    expect(PLAN_METADATA.ATLAS_STARTER.billingIntervalPrice).toEqual({
      monthly: 49,
      annual: 470,
    });
    expect(PLAN_METADATA.ATLAS_GROWTH.billingIntervalPrice).toEqual({
      monthly: 149,
      annual: 1430,
    });
    expect(PLAN_METADATA.ATLAS_SCALE.billingIntervalPrice).toEqual({
      monthly: 299,
      annual: 2870,
    });
  });

  it("discounts every annual plan by at least 20% against twelve monthly payments", () => {
    for (const plan of ALL_INTERNAL_PLANS) {
      const prices = PLAN_METADATA[plan].billingIntervalPrice;
      const twelveMonths = prices.monthly * 12;
      expect(prices.annual).toBeLessThan(twelveMonths);
      const discount = (twelveMonths - prices.annual) / twelveMonths;
      expect(discount).toBeGreaterThanOrEqual(0.2);
    }
  });

  it("has no trial amounts in the catalog", () => {
    expect(JSON.stringify(PLAN_METADATA)).not.toMatch(/trial/i);
  });

  it("keeps entitlements aligned with the plan list", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual([...ALL_INTERNAL_PLANS].sort());
  });

  it("keeps the code seat limits identical to the database seat limits", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      resolve(here, "../../../supabase/migrations/20260918_atlas_security_hardening.sql"),
      "utf8",
    );
    // The security-hardening migration is the server-authoritative source of
    // seat limits; a drift between it and plans.ts would let the UI advertise
    // a limit the server does not enforce.
    expect(migration).toContain("('ATLAS_STARTER', 5)");
    expect(migration).toContain("('ATLAS_GROWTH', 25)");
    expect(migration).toContain("('ATLAS_SCALE', null)");
    expect(PLAN_ENTITLEMENTS.ATLAS_STARTER.maxSeats).toBe(5);
    expect(PLAN_ENTITLEMENTS.ATLAS_GROWTH.maxSeats).toBe(25);
    expect(PLAN_ENTITLEMENTS.ATLAS_SCALE.maxSeats).toBeNull();
  });
});
