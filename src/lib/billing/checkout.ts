// ---------------------------------------------------------------------------
// Atlas Billing — Checkout Client Contract (Stripe)
//
// Two responsibilities, both browser-safe:
//
//   1. PRICING DISPLAY — the single source of the plan list and the amounts
//      the pricing page renders (previously duplicated as a hardcoded array
//      inside the page). Display values are NOT authorization: the server
//      resolves the Stripe Price id and the browser can never send an amount,
//      a currency or a price id.
//
//   2. CHECKOUT REQUEST — `startCheckout()` calls the provider-neutral
//      `billing-checkout` Edge Function with plan + interval ONLY and returns
//      the hosted checkout URL (Stripe or Paystack) to navigate to. The
//      provider is chosen SERVER-SIDE (ATLAS_BILLING_PROVIDER); the browser
//      never selects, sends or observes it.
//
// The browser NEVER:
//   * creates a subscription
//   * chooses or sends a price id, amount, currency or provider
//   * holds a payment-provider secret key
//   * treats the post-checkout redirect as proof of payment
//
// Access is granted only after the verified `stripe-webhook` writes billing
// state — see PricingSuccess.tsx, which polls `billing_get_state`.
// ---------------------------------------------------------------------------

import {
  ALL_INTERNAL_PLANS,
  PLAN_METADATA,
  intervalForInput,
  planForSlug,
} from "./plans";
import type { BillingInterval, BillingState, InternalPlan } from "./types";

/**
 * Whole-percent saving of the annual price versus twelve monthly payments
 * (two months free ≈ 20% off at the canonical Atlas prices). Derived, never
 * hardcoded, so a catalog change cannot leave the pricing page advertising the
 * wrong discount.
 */
function annualSavingsPercent(prices: {
  monthly: number;
  annual: number;
}): number | null {
  const full = prices.monthly * 12;
  if (!full || prices.annual >= full) return null;
  return Math.round(((full - prices.annual) / full) * 100);
}

// Atlas sells NO trials: checkout is a plain recurring subscription at the
// plan price. (Defensive `trialing` subscription-state handling still exists in
// the entitlement mapping for subscriptions created outside Atlas, e.g. by
// Stripe support or a future promotion — Atlas itself never creates one.)

// ---------------------------------------------------------------------------
// Client-visible pricing plan data
// ---------------------------------------------------------------------------

export interface PricingPlanData {
  internalPlan: InternalPlan;
  /** Client-visible slug ("starter" | "growth" | "scale") sent to the server. */
  slug: string;
  displayName: string;
  description: string;
  /** Monthly headline price. */
  price: number;
  /** Price for the selected billing interval. */
  intervalPrice: number;
  /** Alias for intervalPrice (kept for UI/contract compatibility). */
  billingIntervalPrice: number;
  interval: BillingInterval;
  /** Monthly price shown as a comparison on annual plans (null for monthly). */
  compareAtPrice: number | null;
  /** Savings on the annual interval, as a whole percentage (null for monthly). */
  annualSavingsPercent: number | null;
}

/** Client-visible pricing plan data for a billing interval. */
export function pricingPlanData(
  plan: InternalPlan,
  interval: BillingInterval,
): PricingPlanData {
  const metadata = PLAN_METADATA[plan];
  const intervalPrice = metadata.billingIntervalPrice[interval];

  return {
    internalPlan: plan,
    slug: metadata.slug,
    displayName: metadata.displayName,
    description: metadata.description,
    price: metadata.billingIntervalPrice.monthly,
    intervalPrice,
    billingIntervalPrice: intervalPrice,
    interval,
    compareAtPrice:
      interval === "annual" ? metadata.billingIntervalPrice.monthly : null,
    annualSavingsPercent:
      interval === "annual" ? annualSavingsPercent(metadata.billingIntervalPrice) : null,
  };
}

/** All plans with their pricing for the given billing interval. */
export function allPricingPlans(interval: BillingInterval): PricingPlanData[] {
  return ALL_INTERNAL_PLANS.map((plan) => pricingPlanData(plan, interval));
}

// ---------------------------------------------------------------------------
// Checkout request contract
// ---------------------------------------------------------------------------

/** Everything the browser may contribute to a checkout request. */
export interface CheckoutRequest {
  /** Plan slug or internal plan name — never a price, never an amount. */
  plan: string;
  /** "month" | "year" | "monthly" | "annual". */
  interval: string;
}

export interface NormalizedCheckoutRequest {
  plan: InternalPlan;
  interval: BillingInterval;
  slug: string;
}

/**
 * Normalize + validate a checkout request locally (fast feedback only).
 *
 * The SERVER re-validates the same way; this helper exists so the UI can fail
 * early with a clear message instead of sending junk to the Edge Function.
 */
export function normalizeCheckoutRequest(
  request: CheckoutRequest,
): NormalizedCheckoutRequest | null {
  const plan = planForSlug(request.plan) ?? (ALL_INTERNAL_PLANS.includes(request.plan as InternalPlan) ? (request.plan as InternalPlan) : null);
  if (!plan) return null;
  const interval = intervalForInput(request.interval);
  if (!interval) return null;
  return { plan, interval, slug: PLAN_METADATA[plan].slug };
}

/** Build the return path Auth uses to send a buyer back to checkout. */
export function checkoutReturnTo(request: CheckoutRequest): string {
  const normalized = normalizeCheckoutRequest(request);
  const slug = normalized?.slug ?? "starter";
  const interval = normalized?.interval ?? "monthly";
  return `/checkout?plan=${encodeURIComponent(slug)}&interval=${encodeURIComponent(interval)}`;
}

