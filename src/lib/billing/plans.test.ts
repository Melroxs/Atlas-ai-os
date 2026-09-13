import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  paddlePriceId,
  internalPlanForPaddlePriceId,
  billingIntervalForPaddlePriceId,
  planAndIntervalForPaddlePriceId,
} from "./plans";

const PRICE_IDS = {
  starterMonthly: "pri_test_starter_monthly",
  starterAnnual: "pri_test_starter_annual",
  growthMonthly: "pri_test_growth_monthly",
  growthAnnual: "pri_test_growth_annual",
  scaleMonthly: "pri_test_scale_monthly",
  scaleAnnual: "pri_test_scale_annual",
} as const;

function setEnv() {
  process.env.PADDLE_STARTER_PRICE_ID_MONTHLY = PRICE_IDS.starterMonthly;
  process.env.PADDLE_STARTER_PRICE_ID_ANNUAL = PRICE_IDS.starterAnnual;
  process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY = PRICE_IDS.growthMonthly;
  process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL = PRICE_IDS.growthAnnual;
  process.env.PADDLE_SCALE_PRICE_ID_MONTHLY = PRICE_IDS.scaleMonthly;
  process.env.PADDLE_SCALE_PRICE_ID_ANNUAL = PRICE_IDS.scaleAnnual;
}

function clearEnv() {
  for (const key of Object.keys(PRICE_IDS) as Array<keyof typeof PRICE_IDS>) {
    delete process.env[
      "PADDLE_" +
        (key === "starterMonthly" || key === "starterAnnual"
          ? "STARTER"
          : key === "growthMonthly" || key === "growthAnnual"
            ? "GROWTH"
            : "SCALE") +
        "_PRICE_ID_" +
        (key.endsWith("Monthly") ? "MONTHLY" : "ANNUAL")
    ];
  }
}

describe("plan → Paddle price id mapping (all 6 combinations)", () => {
  beforeEach(setEnv);
  afterEach(clearEnv);

  it("maps Starter monthly and annual", () => {
    expect(paddlePriceId("ATLAS_STARTER", "monthly")).toBe(PRICE_IDS.starterMonthly);
    expect(paddlePriceId("ATLAS_STARTER", "annual")).toBe(PRICE_IDS.starterAnnual);
  });

  it("maps Growth monthly and annual", () => {
    expect(paddlePriceId("ATLAS_GROWTH", "monthly")).toBe(PRICE_IDS.growthMonthly);
    expect(paddlePriceId("ATLAS_GROWTH", "annual")).toBe(PRICE_IDS.growthAnnual);
  });

  it("maps Scale monthly and annual", () => {
    expect(paddlePriceId("ATLAS_SCALE", "monthly")).toBe(PRICE_IDS.scaleMonthly);
    expect(paddlePriceId("ATLAS_SCALE", "annual")).toBe(PRICE_IDS.scaleAnnual);
  });

  it("returns null when a price id is not configured", () => {
    delete process.env.PADDLE_SCALE_PRICE_ID_ANNUAL;
    expect(paddlePriceId("ATLAS_SCALE", "annual")).toBeNull();
  });

  it("resolves the internal plan from each of the six price ids", () => {
    expect(internalPlanForPaddlePriceId(PRICE_IDS.starterMonthly)).toBe("ATLAS_STARTER");
    expect(internalPlanForPaddlePriceId(PRICE_IDS.starterAnnual)).toBe("ATLAS_STARTER");
    expect(internalPlanForPaddlePriceId(PRICE_IDS.growthMonthly)).toBe("ATLAS_GROWTH");
    expect(internalPlanForPaddlePriceId(PRICE_IDS.growthAnnual)).toBe("ATLAS_GROWTH");
    expect(internalPlanForPaddlePriceId(PRICE_IDS.scaleMonthly)).toBe("ATLAS_SCALE");
    expect(internalPlanForPaddlePriceId(PRICE_IDS.scaleAnnual)).toBe("ATLAS_SCALE");
  });

  it("resolves the billing interval from each of the six price ids", () => {
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.starterMonthly)).toBe("monthly");
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.starterAnnual)).toBe("annual");
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.growthMonthly)).toBe("monthly");
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.growthAnnual)).toBe("annual");
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.scaleMonthly)).toBe("monthly");
    expect(billingIntervalForPaddlePriceId(PRICE_IDS.scaleAnnual)).toBe("annual");
  });

  it("resolves plan + interval together", () => {
    expect(planAndIntervalForPaddlePriceId(PRICE_IDS.growthAnnual)).toEqual({
      plan: "ATLAS_GROWTH",
      interval: "annual",
    });
  });

  it("returns null for unknown price ids (never infers)", () => {
    expect(internalPlanForPaddlePriceId("pri_someone_elses")).toBeNull();
    expect(billingIntervalForPaddlePriceId("pri_someone_elses")).toBeNull();
    expect(planAndIntervalForPaddlePriceId("pri_someone_elses")).toBeNull();
  });
});