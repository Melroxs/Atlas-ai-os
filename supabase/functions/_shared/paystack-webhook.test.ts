/**
 * Tests for supabase/functions/_shared/paystack-webhook.ts — the single
 * Paystack entitlement reconciliation path (the counterpart of
 * stripe-webhook.test.ts).
 *
 * The module takes its persistence and its Paystack reads as injected
 * dependencies, so this suite exercises the EXACT production logic the
 * paystack-webhook Edge Function runs — parsing, idempotency, organization
 * resolution, verification, canonical mapping and durable audit — against an
 * in-memory store. No Supabase project and no Paystack account are involved.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type {
  AtlasBillingState,
  PaystackVerifiedTransaction,
} from "./paystack.ts";
import {
  type PaystackAuditEntry,
  type PaystackBillingStore,
  type PaystackBillingTransaction,
  type PaystackEvent,
  type PaystackGateway,
  type PaystackSubscriptionRow,
  PAYSTACK_ENTITLEMENT_EVENTS,
  PAYSTACK_INFORMATIONAL_EVENTS,
  billingStateForStatus,
  customerCodeFromData,
  hasLivePaystackSubscription,
  mapPaystackSubscriptionStatus,
  parsePaystackEvent,
  paystackTimeMs,
  processPaystackEvent,
  reconcilePaystackEvent,
  subscriptionCodeFromData,
} from "./paystack-webhook.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PLAN_CODES = {
  starterMonthly: "PLN_atlas_starter_monthly",
  growthMonthly: "PLN_atlas_growth_monthly",
};

const ENV: Record<string, string> = {
  PAYSTACK_SECRET_KEY: "sk_test_atlas",
  PAYSTACK_CURRENCY: "ZAR",
  PAYSTACK_PLAN_STARTER_MONTHLY: PLAN_CODES.starterMonthly,
  PAYSTACK_PLAN_STARTER_YEARLY: "PLN_atlas_starter_yearly",
  PAYSTACK_PLAN_GROWTH_MONTHLY: PLAN_CODES.growthMonthly,
  PAYSTACK_PLAN_GROWTH_YEARLY: "PLN_atlas_growth_yearly",
  PAYSTACK_PLAN_SCALE_MONTHLY: "PLN_atlas_scale_monthly",
  PAYSTACK_PLAN_SCALE_YEARLY: "PLN_atlas_scale_yearly",
  ATLAS_APP_URL: "https://atlas-ai-os.com",
};

function stubDeno(env: Record<string, string> = {}): void {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => env[key] ?? "" },
  };
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const REF = "ATL0123456789abcdef0123456789abcdef";
const CUSTOMER = "CUS_1";
const SUBSCRIPTION = "SUB_1";
const AMOUNT = 89900; // PAYSTACK_PRICE_STARTER_MONTHLY (subunits)
const NOW = 1_800_000_000_000;

interface StoreState {
  events: Map<string, { result: string; organizationId: string | null }>;
  audits: PaystackAuditEntry[];
  subs: Map<string, PaystackSubscriptionRow>;
  tokens: Map<string, string>;
  billing: Map<string, AtlasBillingState>;
  transactions: Map<string, PaystackBillingTransaction>;
  verified: Array<{ transactionId: string; providerTransactionId: number | null }>;
  customers: Map<string, string>;
  subscriptions: Map<string, string>;
  pilots: Set<string>;
  conversions: Array<{ organizationId: string; reason: string }>;
  ops: string[];
  failOnSave: boolean;
}

function createStore(): { store: PaystackBillingStore; state: StoreState } {
  const state: StoreState = {
    events: new Map(),
    audits: [],
    subs: new Map(),
    tokens: new Map(),
    billing: new Map(),
    transactions: new Map(),
    verified: [],
    customers: new Map(),
    subscriptions: new Map(),
    pilots: new Set(),
    conversions: [],
    ops: [],
    failOnSave: false,
  };

  const store: PaystackBillingStore = {
    async findProcessedEvent(eventId) {
      return state.events.get(eventId) ?? null;
    },
    async recordEvent(entry) {
      // First-writer-wins (mirrors the 23505 no-op in the Supabase store).
      if (!state.events.has(entry.providerEventId)) {
        state.events.set(entry.providerEventId, {
          result: entry.result,
          organizationId: entry.organizationId,
        });
      }
    },
    async appendAudit(entry) {
      state.audits.push(entry);
    },
    async loadSubscription(organizationId) {
      return state.subs.get(organizationId) ?? null;
    },
    async saveSubscription(row) {
      if (state.failOnSave) throw new Error("database unavailable");
      state.subs.set(row.organizationId, row);
      state.ops.push(`save:${row.organizationId}`);
    },
    async setBillingState(organizationId, billingState) {
      state.billing.set(organizationId, billingState);
      state.ops.push(`state:${organizationId}:${billingState}`);
    },
    async findTransactionByReference(reference) {
      return state.transactions.get(reference) ?? null;
    },
    async markTransactionVerified(transactionId, providerTransactionId) {
      state.verified.push({ transactionId, providerTransactionId });
      for (const txn of state.transactions.values()) {
        if (txn.id === transactionId) {
          txn.verified = true;
          txn.verifiedAt = NOW;
          txn.providerTransactionId = providerTransactionId;
        }
      }
    },
    async saveSubscriptionToken(organizationId, emailToken) {
      state.tokens.set(organizationId, emailToken);
    },
    async resolveOrganizationIdByCustomer(customerCode) {
      return state.customers.get(customerCode) ?? null;
    },
    async resolveOrganizationIdBySubscription(subscriptionCode) {
      return state.subscriptions.get(subscriptionCode) ?? null;
    },
    async isPilotOrganization(organizationId) {
      return state.pilots.has(organizationId);
    },
    async convertPilotOrganization(organizationId, reason) {
      state.conversions.push({ organizationId, reason });
    },
  };

  return { store, state };
}

function gatewayReturning(result: PaystackVerifiedTransaction | null): {
  gateway: PaystackGateway;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    gateway: {
      async verifyTransaction(reference) {
        calls.push(reference);
        return result;
      },
    },
    calls,
  };
}

function verifiedFixture(
  overrides: Partial<PaystackVerifiedTransaction> = {},
): PaystackVerifiedTransaction {
  return {
    id: 424242,
    status: "success",
    reference: REF,
    amount: AMOUNT,
    currency: "ZAR",
    paidAt: "2026-10-07T10:00:00.000Z",
    customerEmail: "owner@atlas.test",
    customerCode: CUSTOMER,
    planCode: PLAN_CODES.starterMonthly,
    organizationId: ORG,
    ...overrides,
  };
}

function transactionFixture(
  overrides: Partial<PaystackBillingTransaction> = {},
): PaystackBillingTransaction {
  return {
    id: "txn-1",
    organizationId: ORG,
    providerReference: REF,
    providerTransactionId: null,
    internalPlan: "ATLAS_STARTER",
    billingInterval: "monthly",
    amount: AMOUNT,
    currency: "ZAR",
    status: "initialized",
    verified: false,
    verifiedAt: null,
    ...overrides,
  };
}

function eventFixture(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { event: type, data };
}

function chargeSuccessPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return eventFixture("charge.success", {
    reference: REF,
    amount: AMOUNT,
    currency: "ZAR",
    status: "success",
    customer: { customer_code: CUSTOMER },
    ...overrides,
  });
}

beforeEach(() => {
  stubDeno(ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).Deno;
});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

describe("parsePaystackEvent", () => {
  it("accepts the documented { event, data } envelope", () => {
    const parsed = parsePaystackEvent({ event: "charge.success", data: { reference: REF } });
    expect(parsed).toEqual({ event: "charge.success", data: { reference: REF } });
  });

  it("throws when the event type is missing or empty", () => {
    expect(() => parsePaystackEvent({ data: {} })).toThrow(/missing event type/i);
    expect(() => parsePaystackEvent({ event: "  ", data: {} })).toThrow(/missing event type/i);
    expect(() => parsePaystackEvent({ event: 42, data: {} })).toThrow(/missing event type/i);
  });

  it("throws when data is missing or not an object", () => {
    expect(() => parsePaystackEvent({ event: "charge.success" })).toThrow(/missing data/i);
    expect(() => parsePaystackEvent({ event: "charge.success", data: [] })).toThrow(/missing data/i);
    expect(() => parsePaystackEvent({ event: "charge.success", data: "x" })).toThrow(/missing data/i);
  });
});

describe("payload extraction helpers", () => {
  it("parses date-ish values into epoch milliseconds (never fabricates)", () => {
    expect(paystackTimeMs("2026-11-07T10:00:00.000Z")).toBe(Date.parse("2026-11-07T10:00:00.000Z"));
    expect(paystackTimeMs(1_800_000_000)).toBe(1_800_000_000_000); // epoch seconds
    expect(paystackTimeMs(1_800_000_000_000)).toBe(1_800_000_000_000); // already ms
    expect(paystackTimeMs("not a date")).toBeNull();
    expect(paystackTimeMs(undefined)).toBeNull();
    expect(paystackTimeMs(null)).toBeNull();
  });

  it("finds subscription and customer codes in every documented position", () => {
    expect(subscriptionCodeFromData({ subscription_code: "SUB_A" })).toBe("SUB_A");
    expect(subscriptionCodeFromData({ code: "SUB_B" })).toBe("SUB_B");
    expect(subscriptionCodeFromData({ subscription: "SUB_C" })).toBe("SUB_C");
    expect(
      subscriptionCodeFromData({ subscription: { subscription_code: "SUB_D" } }),
    ).toBe("SUB_D");
    expect(subscriptionCodeFromData({})).toBeNull();

    expect(customerCodeFromData({ customer_code: "CUS_A" })).toBe("CUS_A");
    expect(customerCodeFromData({ customer: { customer_code: "CUS_B" } })).toBe("CUS_B");
    expect(customerCodeFromData({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Canonical mapping
// ---------------------------------------------------------------------------

describe("mapPaystackSubscriptionStatus", () => {
  it("maps the documented Paystack statuses into Atlas vocabulary", () => {
    expect(mapPaystackSubscriptionStatus("active")).toBe("active");
    expect(mapPaystackSubscriptionStatus("complete")).toBe("canceled");
    expect(mapPaystackSubscriptionStatus("disabled")).toBe("canceled");
    expect(mapPaystackSubscriptionStatus("non_renewing")).toBe("active");
    expect(mapPaystackSubscriptionStatus("not_renew")).toBe("active");
  });

  it("keeps the fallback for unknown/absent statuses (never invents one)", () => {
    expect(mapPaystackSubscriptionStatus("", "past_due")).toBe("past_due");
    expect(mapPaystackSubscriptionStatus(undefined, "incomplete")).toBe("incomplete");
    expect(mapPaystackSubscriptionStatus("something_new", "incomplete")).toBe("incomplete");
    expect(mapPaystackSubscriptionStatus("active", "incomplete")).toBe("active");
  });
});

describe("billingStateForStatus", () => {
  it("maps Atlas statuses onto the canonical billing states", () => {
    expect(billingStateForStatus("active")).toBe("active");
    expect(billingStateForStatus("trialing")).toBe("active");
    expect(billingStateForStatus("past_due")).toBe("past_due");
    expect(billingStateForStatus("unpaid")).toBe("payment_failed");
    expect(billingStateForStatus("incomplete")).toBe("payment_failed");
    expect(billingStateForStatus("canceled")).toBe("cancelled");
    expect(billingStateForStatus("paused")).toBe("suspended");
    expect(billingStateForStatus("unknown")).toBe("payment_failed"); // fail closed
  });
});

describe("event taxonomies", () => {
  it("contains exactly the candidate event set", () => {
    expect([...PAYSTACK_ENTITLEMENT_EVENTS].sort()).toEqual(
      [
        "charge.success",
        "invoice.create",
        "invoice.payment_failed",
        "invoice.update",
        "subscription.create",
        "subscription.disable",
        "subscription.not_renew",
      ].sort(),
    );
    expect(PAYSTACK_INFORMATIONAL_EVENTS.has("refund.processed")).toBe(true);
    expect(PAYSTACK_ENTITLEMENT_EVENTS.has("charge.refunded")).toBe(false);
  });
});

describe("hasLivePaystackSubscription (duplicate-checkout guard)", () => {
  it("blocks a second checkout only for a live subscription", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid", "paused"]) {
      expect(
        hasLivePaystackSubscription({ providerSubscriptionId: "SUB_1", status }),
        `${status} must block`,
      ).toBe(true);
    }
    for (const status of ["incomplete", "canceled", "unknown", ""]) {
      expect(
        hasLivePaystackSubscription({ providerSubscriptionId: "SUB_1", status }),
        `${status} must allow a retry`,
      ).toBe(false);
    }
  });

  it("never blocks a row without a stored subscription id", () => {
    expect(hasLivePaystackSubscription(null)).toBe(false);
    expect(
      hasLivePaystackSubscription({ providerSubscriptionId: null, status: "active" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcilePaystackEvent — the ONLY place entitlement is decided
// ---------------------------------------------------------------------------

describe("reconcilePaystackEvent", () => {
  const base = {
    organizationId: ORG,
    existing: null as PaystackSubscriptionRow | null,
    transaction: null as PaystackBillingTransaction | null,
    verified: null as PaystackVerifiedTransaction | null,
    nowMs: NOW,
  };

  it("charge.success activates ONLY with a stored transaction and verification", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(chargeSuccessPayload()) as PaystackEvent,
      transaction: transactionFixture(),
      verified: verifiedFixture(),
    });
    expect(result.result).toBe("processed");
    expect(result.changed).toBe(true);
    expect(result.billingState).toBe("active");
    expect(result.row).toMatchObject({
      organizationId: ORG,
      billingProvider: "paystack",
      status: "active",
      paymentStatus: "paid",
      internalPlan: "ATLAS_STARTER",
      billingInterval: "monthly",
      providerCustomerId: CUSTOMER,
      providerPriceId: PLAN_CODES.starterMonthly,
    });
  });

  it("charge.success without a transaction or verification is rejected", () => {
    const event = parsePaystackEvent(chargeSuccessPayload()) as PaystackEvent;
    expect(reconcilePaystackEvent({ ...base, event }).result).toBe("rejected");
    expect(
      reconcilePaystackEvent({ ...base, event, transaction: transactionFixture() }).result,
    ).toBe("rejected");
    expect(
      reconcilePaystackEvent({ ...base, event, verified: verifiedFixture() }).result,
    ).toBe("rejected");
  });

  it("a genuine renewal keeps period + cancellation fields", () => {
    const existing: PaystackSubscriptionRow = {
      organizationId: ORG,
      billingProvider: "paystack",
      providerCustomerId: CUSTOMER,
      providerSubscriptionId: SUBSCRIPTION,
      providerPriceId: PLAN_CODES.starterMonthly,
      internalPlan: "ATLAS_STARTER",
      billingInterval: "monthly",
      status: "active",
      paymentStatus: "paid",
      trialStart: null,
      trialEnd: null,
      currentPeriodStart: 1_700_000_000_000,
      currentPeriodEnd: 1_702_592_000_000,
      nextBilledAt: 1_702_592_000_000,
      cancelAt: 1_702_592_000_000,
      cancelAtPeriodEnd: true,
      canceledAt: null,
      latestInvoiceId: null,
      latestInvoiceAt: null,
      providerEventAt: null,
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
    };
    const result = reconcilePaystackEvent({
      ...base,
      existing,
      event: parsePaystackEvent(chargeSuccessPayload()) as PaystackEvent,
      transaction: transactionFixture(),
      verified: verifiedFixture(),
    });
    expect(result.row?.cancelAt).toBe(1_702_592_000_000);
    expect(result.row?.currentPeriodStart).toBe(1_700_000_000_000);
    expect(result.billingState).toBe("active");
  });

  it("subscription.create records identity and email token but NEVER grants", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(
        eventFixture("subscription.create", {
          subscription_code: SUBSCRIPTION,
          email_token: "email_token_1",
          status: "active",
          plan: { plan_code: PLAN_CODES.starterMonthly },
          customer: { customer_code: CUSTOMER },
          next_payment_date: "2026-11-07T10:00:00.000Z",
        }),
      ) as PaystackEvent,
    });
    expect(result.result).toBe("processed");
    expect(result.billingState).toBeNull();
    expect(result.subscriptionToken).toBe("email_token_1");
    expect(result.row).toMatchObject({
      providerSubscriptionId: SUBSCRIPTION,
      status: "active",
      providerPriceId: PLAN_CODES.starterMonthly,
      nextBilledAt: Date.parse("2026-11-07T10:00:00.000Z"),
    });
  });

  it("subscription.create without a code is rejected", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(eventFixture("subscription.create", { status: "active" })) as PaystackEvent,
    });
    expect(result.result).toBe("rejected");
    expect(result.row).toBeNull();
  });

  it("invoice.create is a recorded no-op", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(eventFixture("invoice.create", { id: "INV_1" })) as PaystackEvent,
    });
    expect(result).toMatchObject({ result: "processed", changed: false, billingState: null, row: null });
  });

  it("invoice.update paid → active; unpaid → no entitlement change", () => {
    const paid = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(
        eventFixture("invoice.update", {
          id: "INV_1",
          status: "paid",
          paid: true,
          subscription_code: SUBSCRIPTION,
          next_payment_date: "2026-11-07T10:00:00.000Z",
        }),
      ) as PaystackEvent,
    });
    expect(paid).toMatchObject({ result: "processed", changed: true, billingState: "active" });
    expect(paid.row).toMatchObject({ status: "active", paymentStatus: "paid", latestInvoiceId: "INV_1" });

    const unpaid = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(
        eventFixture("invoice.update", { id: "INV_2", status: "pending", paid: false }),
      ) as PaystackEvent,
    });
    expect(unpaid).toMatchObject({ result: "processed", changed: false, billingState: null });
  });

  it("a paid invoice does not resurrect a canceled subscription", () => {
    const existing: PaystackSubscriptionRow = {
      ...{
        organizationId: ORG,
        billingProvider: "paystack" as const,
        providerCustomerId: CUSTOMER,
        providerSubscriptionId: SUBSCRIPTION,
        providerPriceId: PLAN_CODES.starterMonthly,
        internalPlan: "ATLAS_STARTER",
        billingInterval: "monthly",
        status: "canceled" as const,
        paymentStatus: "paid" as const,
        trialStart: null,
        trialEnd: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        nextBilledAt: null,
        cancelAt: null,
        cancelAtPeriodEnd: true,
        canceledAt: NOW,
        latestInvoiceId: null,
        latestInvoiceAt: null,
        providerEventAt: null,
        createdAt: 1_600_000_000_000,
        updatedAt: 1_600_000_000_000,
      },
    };
    const result = reconcilePaystackEvent({
      ...base,
      existing,
      event: parsePaystackEvent(
        eventFixture("invoice.update", { id: "INV_3", status: "paid", paid: true }),
      ) as PaystackEvent,
    });
    expect(result.billingState).toBeNull();
    expect(result.row?.paymentStatus).toBe("paid");
    expect(result.row?.status).toBe("canceled");
  });

  it("invoice.payment_failed moves Atlas to past_due (grace)", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(
        eventFixture("invoice.payment_failed", { id: "INV_4", subscription_code: SUBSCRIPTION }),
      ) as PaystackEvent,
    });
    expect(result).toMatchObject({ result: "processed", changed: true, billingState: "past_due" });
    expect(result.row).toMatchObject({ status: "past_due", paymentStatus: "failed" });
  });

  it("subscription.not_renew keeps access until the next payment date", () => {
    const nextPayment = Date.parse("2026-11-07T10:00:00.000Z");
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(
        eventFixture("subscription.not_renew", {
          subscription_code: SUBSCRIPTION,
          next_payment_date: "2026-11-07T10:00:00.000Z",
        }),
      ) as PaystackEvent,
    });
    expect(result).toMatchObject({ result: "processed", billingState: "active" });
    expect(result.row).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: true,
      cancelAt: nextPayment,
      canceledAt: null,
    });
  });

  it("subscription.disable cancels the canonical entitlement", () => {
    const existing: PaystackSubscriptionRow = {
      organizationId: ORG,
      billingProvider: "paystack",
      providerCustomerId: CUSTOMER,
      providerSubscriptionId: SUBSCRIPTION,
      providerPriceId: PLAN_CODES.starterMonthly,
      internalPlan: "ATLAS_STARTER",
      billingInterval: "monthly",
      status: "active",
      paymentStatus: "paid",
      trialStart: null,
      trialEnd: null,
      currentPeriodStart: 1_700_000_000_000,
      currentPeriodEnd: 1_702_592_000_000,
      nextBilledAt: 1_702_592_000_000,
      cancelAt: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      latestInvoiceId: null,
      latestInvoiceAt: null,
      providerEventAt: null,
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
    };
    const result = reconcilePaystackEvent({
      ...base,
      existing,
      event: parsePaystackEvent(
        eventFixture("subscription.disable", { subscription_code: SUBSCRIPTION }),
      ) as PaystackEvent,
    });
    expect(result).toMatchObject({ result: "processed", billingState: "cancelled" });
    expect(result.row).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: true,
      internalPlan: null,
      billingInterval: null,
    });
  });

  it("an unhandled event type is rejected without any write", () => {
    const result = reconcilePaystackEvent({
      ...base,
      event: parsePaystackEvent(eventFixture("something.unknown", {})) as PaystackEvent,
    });
    expect(result).toMatchObject({ result: "rejected", row: null, billingState: null, changed: false });
  });
});

// ---------------------------------------------------------------------------
// processPaystackEvent — the exact pipeline the Edge Function runs
// ---------------------------------------------------------------------------

describe("processPaystackEvent", () => {
  it("activates a verified charge and marks the transaction verified", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    state.customers.set(CUSTOMER, ORG);
    const { gateway, calls } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload();
    const rawBody = JSON.stringify(payload);

    const result = await processPaystackEvent(store, gateway, rawBody, payload);

    expect(result).toMatchObject({ result: "processed", changed: true, organizationId: ORG });
    expect(calls).toEqual([REF]);
    expect(state.billing.get(ORG)).toBe("active");
    expect(state.subs.get(ORG)).toMatchObject({ status: "active", internalPlan: "ATLAS_STARTER" });
    expect(state.verified).toEqual([
      { transactionId: "txn-1", providerTransactionId: 424242 },
    ]);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ organizationId: ORG, eventType: "charge.success", result: "processed" });
    expect(state.events.has(result.eventId)).toBe(true);
  });

  it("ignores an EXACT replay (same raw body) without re-applying state", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    const { gateway, calls } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload();
    const rawBody = JSON.stringify(payload);

    const first = await processPaystackEvent(store, gateway, rawBody, payload);
    expect(first.result).toBe("processed");

    const opsAfterFirst = [...state.ops];
    const second = await processPaystackEvent(store, gateway, rawBody, payload);

    expect(second.result).toBe("duplicate");
    expect(second.changed).toBe(false);
    expect(second.organizationId).toBe(ORG);
    expect(state.ops).toEqual(opsAfterFirst); // no repeated writes
    expect(calls).toHaveLength(1); // gateway not re-consulted
    expect(state.audits.at(-1)).toMatchObject({ result: "duplicate" });
  });

  it("rejects a charge with no Atlas billing transaction — gateway never called", async () => {
    const { store, state } = createStore();
    const { gateway, calls } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload();
    const rawBody = JSON.stringify(payload);

    const result = await processPaystackEvent(store, gateway, rawBody, payload);

    expect(result.result).toBe("rejected");
    expect(calls).toHaveLength(0);
    expect(state.subs.size).toBe(0);
    expect(state.billing.size).toBe(0);
    expect(state.verified).toHaveLength(0);
  });

  it("rejects when Paystack does not know the reference", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    const { gateway } = gatewayReturning(null);

    const payload = chargeSuccessPayload();
    const result = await processPaystackEvent(store, gateway, JSON.stringify(payload), payload);

    expect(result.result).toBe("rejected");
    expect(result.note).toMatch(/does not know reference/i);
    expect(state.billing.size).toBe(0);
  });

  it("rejects a wrong-amount payment (verified against Paystack, not the payload)", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    const { gateway } = gatewayReturning(verifiedFixture({ amount: 100 }));

    const payload = chargeSuccessPayload({ amount: 100 });
    const result = await processPaystackEvent(store, gateway, JSON.stringify(payload), payload);

    expect(result.result).toBe("rejected");
    expect(result.note).toMatch(/amount_mismatch/);
    expect(state.billing.size).toBe(0);
    expect(state.subs.size).toBe(0);
  });

  it("rejects a wrong-currency payment", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    const { gateway } = gatewayReturning(verifiedFixture({ currency: "USD" }));

    const payload = chargeSuccessPayload();
    const result = await processPaystackEvent(store, gateway, JSON.stringify(payload), payload);

    expect(result.result).toBe("rejected");
    expect(result.note).toMatch(/currency_mismatch/);
    expect(state.billing.size).toBe(0);
  });

  it("cross-tenant: another organization's echo can never activate ours", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    const { gateway } = gatewayReturning(verifiedFixture({ organizationId: OTHER_ORG }));

    const payload = chargeSuccessPayload();
    const result = await processPaystackEvent(store, gateway, JSON.stringify(payload), payload);

    expect(result.result).toBe("rejected");
    expect(result.note).toMatch(/organization_mismatch/);
    expect(state.billing.size).toBe(0);
    expect(state.subs.size).toBe(0);
  });

  it("throws when charge.success carries no reference (shape alarm ⇒ 5xx)", async () => {
    const { store, state } = createStore();
    const { gateway } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload({ reference: undefined });
    delete (payload.data as Record<string, unknown>).reference;

    await expect(
      processPaystackEvent(store, gateway, JSON.stringify(payload), payload),
    ).rejects.toThrow(/without a transaction reference/i);
    expect(state.events.size).toBe(0); // nothing recorded as processed
  });

  it("records unknown events without touching billing state", async () => {
    const { store, state } = createStore();
    const { gateway, calls } = gatewayReturning(verifiedFixture());
    const payload = eventFixture("charge.pending", { reference: REF });
    const rawBody = JSON.stringify(payload);

    const result = await processPaystackEvent(store, gateway, rawBody, payload);

    expect(result).toMatchObject({ result: "ignored", changed: false, organizationId: null });
    expect(calls).toHaveLength(0);
    expect(state.subs.size).toBe(0);
    expect(state.billing.size).toBe(0);
    expect(state.audits[0]?.result).toBe("ignored");
    expect(state.events.has(result.eventId)).toBe(true);
  });

  it("records informational refund events as ignored", async () => {
    const { store, state } = createStore();
    const payload = eventFixture("refund.processed", { reference: REF });
    const result = await processPaystackEvent(
      store,
      gatewayReturning(null).gateway,
      JSON.stringify(payload),
      payload,
    );
    expect(result.result).toBe("ignored");
    expect(result.note).toMatch(/does not change entitlement/i);
    expect(state.billing.size).toBe(0);
  });

  it("throws on a malformed payload (the handler answers 500 and retries)", async () => {
    const { store } = createStore();
    const payload = { nope: true };
    await expect(
      processPaystackEvent(store, gatewayReturning(null).gateway, JSON.stringify(payload), payload),
    ).rejects.toThrow(/malformed/i);
  });

  it("rejects an entitlement event that cannot be attributed to an organization", async () => {
    const { store, state } = createStore();
    const payload = eventFixture("invoice.payment_failed", { id: "INV_9", subscription_code: "SUB_unknown" });
    const result = await processPaystackEvent(
      store,
      gatewayReturning(null).gateway,
      JSON.stringify(payload),
      payload,
    );
    expect(result.result).toBe("rejected");
    expect(state.subs.size).toBe(0);
    expect(state.billing.size).toBe(0);
  });

  it("resolves the organization from a STORED subscription code", async () => {
    const { store, state } = createStore();
    state.subscriptions.set(SUBSCRIPTION, ORG);
    const payload = eventFixture("invoice.payment_failed", {
      id: "INV_10",
      subscription_code: SUBSCRIPTION,
    });

    const result = await processPaystackEvent(
      store,
      gatewayReturning(null).gateway,
      JSON.stringify(payload),
      payload,
    );

    expect(result).toMatchObject({ result: "processed", organizationId: ORG });
    expect(state.billing.get(ORG)).toBe("past_due");
    expect(state.subs.get(ORG)).toMatchObject({ status: "past_due", paymentStatus: "failed" });
  });

  it("falls back to a stored customer code when no subscription is stored yet", async () => {
    const { store, state } = createStore();
    state.customers.set(CUSTOMER, ORG);
    const payload = eventFixture("subscription.create", {
      subscription_code: "SUB_NEW",
      email_token: "tok_1",
      status: "active",
      customer: { customer_code: CUSTOMER },
    });

    const result = await processPaystackEvent(
      store,
      gatewayReturning(null).gateway,
      JSON.stringify(payload),
      payload,
    );

    expect(result).toMatchObject({ result: "processed", organizationId: ORG });
    expect(state.tokens.get(ORG)).toBe("tok_1");
    expect(state.billing.has(ORG)).toBe(false); // subscription.create never grants
    expect(state.subs.get(ORG)?.providerSubscriptionId).toBe("SUB_NEW");
  });

  it("propagates a persistence failure WITHOUT recording the event (retry-safe)", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    state.failOnSave = true;
    const { gateway } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload();
    const rawBody = JSON.stringify(payload);

    await expect(processPaystackEvent(store, gateway, rawBody, payload)).rejects.toThrow(
      /database unavailable/,
    );
    expect(state.events.size).toBe(0); // ledger written LAST → Paystack may retry
    expect(state.billing.size).toBe(0);
  });

  it("converts a Free Pilot organization once a paid state is written", async () => {
    const { store, state } = createStore();
    state.transactions.set(REF, transactionFixture());
    state.pilots.add(ORG);
    const { gateway } = gatewayReturning(verifiedFixture());
    const payload = chargeSuccessPayload();

    const result = await processPaystackEvent(store, gateway, JSON.stringify(payload), payload);

    expect(result.result).toBe("processed");
    expect(state.conversions).toHaveLength(1);
    expect(state.conversions[0].organizationId).toBe(ORG);
  });

  it("does not convert a pilot organization on a non-granting event", async () => {
    const { store, state } = createStore();
    state.subscriptions.set(SUBSCRIPTION, ORG);
    state.pilots.add(ORG);
    const payload = eventFixture("subscription.create", {
      subscription_code: SUBSCRIPTION,
      status: "active",
    });

    await processPaystackEvent(store, gatewayReturning(null).gateway, JSON.stringify(payload), payload);

    expect(state.conversions).toHaveLength(0);
    expect(state.billing.has(ORG)).toBe(false);
  });
});
