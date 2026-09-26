// ---------------------------------------------------------------------------
// Atlas Billing — Canonical Plan Catalog ➜ Stripe Price Mapping
//
// Never scatter Stripe price ids through React components. Every price lookup
// flows through this mapping, so a catalog change is a configuration change,
// not a frontend rewrite.
//
// Price ids are environment-driven and SERVER-SIDE (Supabase Edge Function
// secrets). The browser only ever sends a plan slug ("starter" | "growth" |
// "scale") and an interval ("month" | "year"); the server resolves the Stripe
// Price id. The browser never sees a price id, an amount, or a currency, and
// can never supply one.
//
// Configuration (names only — values live in the Edge Function secrets):
//   STRIPE_PRICE_STARTER_MONTHLY   STRIPE_PRICE_STARTER_YEARLY
//   STRIPE_PRICE_GROWTH_MONTHLY    STRIPE_PRICE_GROWTH_YEARLY
//   STRIPE_PRICE_SCALE_MONTHLY     STRIPE_PRICE_SCALE_YEARLY
//
// Atlas sells no trials: every checkout is a plain recurring subscription.
//
// If a price id is missing for a plan/interval, checkout fails explicitly
// rather than silently creating an unusable session.
// ---------------------------------------------------------------------------

import type { InternalPlan, BillingInterval } from "./types";// ---------------------------------------------------------------------------
// Internal plan metadata (Atlas-owned)
//
// The amounts below are the canonical Atlas list prices and are what the

// ---------------------------------------------------------------------------

export const PLAN_METADATA = {
  ATLAS_STARTER: {
    internalPlan: "ATLAS_STARTER" as InternalPlan,
    slug: "starter",
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
    slug: "growth",
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
    slug: "scale",
    displayName: "Atlas Scale",
    description:
      "For larger operations with heavier claim volume and multi-team workflows.",
    billingIntervalPrice: {
      monthly: 299,
      annual: 2870,
    },
  },
} as const;

export type PlanMetadata = (typeof PLAN_METADATA)[InternalPlan];

/** All internal plans in a stable display order. */
export const ALL_INTERNAL_PLANS: InternalPlan[] = [
  "ATLAS_STARTER",
  "ATLAS_GROWTH",
  "ATLAS_SCALE",
];

/** Client-visible plan slug ➜ internal plan. */
export const INTERNAL_PLAN_SLUGS: Record<string, InternalPlan> = {
  starter: "ATLAS_STARTER",
  growth: "ATLAS_GROWTH",
  scale: "ATLAS_SCALE",
};

/** Internal plan ➜ client-visible slug. */
export function planSlug(plan: InternalPlan | null | undefined): string | null {
  if (!plan) return null;
  return PLAN_METADATA[plan]?.slug ?? null;
}

/** Normalize a client-supplied plan slug (null for anything unknown). */
export function planForSlug(raw: string | null | undefined): InternalPlan | null {
  if (!raw) return null;
  return INTERNAL_PLAN_SLUGS[raw.trim().toLowerCase()] ?? null;
}

/** Normalize a client-supplied interval (null for anything unknown). */
export function intervalForInput(raw: string | null | undefined): BillingInterval | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "month":
    case "monthly":
      return "monthly";
    case "year":
    case "annual":
    case "yearly":
      return "annual";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Stripe price mapping
// ---------------------------------------------------------------------------

const PLAN_KEY: Record<InternalPlan, string> = {
  ATLAS_STARTER: "STARTER",
  ATLAS_GROWTH: "GROWTH",
  ATLAS_SCALE: "SCALE",
};

/** Environment variable name for a plan/interval price id (names only). */
export function stripePriceEnvKey(
  plan: InternalPlan,
  interval: BillingInterval,
): string {
  return `STRIPE_PRICE_${PLAN_KEY[plan]}_${interval === "annual" ? "YEARLY" : "MONTHLY"}`;
}

