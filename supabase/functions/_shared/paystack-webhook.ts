// ---------------------------------------------------------------------------
// Atlas Billing — Paystack webhook reconciliation (pure, provider-scoped)
//
// The Paystack counterpart of _shared/stripe-webhook.ts: a pure module with
// no network and no database, so every decision is unit-testable. The
// Supabase-backed store lives in paystack-webhook/index.ts.
//
// DESIGN (mirrors the Stripe processor):
//   * ONE reconciliation path — no event handler grants entitlement on its
//     own; each event produces a canonical row + optional billing state and
//     the SAME persistence functions apply them.
//   * EXACT-replay dedupe via a durable ledger (Paystack signatures carry no
//     timestamp, so `psk_<sha256(rawBody)>` + idempotent reconciliation
//     together provide replay protection — see paystackWebhookEventId).
//   * charge.success NEVER activates from the webhook payload: the
//     transaction is re-verified against Paystack's Verify API and validated
//     against the billing_transactions row Atlas persisted BEFORE checkout
//     (reference / amount / currency / organization / plan). Mismatch ⇒
//     REJECTED — never activated.
//   * canonical vocabulary: the same Atlas status/billing-state values Stripe
//     writes — no second entitlement state system.
//
// PAYSTACK-SPECIFIC ASSUMPTIONS (verify against test-mode payloads before
// production — flagged in the implementation report):
//   * event envelope { event, data } per official docs
//   * charge.success data carries a transaction object with `reference`
//   * subscription events carry `subscription_code` (+ `email_token` on
//     create) and possibly `next_payment_date`
//   * status vocabulary observed in official docs: active / complete /
//     disabled, plus not_renew semantics; mapping is centralized below
// ---------------------------------------------------------------------------

import {
  type AtlasBillingState,
  type AtlasPaymentStatus,
  type AtlasSubscriptionStatus,
  type BillingInterval,
  type InternalPlan,
  type PaystackVerifiedTransaction,
  paystackPlanCode,
  paystackWebhookEventId,
  validateVerifiedPayment,
} from "./paystack.ts";

// ---------------------------------------------------------------------------
// Persistence contract (implemented over Supabase in paystack-webhook/index.ts)
// ---------------------------------------------------------------------------

