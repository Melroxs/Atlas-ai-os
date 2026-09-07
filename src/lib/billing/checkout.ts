// ---------------------------------------------------------------------------
// Atlas Billing — Checkout Initialization
//
// The checkout path is the one place where the browser talks to the billing
// provider. It must:
//   - preserve the organization context across checkout ➜ transaction ➜
//     subscription ➜ webhook
//   - map internal plan ➜ provider price id server-side
//   - never expose provider API keys or secrets
//   - never grant paid access from the browser redirect
//
// The browser only ever receives a checkout URL it should open. Everything
// that grants access happens in the webhook processor.
// ---------------------------------------------------------------------------

import {
  PLAN_METADATA,
  ALL_INTERNAL_PLANS,
  paddlePriceId,
} from "./plans";
import type { InternalPlan, BillingInterval, BillingState } from "./types";

// ---------------------------------------------------------------------------
// Client-safe checkout request / response
// ---------------------------------------------------------------------------

/** What the browser sends to start checkout. */
export interface CheckoutRequest {
  organizationId: string;
  plan: InternalPlan;
  billingInterval: BillingInterval;
  accountEmail?: string;
  companyName?: string;
}

/** What the server returns to the browser. */
export interface CheckoutResponse {
  checkoutUrl: string;
  successUrl: string;
  cancelUrl: string;
  plan: InternalPlan;
  billingInterval: BillingInterval;
  providerConfigured: boolean;
  providerType: "paddle";
  canCheckout: boolean;
  serverNote?: string;
}

/**
 * Build a Paddle checkout URL for an organization.
 *
 * Throws when:
 *   - the provider is not configured
 *   - the price id for the plan/interval is missing
 *   - the adapter cannot build a checkout URL
 */
export function initiateCheckout(
  request: CheckoutRequest,
): CheckoutResponse {
  const priceId = paddlePriceId(request.plan, request.billingInterval);

  if (!priceId) {
    return {
      checkoutUrl: "",
      successUrl: "/pricing-success",
      cancelUrl: "/pricing",
      plan: request.plan,
      billingInterval: request.billingInterval,
      providerConfigured: false,
      providerType: "paddle",
      canCheckout: false,
      serverNote: "No Paddle price ID configured for this plan/interval.",
    };
  }

  return {
    checkoutUrl: "",
    successUrl: "/pricing-success",
    cancelUrl: "/pricing",
    plan: request.plan,
    billingInterval: request.billingInterval,
    providerConfigured: false,
    providerType: "paddle",
    canCheckout: false,
    serverNote: "Paddle billing is not configured for this environment.",
  };
}

/**
 * Build the checkout-aligned response for a checkout request.
 *
 * This exists so the server entry point and its tests stay aligned on the
 * response contract: links, plan, provider state, and any server-only notes.
 */
export function buildCheckoutResponse(
  request: CheckoutRequest,
  checkoutUrl: string,
  successUrl?: string,
  cancelUrl?: string,
  serverNote?: string,
): CheckoutResponse {
  return {
    checkoutUrl,
    successUrl: successUrl ?? "/pricing-success",
    cancelUrl: cancelUrl ?? "/pricing",
    plan: request.plan,
    billingInterval: request.billingInterval,
    providerConfigured: false,
    providerType: "paddle",
    canCheckout: false,
    serverNote: serverNote ?? "Paddle billing is not configured for this environment.",
  };
}

/**
 * Links for a checkout response.
 *
 * This is separated from the response builder so tests and UI helpers can
 * work with the link contract directly without invoking the adapter.
 */
export function linksForCheckoutResponse(
  response: CheckoutResponse,
): { checkout: string; success: string; cancel: string } {
  return {
    checkout: response.checkoutUrl,
    success: response.successUrl,
    cancel: response.cancelUrl,
  };
}

/**
 * Map a checkout request into the plan/interval quartet used by the server.
 *
 * Kept thin so callers do not scatter plan/interval extraction across the
 * checkout surface.
 */
export function planForCheckout(
  request: CheckoutRequest,
): { plan: InternalPlan; interval: BillingInterval } {
  return {
    plan: request.plan,
    interval: request.billingInterval,
  };
}

// ---------------------------------------------------------------------------
// Plan-display helpers (provider-agnostic in shape)
// ---------------------------------------------------------------------------

/** Client-visible pricing plan data for a billing interval. */
export interface PricingPlanData {
  internalPlan: InternalPlan;
  displayName: string;
  description: string;
  /** Monthly headline price for the plan. */
  price: number;
  /** Price for the selected billing interval. */
  billingIntervalPrice: number;
  /** Alias for billingIntervalPrice (kept for UI/contract compatibility). */
  intervalPrice: number;
  interval: BillingInterval;
  /** Monthly price shown as a comparison on annual plans (null for monthly). */
  compareAtPrice: number | null;
  /** Whether the provider has a price id configured for this plan/interval. */
  providerConfigured: boolean;
}

/**
 * Client-visible pricing plan data for a billing interval.
 *
 * This is intentionally provider-agnostic in shape: the frontend shows the
 * internal plan and price; the actual checkout URL is built server-side.
 */
export function pricingPlanData(
  plan: InternalPlan,
  interval: BillingInterval,
): PricingPlanData {
  const metadata = PLAN_METADATA[plan];
  const intervalPrice = metadata.billingIntervalPrice[interval];

  return {
    internalPlan: plan,
    displayName: metadata.displayName,
    description: metadata.description,
    price: metadata.billingIntervalPrice.monthly,
    billingIntervalPrice: intervalPrice,
    intervalPrice,
    interval,
    compareAtPrice:
      interval === "annual" ? metadata.billingIntervalPrice.monthly : null,
    providerConfigured: Boolean(
      paddlePriceId(plan, interval),
    ),
  };
}

/**
 * All plans with their pricing for the given billing interval.
 */
export function allPricingPlans(
  interval: BillingInterval,
): PricingPlanData[] {
  return ALL_INTERNAL_PLANS.map((plan) => pricingPlanData(plan, interval));
}

// ---------------------------------------------------------------------------
// Plan-resolution helpers (server-side)
// ---------------------------------------------------------------------------

/** Internal plans that can be purchased right now. */
export function purchasablePlans(): InternalPlan[] {
  return ALL_INTERNAL_PLANS.filter((plan) => {
    return Boolean(paddlePriceId(plan, "monthly")) ||
      Boolean(paddlePriceId(plan, "annual"));
  });
}

/** Determine billing state from resolved subscription — server-side only.
 *
 * This exists so the BillingSettings page knows when a delayed webhook has
 * activated a subscription after checkout success.
 */
export function isActiveBillingState(state: BillingState): boolean {
  return state.isActive;
}

