// ---------------------------------------------------------------------------
// Atlas Billing — Provider-Agnostic Domain Types (Stripe)
//
// Atlas owns:
//   - organization/tenant identity
//   - internal plan model (ATLAS_STARTER / ATLAS_GROWTH / ATLAS_SCALE)
//   - entitlement resolution
//   - application authorization
//
// Stripe owns:
//   - payment processing
//   - subscription lifecycle in Stripe
//   - Stripe customer / subscription / price / invoice identifiers
//
// Application code resolves billing state through the internal plan model and
// the organization's stored subscription record — never by trusting any
// client-provided plan, price, amount, status or "payment succeeded" signal.
//
// The subscription record is written EXCLUSIVELY by the verified
// `stripe-webhook` Edge Function (service role). Clients can only read it
// through the `billing_get_state` RPC.
// ---------------------------------------------------------------------------

/** Internal Atlas plans — single source of truth for application entitlement. */
export const INTERNAL_PLANS = {
  ATLAS_STARTER: "ATLAS_STARTER",
  ATLAS_GROWTH: "ATLAS_GROWTH",
  ATLAS_SCALE: "ATLAS_SCALE",
} as const;

export type InternalPlan = (typeof INTERNAL_PLANS)[keyof typeof INTERNAL_PLANS];

/** Billing provider identifiers. Stripe is the sole paid provider. */
export const BILLING_PROVIDERS = {
  STRIPE: "stripe",
} as const;

export type BillingProvider = (typeof BILLING_PROVIDERS)[keyof typeof BILLING_PROVIDERS];

/**
 * Stripe subscription statuses Atlas synchronizes.
 *
 * These mirror Stripe's documented lifecycle exactly — Atlas never invents a
 * status Stripe does not report. `unknown` is the defensive fallback.
 */
export const SUBSCRIPTION_STATUSES = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAST_DUE: "past_due",
  UNPAID: "unpaid",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
  PAUSED: "paused",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
} as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];

/** Invoice / payment state — displayed and audited, never a standalone grant. */
export type PaymentStatus = "paid" | "pending" | "failed" | "requires_action" | "unknown";

/** Billing period for a subscription. */
export type BillingInterval = "monthly" | "annual";

/**
 * The canonical Atlas entitlement state — the value written to
 * `tenants.billing_state` and enforced by the access gate.
 */
export type AtlasBillingState =
  | "pending_checkout"
  | "active"
  | "past_due"
  | "payment_failed"
  | "cancelled"
  | "suspended";

/**
 * A subscription record Atlas maintains for an organization.
 *
 * All timestamps are Unix milliseconds (Stripe reports seconds — the webhook
 * converts once, at the boundary). Written only by the verified Stripe
 * webhook; client code may only read it (through RLS / billing_get_state).
 */