export type CheckoutStartResult =
  | { ok: true; url: string; sessionId: string | null; plan: InternalPlan; interval: BillingInterval }
  | {
      ok: false;
      /** HTTP status from the Edge Function (0 = network failure). */
      status: number;
      message: string;
      /** True when the organization already has a subscription to manage. */
      alreadySubscribed: boolean;
    };

export interface StartCheckoutInput extends CheckoutRequest {
  /** Supabase access token of the signed-in user. */
  accessToken: string;
  /** Base URL of the Supabase project (…/functions/v1/billing-checkout). */
  functionsBaseUrl: string;
  /** Public anon key (sent as `apikey`, matching every other Edge call). */
  anonKey?: string;
  /** Organization the caller believes they are billing (server re-checks). */
  tenantId?: string | null;
  companyName?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function friendlyMessage(status: number, serverMessage: string | null): string {
  if (serverMessage) return serverMessage;
  if (status === 401 || status === 403) return "Your session expired. Please sign in again.";
  if (status === 404) return "The billing service isn't available yet. Please contact support.";
  if (status === 409) return "This organization already has an active subscription.";
  if (status === 422) return "The selected Atlas plan isn't available for billing yet.";
  if (status === 503) return "Billing is temporarily unavailable. Please try again shortly.";
  return "Could not start checkout. Please try again in a moment.";
}

/**
 * Start hosted checkout for the caller's organization (provider chosen
 * server-side).
 *
 * Sends plan + interval only. Returns the hosted URL to navigate to —
 * never a secret, never a subscription, never an entitlement.
 */
export async function startCheckout(input: StartCheckoutInput): Promise<CheckoutStartResult> {
  const normalized = normalizeCheckoutRequest(input);
  if (!normalized) {
    return {
      ok: false,
      status: 422,
      message: "That plan or billing interval is not available.",
      alreadySubscribed: false,
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const base = input.functionsBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
  };
  if (input.anonKey) headers.apikey = input.anonKey;

  const requestBody = JSON.stringify({
    plan: normalized.slug,
    interval: normalized.interval,
    tenantId: input.tenantId ?? undefined,
    companyName: input.companyName ?? undefined,
  });
  const postTo = (entry: string): Promise<Response> =>
    doFetch(`${base}/functions/v1/${entry}`, {
      method: "POST",
      headers,
      body: requestBody,
    });

  let response: Response;
  try {
    // Provider-neutral entry: the SERVER decides stripe vs paystack.
    response = await postTo("billing-checkout");
    if (response.status === 404) {
      // Deploy-order safety: billing-checkout is a new entry point. Until it
      // is deployed, retry the original stripe-checkout entry so the
      // production Stripe flow keeps working. This is NOT a provider choice:
      // stripe-checkout serves only the Stripe handler, and everything the
      // server validates (plan, interval, price, provider) is unchanged.
      try {
        response = await postTo("stripe-checkout");
      } catch {
        // Network failure on the fallback: keep the original 404 result.
      }
    }
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Checkout couldn't be started. Please check your connection and try again.",
      alreadySubscribed: false,
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: { url?: string; sessionId?: string } | null; error?: string | null }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: friendlyMessage(response.status, payload?.error ?? null),
      alreadySubscribed: response.status === 409,
    };
  }

  const url = payload?.data?.url;
  if (typeof url !== "string" || url === "") {
    return {
      ok: false,
      status: 502,
      message: "We couldn't open the payment window. Please try again.",
      alreadySubscribed: false,
    };
  }

  return {
    ok: true,
    url,
    sessionId: payload?.data?.sessionId ?? null,
    plan: normalized.plan,
    interval: normalized.interval,
  };
}

// ---------------------------------------------------------------------------
// Billing Portal (Manage Billing)
// ---------------------------------------------------------------------------

export interface OpenPortalInput {
  /** Supabase access token of the signed-in user. */
  accessToken: string;
  /** Base URL of the Supabase project. */
  functionsBaseUrl: string;
  /** Public anon key (sent as `apikey`). */
  anonKey?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask the server for a Stripe Billing Portal URL (Stripe subscriptions only —
 * Paystack self-service management is Phase 2).
 *
 * No customer id is sent — the server resolves it from Atlas storage after
 * re-authorizing the caller. The portal itself is Stripe's; Atlas never
 * performs cancellation or plan changes locally.
 */
export async function openBillingPortal(
  input: OpenPortalInput,
): Promise<{ ok: true; url: string } | { ok: false; status: number; message: string }> {
  const doFetch = input.fetchImpl ?? fetch;
  const base = input.functionsBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
  };
  if (input.anonKey) headers.apikey = input.anonKey;

  let response: Response;
  try {
    response = await doFetch(`${base}/functions/v1/stripe-customer-portal`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Billing management couldn't be opened. Please check your connection.",
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: { url?: string } | null; error?: string | null }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        payload?.error ??
        (response.status === 404
          ? "This organization doesn't have a billing profile yet."
          : response.status === 401 || response.status === 403
            ? "Your session expired, or you don't have permission to manage billing."
            : "Billing management is unavailable right now."),
    };
  }

  const url = payload?.data?.url;
  if (typeof url !== "string" || url === "") {
    return { ok: false, status: 502, message: "Billing management is unavailable right now." };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Billing-state helpers (read-only, server-authored)
// ---------------------------------------------------------------------------

/** True when the server-reported state grants paid access. */
export function isActiveBillingState(state: BillingState | null | undefined): boolean {
  return state?.isActive === true;
}
