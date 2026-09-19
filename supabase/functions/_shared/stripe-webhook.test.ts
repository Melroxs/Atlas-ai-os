/**
 * Tests for supabase/functions/_shared/stripe-webhook.ts — the single
 * entitlement reconciliation path.
 *
 * The module takes its persistence and its Stripe reads as injected
 * dependencies, so this suite exercises the EXACT production logic (including
 * ordering guards and the idempotency ledger) against an in-memory store. No
 * Supabase project and no Stripe account are involved.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { StripeSubscription } from "./stripe.ts";
import {
  type AuditEntry,
  type BillingStore,
  type StripeGateway,
  type SubscriptionRow,
  hasManageableSubscription,
  processStripeWebhook,
  reconcileAtlasEntitlement,
} from "./stripe-webhook.ts";
import { rowFromDb, rowToDb } from "./stripe-rows.ts";
import { resolveAtlasBillingState } from "./stripe.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PRICE = {
  starterMonthly: "price_starter_monthly",
  starterYearly: "price_starter_yearly",
  growthMonthly: "price_growth_monthly",
  growthYearly: "price_growth_yearly",
  scaleMonthly: "price_scale_monthly",
  scaleYearly: "price_scale_yearly",
};

const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_atlas",
  STRIPE_WEBHOOK_SECRET: "whsec_atlas_test",
  STRIPE_PRICE_STARTER_MONTHLY: PRICE.starterMonthly,
  STRIPE_PRICE_STARTER_YEARLY: PRICE.starterYearly,
  STRIPE_PRICE_GROWTH_MONTHLY: PRICE.growthMonthly,
  STRIPE_PRICE_GROWTH_YEARLY: PRICE.growthYearly,
  STRIPE_PRICE_SCALE_MONTHLY: PRICE.scaleMonthly,
  STRIPE_PRICE_SCALE_YEARLY: PRICE.scaleYearly,
  ATLAS_APP_URL: "https://atlas-ai-os.com",
};

const ORG = "org-1";
const CUSTOMER = "cus_1";
const SUBSCRIPTION = "sub_1";

interface StoreState {
  rows: Map<string, SubscriptionRow>;
  events: Map<string, { result: string; organizationId: string | null }>;
  audits: AuditEntry[];
  billing: Map<string, string>;
  ops: string[];
}

function createStore(): BillingStore & { state: StoreState } {
  const state: StoreState = {
    rows: new Map(),
    events: new Map(),
    audits: [],
    billing: new Map(),
    ops: [],
  };

  const findBy = (
    key: "providerCustomerId" | "providerSubscriptionId",
    value: string,
  ): string | null => {
    for (const row of state.rows.values()) {
      if (row[key] === value) return row.organizationId;
    }
    return null;
  };

  return {
    state,
    async findProcessedEvent(eventId) {
      return state.events.get(eventId) ?? null;
    },
    async recordEvent(entry) {
      state.ops.push("recordEvent");
      // Mirrors the DB unique index on (provider, provider_event_id).
      if (!state.events.has(entry.providerEventId)) {
        state.events.set(entry.providerEventId, {
          result: entry.result,
          organizationId: entry.organizationId,
        });
      }
    },
    async loadSubscription(organizationId) {
      return state.rows.get(organizationId) ?? null;
    },
    async saveSubscription(row) {
      state.ops.push("saveSubscription");
      state.rows.set(row.organizationId, row);
    },
    async setBillingState(organizationId, billingState) {
      state.ops.push("setBillingState");
      state.billing.set(organizationId, billingState);
    },
    async appendAudit(entry) {
      state.ops.push("appendAudit");
      state.audits.push(entry);
    },
    async resolveOrganizationIdByCustomer(customerId) {
      return findBy("providerCustomerId", customerId);
    },
    async resolveOrganizationIdBySubscription(subscriptionId) {
      return findBy("providerSubscriptionId", subscriptionId);
    },
  };
}

function createGateway(
  subscription: StripeSubscription | null | (() => Promise<StripeSubscription | null>),
): StripeGateway {
  return {
    fetchSubscription: async () => {
      if (typeof subscription === "function") return await subscription();
      return subscription;
    },
  };
}

const T0 = 1_700_000_000; // seconds

function stripeSubscription(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: SUBSCRIPTION,
    customer: CUSTOMER,
    status: "active",
    current_period_start: T0,
    current_period_end: T0 + 2_592_000,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    metadata: { atlas_org_id: ORG },
    items: { data: [{ price: { id: PRICE.starterMonthly, active: true } }] },
    ...overrides,
  };
}

function subscriptionEvent(
  type: string,
  overrides: Partial<StripeSubscription> = {},
  id = "evt_sub",
): Record<string, unknown> {
  return {
    id,
    type,
    created: T0,
    data: { object: stripeSubscription(overrides) },
  };
}

function invoiceEvent(
  type: string,
  options: {
    id?: string;
    created?: number;
    invoiceId?: string;
    status?: string;
    paid?: boolean;
    subscription?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    id: options.id ?? "evt_inv",
    type,
    created: options.created ?? T0,
    data: {
      object: {
        id: options.invoiceId ?? "in_1",
        customer: CUSTOMER,
        subscription:
          options.subscription === undefined ? SUBSCRIPTION : options.subscription,
        status: options.status ?? "open",
        paid: options.paid ?? false,
        metadata: { atlas_org_id: ORG },
      },
    },
  };
}

function checkoutEvent(
  type: string,
  options: { metadata?: Record<string, string> | null } = {},
): Record<string, unknown> {
  return {
    id: "evt_checkout",
    type,
    created: T0,
    data: {
      object: {
        id: "cs_1",
        customer: CUSTOMER,
        subscription: SUBSCRIPTION,
        status: "complete",
        payment_status: "paid",
        client_reference_id: options.metadata === null ? null : ORG,
        metadata: options.metadata === null ? null : { atlas_org_id: ORG },
      },
    },
  };
}

/** A row already stored for the organization (an existing subscription). */
function storedRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    organizationId: ORG,
    billingProvider: "stripe",
    providerCustomerId: CUSTOMER,
    providerSubscriptionId: SUBSCRIPTION,
    providerPriceId: PRICE.starterMonthly,
    internalPlan: "ATLAS_STARTER",
    billingInterval: "monthly",
    status: "active",
    paymentStatus: "paid",
    trialStart: null,
    trialEnd: null,
    currentPeriodStart: T0 * 1000,
    currentPeriodEnd: (T0 + 2_592_000) * 1000,
    nextBilledAt: (T0 + 2_592_000) * 1000,
    cancelAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    latestInvoiceId: null,
    latestInvoiceAt: null,
    providerEventAt: T0 * 1000,
    createdAt: T0 * 1000,
    updatedAt: T0 * 1000,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => ENV[key] ?? "" },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Deno;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("processes a new event durably (state first, ledger last)", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent("customer.subscription.created"),
    );

    expect(result.result).toBe("processed");
    expect(result.organizationId).toBe(ORG);
    expect(store.state.rows.get(ORG)?.internalPlan).toBe("ATLAS_STARTER");
    expect(store.state.billing.get(ORG)).toBe("active");

    const saveIndex = store.state.ops.indexOf("saveSubscription");
    const ledgerIndex = store.state.ops.indexOf("recordEvent");
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerIndex).toBeGreaterThan(saveIndex);
  });

  it("ignores a duplicate delivery without touching state", async () => {
    const store = createStore();
    const gateway = createGateway(stripeSubscription());
    const event = subscriptionEvent("customer.subscription.created");

    await processStripeWebhook(store, gateway, event);
    const stateAfterFirst = JSON.stringify([...store.state.rows.entries()]);
    const opsAfterFirst = store.state.ops.length;

    const second = await processStripeWebhook(store, gateway, event);

    expect(second.result).toBe("duplicate");
    expect(second.changed).toBe(false);
    expect(JSON.stringify([...store.state.rows.entries()])).toBe(stateAfterFirst);
    // Only the duplicate audit is appended; no state write happens.
    expect(store.state.ops.slice(opsAfterFirst)).toEqual(["appendAudit"]);
  });

  it("a duplicate delivery can never create a second subscription row", async () => {
    const store = createStore();
    const gateway = createGateway(stripeSubscription());
    await processStripeWebhook(
      store,
      gateway,
      subscriptionEvent("customer.subscription.created"),
    );
    await processStripeWebhook(
      store,
      gateway,
      subscriptionEvent("customer.subscription.created"),
    );
    expect(store.state.rows.size).toBe(1);
    expect(store.state.audits.filter((entry) => entry.result === "duplicate")).toHaveLength(1);
  });

  it("records the event id in the ledger under the stripe provider", async () => {
    const store = createStore();
    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent("customer.subscription.created"),
    );
    expect(store.state.events.get("evt_sub")).toEqual({
      result: "processed",
      organizationId: ORG,
    });
  });
});

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