/** A row of public.organization_subscriptions (camelCase for the processor). */
export interface PaystackSubscriptionRow {
  organizationId: string;
  billingProvider: "paystack";
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Paystack plan code recorded on the provider_price_id column. */
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

/** A row of public.billing_transactions (the Atlas payment attempt). */
export interface PaystackBillingTransaction {
  id: string;
  organizationId: string;
  providerReference: string;
  providerTransactionId: number | null;
  internalPlan: InternalPlan | null;
  billingInterval: BillingInterval | null;
  amount: number;
  currency: string;
  status: string;
  verified: boolean;
  verifiedAt: number | null;
}

export type WebhookResult = "processed" | "ignored" | "rejected" | "duplicate";

export interface PaystackAuditEntry {
  organizationId: string | null;
  providerEventId: string;
  eventType: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  result: WebhookResult;
  note: string;
  providerEventAt: number | null;
}

export interface PaystackBillingStore {
  findProcessedEvent(
    eventId: string,
  ): Promise<{ result: string; organizationId: string | null } | null>;
  recordEvent(entry: PaystackAuditEntry): Promise<void>;
  appendAudit(entry: PaystackAuditEntry): Promise<void>;
  loadSubscription(organizationId: string): Promise<PaystackSubscriptionRow | null>;
  saveSubscription(row: PaystackSubscriptionRow): Promise<void>;
  setBillingState(organizationId: string, billingState: AtlasBillingState): Promise<void>;
  findTransactionByReference(reference: string): Promise<PaystackBillingTransaction | null>;
  markTransactionVerified(transactionId: string, providerTransactionId: number | null): Promise<void>;
  /** Persist the email token from subscription.create (needed for disable). */
  saveSubscriptionToken(organizationId: string, emailToken: string): Promise<void>;
  resolveOrganizationIdByCustomer(customerCode: string): Promise<string | null>;
  resolveOrganizationIdBySubscription(subscriptionCode: string): Promise<string | null>;
  isPilotOrganization(organizationId: string): Promise<boolean>;
  convertPilotOrganization(organizationId: string, reason: string): Promise<void>;
}

/** External calls the processor needs (injected — tests never hit Paystack). */
export interface PaystackGateway {
  verifyTransaction(reference: string): Promise<PaystackVerifiedTransaction | null>;
}

// ---------------------------------------------------------------------------
// Event taxonomy (candidate set from official docs; verify in test mode)
// ---------------------------------------------------------------------------

/** Events that may change canonical billing state. */
export const PAYSTACK_ENTITLEMENT_EVENTS = new Set([
  "charge.success",
  "invoice.update",
  "invoice.payment_failed",
  "invoice.create",
  "subscription.create",
  "subscription.disable",
  "subscription.not_renew",
]);

/** Events recorded for observability that never change entitlement. */
export const PAYSTACK_INFORMATIONAL_EVENTS = new Set([
  "refund.processed",
  "refund.pending",
  "refund.failed",
  "refund.processing",
  "charge.dispute.create",
  "charge.dispute.remind",
  "charge.dispute.resolve",
  "subscription.expiring_cards",
]);

// ---------------------------------------------------------------------------
// Parsing (defensive — payload shapes beyond the documented envelope are
// treated as absent, never as an activation signal)
// ---------------------------------------------------------------------------

export interface PaystackEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse a SIGNATURE-VERIFIED Paystack payload. Throws when malformed. */
export function parsePaystackEvent(payload: Record<string, unknown>): PaystackEvent {
  const event = typeof payload.event === "string" ? payload.event.trim() : "";
  if (!event) {
    throw new Error("Malformed Paystack event: missing event type.");
  }
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Malformed Paystack event: missing data object.");
  }
  return { event, data: data as Record<string, unknown> };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Convert a Paystack date-ish value to Unix milliseconds. ISO strings and
 * epoch seconds/milliseconds are all handled; anything unparseable is null
 * (never a fabricated timestamp).
 */
export function paystackTimeMs(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Paystack timestamps are epoch seconds; sub-second values are ms.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  return null;
}

/** Extract a subscription code from any documented payload position. */
export function subscriptionCodeFromData(data: Record<string, unknown>): string | null {
  const direct = str(data.subscription_code) ?? str(data.code);
  if (direct) return direct;
  const nested = data.subscription;
  if (typeof nested === "string" && nested !== "") return nested;
  if (nested && typeof nested === "object") {
    const record = nested as Record<string, unknown>;
    return str(record.subscription_code) ?? str(record.code);
  }
  return null;
}

/** Extract a customer code from any documented payload position. */
export function customerCodeFromData(data: Record<string, unknown>): string | null {
  const direct = str(data.customer_code);
  if (direct) return direct;
  const customer = data.customer;
  if (customer && typeof customer === "object") {
    return str((customer as Record<string, unknown>).customer_code);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical mapping (Paystack vocabulary ➜ Atlas vocabulary)
// ---------------------------------------------------------------------------

/**
 * Paystack subscription status ➜ Atlas status.
 * Observed in official docs/samples: `active`, `complete`, `disabled`, and
 * the not_renew signal. Anything else keeps the stored status (or incomplete
 * for a first sighting) — never an invented status.
 */
export function mapPaystackSubscriptionStatus(
  raw: unknown,
  fallback: AtlasSubscriptionStatus = "incomplete",
): AtlasSubscriptionStatus {
  switch (typeof raw === "string" ? raw.toLowerCase() : "") {
    case "active":
      return "active";
    case "complete":
      return "canceled";
    case "disabled":
      return "canceled";
    case "non_renewing":
    case "not_renew":
      return "active";
    case "":
      return fallback;
    default:
      return fallback;
  }
}

/** Atlas status ➜ canonical entitlement (same table Stripe uses). */
export function billingStateForStatus(status: AtlasSubscriptionStatus): AtlasBillingState {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
    case "incomplete":
      return "payment_failed";
    case "incomplete_expired":
    case "canceled":
      return "cancelled";
    case "paused":
      return "suspended";
    default:
      // unknown → fail closed
      return "payment_failed";
  }
}

/** Statuses that keep a live plan association (mirrors the Stripe rule). */
const KEEPS_PLAN: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
]);

/**
 * Checkout guard (the counterpart of Stripe's hasManageableSubscription):
 * an organization with a live Paystack subscription must use its billing
 * records instead of opening a second one. `incomplete` is deliberately NOT
 * blocking — it is a never-paid attempt the customer is retrying.
 */
export function hasLivePaystackSubscription(row: {
  providerSubscriptionId: string | null;
  status: string;
} | null): boolean {
  if (!row?.providerSubscriptionId) return false;
  return ["active", "trialing", "past_due", "unpaid", "paused"].includes(row.status);
}

