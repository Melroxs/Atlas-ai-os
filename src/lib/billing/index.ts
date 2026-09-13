// ---------------------------------------------------------------------------
// Atlas Billing — public barrel (browser-safe)
//
// Consumers import from here rather than drilling into provider-specific
// files. Today that means Paddle, but the surface is provider-agnostic.
//
// NOTE: this barrel is imported by browser pages and therefore must stay
// browser-safe. The Paddle adapter (./paddle) is server-side only — it uses
// Node's crypto for webhook signature verification and reads PADDLE_* secrets
// from process.env. Server entry points (edge functions / workers / scripts)
// must import { PADDLE_ADAPTER, paddleAdapterInit, canBuildPaddleCheckout }
// directly from "@/lib/billing/paddle" instead of this barrel.
// ---------------------------------------------------------------------------

export {
  BillingProviderAdapter,
  ProviderSubscription,
  setActiveAdapter,
  hasActiveAdapter,
  getActiveAdapter,
  isBillingProviderConfigured,
  resolveBillingState,
} from "./provider";
export {
  InternalPlan,
  BillingProvider,
  SubscriptionStatus,
  BillingInterval,
  OrganizationSubscription,
  ProcessedWebhookEvent,
  BillingState,
  BillingWebhookEvent,
  BILLING_PROVIDERS,
  INTERNAL_PLANS,
  SUBSCRIPTION_STATUSES,
} from "./types";
