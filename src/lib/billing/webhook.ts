// ---------------------------------------------------------------------------
// Atlas Billing — Paddle Webhook Processor
//
// A webhook event flows through:
//   1. raw HTTP body + signature header
//   2. signature verification (throws → 400/401)
//   3. idempotency check (did we already process this event?)
//   4. organization resolution (from custom data or provider lookup)
//   5. state transition (create / update / cancel / fail / reactivate)
//   6. audit record + structured log
//
// Never trust the event without signature verification.
// Never process an event twice.
// Never grant paid access from a browser redirect.
// ---------------------------------------------------------------------------

import { getActiveAdapter } from "./provider";
import type { BillingWebhookEvent, OrganizationSubscription, ProcessedWebhookEvent, SubscriptionStatus } from "./types";
import type { InternalPlan } from "./types";

// ---------------------------------------------------------------------------
// Webhook processing service
// ---------------------------------------------------------------------------

export interface WebhookProcessingResult {
  /** The webhook was verified and processed (includes duplicates). */
  accepted: boolean;
  /** Whether this event caused an actual state change. */
  changed: boolean;
  /** Human-readable note for observability. */
  note: string;
  /** The resolved organization id (null when unresolved). */
  organizationId: string | null;
  /** The provider event id. */
  providerEventId: string;
  /** The provider event type. */
  eventType: string;
  /** The provider customer id. */
  providerCustomerId: string | null;
  /** The provider subscription id. */
  providerSubscriptionId: string | null;
}

/**
 * Access the persistence layer for subscriptions / webhook events.
 *
 * In production this is wired to the Supabase RPC / table layer. For now we
 * define the interface so the webhook processor is testable and provider-UI
 * agnostic. The actual storage calls are filled in against the existing
 * tenants / subscription table / webhook events table when the migration
 * lands.
 */
export interface BillingStorage {
  /** Load the current subscription record for an organization. */
  loadSubscription(organizationId: string): Promise<OrganizationSubscription | null>;

  /** Upsert the subscription record for an organization. */
  saveSubscription(record: OrganizationSubscription): Promise<void>;

  /** Load a processed webhook event by provider event id. */
  loadWebhookEvent(providerEventId: string): Promise<ProcessedWebhookEvent | null>;

  /** Persist a processed webhook event (idempotency record). */
  saveWebhookEvent(record: ProcessedWebhookEvent): Promise<void>;

  /** Write a structured billing audit entry. */
  appendAuditEntry(
    organizationId: string | null,
    event: {
      providerEventId: string;
      eventType: string;
      providerCustomerId: string | null;
      providerSubscriptionId: string | null;
      result: string;
      note: string;
    },
    providerEventAt?: number | null,
  ): Promise<void>;

  /** Resolve an organization id from provider customer id (best-effort). */
  resolveOrganizationIdFromProviderCustomer(
    provider_customer_id: string,
  ): Promise<string | null>;
}

/** Map provider event types to allowed transitions. */
const ALLOWED_EVENT_TYPES = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "subscription.paused",
  "subscription.unpaused",
  "subscription.failed",
  "subscription.reactivated",
  "transaction.completed",
  "transaction.paid",
  "payment.method.updated",
  "customer.created",
  "customer.updated",
]);

