// ---------------------------------------------------------------------------
// Atlas Billing — Paddle Webhook Processor
//
// A webhook event flows through:
//   1. raw HTTP body + signature header
//   2. signature verification (throws → 400/401)
//   3. idempotency check (did we already process this event?)
//   4. organization resolution (custom data → provider customer → provider
//      subscription, in that order)
//   5. state transition (create / update / cancel / fail / reactivate)
//   6. audit record + structured log
//
// Never trust the event without signature verification.
// Never process an event twice.
// Never grant paid access from a browser redirect.
//
// Paddle is the billing source of truth: the payload's subscription state is
// written straight into the Atlas subscription record. Atlas never computes
// trial expiration, renewal dates or charges on its own.
// ---------------------------------------------------------------------------

import { getActiveAdapter } from "./provider";
import type {
  BillingWebhookEvent,
  OrganizationSubscription,
  ProcessedWebhookEvent,
} from "./types";

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
 * In production this is wired to the Supabase tables (see
 * supabase/functions/paddle-webhook and the paddle billing migration). The
 * interface keeps the processor testable and provider-UI agnostic.
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

  /** Resolve an organization id from provider subscription id (best-effort). */
  resolveOrganizationIdFromProviderSubscription(
    provider_subscription_id: string,
  ): Promise<string | null>;
}

/**
 * Paddle Billing event types Atlas consumes.
 *
 * Only events Paddle actually emits are listed. `transaction.completed`
 * confirms the initial charge (including the $10 / 1-day trial) but the
 * subscription lifecycle events carry the state Atlas synchronizes;
 * transaction events are audited and otherwise informational.
 */
const SUBSCRIPTION_EVENT_TYPES = new Set([
  "subscription.created",
  "subscription.trialing",
  "subscription.activated",
  "subscription.updated",
  "subscription.resumed",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
]);

const TRANSACTION_EVENT_TYPES = new Set([
  "transaction.completed",
  "transaction.payment_failed",
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
 *   - resolves the owning organization
 *   - applies the lifecycle transition
 *   - persists the subscription + audit record
 */
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
    await storage.appendAuditEntry(
      event.organizationIdHint ?? null,
      {
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        result: "duplicate",
        note: `Duplicate webhook event; previously ${existingEvent.result}`,
      },
      event.providerEventAt ?? null,
    );
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
  if (
    !SUBSCRIPTION_EVENT_TYPES.has(event.eventType) &&
    !TRANSACTION_EVENT_TYPES.has(event.eventType)
  ) {
    await storage.appendAuditEntry(
      event.organizationIdHint ?? null,
      {
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        result: "ignored",
        note: "Unknown Paddle event type; safely ignored.",
      },
      event.providerEventAt ?? null,
    );
    await storage.saveWebhookEvent({
      provider_event_id: event.providerEventId,
      provider: "paddle",
      event_type: event.eventType,
      organization_id: event.organizationIdHint ?? null,
      provider_customer_id: event.providerCustomerId,
      provider_subscription_id: event.providerSubscriptionId,
      result: "ignored",
      provider_event_at: event.providerEventAt ?? null,
      processed_at: Date.now(),
    });
    return {
      accepted: true,
      changed: false,
      note: `Unknown event type ${event.eventType}; safely ignored.`,
      organizationId: event.organizationIdHint ?? null,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
    };
  }

  // Transaction events are informational for Atlas (Paddle creates the
  // subscription; the subscription.* events carry the state to sync). They
  // still get audited so payment failures are visible.
  if (TRANSACTION_EVENT_TYPES.has(event.eventType)) {
    await storage.appendAuditEntry(
      event.organizationIdHint ?? null,
      {
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        result: "informational",
        note: `Transaction event received; subscription state follows via subscription.* events.`,
      },
      event.providerEventAt ?? null,
    );
    await storage.saveWebhookEvent({
      provider_event_id: event.providerEventId,
      provider: "paddle",
      event_type: event.eventType,
      organization_id: event.organizationIdHint ?? null,
      provider_customer_id: event.providerCustomerId,
      provider_subscription_id: event.providerSubscriptionId,
      result: "ignored",
      provider_event_at: event.providerEventAt ?? null,
      processed_at: Date.now(),
    });
    return {
      accepted: true,
      changed: false,
      note: `Transaction event ${event.eventType} audited (no subscription state change).`,
      organizationId: event.organizationIdHint ?? null,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
    };
  }

  // ---- Organization resolution ----
  // Order of trust: (1) custom data written at checkout, (2) provider
  // customer id on an existing record, (3) provider subscription id on an
  // existing record. Custom data is only ever a *hint* — it does not grant
  // access; the subscription record is written from verified webhook state.
  let organizationId: string | null = event.organizationIdHint ?? null;

  if (!organizationId && event.providerCustomerId) {
    organizationId = await storage.resolveOrganizationIdFromProviderCustomer(
      event.providerCustomerId,
    );
  }

  if (!organizationId && event.providerSubscriptionId) {
    organizationId = await storage.resolveOrganizationIdFromProviderSubscription(
      event.providerSubscriptionId,
    );
  }

  if (!organizationId) {
    await storage.appendAuditEntry(null, {
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      result: "rejected",
      note: "Could not resolve the owning organization; event rejected.",
    }, event.providerEventAt ?? null);
    throw new Error(
      `Paddle webhook event ${event.eventType} could not be resolved to an organization. ` +
        "The checkout custom_data must carry atlas_organization_id.",
    );
  }

  // ---- Subscription state transition ----
  const existingSubscription = await storage.loadSubscription(organizationId);
  const adapter = getActiveAdapter();

  const providerSubscription = {
    id: event.providerSubscriptionId ?? existingSubscription?.provider_subscription_id ?? "",
    customerId: event.providerCustomerId ?? existingSubscription?.provider_customer_id ?? "",
    status: event.status,
    priceId: event.providerPriceId ?? existingSubscription?.provider_price_id ?? null,
    billingCycle: event.billingInterval ?? "monthly",
    trialStartDate: event.trialStart,
    trialEndDate: event.trialEnd,
    currentPeriodStart: event.currentPeriodStart,
    currentPeriodEnd: event.currentPeriodEnd,
    nextBilledAt: event.nextBilledAt,
    cancelAt: event.cancelAt,
    canceledAt: event.canceledAt,
  };

  const updatedSubscription = adapter.mapSubscriptionToRecord(
    event.providerCustomerId ?? existingSubscription?.provider_customer_id ?? "",
    providerSubscription,
    existingSubscription,
  );
  // The adapter does not know the Atlas organization id — attach it here.
  updatedSubscription.organization_id = organizationId;

  // Preserve plan/interval from the existing record when the event does not
  // carry them (e.g. status-only events).
  if (!updatedSubscription.internal_plan) {
    updatedSubscription.internal_plan =
      existingSubscription?.internal_plan ?? null;
  }
  if (!updatedSubscription.billing_interval) {
    updatedSubscription.billing_interval =
      existingSubscription?.billing_interval ?? null;
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
    existingSubscription.internal_plan !== updatedSubscription.internal_plan ||
    existingSubscription.billing_interval !== updatedSubscription.billing_interval;

  await storage.appendAuditEntry(organizationId, {
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    result: "processed",
    note: `Subscription state synchronized: ${updatedSubscription.status} | plan=${updatedSubscription.internal_plan ?? "none"} | interval=${updatedSubscription.billing_interval ?? "none"}`,
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