// ---------------------------------------------------------------------------
// Atlas Billing — Internal Plan ➜ Provider Price Mapping
//
// Never scatter provider price IDs through React components. Every price lookup
// flows through this mapping so a provider change is a config change, not a
// frontend rewrite.
//
// Price IDs are environment-driven (server-side secrets). The frontend only
// ever sees the internal plan name and a checkout URL; it never receives
// provider API keys or secrets.
// ---------------------------------------------------------------------------

import type { InternalPlan, BillingInterval } from "./types";

// ---------------------------------------------------------------------------
// Internal plan metadata (Atlas-owned)
// ---------------------------------------------------------------------------

export const PLAN_METADATA = {
  ATLAS_STARTER: {
    internalPlan: "ATLAS_STARTER" as InternalPlan,
    displayName: "Atlas Starter",
    description:
      "For small restoration teams getting started with AI workforce intelligence.",
    billingIntervalPrice: {
      monthly: 49,
      annual: 470,
    },
  },
  ATLAS_GROWTH: {
    internalPlan: "ATLAS_GROWTH" as InternalPlan,
    displayName: "Atlas Growth",
    description:
      "For growing teams that need the full AI workforce across claims, supplements, estimating, recovery, project management, and customer success.",
    billingIntervalPrice: {
      monthly: 149,
      annual: 1430,
    },
  },
  ATLAS_SCALE: {
    internalPlan: "ATLAS_SCALE" as InternalPlan,
    displayName: "Atlas Scale",
    description:
      "For larger operations with heavier claim volume and multi-team workflows.",
    billingIntervalPrice: {
      monthly: 299,
      annual: 2870,
    },
  },
} as const;

export type PlanMetadata = typeof PLAN_METADATA[InternalPlan];

/** All internal plans in a stable order. */
export const ALL_INTERNAL_PLANS: InternalPlan[] = [
  "ATLAS_STARTER" as InternalPlan,
  "ATLAS_GROWTH" as InternalPlan,
  "ATLAS_SCALE" as InternalPlan,
];

// ---------------------------------------------------------------------------
// Provider price mapping
// ---------------------------------------------------------------------------
//
// Paddle uses PRICE_ID per product/price. The mapping below is authoritative:
//   InternalPlan + BillingInterval ➜ Paddle Price ID
//
// Environment variables (server-side):
//   PADDLE_STARTER_PRICE_ID_MONTHLY
//   PADDLE_STARTER_PRICE_ID_ANNUAL
//   PADDLE_GROWTH_PRICE_ID_MONTHLY
//   PADDLE_GROWTH_PRICE_ID_ANNUAL
//   PADDLE_SCALE_PRICE_ID_MONTHLY
//   PADDLE_SCALE_PRICE_ID_ANNUAL
//
// If a price id is missing for a plan/interval, the checkout init must fail
// explicitly rather than silently creating an unusable session.
// ---------------------------------------------------------------------------

function envPriceId(
  plan: InternalPlan,
  interval: BillingInterval,
): string | undefined {
  const key =
    "PADDLE_" +
    plan.replace("ATLAS_", "").toLowerCase() +
    "_PRICE_ID_" +
    interval.toUpperCase();

  return process.env[key];
}

export function paddlePriceId(
  plan: InternalPlan,
  interval: BillingInterval,
): string | null {
  return envPriceId(plan, interval) ?? null;
}

export function internalPlanForPaddlePriceId(
  priceId: string,
): InternalPlan | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (
      plan &&
      (envPriceId(plan, "monthly") === priceId ||
        envPriceId(plan, "annual") === priceId)
    ) {
      return plan;
    }
  }
  return null;
}
