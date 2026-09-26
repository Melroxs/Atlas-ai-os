/**
 * The annual saving shown on the pricing page must be DERIVED from the
 * canonical catalog, never hardcoded. This test pins the behaviour so a future
 * price change cannot leave a stale percentage on the page.
 */
import { describe, expect, it } from "vitest";
import { allPricingPlans, pricingPlanData } from "./checkout";

function bestAnnualDiscountPercent(): number {
  const monthly = allPricingPlans("monthly");
  const annual = allPricingPlans("annual");
  const best = monthly.reduce((acc, p, i) => {
    // `intervalPrice` is the amount actually charged; `price` is only the
    // monthly-equivalent display figure. Using `price` here silently produced
    // a nonsense ~92% saving.
    const twelve = p.intervalPrice * 12;
    const pct = ((twelve - annual[i].intervalPrice) / twelve) * 100;
    return pct > acc.pct ? { pct } : acc;
  }, { pct: -Infinity });
  return Number.isFinite(best.pct) ? Math.max(0, Math.round(best.pct)) : 0;
}

describe("annual discount is derived from the catalog", () => {
  it("reports approximately 20% for the authoritative prices", () => {
    expect(bestAnnualDiscountPercent()).toBe(20);
  });

  it("is not the stale 17% value", () => {
    expect(bestAnnualDiscountPercent()).not.toBe(17);
  });

  it("matches the per-plan annualSavingsPercent for every plan", () => {
    for (const plan of ["ATLAS_STARTER", "ATLAS_GROWTH", "ATLAS_SCALE"] as const) {
      const data = pricingPlanData(plan, "annual");
      expect(data.annualSavingsPercent).toBeGreaterThanOrEqual(20);
      expect(data.annualSavingsPercent).toBeLessThanOrEqual(21);
    }
  });

  it("keeps every annual plan cheaper than twelve monthly payments", () => {
    const monthly = allPricingPlans("monthly");
    const annual = allPricingPlans("annual");
    for (let i = 0; i < monthly.length; i++) {
      expect(annual[i].intervalPrice).toBeLessThan(monthly[i].intervalPrice * 12);
    }
  });

  it("uses the authoritative amounts actually charged", () => {
    expect(allPricingPlans("monthly").map((p) => p.intervalPrice)).toEqual([49, 149, 299]);
    expect(allPricingPlans("annual").map((p) => p.intervalPrice)).toEqual([470, 1430, 2870]);
  });

  it("shows the annual monthly-equivalent as `price` and the annual total as `intervalPrice`", () => {
    const annual = allPricingPlans("annual");
    expect(annual.map((p) => p.price)).toEqual([49, 149, 299]);
    expect(annual.map((p) => p.intervalPrice)).toEqual([470, 1430, 2870]);
  });
});
