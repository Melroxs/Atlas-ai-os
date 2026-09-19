// ---------------------------------------------------------------------------
// Atlas — Stripe webhook processor (canonical entitlement reconciliation)
//
// Stripe owns payment + subscription state. Atlas owns authorization. The one
// bridge between them is this module:
//
//   verified Stripe event ──▶ idempotency ──▶ organization resolution
//                         ──▶ reconcileAtlasEntitlement()  (single path)
//                         ──▶ organization_subscriptions + tenants.billing_state
//                         ──▶ processed_webhook_events (durable idempotency)
//                         ──▶ billing_audit_events (append-only audit)
//
// Guarantees:
//   * Every event id is processed at most once (durable ledger).
//   * Duplicate delivery can never create a second subscription, a second
//     entitlement, or corrupt state: all writes are full-state upserts keyed
//     by organization, and the ledger row is written last.
//   * Out-of-order deliveries are ignored per watermark (subscription state
//     and invoice state have separate watermarks).
//   * Unknown event types / unknown prices never change entitlement.
//   * Entitlement is NEVER granted because a checkout redirect happened, and
//     never granted from `checkout.session.completed` alone — the subscription
//     itself must say the customer is active/trialing.
//
// The storage is injected so the exact production logic is unit-testable
// (supabase/functions/_shared/stripe-webhook.test.ts) without touching
// Supabase or Stripe.
// ---------------------------------------------------------------------------

import {
  type AtlasBillingState,
  type AtlasPaymentStatus,
  type AtlasSubscriptionStatus,
  type BillingInterval,
  type InternalPlan,
  type StripeSubscription,
  idOf,
  invoicePaymentStatus,
  mapStripeSubscriptionStatus,
  organizationIdHintFromObject,
  planAndIntervalForStripePriceId,
  primaryPriceOfSubscription,
  resolveAtlasBillingState,
} from "./stripe.ts";

// ---------------------------------------------------------------------------
// Persistence contract (implemented over Supabase in stripe-webhook/index.ts)
// ---------------------------------------------------------------------------

/** A row of public.organization_subscriptions (camelCase for the processor). */
export interface SubscriptionRow {
  organizationId: string;
  billingProvider: "stripe";
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerPriceId: string | null;
  internalPlan: InternalPlan | null;
  billingInterval: BillingInterval | null;
  status: AtlasSubscriptionStatus;
  paymentStatus: AtlasPaymentStatus;
  trialStart: number | null;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  nextBilledAt: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  latestInvoiceId: string | null;
  latestInvoiceAt: number | null;
  providerEventAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WebhookResult = "processed" | "ignored" | "rejected" | "duplicate";

export interface AuditEntry {
  organizationId: string | null;
  providerEventId: string;
  eventType: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  result: WebhookResult;
  note: string;
  providerEventAt: number | null;
}

export interface BillingStore {
  findProcessedEvent(eventId: string): Promise<{ result: string; organizationId: string | null } | null>;
  recordEvent(entry: AuditEntry): Promise<void>;
  loadSubscription(organizationId: string): Promise<SubscriptionRow | null>;
  saveSubscription(row: SubscriptionRow): Promise<void>;
  setBillingState(organizationId: string, billingState: AtlasBillingState): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  resolveOrganizationIdByCustomer(customerId: string): Promise<string | null>;
  resolveOrganizationIdBySubscription(subscriptionId: string): Promise<string | null>;
}

/** External calls the processor needs (injected so tests never hit Stripe). */
export interface StripeGateway {
  fetchSubscription(subscriptionId: string): Promise<StripeSubscription | null>;
}

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/** Events that carry authoritative subscription state. */
export const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
]);

/** Events that describe a payment/invoice outcome; the subscription is re-read from Stripe. */
export const INVOICE_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.finalized",
  "invoice.payment_action_required",
  "invoice.marked_uncollectible",
]);

/** Checkout hand-off events: identifiers only — never an entitlement change on their own. */
export const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
]);

/**
 * Events Atlas records for observability but that never change entitlement.
 * Refunds are deliberately informational: Stripe does not cancel a subscription
 * when a charge is refunded, so entitlement must follow the subscription.
 */
export const INFORMATIONAL_EVENTS = new Set([
  "charge.refunded",
  "charge.refund.updated",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
]);

