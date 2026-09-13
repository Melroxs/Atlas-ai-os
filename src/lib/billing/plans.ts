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
    plan.replace("ATLAS_", "").toUpperCase() +
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

/**
 * Resolve the billing interval for a Paddle price id (monthly/annual).
 *
 * The price id is the authoritative key for plan + interval — we never infer
 * the interval from user-supplied values or displayed prices.
 */
export function billingIntervalForPaddlePriceId(
  priceId: string,
): BillingInterval | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (envPriceId(plan, "monthly") === priceId) return "monthly";
    if (envPriceId(plan, "annual") === priceId) return "annual";
  }
  return null;
}

/**
 * Resolve plan + interval together from a Paddle price id.
 *
 * Returns null when the price id is not one of Atlas's configured prices.
 */
export function planAndIntervalForPaddlePriceId(
  priceId: string,
): { plan: InternalPlan; interval: BillingInterval } | null {
  const plan = internalPlanForPaddlePriceId(priceId);
  if (!plan) return null;
  const interval = billingIntervalForPaddlePriceId(priceId);
  if (!interval) return null;
  return { plan, interval };
}

// ---------------------------------------------------------------------------
// Plan entitlements (server-side contract)
//
// Mirrors the features listed on the public pricing page — no new limits or
// pricing are invented here. Access to these entitlements is gated by the
// organization's subscription state (see resolveBillingState); the browser
// never supplies plan/status values.
// ---------------------------------------------------------------------------

export interface PlanEntitlements {
  internalPlan: InternalPlan;
  /** null = unlimited. */
  maxSeats: number | null;
  /** null = unlimited. */
  maxStorageGb: number | null;
  aiTier: "basic" | "advanced" | "enterprise";
  prioritySupport: boolean;
  multipleOrganizations: boolean;
  customWorkflows: boolean;
  apiAccess: boolean;
  sso: boolean;
  sla: boolean;
}

export const PLAN_ENTITLEMENTS: Record<InternalPlan, PlanEntitlements> = {
  ATLAS_STARTER: {
    internalPlan: "ATLAS_STARTER",
    maxSeats: 5,
    maxStorageGb: 10,
    aiTier: "basic",
    prioritySupport: false,
    multipleOrganizations: false,
    customWorkflows: false,
    apiAccess: false,
    sso: false,
    sla: false,
  },
  ATLAS_GROWTH: {
    internalPlan: "ATLAS_GROWTH",
    maxSeats: 25,
    maxStorageGb: 100,
    aiTier: "advanced",
    prioritySupport: true,
    multipleOrganizations: true,
    customWorkflows: true,
    apiAccess: true,
    sso: false,
    sla: false,
  },
  ATLAS_SCALE: {
    internalPlan: "ATLAS_SCALE",
    maxSeats: null,
    maxStorageGb: null,
    aiTier: "enterprise",
    prioritySupport: true,
    multipleOrganizations: true,
    customWorkflows: true,
    apiAccess: true,
    sso: true,
    sla: true,
  },
};

/** Resolve the entitlements for an internal plan (null when not on a plan). */
export function resolvePlanEntitlements(
  plan: InternalPlan | null,
): PlanEntitlements | null {
  return plan ? PLAN_ENTITLEMENTS[plan] : null;
}