export interface OrganizationSubscription {
  /** FK to the owning organization (the billing entity in Atlas). */
  organization_id: string;
  /** Billing provider — `stripe`. */
  billing_provider: BillingProvider;
  /** Stripe customer id (nullable until checkout creates one). */
  provider_customer_id: string | null;
  /** Stripe subscription id. */
  provider_subscription_id: string | null;
  /** Stripe price id that produced this subscription. */
  provider_price_id: string | null;
  /** Internal Atlas plan mapped from the Stripe price. */
  internal_plan: InternalPlan | null;
  /** Billing interval mapped from the Stripe price (monthly/annual). */
  billing_interval: BillingInterval | null;
  /** Current Stripe subscription status. */
  status: SubscriptionStatus;
  /** Latest payment state (invoice-derived). */
  payment_status: PaymentStatus;
  /**
   * Trial start (Unix ms). Atlas never creates a trial, so this is populated
   * only for a subscription created outside Atlas that Stripe reports as
   * `trialing`.
   */
  trial_start: number | null;
  /** Trial end (Unix ms) — same defensive case as trial_start. */
  trial_end: number | null;
  /** Current billing period start (Unix ms, Stripe time). */
  current_period_start: number | null;
  /** Current billing period end (Unix ms, Stripe time). */
  current_period_end: number | null;
  /** Next scheduled renewal (Unix ms); null when cancelling at period end. */
  next_billed_at: number | null;
  /** When a scheduled cancellation takes effect (Unix ms). */
  cancel_at: number | null;
  /** True when the subscription ends at the current period end. */
  cancel_at_period_end: boolean;
  /** When the subscription was canceled (Unix ms). */
  canceled_at: number | null;
  /** Latest invoice id Stripe reported. */
  latest_invoice_id: string | null;
  /**
   * Stripe event timestamp (Unix ms) of the last SUBSCRIPTION-state event
   * applied. Used to reject out-of-order webhook deliveries: an older
   * subscription event must never overwrite newer subscription state.
   */
  provider_event_at: number | null;
  /**
   * Stripe event timestamp (Unix ms) of the last INVOICE event applied.
   * Kept separate from provider_event_at so the invoice and subscription
   * lifecycles can never wedge each other into ignoring real updates.
   */
  latest_invoice_at: number | null;
  /** When this record was created (Unix ms). */
  created_at: number;
  /** When this record was last updated (Unix ms). */
  updated_at: number;
}

/** A processed webhook event (durable idempotency ledger). */
export interface ProcessedWebhookEvent {
  /** Stripe event id (`evt_...`). */
  provider_event_id: string;
  /** Provider (stripe). */
  provider: BillingProvider;
  /** Event type (e.g. customer.subscription.updated). */
  event_type: string;
  /** Owning organization Atlas determined from the event. */
  organization_id: string | null;
  /** Stripe customer id referenced by the event. */
  provider_customer_id: string | null;
  /** Stripe subscription id referenced by the event. */
  provider_subscription_id: string | null;
  /** Result of processing. */
  result: "processed" | "ignored" | "rejected" | "duplicate";
  /** When Stripe emitted the event (Unix ms), if available. */
  provider_event_at: number | null;
  /** When Atlas processed the event (Unix ms). */
  processed_at: number;
}

/**
 * What the billing subsystem exposes to the rest of Atlas.
 *
 * Resolved server-side from the organization subscription record; the browser
 * never supplies plan/status values.
 */
export interface BillingState {
  /** True when the organization has an active paid or trialing subscription. */
  isActive: boolean;
  /** Current internal plan (null when no subscription / free). */
  plan: InternalPlan | null;
  /** Stripe subscription status. */
  status: SubscriptionStatus;
  /** Billing provider (stripe). */
  provider: BillingProvider;
  /** Billing interval (monthly/annual), when known. */
  billingInterval: BillingInterval | null;
  /** Stripe customer id. */
  providerCustomerId: string | null;
  /** Stripe subscription id. */
  providerSubscriptionId: string | null;
  /** Stripe price id. */
  providerPriceId: string | null;
  /** Latest payment state. */
  paymentStatus: PaymentStatus;
  /** Trial start. */
  trialStart: number | null;
  /** Trial end. */
  trialEnd: number | null;
  /** Current period start. */
  currentPeriodStart: number | null;
  /** Current period end. */
  currentPeriodEnd: number | null;
  /** Next scheduled renewal (null when cancelling at period end). */
  nextBilledAt: number | null;
  /** Cancel-at timestamp. */
  cancelAt: number | null;
  /** True when the subscription ends at the current period end. */
  cancelAtPeriodEnd: boolean;
  /** Canceled-at timestamp. */
  canceledAt: number | null;
  /** Whether the organization can use paid features. */
  canUsePaidFeatures: boolean;
  /**
   * Which path granted effective access (display only — the authorization
   * decision comes from `tenants.billing_state` via evaluateAtlasAccess).
   */
  accessSource: "stripe" | "complimentary" | null;
}