describe("event taxonomy", () => {
  it("ignores an unknown event type without corrupting billing state", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      {
        id: "evt_unknown",
        type: "radar.early_fraud_warning.created",
        created: T0,
        data: { object: { id: "issfr_1", metadata: { atlas_org_id: ORG } } },
      },
    );

    expect(result.result).toBe("ignored");
    expect(store.state.billing.size).toBe(0);
    expect(store.state.rows.get(ORG)?.internalPlan).toBe("ATLAS_STARTER");
    expect(store.state.events.has("evt_unknown")).toBe(true);
  });

  it("records refunds as informational without changing entitlement", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(store, createGateway(null), {
      id: "evt_refund",
      type: "charge.refunded",
      created: T0 + 100,
      data: { object: { id: "ch_1", customer: CUSTOMER, amount_refunded: 4900 } },
    });

    expect(result.result).toBe("ignored");
    expect(result.note).toMatch(/does not change entitlement/i);
    expect(store.state.billing.size).toBe(0);
    expect(store.state.rows.get(ORG)?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Organization resolution
// ---------------------------------------------------------------------------

describe("organization resolution", () => {
  it("resolves the organization from checkout metadata", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      checkoutEvent("checkout.session.completed"),
    );
    expect(result.organizationId).toBe(ORG);
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("resolves the organization from the stored Stripe customer", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const event = subscriptionEvent("customer.subscription.updated", {
      metadata: {},
      id: SUBSCRIPTION,
      customer: CUSTOMER,
    });
    // Remove the metadata hint entirely: only the customer id can resolve it.
    (event.data as { object: Record<string, unknown> }).object.metadata = null;

    const result = await processStripeWebhook(store, createGateway(stripeSubscription()), event);
    expect(result.organizationId).toBe(ORG);
  });

  it("rejects an event that cannot be attributed to an organization", async () => {
    const store = createStore();
    const result = await processStripeWebhook(store, createGateway(null), {
      id: "evt_orphan",
      type: "customer.subscription.updated",
      created: T0,
      data: {
        object: stripeSubscription({ customer: "cus_unknown", metadata: null }),
      },
    });

    expect(result.result).toBe("rejected");
    expect(result.organizationId).toBeNull();
    expect(store.state.billing.size).toBe(0);
    expect(store.state.events.get("evt_orphan")?.result).toBe("rejected");
    expect(
      store.state.audits.some((entry) => /could not resolve/i.test(entry.note)),
    ).toBe(true);
  });

  it("rejects a checkout completion with missing Atlas metadata", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      checkoutEvent("checkout.session.completed", { metadata: null }),
    );
    expect(result.result).toBe("rejected");
    expect(result.note).toMatch(/atlas_org_id/);
    expect(store.state.billing.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Checkout hand-off
// ---------------------------------------------------------------------------

describe("checkout.session.completed", () => {
  it("grants the plan only from the subscription Stripe reports", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(
        stripeSubscription({
          status: "trialing",
          trial_start: T0,
          trial_end: T0 + 86_400,
          items: { data: [{ price: { id: PRICE.growthYearly, active: true } }] },
        }),
      ),
      checkoutEvent("checkout.session.completed"),
    );

    expect(result.result).toBe("processed");
    const row = store.state.rows.get(ORG)!;
    expect(row.internalPlan).toBe("ATLAS_GROWTH");
    expect(row.billingInterval).toBe("annual");
    expect(row.status).toBe("trialing");
    expect(row.trialEnd).toBe((T0 + 86_400) * 1000);
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("does NOT grant access when the subscription contradicts the redirect", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "incomplete" })),
      checkoutEvent("checkout.session.completed"),
    );

    expect(store.state.rows.get(ORG)?.status).toBe("incomplete");
    expect(store.state.billing.get(ORG)).toBe("payment_failed");
    expect(result.note).toMatch(/billing_state=payment_failed/);
  });

  it("grants nothing when the session has no readable subscription yet", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(null),
      checkoutEvent("checkout.session.completed"),
    );
    expect(result.result).toBe("ignored");
    expect(store.state.billing.size).toBe(0);
  });

  it("ignores an expired checkout session", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(null),
      {
        id: "evt_expired",
        type: "checkout.session.expired",
        created: T0,
        data: {
          object: {
            id: "cs_expired",
            customer: CUSTOMER,
            subscription: null,
            metadata: { atlas_org_id: ORG },
          },
        },
      },
    );
    expect(result.result).toBe("ignored");
    expect(store.state.billing.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe("subscription lifecycle", () => {
  const cases: Array<[string, string, string, string | null]> = [
    ["active", "active", "active", "ATLAS_STARTER"],
    ["trialing", "trialing", "active", "ATLAS_STARTER"],
    ["past_due", "past_due", "past_due", "ATLAS_STARTER"],
    ["unpaid", "unpaid", "payment_failed", "ATLAS_STARTER"],
    ["incomplete", "incomplete", "payment_failed", null],
    ["incomplete_expired", "incomplete_expired", "cancelled", null],
    ["paused", "paused", "suspended", "ATLAS_STARTER"],
    ["canceled", "canceled", "cancelled", null],
  ];

  for (const [stripeStatus, storedStatus, billingState, plan] of cases) {
    it(`maps Stripe status ${stripeStatus} to ${billingState}`, async () => {
      const store = createStore();
      await processStripeWebhook(
        store,
        createGateway(stripeSubscription({ status: stripeStatus })),
        subscriptionEvent("customer.subscription.updated", { status: stripeStatus }),
      );
      const row = store.state.rows.get(ORG)!;
      expect(row.status).toBe(storedStatus);
      expect(store.state.billing.get(ORG)).toBe(billingState);
      expect(store.state.billing.get(ORG)).toBe(resolveAtlasBillingState(row.status));
      expect(row.internalPlan).toBe(plan);
    });
  }

  it("updates entitlement when the plan changes (starter → scale)", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.updated",
        {
          items: { data: [{ price: { id: PRICE.scaleYearly, active: true } }] },
        },
        "evt_plan_change",
      ),
    );

    expect(result.changed).toBe(true);
    expect(store.state.rows.get(ORG)?.internalPlan).toBe("ATLAS_SCALE");
    expect(store.state.rows.get(ORG)?.billingInterval).toBe("annual");
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("retains access until period end on a scheduled cancellation", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.updated",
        { cancel_at_period_end: true, cancel_at: T0 + 2_592_000 },
        "evt_cancel_scheduled",
      ),
    );

    const row = store.state.rows.get(ORG)!;
    expect(row.status).toBe("active");
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.cancelAt).toBe((T0 + 2_592_000) * 1000);
    expect(row.nextBilledAt).toBeNull();
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("revokes paid entitlement when the subscription is deleted", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.deleted",
        { status: "canceled", canceled_at: T0 + 100, cancel_at_period_end: false },
        "evt_deleted",
      ),
    );

    expect(result.changed).toBe(true);
    const row = store.state.rows.get(ORG)!;
    expect(row.status).toBe("canceled");
    expect(row.internalPlan).toBeNull();
    expect(row.billingInterval).toBeNull();
    expect(store.state.billing.get(ORG)).toBe("cancelled");
  });

  it("keeps a paid subscription identifiable by its Stripe customer", async () => {
    const store = createStore();
    await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ customer: { id: CUSTOMER } })),
      subscriptionEvent("customer.subscription.created"),
    );
    expect(store.state.rows.get(ORG)?.providerCustomerId).toBe(CUSTOMER);
  });
});