/**
 * Process a verified Paddle webhook event.
 *
 * The caller is responsible for:
 *   - having verified the signature
 *   - providing a storage layer the webhook is authorized to write to
 *
 * The processor:
 *   - rejects unknown event types with an "ignored" result
 *   - deduplicates by provider event id
//   - resolves the owning organization
//   - applies the lifecycle transition
//   - persists the subscription + audit record
// ---------------------------------------------------------------------------

export async function processPaddleWebhook(
  storage: BillingStorage,
  verifiedPayload: Record<string, unknown>,
  provider: "paddle",
): Promise<WebhookProcessingResult> {

  let event: BillingWebhookEvent;

  try {
    event = getActiveAdapter().parseWebhookEvent(verifiedPayload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse Paddle webhook event: ${msg}`);
  }

  // ---- Idempotency ----
  const existingEvent = await storage.loadWebhookEvent(event.providerEventId);
  if (existingEvent) {
    await storage.appendAuditEntry(event.providerCustomerId ?? null, {
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      result: "duplicate",
      note: `Duplicate webhook event; previously ${existingEvent.result}`,
    }, event.providerEventAt ?? null);
    return {
      accepted: true,
      changed: false,
      note: "Duplicate webhook event; ignored.",
      organizationId: existingEvent.organization_id ?? null,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
    };
  }

  // ---- Unknown events ----
  if (!ALLOWED_EVENT_TYPES.has(event.eventType)) {
    await storage.appendAuditEntry(event.providerCustomerId ?? null, {
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      result: "ignored",
      note: `Unknown Paddle event type; safely ignored.`,
    }, event.providerEventAt ?? null);
    return {
      accepted: true,
      changed: false,
      note: `Unknown event type ${event.eventType}; safely ignored.`,
      organizationId: event.providerCustomerId,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
    };
  }

  // ---- Organization resolution ----
  let organizationId: string | null = null;

  if (event.providerCustomerId) {
    organizationId =
      (await storage.resolveOrganizationIdFromProviderCustomer(
        event.providerCustomerId,
      )) ??
      null;
  }

  if (!organizationId && event.providerSubscriptionId) {
    // Fallback: try the subscription record we already have.
    const existing = await storage.loadSubscription(
      // We cannot load by org without id; so in this path we only update
      // records that are already linked. A brand-new subscription from a
      // checkout flow should carry customData with the org id, which the
      // adapter exposed via BillingWebhookEvent still needs to be mapped
      // through the adapter's custom data extraction.
      "",
    );
    if (existing) {
      organizationId = existing.organization_id;
    }
  }

  if (!organizationId) {
    await storage.appendAuditEntry(event.providerCustomerId ?? null, {
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      result: "rejected",
      note: "Could not resolve the owning organization; event rejected.",
    }, event.providerEventAt ?? null);
    throw new Error(
      `Paddle webhook event ${event.eventType} could not be resolved to an organization. ` +
        "The checkout customData must carry atlas.organization_id.",
    );
  }

  // ---- Subscription state transition ----
  const existingSubscription = await storage.loadSubscription(organizationId);
  const adapter = getActiveAdapter();

  let updatedSubscription: OrganizationSubscription;

  if (event.eventType === "subscription.created") {
    if (existingSubscription) {
      // Idempotent create: if we already have a subscription for this org,
      // treat the incoming subscription as the source of truth.
    }
    updatedSubscription = adapter.mapSubscriptionToRecord(
      event.providerCustomerId ?? "",
      {
        id: event.providerSubscriptionId ?? "",
        customerId: event.providerCustomerId ?? "",
        status: event.status,
        planId: event.internalPlan ?? undefined,
        priceId: event.providerSubscriptionId ?? undefined,
        billingCycle: "monthly",
        trialStartDate: event.trialStart,
        trialEndDate: event.trialEnd,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAt: event.cancelAt,
        canceledAt: event.canceledAt,
      },
      existingSubscription,
    );
  } else {
    updatedSubscription = adapter.mapSubscriptionToRecord(
      event.providerCustomerId ?? "",
      {
        id: event.providerSubscriptionId ?? "",
        customerId: event.providerCustomerId ?? "",
        status: event.status,
        planId: event.internalPlan ?? undefined,
        priceId: event.providerSubscriptionId ?? undefined,
        billingCycle: "monthly",
        trialStartDate: event.trialStart,
        trialEndDate: event.trialEnd,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAt: event.cancelAt,
        canceledAt: event.canceledAt,
      },
      existingSubscription,
    );
  }

  await storage.saveSubscription(updatedSubscription);
  await storage.saveWebhookEvent({
    provider_event_id: event.providerEventId,
    provider: "paddle",
    event_type: event.eventType,
    organization_id: organizationId,
    provider_customer_id: event.providerCustomerId,
    provider_subscription_id: event.providerSubscriptionId,
    result: "processed",
    provider_event_at: event.providerEventAt ?? null,
    processed_at: Date.now(),
  });

  const changed =
    !existingSubscription ||
    existingSubscription.status !== updatedSubscription.status ||
    existingSubscription.internal_plan !== updatedSubscription.internal_plan;

  await storage.appendAuditEntry(organizationId, {
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    result: "processed",
    note: `Subscription state synchronized: ${updatedSubscription.status} | plan=${updatedSubscription.internal_plan ?? "none"}`,
  }, event.providerEventAt ?? null);

  return {
    accepted: true,
    changed,
    note: `Processed ${event.eventType} for ${organizationId}.`,
    organizationId,
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
  };
}

// ---------------------------------------------------------------------------
// Webhook entry point wire-up (server-side)
// ---------------------------------------------------------------------------

/**
 * Handle an incoming Paddle webhook request.
 *
 * This is the shape a server entry point (Edge Function / Express route / RPC
 * handler) would call after reading the raw body and signature header.
 */
export async function handlePaddleWebhook(
  storage: BillingStorage,
  rawBody: string,
  signatureHeader: string | null,
): Promise<WebhookProcessingResult> {
  const adapter = getActiveAdapter();

  const verifiedPayload = adapter.verifyWebhookSignature(
    rawBody,
    signatureHeader,
  );

  return processPaddleWebhook(storage, verifiedPayload, "paddle");
}