// ---------------------------------------------------------------------------
// Reconciliation — the ONLY place Paystack entitlement is decided
// ---------------------------------------------------------------------------

export interface PaystackReconcileInput {
  organizationId: string;
  event: PaystackEvent;
  existing: PaystackSubscriptionRow | null;
  /** The Atlas billing attempt for charge.success (from billing_transactions). */
  transaction: PaystackBillingTransaction | null;
  /** The Verify-API result for charge.success (already validated). */
  verified: PaystackVerifiedTransaction | null;
  nowMs: number;
}

export interface PaystackReconcileResult {
  /** Row to persist via billing_upsert_subscription, or null for no write. */
  row: PaystackSubscriptionRow | null;
  /** Canonical entitlement to write via billing_apply_state, or null for no change. */
  billingState: AtlasBillingState | null;
  /** Email token from subscription.create, persisted separately (disable API). */
  subscriptionToken: string | null;
  result: "processed" | "rejected";
  changed: boolean;
  note: string;
}

function baseRow(
  organizationId: string,
  existing: PaystackSubscriptionRow | null,
  nowMs: number,
): PaystackSubscriptionRow {
  return {
    organizationId,
    billingProvider: "paystack",
    providerCustomerId: existing?.providerCustomerId ?? null,
    providerSubscriptionId: existing?.providerSubscriptionId ?? null,
    providerPriceId: existing?.providerPriceId ?? null,
    internalPlan: existing?.internalPlan ?? null,
    billingInterval: existing?.billingInterval ?? null,
    status: existing?.status ?? "unknown",
    paymentStatus: existing?.paymentStatus ?? "unknown",
    trialStart: existing?.trialStart ?? null,
    trialEnd: existing?.trialEnd ?? null,
    currentPeriodStart: existing?.currentPeriodStart ?? null,
    currentPeriodEnd: existing?.currentPeriodEnd ?? null,
    nextBilledAt: existing?.nextBilledAt ?? null,
    cancelAt: existing?.cancelAt ?? null,
    cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
    canceledAt: existing?.canceledAt ?? null,
    latestInvoiceId: existing?.latestInvoiceId ?? null,
    latestInvoiceAt: existing?.latestInvoiceAt ?? null,
    providerEventAt: existing?.providerEventAt ?? null,
    createdAt: existing?.createdAt ?? nowMs,
    updatedAt: nowMs,
  };
}

function rejected(note: string): PaystackReconcileResult {
  return { row: null, billingState: null, subscriptionToken: null, result: "rejected", changed: false, note };
}

function noop(result: string, note: string): PaystackReconcileResult {
  return {
    row: null,
    billingState: null,
    subscriptionToken: null,
    result: result as "processed" | "rejected",
    changed: false,
    note,
  };
}

/**
 * Reconcile one Paystack event into canonical Atlas state.
 *
 * INPUT INVARIANTS (enforced by the caller before invoking):
 *   * the payload passed signature verification
 *   * for charge.success: `transaction` and `verified` are present and
 *     `validateVerifiedPayment` already returned ok
 *   * for other entitlement events: the organization was resolved from a
 *     STORED identifier (subscription code / customer code)
 */