// ---------------------------------------------------------------------------
// Invoices, dunning and payment state
// ---------------------------------------------------------------------------

describe("invoice events", () => {
  it("renews from the subscription Stripe currently reports (invoice.paid)", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(
      store,
      createGateway(
        stripeSubscription({
          current_period_start: T0 + 2_592_000,
          current_period_end: T0 + 5_184_000,
        }),
      ),
      invoiceEvent("invoice.paid", { status: "paid", paid: true, invoiceId: "in_renewal" }),
    );

    const row = store.state.rows.get(ORG)!;
    expect(result.result).toBe("processed");
    expect(row.paymentStatus).toBe("paid");
    expect(row.currentPeriodEnd).toBe((T0 + 5_184_000) * 1000);
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("records a failed renewal and keeps the documented grace period", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "past_due" })),
      invoiceEvent("invoice.payment_failed", { status: "open", paid: false }),
    );

    const row = store.state.rows.get(ORG)!;
    expect(row.status).toBe("past_due");
    expect(row.paymentStatus).toBe("failed");
    // Grace: the access gate allows past_due while Stripe retries.
    expect(store.state.billing.get(ORG)).toBe("past_due");
  });

  it("flags a payment that needs authentication", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "past_due" })),
      invoiceEvent("invoice.payment_action_required", { status: "open", paid: false }),
    );

    expect(store.state.rows.get(ORG)?.paymentStatus).toBe("requires_action");
  });

  it("records invoice.finalized and uncollectible invoices safely", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      invoiceEvent("invoice.finalized", { status: "open", paid: false }),
    );
    expect(store.state.rows.get(ORG)?.paymentStatus).toBe("pending");

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "unpaid" })),
      invoiceEvent("invoice.marked_uncollectible", {
        status: "uncollectible",
        paid: false,
        id: "evt_uncollectible",
      }),
    );
    expect(store.state.rows.get(ORG)?.status).toBe("unpaid");
    expect(store.state.billing.get(ORG)).toBe("payment_failed");
  });

  it("does not revoke state when the subscription behind an invoice is gone", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    const result = await processStripeWebhook(
      store,
      createGateway(null),
      invoiceEvent("invoice.paid", { status: "paid", paid: true }),
    );

    expect(result.result).toBe("ignored");
    expect(store.state.rows.get(ORG)?.status).toBe("active");
    expect(store.state.billing.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prices Atlas does not know
// ---------------------------------------------------------------------------

describe("price handling", () => {
  it("never invents a plan for an unknown active Stripe price", async () => {
    const store = createStore();
    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.created",
        { items: { data: [{ price: { id: "price_created_by_ops", active: true } }] } },
        "evt_odd_price",
      ),
    );

    const row = store.state.rows.get(ORG)!;
    expect(result.result).toBe("ignored");
    expect(row.internalPlan).toBeNull();
    expect(result.note).toMatch(/not one of the configured Atlas prices/i);
  });

  it("keeps an existing plan when a paying customer's price is unrecognised", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow());

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.updated",
        { items: { data: [{ price: { id: "price_created_by_ops", active: true } }] } },
        "evt_odd_price_2",
      ),
    );

    // A paying customer is never silently downgraded; the mismatch is audited.
    expect(store.state.rows.get(ORG)?.internalPlan).toBe("ATLAS_STARTER");
    expect(store.state.audits.some((entry) => /not one of the configured/i.test(entry.note))).toBe(
      true,
    );
  });

  it("does not grant a plan from an inactive Stripe price", async () => {
    const store = createStore();
    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent(
        "customer.subscription.created",
        { items: { data: [{ price: { id: PRICE.starterMonthly, active: false } }] } },
        "evt_inactive_price",
      ),
    );
    expect(store.state.rows.get(ORG)?.internalPlan).toBeNull();
  });

  it("falls back to the stored price when an event omits the item", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow({ providerPriceId: PRICE.growthMonthly }));

    await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      subscriptionEvent("customer.subscription.updated", { items: undefined }, "evt_no_items"),
    );

    expect(store.state.rows.get(ORG)?.internalPlan).toBe("ATLAS_GROWTH");
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("out-of-order delivery", () => {
  it("ignores a stale subscription event", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow({ providerEventAt: (T0 + 600) * 1000 }));

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "canceled" })),
      subscriptionEvent("customer.subscription.deleted", { status: "canceled" }, "evt_stale"),
    );

    expect(result.result).toBe("ignored");
    expect(result.note).toMatch(/out-of-order/i);
    expect(store.state.rows.get(ORG)?.status).toBe("active");
    expect(store.state.billing.size).toBe(0);
    expect(store.state.events.has("evt_stale")).toBe(true);
  });

  it("ignores a stale invoice event", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow({ latestInvoiceAt: (T0 + 600) * 1000 }));

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription({ status: "unpaid" })),
      invoiceEvent("invoice.payment_failed", { created: T0, status: "open" }),
    );

    expect(result.result).toBe("ignored");
    expect(result.note).toMatch(/newer invoice outcome/i);
  });

  it("still applies a newer invoice after a newer subscription event", async () => {
    const store = createStore();
    store.state.rows.set(ORG, storedRow({ providerEventAt: (T0 + 100) * 1000 }));

    const result = await processStripeWebhook(
      store,
      createGateway(stripeSubscription()),
      invoiceEvent("invoice.paid", { created: T0 + 200, status: "paid", paid: true }),
    );

    expect(result.result).toBe("processed");
    expect(store.state.rows.get(ORG)?.paymentStatus).toBe("paid");
    expect(store.state.rows.get(ORG)?.latestInvoiceAt).toBe((T0 + 200) * 1000);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  it("propagates a Stripe API failure so the caller can answer 5xx", async () => {
    const store = createStore();
    const gateway = createGateway(async () => {
      throw new Error("Stripe request failed: timeout");
    });

    await expect(
      processStripeWebhook(store, gateway, checkoutEvent("checkout.session.completed")),
    ).rejects.toThrow(/timeout/);

    // Nothing was recorded, so Stripe's retry reprocesses the event.
    expect(store.state.events.size).toBe(0);
    expect(store.state.billing.size).toBe(0);
  });

  it("propagates a database failure and leaves the ledger empty for the retry", async () => {
    const store = createStore();
    store.saveSubscription = async () => {
      throw new Error("subscription save failed: connection reset");
    };

    await expect(
      processStripeWebhook(
        store,
        createGateway(stripeSubscription()),
        subscriptionEvent("customer.subscription.created"),
      ),
    ).rejects.toThrow(/subscription save failed/);

    expect(store.state.events.size).toBe(0);
  });

  it("rejects a malformed event envelope", async () => {
    const store = createStore();
    await expect(
      processStripeWebhook(store, createGateway(null), { type: "invoice.paid" }),
    ).rejects.toThrow(/missing id or type/i);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation unit surface
// ---------------------------------------------------------------------------

describe("reconcileAtlasEntitlement", () => {
  it("maps plan + interval from the Stripe price", () => {
    const result = reconcileAtlasEntitlement({
      organizationId: ORG,
      subscription: stripeSubscription({
        items: { data: [{ price: { id: PRICE.scaleMonthly, active: true } }] },
      }),
      existing: null,
      paymentStatus: "paid",
      eventAt: T0 * 1000,
      eventType: "customer.subscription.created",
      eventId: "evt_1",
    });
    expect(result.row.internalPlan).toBe("ATLAS_SCALE");
    expect(result.row.billingInterval).toBe("monthly");
    expect(result.billingState).toBe("active");
  });

  it("keeps created_at and preserves the stored customer id", () => {
    const existing = storedRow({ createdAt: 1234, providerCustomerId: CUSTOMER });
    const result = reconcileAtlasEntitlement({
      organizationId: ORG,
      subscription: stripeSubscription({ customer: null }),
      existing,
      paymentStatus: "paid",
      eventAt: T0 * 1000,
      eventType: "customer.subscription.updated",
      eventId: "evt_2",
    });
    expect(result.row.createdAt).toBe(1234);
    expect(result.row.providerCustomerId).toBe(CUSTOMER);
  });

  it("clears the plan association once the subscription is over", () => {
    const result = reconcileAtlasEntitlement({
      organizationId: ORG,
      subscription: stripeSubscription({ status: "canceled" }),
      existing: storedRow(),
      paymentStatus: "paid",
      eventAt: T0 * 1000,
      eventType: "customer.subscription.deleted",
      eventId: "evt_3",
    });
    expect(result.row.internalPlan).toBeNull();
    expect(result.billingState).toBe("cancelled");
  });
});

describe("hasManageableSubscription", () => {
  it("routes live subscriptions to the billing portal", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"] as const) {
      expect(hasManageableSubscription(storedRow({ status }))).toBe(true);
    }
  });

  it("allows a fresh checkout when there is no live subscription", () => {
    expect(hasManageableSubscription(null)).toBe(false);
    expect(hasManageableSubscription(storedRow({ status: "canceled" }))).toBe(false);
    expect(hasManageableSubscription(storedRow({ status: "unknown" }))).toBe(false);
    expect(
      hasManageableSubscription(storedRow({ status: "active", providerSubscriptionId: null })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

describe("organization_subscriptions row mapping", () => {
  it("round-trips the processor row through the database shape", () => {
    const row = storedRow();
    const db = rowToDb(row);
    expect(db.billing_provider).toBe("stripe");
    expect(db.organization_id).toBe(ORG);
    expect(db.cancel_at_period_end).toBe(false);
    expect(rowFromDb(db)).toEqual(row);
  });

  it("defaults safely for a legacy row that predates the Stripe columns", () => {
    const mapped = rowFromDb({
      organization_id: ORG,
      billing_provider: "paddle",
      provider_customer_id: "ctm_legacy",
      status: "active",
    });
    expect(mapped.status).toBe("active");
    expect(mapped.paymentStatus).toBe("unknown");
    expect(mapped.cancelAtPeriodEnd).toBe(false);
    expect(mapped.providerSubscriptionId).toBeNull();
  });
});
