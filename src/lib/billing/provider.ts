// ---------------------------------------------------------------------------
// Atlas Billing — Provider-Agnostic Domain Model
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

/** Subscription statuses we synchronize from the provider. */
export const SUBSCRIPTION_STATUSES = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAUSED: "paused",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
  UNKNOWN: "unknown",
} as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];

/** Billing period for a subscription. */
export type BillingInterval = "monthly" | "annual";

/** A subscription record Atlas maintains for an organization. */
export interface OrganizationSubscription {
  /** FK to the owning organization. */
  organization_id: string;
  /** Billing provider (paddle today). */
  billing_provider: BillingProvider;
  /** Provider customer identifier (nullable until checkout succeeds). */
  provider_customer_id: string | null;
  /** Provider subscription identifier. */
  provider_subscription_id: string | null;
  /** Internal Atlas plan mapped from the provider subscription. */
  internal_plan: InternalPlan | null;
  /** Provider price identifier that produced this subscription. */
  provider_price_id: string | null;
  /** Current subscription status (synchronized from provider). */
  status: SubscriptionStatus;
  /** Current billing period start (Unix ms, provider time). */
  current_period_start: number | null;
  /** Current billing period end (Unix ms, provider time). */
  current_period_end: number | null;
  /** When a cancellation was requested (Unix ms). */
  cancel_at: number | null;
  /** When the subscription was canceled (Unix ms). */
  canceled_at: number | null;
  /** Trial start (Unix ms), if applicable. */
  trial_start: number | null;
  /** Trial end (Unix ms), if applicable. */
  trial_end: number | null;
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

/** What the billing subsystem exposes to the rest of Atlas. */
export interface BillingState {
  /** True when the organization has an active paid or trialing subscription. */
  isActive: boolean;
  /** Current internal plan (null when no subscription / free). */
  plan: InternalPlan | null;
  /** Subscription status. */
  status: SubscriptionStatus;
  /** Billing provider. */
  provider: BillingProvider;
  /** Provider customer id. */
  providerCustomerId: string | null;
  /** Provider subscription id. */
  providerSubscriptionId: string | null;
  /** Current period start. */
  currentPeriodStart: number | null;
  /** Current period end. */
  currentPeriodEnd: number | null;
  /** Cancel-at timestamp. */
  cancelAt: number | null;
  /** Canceled-at timestamp. */
  canceledAt: number | null;
  /** Whether the organization can use paid features. */
  canUsePaidFeatures: boolean;
}

import type { BillingWebhookEvent } from "./types";

// ---------------------------------------------------------------------------
// Provider adapter contract
// ---------------------------------------------------------------------------

/**
 * Every billing provider implements this interface. The application never
 * calls provider-specific SDKs directly — it goes through this abstraction.
 */
export interface BillingProviderAdapter {
  /** Provider identifier (paddle, later stripe, etc.). */
  readonly name: BillingProvider;

  /** Validate that the provider is configured. Throws when not. */
  init(): void;

  /** Whether this adapter can currently build a checkout URL. */
  canBuildCheckout(): boolean;

  /** Build a checkout URL for an organization + plan + interval. */
  buildCheckoutUrl(
    organizationId: string,
    internalPlan: InternalPlan,
    interval: "monthly" | "annual",
    metadata: Record<string, string>,
  ): string;

  /**
   * Verify a provider webhook signature.
   *
   * Throws when verification fails. Returns the parsed payload when valid.
   *
   * The `now` parameter is optional so tests can pin clock-dependent checks
   * without waiting for real time to pass.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
    now?: number,
  ): Record<string, unknown>;

  /** Parse a verified webhook payload into the provider-agnostic event model. */
  parseWebhookEvent(payload: Record<string, unknown>): BillingWebhookEvent;

  /** Fetch the latest provider subscription for a customer + subscription id. */
  fetchSubscription(
    providerCustomerId: string,
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null>;

  /**
   * Build an OrganizationSubscription row from a provider subscription.
   *
   * The `existing` row is used to preserve fields we do not want to lose,
   * e.g. created_at when we are only updating status/plan.
   */
  mapSubscriptionToRecord(
    providerCustomerId: string,
    providerSubscription: ProviderSubscription,
    existing: OrganizationSubscription | null,
  ): OrganizationSubscription;
}

// ---------------------------------------------------------------------------
// Provider subscription shape (from provider API)
// ---------------------------------------------------------------------------

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: string;
  planId?: string | null;
  priceId?: string | null;
  billingCycle: "monthly" | "annual" | string;
  trialStartDate?: number | null;
  trialEndDate?: number | null;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  cancelAt?: number | null;
  canceledAt?: number | null;
  amount?: number | null;
  currency?: string | null;
}

// ---------------------------------------------------------------------------
// Default adapter registry
// ---------------------------------------------------------------------------

/** Currently configured provider adapter (or null when none). */
let activeAdapter: BillingProviderAdapter | null = null;

/** Set the active provider adapter. Called once at server startup. */
export function setActiveAdapter(adapter: BillingProviderAdapter): void {
  activeAdapter = adapter;
}

/** The active provider adapter (throws when not configured). */
export function hasActiveAdapter(): boolean {
  return activeAdapter !== null;
}

export function getActiveAdapter(): BillingProviderAdapter {
  if (!activeAdapter) {
    throw new Error(
      "Billing provider is not configured. No BillingProviderAdapter has been registered.",
    );
  }
  return activeAdapter;
}

/** True when a billing provider is configured. */
export function isBillingProviderConfigured(): boolean {
  return activeAdapter != null;
}

// ---------------------------------------------------------------------------
// Billing state resolution (server-side)
// ---------------------------------------------------------------------------

/**
 * Resolve the billing state for an organization.
 *
 * Atlas owns the authorization decision: this is called server-side with an
 * organization id the caller is authorized to inspect.
 */
export function resolveBillingState(
  subscription: OrganizationSubscription | null,
): BillingState {
  const isActive =
    subscription != null &&
    (subscription.status === "active" || subscription.status === "trialing");

  return {
    isActive,
    plan: subscription?.internal_plan ?? null,
    status: subscription?.status ?? "unknown",
    provider: subscription?.billing_provider ?? "paddle",
    providerCustomerId: subscription?.provider_customer_id ?? null,
    providerSubscriptionId: subscription?.provider_subscription_id ?? null,
    currentPeriodStart: subscription?.current_period_start ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAt: subscription?.cancel_at ?? null,
    canceledAt: subscription?.canceled_at ?? null,
    canUsePaidFeatures: isActive,
  };
}