export function reconcilePaystackEvent(input: PaystackReconcileInput): PaystackReconcileResult {
  const { organizationId, event, existing, transaction, verified, nowMs } = input;
  const type = event.event;
  const data = event.data;

  // ---- charge.success (verified payment — the activation path) -----------
  if (type === "charge.success") {
    if (!transaction || !verified) {
      return rejected("charge.success without a verified Atlas transaction.");
    }
    const row = baseRow(organizationId, existing, nowMs);

    // A genuine renewal charge for the still-live subscription keeps period
    // and cancellation fields; anything else (new purchase, re-purchase after
    // cancel) resets them so a stale cancellation can never leak forward.
    const liveRenewal =
      existing !== null &&
      ["active", "trialing", "past_due"].includes(existing.status) &&
      existing.internalPlan === transaction.internalPlan &&
      existing.providerSubscriptionId !== null;

    row.providerCustomerId = verified.customerCode ?? row.providerCustomerId;
    row.providerPriceId = verified.planCode ?? row.providerPriceId;
    row.internalPlan = transaction.internalPlan;
    row.billingInterval = transaction.billingInterval;
    row.status = "active";
    row.paymentStatus = "paid";
    if (!liveRenewal) {
      row.cancelAt = null;
      row.cancelAtPeriodEnd = false;
      row.canceledAt = null;
      row.currentPeriodStart = null;
      row.currentPeriodEnd = null;
      row.nextBilledAt = null;
    }
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;

    return {
      row,
      billingState: "active",
      subscriptionToken: null,
      result: "processed",
      changed: true,
      note: `Verified Paystack payment ${verified.reference} activated plan ${transaction.internalPlan ?? "?"}.`,
    };
  }

  // ---- subscription.create (records identity; never grants by itself) ----
  if (type === "subscription.create") {
    const subCode = subscriptionCodeFromData(data);
    if (!subCode) {
      return rejected("subscription.create without a subscription code.");
    }
    const row = baseRow(organizationId, existing, nowMs);
    row.providerSubscriptionId = subCode;
    row.providerCustomerId = customerCodeFromData(data) ?? row.providerCustomerId;
    const plan = data.plan;
    if (plan && typeof plan === "object") {
      const planCode = str((plan as Record<string, unknown>).plan_code);
      if (planCode) row.providerPriceId = planCode;
    }
    // The subscription identity does NOT grant entitlement: activation comes
    // only from a verified payment (charge.success / paid invoice.update).
    row.status = mapPaystackSubscriptionStatus(
      data.status,
      existing?.status === "active" ? "active" : "incomplete",
    );
    const nextPayment = paystackTimeMs(data.next_payment_date);
    if (nextPayment !== null) row.nextBilledAt = nextPayment;
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;

    return {
      row,
      billingState: null,
      subscriptionToken: str(data.email_token),
      result: "processed",
      changed: true,
      note: `Paystack subscription ${subCode} recorded.`,
    };
  }

  // ---- invoice.create (renewal notice — no state change) -----------------
  if (type === "invoice.create") {
    return noop("processed", "Renewal invoice created; no entitlement change.");
  }

  // ---- invoice.update (charged successfully → active) --------------------
  if (type === "invoice.update") {
    const subCode = subscriptionCodeFromData(data);
    const row = baseRow(organizationId, existing, nowMs);
    const invoiceStatus = str(data.status);
    const paidFlag = data.paid === true;
    const charged = paidFlag || invoiceStatus === "paid";
    const invoiceId = str(data.id) ?? (typeof data.id === "number" ? String(data.id) : null);
    if (invoiceId) row.latestInvoiceId = invoiceId;
    row.latestInvoiceAt = nowMs;

    if (!charged) {
      // Shape unknown / not yet paid → observability only, never activation.
      return {
        row,
        billingState: null,
        subscriptionToken: null,
        result: "processed",
        changed: false,
        note: `invoice.update with status ${invoiceStatus ?? "unknown"}; no entitlement change.`,
      };
    }
    if (existing && !KEEPS_PLAN.has(existing.status)) {
      // A paid invoice for a subscription Atlas recorded as canceled is a
      // renewal AFTER disable: record the payment but do not resurrect
      // entitlement without a current subscription record.
      row.paymentStatus = "paid";
      row.providerEventAt = nowMs;
      row.updatedAt = nowMs;
      return {
        row,
        billingState: null,
        subscriptionToken: null,
        result: "processed",
        changed: true,
        note: "Paid invoice for a non-live subscription recorded without entitlement change.",
      };
    }
    row.status = "active";
    row.paymentStatus = "paid";
    const nextPayment = paystackTimeMs(data.next_payment_date);
    if (nextPayment !== null) row.nextBilledAt = nextPayment;
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;
    return {
      row,
      billingState: "active",
      subscriptionToken: null,
      result: "processed",
      changed: true,
      note: `Renewal charged${subCode ? ` for ${subCode}` : ""}.`,
    };
  }

  // ---- invoice.payment_failed (dunning → grace period) -------------------
  if (type === "invoice.payment_failed") {
    const row = baseRow(organizationId, existing, nowMs);
    row.status = "past_due";
    row.paymentStatus = "failed";
    const invoiceId = str(data.id) ?? (typeof data.id === "number" ? String(data.id) : null);
    if (invoiceId) row.latestInvoiceId = invoiceId;
    row.latestInvoiceAt = nowMs;
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;
    return {
      row,
      // Grace period: the customer has paid before and the next renewal is
      // what failed — `past_due` keeps the existing Atlas grace semantics.
      billingState: "past_due",
      subscriptionToken: null,
      result: "processed",
      changed: true,
      note: "Renewal payment failed; Atlas moved to past_due (grace).",
    };
  }

  // ---- subscription.not_renew (pre-cancel: access until next payment) ----
  if (type === "subscription.not_renew") {
    const subCode = subscriptionCodeFromData(data);
    const row = baseRow(organizationId, existing, nowMs);
    if (subCode) row.providerSubscriptionId = subCode;
    const nextPayment = paystackTimeMs(data.next_payment_date);
    row.status = "active";
    row.cancelAtPeriodEnd = true;
    row.cancelAt = nextPayment;
    row.canceledAt = null;
    if (nextPayment !== null) row.nextBilledAt = nextPayment;
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;
    return {
      row,
      billingState: "active",
      subscriptionToken: null,
      result: "processed",
      changed: true,
      note: nextPayment
        ? `Subscription will not renew; access kept until ${new Date(nextPayment).toISOString()}.`
        : "Subscription marked non-renewing (no next payment date in payload).",
    };
  }

  // ---- subscription.disable (cancellation takes effect) -------------------
  if (type === "subscription.disable") {
    const subCode = subscriptionCodeFromData(data);
    const row = baseRow(organizationId, existing, nowMs);
    if (subCode) row.providerSubscriptionId = subCode;
    row.status = "canceled";
    row.cancelAtPeriodEnd = true;
    row.canceledAt = nowMs;
    // Canonical rule (mirrors Stripe's deleted-subscription handling): the
    // plan association ends with the subscription. Paystack has no native
    // cancel-at-period-end state — see the report's cancellation note.
    if (!KEEPS_PLAN.has(row.status)) {
      row.internalPlan = null;
      row.billingInterval = null;
    }
    row.providerEventAt = nowMs;
    row.updatedAt = nowMs;
    return {
      row,
      billingState: "cancelled",
      subscriptionToken: null,
      result: "processed",
      changed: true,
      note: "Paystack subscription disabled; Atlas entitlement cancelled.",
    };
  }

  return noop("rejected", `Unhandled Paystack event ${type}.`);
}

