// ---------------------------------------------------------------------------
// Atlas Billing — Billing State Resolution (Stripe)
//
// Stripe is the sole paid billing provider. The provider-side implementation
// (REST calls, webhook signature verification, event processing) is
// server-only and lives in:
//
//   supabase/functions/_shared/stripe.ts          — Stripe API + signature
//   supabase/functions/_shared/stripe-webhook.ts  — entitlement reconciliation
//   supabase/functions/stripe-checkout            — Checkout Session
//   supabase/functions/stripe-webhook             — durable event processing
//   supabase/functions/stripe-customer-portal     — Billing Portal
//
// This module is the browser-safe half: it turns a STORED subscription record
// (written by the verified webhook, read through billing_get_state) into the
// BillingState the UI renders. It never contacts Stripe and never decides
// authorization — that is evaluateAtlasAccess over the server-computed
// `tenants.billing_state`.
// ---------------------------------------------------------------------------

import type {
  BillingInterval,
  BillingProvider,
  BillingState,
  InternalPlan,
  OrganizationSubscription,
  PaymentStatus,
  SubscriptionStatus,
} from "./types";

/**
 * Resolve the billing state for an organization from its stored record.
 *
 * Access semantics (the authorization decision itself is the access gate's):
 *   - active / trialing          → paid access
 *   - past_due                   → grace period (Stripe is still retrying);
 *                                  `tenants.billing_state` carries the same
 *                                  grace semantics
 *   - unpaid / incomplete        → no paid access (dunning exhausted / never
 *                                  completed) — surfaced as an inactive state
 *   - paused / canceled / unknown→ no paid access
 */
export function resolveBillingState(
  subscription: OrganizationSubscription | null,
): BillingState {
  const status: SubscriptionStatus = subscription?.status ?? "unknown";
  const paymentStatus: PaymentStatus = subscription?.payment_status ?? "unknown";
  const isActive = subscription != null && (status === "active" || status === "trialing");

  return {
    isActive,
    plan: subscription?.internal_plan ?? null,
    status,
    provider: subscription?.billing_provider ?? "stripe",
    billingInterval: subscription?.billing_interval ?? null,
    providerCustomerId: subscription?.provider_customer_id ?? null,
    providerSubscriptionId: subscription?.provider_subscription_id ?? null,
    providerPriceId: subscription?.provider_price_id ?? null,
    paymentStatus,
    trialStart: subscription?.trial_start ?? null,
    trialEnd: subscription?.trial_end ?? null,
    currentPeriodStart: subscription?.current_period_start ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    nextBilledAt: subscription?.next_billed_at ?? null,
    cancelAt: subscription?.cancel_at ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    canceledAt: subscription?.canceled_at ?? null,
    canUsePaidFeatures: isActive,
    // `accessSource` is computed server-side (billing_get_state) because only
    // the database can see complimentary grants.
    accessSource: isActive ? "stripe" : null,
  };
}

/**
 * Whether the caller should be shown billing-management affordances.
 *
 * Display only: the Stripe Billing Portal function re-authorizes the caller
 * server-side, and the customer id always comes from Atlas storage.
 */
export function hasManageableSubscription(
  state: Pick<BillingState, "providerSubscriptionId" | "status"> | null | undefined,
): boolean {
  if (!state?.providerSubscriptionId) return false;
  return ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(
    state.status,
  );
}

export type {
  BillingInterval,
  BillingProvider,
  BillingState,
  InternalPlan,
  OrganizationSubscription,
  PaymentStatus,
  SubscriptionStatus,
};
