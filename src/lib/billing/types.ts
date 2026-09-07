// ---------------------------------------------------------------------------
// Atlas Billing — Provider-Agnostic Domain Types
//
// Atlas owns:
//   - organization/tenant identity
//   - internal plan model (ATLAS_STARTER / ATLAS_GROWTH / ATLAS_SCALE)
//   - entitlement resolution
//   - application authorization
//
// The billing provider (Paddle today, other providers later) owns:
//   - payment processing
//   - subscription lifecycle in the provider
//   - provider customer/subscription identifiers
//
// Application code should resolve billing state through the internal plan
// model and the organization's subscription record, never by trusting
// client-provided plan/status values.
// ---------------------------------------------------------------------------

/** Internal Atlas plans — single source of truth for application entitlement. */
export const INTERNAL_PLANS = {
  ATLAS_STARTER: "ATLAS_STARTER",
  ATLAS_GROWTH: "ATLAS_GROWTH",
  ATLAS_SCALE: "ATLAS_SCALE",
} as const;

export type InternalPlan = (typeof INTERNAL_PLANS)[keyof typeof INTERNAL_PLANS];

/** Billing provider identifiers. New providers extend this union. */
export const BILLING_PROVIDERS = {
  PADDLE: "paddle",
} as const;

export type BillingProvider = (typeof BILLING_PROVIDERS)[keyof typeof BILLING_PROVIDERS];

/**
 * Subscription statuses we synchronize from the provider.
 *
 * These mirror Paddle Billing subscription statuses (active, trialing,
 * past_due, paused, canceled) plus the Atlas "unknown" fallback. Atlas never
 * invents statuses the provider does not report.
 */
export const SUBSCRIPTION_STATUSES = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAUSED: "paused",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
} as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];

/** Billing period for a subscription. */
export type BillingInterval = "monthly" | "annual";

/**
 * A subscription record Atlas maintains for an organization.
 *
 * All timestamps are Unix milliseconds. The record is written exclusively by
 * the verified billing webhook; client code may only read it (through RLS /
 * the billing_get_state RPC).
 */
export interface OrganizationSubscription {
  /** FK to the owning organization. */
  organization_id: string;
  /** Billing provider (paddle today). */
  billing_provider: BillingProvider;
  /** Provider customer identifier (nullable until checkout succeeds). */
  provider_customer_id: string | null;
  /** Provider subscription identifier. */
  provider_subscription_id: string | null;
  /** Provider price identifier that produced this subscription. */
  provider_price_id: string | null;
  /** Internal Atlas plan mapped from the provider subscription. */
  internal_plan: InternalPlan | null;
  /** Billing interval mapped from the provider price (monthly/annual). */
  billing_interval: BillingInterval | null;
  /** Current subscription status (synchronized from provider). */
  status: SubscriptionStatus;
  /** Trial start (Unix ms), if applicable. */
  trial_start: number | null;
  /** Trial end (Unix ms), if applicable. */
  trial_end: number | null;
  /** Current billing period start (Unix ms, provider time). */
  current_period_start: number | null;
  /** Current billing period end (Unix ms, provider time). */
  current_period_end: number | null;
  /** When the next renewal is scheduled (Unix ms, provider time). */
  next_billed_at: number | null;
  /** When a cancellation was requested / will take effect (Unix ms). */
  cancel_at: number | null;
  /** When the subscription was canceled (Unix ms). */
  canceled_at: number | null;
  /** When this record was created (Unix ms). */
  created_at: number;
  /** When this record was last updated (Unix ms). */
  updated_at: number;
}

/** A processed webhook event (for idempotency tracking). */
export interface ProcessedWebhookEvent {
  /** Provider event identifier (Paddle event_id). */
  provider_event_id: string;
  /** Provider (paddle). */
  provider: BillingProvider;
  /** Event type (e.g. subscription.created). */
  event_type: string;
  /** Owning organization id Atlas determined from the event. */
  organization_id: string | null;
  /** Provider customer id referenced by the event. */
  provider_customer_id: string | null;
  /** Provider subscription id referenced by the event. */
  provider_subscription_id: string | null;
  /** Result of processing. */
  result: "processed" | "ignored" | "rejected" | "duplicate";
  /** When the provider emitted the event (Unix ms), if available. */
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
  /** Subscription status. */
  status: SubscriptionStatus;
  /** Billing provider. */
  provider: BillingProvider;
  /** Billing interval (monthly/annual), when known. */
  billingInterval: BillingInterval | null;
  /** Provider customer id. */
  providerCustomerId: string | null;
  /** Provider subscription id. */
  providerSubscriptionId: string | null;
  /** Trial start. */
  trialStart: number | null;
  /** Trial end. */
  trialEnd: number | null;
  /** Current period start. */
  currentPeriodStart: number | null;
  /** Current period end. */
  currentPeriodEnd: number | null;
  /** Next scheduled renewal. */
  nextBilledAt: number | null;
  /** Cancel-at timestamp. */
  cancelAt: number | null;
  /** Canceled-at timestamp. */
  canceledAt: number | null;
  /** Whether the organization can use paid features. */
  canUsePaidFeatures: boolean;
}

// ---------------------------------------------------------------------------
// Provider-agnostic webhook event surface (used by the webhook processor)
// ---------------------------------------------------------------------------

/** Provider-agnostic webhook event produced after signature verification. */
export interface BillingWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Provider price id carried by the event (null when unknown). */
  providerPriceId: string | null;
  /** Organization id embedded in provider custom data, if any. */
  organizationIdHint: string | null;
  internalPlan: InternalPlan | null;
  billingInterval: BillingInterval | null;
  active: boolean;
  status: SubscriptionStatus;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  nextBilledAt: number | null;
  cancelAt: number | null;
  canceledAt: number | null;
  trialStart: number | null;
  trialEnd: number | null;
  providerEventAt?: number | null;
}