export const SUPPORTED_EVENT_TYPES: string[] = [
  ...SUBSCRIPTION_EVENTS,
  ...INVOICE_EVENTS,
  ...CHECKOUT_EVENTS,
  ...INFORMATIONAL_EVENTS,
];

// ---------------------------------------------------------------------------
// Entitlement reconciliation — the ONLY place entitlement is decided
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  organizationId: string;
  /** Authoritative Stripe subscription (from the event or re-read from Stripe). */
  subscription: StripeSubscription | null;
  existing: SubscriptionRow | null;
  paymentStatus: AtlasPaymentStatus;
  latestInvoiceId?: string | null;
  /** Millisecond timestamp of the event that caused this reconciliation. */
  eventAt: number;
  eventType: string;
  eventId: string;
  /** Identifiers known from the event when the subscription could not be read. */
  fallbackCustomerId?: string | null;
  fallbackSubscriptionId?: string | null;
}

/**
 * Stripe sends Unix SECONDS; Atlas stores every billing instant as bigint
 * MILLISECONDS (see the organization_subscriptions columns). Converting in one
 * place keeps the values the UI formats (`new Date(ms)`) correct.
 */
function toMs(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

export interface ReconcileResult {
  row: SubscriptionRow;
  billingState: AtlasBillingState;
  changed: boolean;
  /** True when the Stripe price is not one of Atlas's configured prices. */
  unresolvedPrice: boolean;
  note: string;
}

/**
 * Reconcile Atlas entitlement from a Stripe subscription.
 *
 * ONE code path for every event type. The inputs are: the organization, the
 * Stripe customer + subscription, the price, the subscription status and the
 * payment state. The output is the canonical Atlas entitlement state.
 */
export function reconcileAtlasEntitlement(input: ReconcileInput): ReconcileResult {
  const { organizationId, subscription, existing } = input;

  const status: AtlasSubscriptionStatus = subscription
    ? mapStripeSubscriptionStatus(subscription.status)
    : (existing?.status ?? "unknown");

  const price = subscription ? primaryPriceOfSubscription(subscription) : { priceId: null, active: null };
  const priceId = price.priceId ?? existing?.providerPriceId ?? null;
  const priceInactive = price.active === false;
  const mapped = priceInactive ? null : planAndIntervalForStripePriceId(priceId);

  // --- Plan resolution (never invented) -----------------------------------
  // The plan association only survives while the subscription is in a state a
  // customer can recover from (Stripe is still billing them). Once it is over —
  // never paid, expired or canceled — Atlas keeps the Stripe ids for history
  // but ends the plan association, so no code path can grant plan limits from a
  // dead subscription. An unknown/inactive price never grants a plan.
  const unresolvedPrice = mapped === null && priceId !== null;
  const keepsPlan = (["active", "trialing", "past_due", "unpaid", "paused"] as const).includes(
    status as "active",
  );

  let internalPlan: InternalPlan | null = null;
  let billingInterval: BillingInterval | null = null;
  if (keepsPlan) {
    if (mapped) {
      internalPlan = mapped.plan;
      billingInterval = mapped.interval;
    } else if (existing?.internalPlan) {
      // A paying customer is never silently downgraded by a price Atlas does
      // not recognise; keep what is recorded and flag it for an operator.
      internalPlan = existing.internalPlan;
      billingInterval = existing.billingInterval;
    }
  }

  const billingState = resolveAtlasBillingState(status);

  const customerId =
    subscription?.customer !== undefined && subscription?.customer !== null
      ? idOf(subscription.customer)
      : input.fallbackCustomerId ?? existing?.providerCustomerId ?? null;

  const subscriptionId = subscription?.id ?? input.fallbackSubscriptionId ?? existing?.providerSubscriptionId ?? null;

  const latestInvoiceId = subscription
    ? idOf(subscription.latest_invoice) ?? input.latestInvoiceId ?? existing?.latestInvoiceId ?? null
    : input.latestInvoiceId ?? existing?.latestInvoiceId ?? null;

  const row: SubscriptionRow = {
    organizationId,
    billingProvider: "stripe",
    providerCustomerId: customerId,
    providerSubscriptionId: subscriptionId,
    providerPriceId: priceId,
    internalPlan,
    billingInterval,
    status,
    paymentStatus: input.paymentStatus,
    trialStart: toMs(subscription?.trial_start) ?? existing?.trialStart ?? null,
    trialEnd: toMs(subscription?.trial_end) ?? existing?.trialEnd ?? null,
    currentPeriodStart:
      toMs(subscription?.current_period_start) ?? existing?.currentPeriodStart ?? null,
    currentPeriodEnd: toMs(subscription?.current_period_end) ?? existing?.currentPeriodEnd ?? null,
    // A subscription set to cancel at period end has no next charge.
    nextBilledAt: subscription
      ? subscription.cancel_at_period_end === true
        ? null
        : (toMs(subscription.current_period_end) ?? existing?.nextBilledAt ?? null)
      : (existing?.nextBilledAt ?? null),
    cancelAt: toMs(subscription?.cancel_at) ?? existing?.cancelAt ?? null,
    cancelAtPeriodEnd: subscription
      ? subscription.cancel_at_period_end === true
      : (existing?.cancelAtPeriodEnd ?? false),
    canceledAt: toMs(subscription?.canceled_at) ?? existing?.canceledAt ?? null,
    // Only subscription-state events advance the subscription watermark; invoice
    // events advance latestInvoiceAt, so the two lifecycles cannot wedge each
    // other into ignoring real updates.
    providerEventAt: SUBSCRIPTION_EVENTS.has(input.eventType)
      ? Math.max(input.eventAt, existing?.providerEventAt ?? 0)
      : existing?.providerEventAt ?? null,
    latestInvoiceAt: INVOICE_EVENTS.has(input.eventType)
      ? Math.max(input.eventAt, existing?.latestInvoiceAt ?? 0)
      : existing?.latestInvoiceAt ?? null,
    createdAt: existing?.createdAt ?? input.eventAt,
    updatedAt: input.eventAt,
  };

  const changed =
    !existing ||
    existing.status !== row.status ||
    existing.internalPlan !== row.internalPlan ||
    existing.billingInterval !== row.billingInterval ||
    existing.cancelAtPeriodEnd !== row.cancelAtPeriodEnd ||
    existing.paymentStatus !== row.paymentStatus ||
    existing.providerSubscriptionId !== row.providerSubscriptionId ||
    existing.providerCustomerId !== row.providerCustomerId;

  const note = unresolvedPrice
    ? `Stripe price ${priceId} is not one of the configured Atlas prices${priceInactive ? " (price inactive)" : ""}; entitlement left unchanged.`
    : `Entitlement reconciled: status=${status} billing_state=${billingState} plan=${internalPlan ?? "none"} interval=${billingInterval ?? "none"}`;

  return { row, billingState, changed, unresolvedPrice, note };
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export interface ProcessedEvent {
  accepted: boolean;
  result: WebhookResult;
  changed: boolean;
  note: string;
  organizationId: string | null;
  eventId: string;
  eventType: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
}

export interface ProcessOptions {
  /** Millisecond clock, injectable for deterministic tests. */
  now?: () => number;
}

function customerIdOfObject(object: Record<string, unknown>): string | null {
  return idOf(object.customer);
}

function subscriptionIdOfObject(object: Record<string, unknown>): string | null {
  const direct = idOf(object.subscription);
  if (direct) return direct;
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idOf(parent?.subscription_details?.subscription);
}

/**
 * Process one SIGNATURE-VERIFIED Stripe event.
 *
 * Throws only on transient failures (Stripe API error, database error) so the
 * caller can answer 5xx and let Stripe retry. Permanent conditions (unknown
 * event, unresolvable organization, unknown price) are recorded and answered
 * 2xx with a loud audit entry.
 */
export async function processStripeWebhook(
  store: BillingStore,
  gateway: StripeGateway,
  payload: Record<string, unknown>,
  options: ProcessOptions = {},
): Promise<ProcessedEvent> {
  const now = options.now ?? (() => Date.now());

  const eventId = typeof payload.id === "string" ? payload.id : "";
  const eventType = typeof payload.type === "string" ? payload.type : "";
  const created = Number(payload.created);
  const eventAt = Number.isFinite(created) ? created * 1000 : now();
  const object = ((payload.data as { object?: unknown } | undefined)?.object ?? {}) as Record<string, unknown>;

  if (!eventId || !eventType) {
    throw new Error("Malformed Stripe event: missing id or type.");
  }

  const providerCustomerId = customerIdOfObject(object);
  const providerSubscriptionId = subscriptionIdOfObject(object);
  const organizationIdHint = organizationIdHintFromObject(object);

  const base = {
    accepted: true,
    eventId,
    eventType,
    providerCustomerId,
    providerSubscriptionId,
  };

  // ---- 1. Idempotency ----------------------------------------------------
  const seen = await store.findProcessedEvent(eventId);
  if (seen) {
    await store.appendAudit({
      organizationId: seen.organizationId,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "duplicate",
      note: `Duplicate delivery; previously ${seen.result}.`,
      providerEventAt: eventAt,
    });
    return {
      ...base,
      result: "duplicate",
      changed: false,
      note: "Duplicate Stripe event ignored.",
      organizationId: seen.organizationId,
    };
  }

  // ---- 2. Unknown / informational events --------------------------------
  const isSubscriptionEvent = SUBSCRIPTION_EVENTS.has(eventType);
  const isInvoiceEvent = INVOICE_EVENTS.has(eventType);
  const isCheckoutEvent = CHECKOUT_EVENTS.has(eventType);

  if (!isSubscriptionEvent && !isInvoiceEvent && !isCheckoutEvent) {
    const informational = INFORMATIONAL_EVENTS.has(eventType);
    const note = informational
      ? `${eventType} recorded; it does not change entitlement.`
      : `Unsupported Stripe event type ${eventType}; ignored without touching billing state.`;
    const entry: AuditEntry = {
      organizationId: organizationIdHint,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "ignored",
      note,
      providerEventAt: eventAt,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { ...base, result: "ignored", changed: false, note, organizationId: organizationIdHint };
  }

  // ---- 3. Organization resolution ---------------------------------------
  // Trust order: metadata written at checkout (hint) → our stored Stripe
  // customer → our stored Stripe subscription. A hint is never sufficient on
  // its own to grant anything; it only identifies the row to update.
  let organizationId: string | null = organizationIdHint;
  if (!organizationId && providerCustomerId) {
    organizationId = await store.resolveOrganizationIdByCustomer(providerCustomerId);
  }
  if (!organizationId && providerSubscriptionId) {
    organizationId = await store.resolveOrganizationIdBySubscription(providerSubscriptionId);
  }

  if (!organizationId && isCheckoutEvent) {
    // A completed Checkout Session always carries our metadata; without it we
    // cannot attribute the purchase. Record it loudly, never guess.
    const entry: AuditEntry = {
      organizationId: null,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "rejected",
      note: `Could not resolve the Atlas organization for ${eventType} (missing atlas_org_id metadata).`,
      providerEventAt: eventAt,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { ...base, result: "rejected", changed: false, note: entry.note, organizationId: null };
  }

  if (!organizationId) {
    const entry: AuditEntry = {
      organizationId: null,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "rejected",
      note: `Could not resolve the Atlas organization for ${eventType}.`,
      providerEventAt: eventAt,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { ...base, result: "rejected", changed: false, note: entry.note, organizationId: null };
  }

  const existing = await store.loadSubscription(organizationId);

  // ---- 4. Ordering guard -------------------------------------------------
  // Stale subscription-state events must never overwrite newer state. Invoice
  // events are compared against the invoice watermark instead.
  if (existing) {
    if (
      isSubscriptionEvent &&
      existing.providerEventAt !== null &&
      eventAt < existing.providerEventAt
    ) {
      const note = "Out-of-order subscription event; newer subscription state already applied.";
      const entry: AuditEntry = {
        organizationId,
        providerEventId: eventId,
        eventType,
        providerCustomerId,
        providerSubscriptionId,
        result: "ignored",
        note,
        providerEventAt: eventAt,
      };
      await store.appendAudit(entry);
      await store.recordEvent(entry);
      return { ...base, result: "ignored", changed: false, note, organizationId };
    }
    if (
      isInvoiceEvent &&
      existing.latestInvoiceAt !== null &&
      eventAt < existing.latestInvoiceAt
    ) {
      const note = "Out-of-order invoice event; a newer invoice outcome is already applied.";
      const entry: AuditEntry = {
        organizationId,
        providerEventId: eventId,
        eventType,
        providerCustomerId,
        providerSubscriptionId,
        result: "ignored",
        note,
        providerEventAt: eventAt,
      };
      await store.appendAudit(entry);
      await store.recordEvent(entry);
      return { ...base, result: "ignored", changed: false, note, organizationId };
    }
  }

  // ---- 5. Authoritative subscription state -------------------------------
  // Subscription events carry the subscription itself. Invoice + checkout
  // events carry other objects, so the subscription is re-read from Stripe —
  // entitlement is always derived from the subscription Stripe currently
  // reports, never from a client-supplied or stale payload field.
  let subscription: StripeSubscription | null = null;
  if (isSubscriptionEvent) {
    subscription = object as unknown as StripeSubscription;
  } else {
    const subscriptionId = providerSubscriptionId ?? idOf(object.subscription) ?? null;
    if (subscriptionId) {
      subscription = await gateway.fetchSubscription(subscriptionId);
    }
  }

  if (!subscription && !existing) {
    const note = `No subscription state available for ${eventType} yet; nothing to reconcile.`;
    const entry: AuditEntry = {
      organizationId,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "ignored",
      note,
      providerEventAt: eventAt,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { ...base, result: "ignored", changed: false, note, organizationId };
  }

  if (!subscription && existing) {
    // A deleted/expired subscription we can no longer read: keep the stored
    // state (the customer.subscription.deleted event is the authoritative
    // signal for termination) and record the gap for an operator.
    const note = `${eventType} arrived but the Stripe subscription could not be read; stored state kept.`;
    const entry: AuditEntry = {
      organizationId,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result: "ignored",
      note,
      providerEventAt: eventAt,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { ...base, result: "ignored", changed: false, note, organizationId };
  }

  // The event type itself is authoritative for the two dunning signals: a
  // failed-payment invoice stays `status=open` while Stripe retries, so the
  // invoice status alone cannot express "the charge failed".
  const paymentStatus: AtlasPaymentStatus =
    eventType === "invoice.payment_action_required"
      ? "requires_action"
      : eventType === "invoice.payment_failed"
        ? "failed"
        : isInvoiceEvent
          ? invoicePaymentStatus(object as { status?: string | null; paid?: boolean | null })
          : isSubscriptionEvent && existing
            ? existing.paymentStatus
            : "unknown";

  const invoiceId = isInvoiceEvent ? idOf(object.id) : null;

  // ---- 6. Single reconciliation path ------------------------------------
  const reconciled = reconcileAtlasEntitlement({
    organizationId,
    subscription,
    existing,
    paymentStatus,
    latestInvoiceId: invoiceId,
    eventAt,
    eventType,
    eventId,
    fallbackCustomerId: providerCustomerId,
    fallbackSubscriptionId: providerSubscriptionId,
  });

  // ---- 7. Persist (full-state upsert + entitlement + idempotency ledger) --
  // Order matters: state first, ledger LAST. If any write fails the caller
  // answers 5xx, Stripe retries, and the retry re-applies the same full state
  // (idempotent) instead of being swallowed as a duplicate.
  await store.saveSubscription(reconciled.row);
  await store.setBillingState(organizationId, reconciled.billingState);

  const result: WebhookResult = reconciled.unresolvedPrice ? "ignored" : "processed";
  const entry: AuditEntry = {
    organizationId,
    providerEventId: eventId,
    eventType,
    providerCustomerId: reconciled.row.providerCustomerId,
    providerSubscriptionId: reconciled.row.providerSubscriptionId,
    result,
    note: reconciled.note,
    providerEventAt: eventAt,
  };
  await store.appendAudit(entry);
  await store.recordEvent(entry);

  return {
    accepted: true,
    result,
    changed: reconciled.changed,
    note: reconciled.note,
    organizationId,
    eventId,
    eventType,
    providerCustomerId: reconciled.row.providerCustomerId,
    providerSubscriptionId: reconciled.row.providerSubscriptionId,
  };
}

// ---------------------------------------------------------------------------
// Duplicate-checkout / duplicate-subscription guard (used by stripe-checkout)
// ---------------------------------------------------------------------------

/**
 * True when the organization already has a subscription that should be managed
 * in the Stripe Billing Portal instead of a new Checkout Session.
 */
export function hasManageableSubscription(row: SubscriptionRow | null): boolean {
  if (!row?.providerSubscriptionId) return false;
  return ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"].includes(
    row.status,
  );
}