/** The configured Stripe Price id for a plan + interval (null when unset). */
export function stripePriceId(
  plan: InternalPlan,
  interval: BillingInterval,
): string | null {
  const value = process.env[stripePriceEnvKey(plan, interval)];
  return value && value.trim() !== "" ? value.trim() : null;
}

export function internalPlanForStripePriceId(priceId: string): InternalPlan | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (
      stripePriceId(plan, "monthly") === priceId ||
      stripePriceId(plan, "annual") === priceId
    ) {
      return plan;
    }
  }
  return null;
}

/**
 * Resolve the billing interval for a Stripe price id.
 *
 * The price id is the authoritative key for plan + interval — the interval is
 * never inferred from user-supplied values or displayed prices.
 */
export function billingIntervalForStripePriceId(
  priceId: string,
): BillingInterval | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (stripePriceId(plan, "monthly") === priceId) return "monthly";
    if (stripePriceId(plan, "annual") === priceId) return "annual";
  }
  return null;
}

/** Resolve plan + interval together from a Stripe price id. */
export function planAndIntervalForStripePriceId(
  priceId: string,
): { plan: InternalPlan; interval: BillingInterval } | null {
  const plan = internalPlanForStripePriceId(priceId);
  if (!plan) return null;
  const interval = billingIntervalForStripePriceId(priceId);
  if (!interval) return null;
  return { plan, interval };
}

/** Every configured plan/interval pair — used for readiness + parity checks. */
export function configuredStripePrices(): Array<{
  plan: InternalPlan;
  interval: BillingInterval;
  envKey: string;
  configured: boolean;
}> {
  const out: Array<{
    plan: InternalPlan;
    interval: BillingInterval;
    envKey: string;
    configured: boolean;
  }> = [];
  for (const plan of ALL_INTERNAL_PLANS) {
    for (const interval of ["monthly", "annual"] as BillingInterval[]) {
      out.push({
        plan,
        interval,
        envKey: stripePriceEnvKey(plan, interval),
        configured: stripePriceId(plan, interval) !== null,
      });
    }
  }
  return out;
}

/** Internal plans with at least one configured price (purchasable now). */
export function purchasablePlans(): InternalPlan[] {
  return ALL_INTERNAL_PLANS.filter((plan) => {
    return (
      Boolean(stripePriceId(plan, "monthly")) || Boolean(stripePriceId(plan, "annual"))
    );
  });
}

// ---------------------------------------------------------------------------
// Plan entitlements (server-side contract)
//
// Mirrors the features listed on the public pricing page. Access to these
// entitlements is gated by the organization's billing state (see
// resolveBillingState + evaluateAtlasAccess); the browser never supplies
// plan/status values.
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

const AI_TIER_LABEL: Record<PlanEntitlements["aiTier"], string> = {
  basic: "Basic AI intelligence",
  advanced: "Advanced AI intelligence",
  enterprise: "Enterprise AI intelligence",
};

/**
 * Display feature lines for a plan, DERIVED from its canonical entitlements.
 *
 * Shared by every page that renders a plan card (pricing page + landing page)
 * so no page can advertise a seat limit, storage limit or feature that the
 * entitlement contract — and therefore the server — does not enforce.
 */
export function planFeatureLines(plan: InternalPlan): string[] {
  const e = PLAN_ENTITLEMENTS[plan];
  const lines: string[] = [
    e.maxSeats === null ? "Unlimited team members" : `Up to ${e.maxSeats} team members`,
    e.maxStorageGb === null
      ? "Unlimited document storage"
      : `${e.maxStorageGb} GB document storage`,
    AI_TIER_LABEL[e.aiTier],
    e.prioritySupport ? "Priority support" : "Email support",
    e.multipleOrganizations ? "Multiple organizations" : "Single organization",
  ];
  if (e.customWorkflows) lines.push("Custom workflows");
  if (e.apiAccess) lines.push("API access");
  if (e.sso) lines.push("SSO & advanced security");
  if (e.sla) lines.push("SLA guarantee");
  return lines;
}
