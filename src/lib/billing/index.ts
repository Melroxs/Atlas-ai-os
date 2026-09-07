// ---------------------------------------------------------------------------
// Atlas Billing — public barrel
//
// Consumers import from here rather than drilling into provider-specific
// files. Today that means Paddle, but the surface is provider-agnostic.
// ---------------------------------------------------------------------------

export { PADDLE_ADAPTER, paddleAdapterInit, canBuildPaddleCheckout } from "./paddle";
export {
  BillingProviderAdapter,
  BillingWebhookEvent,
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
  BILLING_PROVIDERS,
  INTERNAL_PLANS,
  SUBSCRIPTION_STATUSES,
} from "./types";
