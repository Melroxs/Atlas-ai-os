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
//
// Domain types live in ./types (single source of truth); this module adds the
// provider adapter contract, the adapter registry, and the billing-state
// resolver on top of them.
// ---------------------------------------------------------------------------

import type {
  BillingInterval,
  BillingProvider,
  BillingState,
  InternalPlan,
  OrganizationSubscription,
  SubscriptionStatus,
} from "./types";
import type { BillingWebhookEvent } from "./types";

// ---------------------------------------------------------------------------
// Provider subscription shape (from provider API)
// ---------------------------------------------------------------------------

/**
 * A subscription as reported by the provider (Paddle Billing v1 shape
 * normalized to camelCase). Timestamps are Unix ms when present.
 */
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
  nextBilledAt?: number | null;
  cancelAt?: number | null;
  canceledAt?: number | null;
  amount?: number | null;
  currency?: string | null;
}

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
  ): Promise<string>;

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
 *
 * Access semantics:
 *   - active / trialing → paid access (a Paddle trial is paid: the $10 charge
 *     is collected up front, so trialing grants the same entitlements).
 *   - past_due → NOT active here; the application access gate treats
 *     past_due as a short grace period (customer already paid) while billing
 *     state is still resolved from the provider.
 *   - paused / canceled / unknown → no paid access.
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
    billingInterval: subscription?.billing_interval ?? null,
    providerCustomerId: subscription?.provider_customer_id ?? null,
    providerSubscriptionId: subscription?.provider_subscription_id ?? null,
    trialStart: subscription?.trial_start ?? null,
    trialEnd: subscription?.trial_end ?? null,
    currentPeriodStart: subscription?.current_period_start ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    nextBilledAt: subscription?.next_billed_at ?? null,
    cancelAt: subscription?.cancel_at ?? null,
    canceledAt: subscription?.canceled_at ?? null,
    canUsePaidFeatures: isActive,
  };
}

export type { BillingInterval, BillingProvider, BillingState, InternalPlan, OrganizationSubscription, SubscriptionStatus };