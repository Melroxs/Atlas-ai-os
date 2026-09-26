// ---------------------------------------------------------------------------
// Atlas Billing — public barrel (browser-safe)
//
// Consumers import from here rather than drilling into individual modules.
//
// NOTE: this barrel is imported by browser pages and must stay browser-safe.
// The Stripe provider implementation is server-only (Deno Edge Functions):
//   supabase/functions/_shared/stripe.ts
//   supabase/functions/_shared/stripe-webhook.ts
//   supabase/functions/stripe-checkout | stripe-webhook | stripe-customer-portal
// Those read STRIPE_* secrets from the environment and must never be imported
// into the client bundle.
// ---------------------------------------------------------------------------

export {
  resolveBillingState,
  hasManageableSubscription,
} from "./provider";
export {
  BILLING_PROVIDERS,
  INTERNAL_PLANS,
  SUBSCRIPTION_STATUSES,
} from "./types";
export type {
  AtlasBillingState,
  BillingInterval,
  BillingProvider,
  BillingState,
  InternalPlan,
  OrganizationSubscription,
  PaymentStatus,
  ProcessedWebhookEvent,
  SubscriptionStatus,
} from "./types";
export {
  ALL_INTERNAL_PLANS,
  INTERNAL_PLAN_SLUGS,
  PLAN_ENTITLEMENTS,
  PLAN_METADATA,
  billingIntervalForStripePriceId,
  configuredStripePrices,
  intervalForInput,
  internalPlanForStripePriceId,
  planAndIntervalForStripePriceId,
  planFeatureLines,
  planForSlug,
  planSlug,
  purchasablePlans,
  resolvePlanEntitlements,
  stripePriceEnvKey,
  stripePriceId,
} from "./plans";
export {
  allPricingPlans,
  checkoutReturnTo,
  isActiveBillingState,
  normalizeCheckoutRequest,
  pricingPlanData,
  startCheckout,
} from "./checkout";
export type {
  CheckoutRequest,
  CheckoutStartResult,
  NormalizedCheckoutRequest,
  PricingPlanData,
  StartCheckoutInput,
} from "./checkout";
export type { PlanEntitlements } from "./plans";
