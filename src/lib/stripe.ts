/**
 * Stripe configuration and helper utilities for Atlas billing.
 *
 * Price IDs are environment-driven (VITE_STRIPE_*_PRICE_ID) so they are
 * never hardcoded into the frontend source. The actual products/prices are
 * created in the Stripe Dashboard and their IDs are injected at build time.
 */

import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * Get the Stripe.js instance (lazy-loaded on first call).
 * Returns null when the publishable key is not configured.
 */
export async function getStripe(): Promise<Stripe | null> {
  const pk = import.meta.env.VITE_STRIPE_PK as string | undefined;
  if (!pk) {
    console.warn("[atlas] Stripe publishable key (VITE_STRIPE_PK) not configured");
    return null;
  }
  if (!stripePromise) {
    stripePromise = loadStripe(pk);
  }
  return stripePromise;
}

/**
 * Stripe price ID configuration — environment-driven, never hardcoded.
 * Add these VITE_ variables in Settings → Environment:
 *   VITE_STRIPE_STARTER_MONTHLY
 *   VITE_STRIPE_STARTER_ANNUAL
 *   VITE_STRIPE_PRO_MONTHLY
 *   VITE_STRIPE_PRO_ANNUAL
 */
export const PRICE_IDS = {
  starter: {
    monthly: (import.meta.env.VITE_STRIPE_STARTER_MONTHLY as string) || "",
    annual: (import.meta.env.VITE_STRIPE_STARTER_ANNUAL as string) || "",
  },
  professional: {
    monthly: (import.meta.env.VITE_STRIPE_PRO_MONTHLY as string) || "",
    annual: (import.meta.env.VITE_STRIPE_PRO_ANNUAL as string) || "",
  },
} as const;

export type PlanName = "starter" | "professional" | "enterprise";
export type BillingInterval = "monthly" | "annual";

/**
 * Resolve a Stripe price ID for a given plan and billing interval.
 */
export function getPriceId(plan: PlanName, billing: BillingInterval): string | null {
  if (plan === "enterprise") return null;
  return PRICE_IDS[plan]?.[billing] || null;
}

/**
 * Check if Stripe is configured (publishable key present).
 */
export function isStripeConfigured(): boolean {
  return Boolean(import.meta.env.VITE_STRIPE_PK);
}