// ---------------------------------------------------------------------------
// Processing pipeline — the same production logic the paystack-webhook Edge
// Function runs, kept pure (store + gateway injected) so the whole flow —
// dedupe, parse, org resolution, verification, reconciliation, audit — is
// unit-testable without a Supabase project or a Paystack account. The Edge
// Function calls this exact function; there is ONE pipeline.
// ---------------------------------------------------------------------------

export interface ProcessPaystackResult {
  eventId: string;
  eventType: string;
  result: "processed" | "ignored" | "rejected" | "duplicate";
  changed: boolean;
  organizationId: string | null;
  note: string;
}

export async function processPaystackEvent(
  store: PaystackBillingStore,
  gateway: PaystackGateway,
  rawBody: string,
  payload: Record<string, unknown>,
): Promise<ProcessPaystackResult> {
  const nowMs = Date.now();
  // Ledger identity for EXACT replays only (documented design decision —
  // semantic duplicates are made safe by idempotent reconciliation).
  const eventId = await paystackWebhookEventId(rawBody);

  // ---- 1. Idempotency ----------------------------------------------------
  const seen = await store.findProcessedEvent(eventId);
  if (seen) {
    await store.appendAudit({
      organizationId: seen.organizationId,
      providerEventId: eventId,
      eventType: typeof payload.event === "string" ? payload.event : "unknown",
      providerCustomerId: null,
      providerSubscriptionId: null,
      result: "duplicate",
      note: `Duplicate delivery; previously ${seen.result}.`,
      providerEventAt: nowMs,
    });
    return {
      eventId,
      eventType: typeof payload.event === "string" ? payload.event : "unknown",
      result: "duplicate",
      changed: false,
      organizationId: seen.organizationId,
      note: "Duplicate Paystack delivery ignored.",
    };
  }

  // ---- 2. Parse (throws ⇒ 500: a malformed payload is a shape alarm) -----
  const event = parsePaystackEvent(payload);
  const eventType = event.event;

  // ---- 3. Unknown / informational events → recorded, answered 2xx --------
  const isCore = PAYSTACK_ENTITLEMENT_EVENTS.has(eventType);
  const isInformational = PAYSTACK_INFORMATIONAL_EVENTS.has(eventType);
  if (!isCore) {
    const note = isInformational
      ? `${eventType} recorded; it does not change entitlement.`
      : `Unsupported Paystack event type ${eventType}; ignored without touching billing state.`;
    const entry: PaystackAuditEntry = {
      organizationId: null,
      providerEventId: eventId,
      eventType,
      providerCustomerId: customerCodeFromData(event.data),
      providerSubscriptionId: subscriptionCodeFromData(event.data),
      result: "ignored",
      note,
      providerEventAt: nowMs,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { eventId, eventType, result: "ignored", changed: false, organizationId: null, note };
  }

  // ---- 4. Organization + transaction resolution --------------------------
  let organizationId: string | null = null;
  let transaction: PaystackBillingTransaction | null = null;
  let verified: PaystackVerifiedTransaction | null = null;
  const providerCustomerId = customerCodeFromData(event.data);
  let providerSubscriptionId = subscriptionCodeFromData(event.data);

  const finish = async (
    result: "processed" | "rejected",
    note: string,
    changed = false,
    org: string | null = organizationId,
  ): Promise<ProcessPaystackResult> => {
    const entry: PaystackAuditEntry = {
      organizationId: org,
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      result,
      note,
      providerEventAt: nowMs,
    };
    await store.appendAudit(entry);
    await store.recordEvent(entry);
    return { eventId, eventType, result, changed, organizationId: org, note };
  };

  if (eventType === "charge.success") {
    const reference = str(event.data.reference);
    if (!reference) {
      // Our documented assumption (charge.success carries `reference`) is
      // broken — fail loudly so Paystack retries and operators see it.
      throw new Error("charge.success payload without a transaction reference.");
    }

    transaction = await store.findTransactionByReference(reference);
    if (!transaction) {
      // No Atlas billing attempt for this reference: resolve nothing, guess
      // nothing, activate nothing (§20).
      return await finish(
        "rejected",
        `No Atlas billing transaction for reference ${reference}; nothing activated.`,
      );
    }
    organizationId = transaction.organizationId;

    // Always re-verify against Paystack — the payload is never trusted, and
    // a duplicate delivery re-applies the same verified full state.
    verified = await gateway.verifyTransaction(reference);
    if (verified === null) {
      return await finish(
        "rejected",
        `Paystack does not know reference ${reference}; nothing activated.`,
      );
    }

    const expectedPlanCode = transaction.internalPlan
      ? (paystackPlanCode(
          transaction.internalPlan,
          transaction.billingInterval ?? "monthly",
        ) ?? "")
      : "";
    const check = validateVerifiedPayment(verified, {
      reference: transaction.providerReference,
      amountSubunits: transaction.amount,
      currency: transaction.currency,
      organizationId: transaction.organizationId,
      planCode: expectedPlanCode,
    });
    if (!check.ok) {
      return await finish(
        "rejected",
        `Payment verification failed for ${reference}: ${check.reason}.`,
      );
    }
    if (!transaction.verified) {
      await store.markTransactionVerified(transaction.id, verified.id);
    }
  } else {
    // Entitlement events other than charge.success resolve the organization
    // from STORED identifiers only.
    const subCode = subscriptionCodeFromData(event.data);
    if (subCode) providerSubscriptionId = subCode;
    if (subCode) organizationId = await store.resolveOrganizationIdBySubscription(subCode);
    if (!organizationId && providerCustomerId) {
      organizationId = await store.resolveOrganizationIdByCustomer(providerCustomerId);
    }
    if (!organizationId) {
      return await finish(
        "rejected",
        `${eventType} could not be attributed to an Atlas organization; nothing changed.`,
      );
    }
  }

  // ---- 5. Reconcile into canonical Atlas state ---------------------------
  const existing = await store.loadSubscription(organizationId);
  const result = reconcilePaystackEvent({
    organizationId,
    event,
    existing,
    transaction,
    verified,
    nowMs,
  });

  if (result.result === "rejected") {
    return await finish("rejected", result.note);
  }

  if (result.row) {
    await store.saveSubscription(result.row);
  }
  if (result.subscriptionToken) {
    await store.saveSubscriptionToken(organizationId, result.subscriptionToken);
  }
  if (result.billingState) {
    await store.setBillingState(organizationId, result.billingState);

    // Free Pilot conversion: same rule as the Stripe processor — an
    // authoritative paid state converts a free_pilot organization once.
    if (result.billingState === "active" && (await store.isPilotOrganization(organizationId))) {
      await store.convertPilotOrganization(
        organizationId,
        `Paystack payment verified (${eventType})`,
      );
    }
  }

  return await finish("processed", result.note, result.changed);
}
