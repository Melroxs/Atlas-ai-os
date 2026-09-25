/**
 * Regression tests for the billing defects found on the live Stripe TEST-mode
 * subscription on 2026-09-20.
 *
 * D1 — the billing period is read from the wrong place.
 *   API version 2026-08-26.dahlia moved `current_period_start` /
 *   `current_period_end` off the Subscription object and onto each subscription
 *   item. `reconcileAtlasEntitlement` read only the top level, so a real paid
 *   subscription persisted NULL periods (the Billing UI showed an active plan
 *   with no renewal date).
 *
 * D3 — `latest_invoice_id` was never persisted at all.
 *   `reconcileAtlasEntitlement` computed the invoice id into a local and never
 *   assigned it to the row it returns, so the column stayed NULL for every
 *   subscription. `tsconfig.app.json` only includes `src`, so `tsc -b` never
 *   examined this directory and the omission was invisible to the typechecker.
 *
 * D2 — a stale event can overwrite newer billing fields.
 *   Stripe delivered `customer.subscription.created`, `invoice.paid` and
 *   `invoice.finalized` with an identical `event_at`, handled concurrently. The
 *   subscription-state handler carries no invoice information; when its write
 *   landed last it reset `payment_status` to 'unknown' and NULLed
 *   `latest_invoice_*`, discarding an invoice outcome Stripe had already
 *   reported.
 *
 * The D2 protection lives in the persistence layer:
 *   * `mergeSubscriptionWrite` (this module) — the pure rule, applied by the
 *     processor and unit-tested below.
 *   * `billing_upsert_subscription` (migration 20260921) — the same rule under a
 *     row lock, which is what makes it atomic between two genuinely concurrent
 *     webhook invocations. The racing store below mirrors that SQL so the
 *     end-to-end sequence is exercised without a database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StripeSubscription } from "./stripe.ts";
import {
  type AuditEntry,
  type BillingStore,
  type StripeGateway,
  type SubscriptionRow,
  mergeSubscriptionWrite,
  processStripeWebhook,
  reconcileAtlasEntitlement,
} from "./stripe-webhook.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORG = "org-1";
const CUSTOMER = "cus_1";
const SUBSCRIPTION = "sub_1";

/** The exact period Stripe reported for the live test subscription. */
const DAHLIA_PERIOD_START = 1_789_882_606;
const DAHLIA_PERIOD_END = 1_792_474_606;

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

const T0 = 1_700_000_000; // seconds

beforeEach(() => {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => ENV[key] ?? "" },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Deno;
});

/**
 * A subscription exactly as API 2026-08-26.dahlia serialises it: no top-level
 * period fields, the period on the item.
 */
function dahliaSubscription(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: SUBSCRIPTION,
    customer: CUSTOMER,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    latest_invoice: null,
    metadata: { atlas_org_id: ORG },
    items: {
      data: [
        {
          current_period_start: DAHLIA_PERIOD_START,
          current_period_end: DAHLIA_PERIOD_END,
          price: { id: PRICE.starterMonthly, active: true },
        },
      ],
    },
    ...overrides,
  } as StripeSubscription;
}

function reconcile(subscription: StripeSubscription | null, existing: SubscriptionRow | null = null) {
  return reconcileAtlasEntitlement({
    organizationId: ORG,
    subscription,
    existing,
    paymentStatus: "unknown",
    eventAt: T0 * 1000,
    eventType: "customer.subscription.created",
    eventId: "evt_1",
  });
}

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
    latestInvoiceId: "in_1",
    latestInvoiceAt: T0 * 1000,
    providerEventAt: T0 * 1000,
    createdAt: T0 * 1000,
    updatedAt: T0 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D1 — billing period extraction
// ---------------------------------------------------------------------------

describe("D1 — billing period extraction", () => {
  it("reads the period from the subscription item (2026-08-26.dahlia payload)", () => {
    const { row } = reconcile(dahliaSubscription());

    expect(row.currentPeriodStart).toBe(DAHLIA_PERIOD_START * 1000);
    expect(row.currentPeriodEnd).toBe(DAHLIA_PERIOD_END * 1000);
    // `next_billed_at` is what the Billing UI renders as the renewal date.
    expect(row.nextBilledAt).toBe(DAHLIA_PERIOD_END * 1000);
    expect(row.status).toBe("active");
    expect(row.internalPlan).toBe("ATLAS_STARTER");
    expect(row.billingInterval).toBe("monthly");
  });

  it("still reads the top-level period fields (pre-dahlia payloads)", () => {
    const legacy = dahliaSubscription({
      current_period_start: T0,
      current_period_end: T0 + 2_592_000,
      items: { data: [{ price: { id: PRICE.starterMonthly, active: true } }] },
    });

    const { row } = reconcile(legacy);
    expect(row.currentPeriodStart).toBe(T0 * 1000);
    expect(row.currentPeriodEnd).toBe((T0 + 2_592_000) * 1000);
    expect(row.nextBilledAt).toBe((T0 + 2_592_000) * 1000);
  });

  it("prefers the top-level period when a payload carries both shapes", () => {
    const both = dahliaSubscription({
      current_period_start: T0,
      current_period_end: T0 + 2_592_000,
    });

    const { row } = reconcile(both);
    expect(row.currentPeriodStart).toBe(T0 * 1000);
    expect(row.currentPeriodEnd).toBe((T0 + 2_592_000) * 1000);
  });

  it("records the period but no next charge for a cancel-at-period-end subscription", () => {
    const cancelling = dahliaSubscription({ cancel_at_period_end: true });

    const { row } = reconcile(cancelling);
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.currentPeriodEnd).toBe(DAHLIA_PERIOD_END * 1000);
    expect(row.nextBilledAt).toBeNull();
  });

  it("keeps the stored period when the payload carries none", () => {
    const noPeriod = dahliaSubscription({
      items: { data: [{ price: { id: PRICE.starterMonthly, active: true } }] },
    });

    const { row } = reconcile(noPeriod, storedRow());
    expect(row.currentPeriodStart).toBe(T0 * 1000);
    expect(row.currentPeriodEnd).toBe((T0 + 2_592_000) * 1000);
  });
});

// ---------------------------------------------------------------------------
// D3 — every SubscriptionRow field must actually be written
//
// `tsconfig.app.json` includes only `src`, so this directory is not covered by
// `tsc -b`; a field the reconciler forgets to assign therefore fails silently as
// a permanently NULL column. That is exactly what happened to
// `latest_invoice_id`.
// ---------------------------------------------------------------------------

describe("D3 — row completeness", () => {
  it("reconcileAtlasEntitlement assigns every SubscriptionRow field", () => {
    const { row } = reconcile(dahliaSubscription());
    const missing = (Object.keys(storedRow()) as Array<keyof SubscriptionRow>).filter(
      (key) => !(key in row),
    );

    expect(missing).toEqual([]);
  });

  it("persists the invoice identity on an invoice event", () => {
    const { row } = reconcileAtlasEntitlement({
      organizationId: ORG,
      subscription: dahliaSubscription(),
      existing: null,
      paymentStatus: "paid",
      latestInvoiceId: "in_1",
      eventAt: T0 * 1000,
      eventType: "invoice.paid",
      eventId: "evt_1",
    });

    expect(row.latestInvoiceId).toBe("in_1");
    expect(row.latestInvoiceAt).toBe(T0 * 1000);
  });
});

// ---------------------------------------------------------------------------
// D2 — the merge rule itself
// ---------------------------------------------------------------------------

describe("D2 — mergeSubscriptionWrite", () => {
  it("applies the incoming row verbatim when nothing is stored", () => {
    const incoming = storedRow({ paymentStatus: "unknown", latestInvoiceId: null });
    expect(mergeSubscriptionWrite(null, incoming)).toBe(incoming);
  });

  it("does not let a stale snapshot clear a newer invoice outcome", () => {
    // The subscription-state handler's row: no invoice information at all.
    const stale = storedRow({
      paymentStatus: "unknown",
      latestInvoiceId: null,
      latestInvoiceAt: null,
      providerEventAt: T0 * 1000,
    });

    const merged = mergeSubscriptionWrite(storedRow(), stale);

    expect(merged.paymentStatus).toBe("paid");
    expect(merged.latestInvoiceId).toBe("in_1");
    expect(merged.latestInvoiceAt).toBe(T0 * 1000);
    // ...while the subscription family from the stale read is still applied,
    // because its watermark ties the stored one.
    expect(merged.status).toBe("active");
    expect(merged.currentPeriodEnd).toBe((T0 + 2_592_000) * 1000);
  });

  it("does not let an older subscription snapshot roll back the subscription family", () => {
    const stored = storedRow({ providerEventAt: (T0 + 10) * 1000, status: "active" });
    const stale = storedRow({
      providerEventAt: T0 * 1000,
      status: "incomplete",
      internalPlan: null,
      billingInterval: null,
      providerPriceId: null,
      cancelAtPeriodEnd: true,
    });

    const merged = mergeSubscriptionWrite(stored, stale);

    expect(merged.status).toBe("active");
    expect(merged.internalPlan).toBe("ATLAS_STARTER");
    expect(merged.billingInterval).toBe("monthly");
    expect(merged.providerPriceId).toBe(PRICE.starterMonthly);
    expect(merged.cancelAtPeriodEnd).toBe(false);
    expect(merged.providerEventAt).toBe((T0 + 10) * 1000);
  });

  it("applies a newer invoice outcome", () => {
    const stored = storedRow({ paymentStatus: "pending", latestInvoiceId: "in_1", latestInvoiceAt: T0 * 1000 });
    const newer = storedRow({ paymentStatus: "paid", latestInvoiceId: "in_2", latestInvoiceAt: (T0 + 60) * 1000 });

    const merged = mergeSubscriptionWrite(stored, newer);

    expect(merged.paymentStatus).toBe("paid");
    expect(merged.latestInvoiceId).toBe("in_2");
    expect(merged.latestInvoiceAt).toBe((T0 + 60) * 1000);
  });

  it("never replaces a known payment outcome with 'unknown'", () => {
    const stored = storedRow({ paymentStatus: "paid", latestInvoiceAt: T0 * 1000 });
    const unknown = storedRow({ paymentStatus: "unknown", latestInvoiceAt: (T0 + 60) * 1000 });

    const merged = mergeSubscriptionWrite(stored, unknown);

    expect(merged.paymentStatus).toBe("paid");
    expect(merged.latestInvoiceAt).toBe((T0 + 60) * 1000);
  });

  it("moves watermarks forward only and keeps the row identity and creation time", () => {
    const stored = storedRow({
      organizationId: ORG,
      createdAt: T0 * 1000,
      updatedAt: (T0 + 30) * 1000,
      providerEventAt: (T0 + 30) * 1000,
      latestInvoiceAt: (T0 + 20) * 1000,
    });
    const late = storedRow({
      organizationId: ORG,
      createdAt: (T0 + 5) * 1000,
      updatedAt: (T0 + 10) * 1000,
      providerEventAt: (T0 + 1) * 1000,
      latestInvoiceAt: (T0 + 2) * 1000,
    });

    const merged = mergeSubscriptionWrite(stored, late);

    expect(merged.providerEventAt).toBe((T0 + 30) * 1000);
    expect(merged.latestInvoiceAt).toBe((T0 + 20) * 1000);
    expect(merged.createdAt).toBe(T0 * 1000);
    expect(merged.updatedAt).toBe((T0 + 30) * 1000);
  });
});

// ---------------------------------------------------------------------------
// D2 — the concurrent delivery sequence, end to end through the processor
// ---------------------------------------------------------------------------

interface RaceState {
  row: SubscriptionRow | null;
  /** Canned reads returned to the next handler, so a run can be given a stale view. */
  staleReads: Array<SubscriptionRow | null>;
  processed: Set<string>;
  billing: Map<string, string>;
  audits: AuditEntry[];
}

/**
 * Mirrors the deployed persistence: `loadSubscription` can hand a handler a
 * deliberately stale view (what concurrent delivery produces), while
 * `saveSubscription` behaves like `billing_upsert_subscription` — the incoming
 * row is merged over the row CURRENTLY stored, under the same rules.
 */
function createRacingStore(initialRow: SubscriptionRow): BillingStore & { state: RaceState } {
  const state: RaceState = {
    row: initialRow,
    staleReads: [],
    processed: new Set(),
    billing: new Map(),
    audits: [],
  };

  const findBy = (key: "providerCustomerId" | "providerSubscriptionId", value: string) => {
    const row = state.row;
    return row && row[key] === value ? row.organizationId : null;
  };

  return {
    state,
    async findProcessedEvent(eventId) {
      return state.processed.has(eventId) ? { result: "processed", organizationId: ORG } : null;
    },
    async recordEvent(entry) {
      state.processed.add(entry.providerEventId);
    },
    async loadSubscription() {
      if (state.staleReads.length > 0) return state.staleReads.shift() ?? null;
      return state.row;
    },
    async saveSubscription(row) {
      state.row = mergeSubscriptionWrite(state.row, row);
    },
    async setBillingState(organizationId, billingState) {
      state.billing.set(organizationId, billingState);
    },
    async appendAudit(entry) {
      state.audits.push(entry);
    },
    async resolveOrganizationIdByCustomer(customerId) {
      return findBy("providerCustomerId", customerId);
    },
    async resolveOrganizationIdBySubscription(id) {
      return findBy("providerSubscriptionId", id);
    },
  };
}

const gateway: StripeGateway = {
  fetchSubscription: async () => dahliaSubscription(),
};

/** The row `tenants_init_for_checkout` leaves behind: customer known, no state yet. */
function preCheckoutRow(): SubscriptionRow {
  return {
    organizationId: ORG,
    billingProvider: "stripe",
    providerCustomerId: CUSTOMER,
    providerSubscriptionId: null,
    providerPriceId: null,
    internalPlan: null,
    billingInterval: null,
    status: "unknown",
    paymentStatus: "unknown",
    trialStart: null,
    trialEnd: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextBilledAt: null,
    cancelAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    latestInvoiceId: null,
    latestInvoiceAt: null,
    providerEventAt: null,
    createdAt: T0 * 1000,
    updatedAt: T0 * 1000,
  };
}

/** `invoice.paid` as API 2026-08-26.dahlia serialises it. */
function invoicePaidEvent(): Record<string, unknown> {
  return {
    id: "evt_invoice_paid",
    type: "invoice.paid",
    // Identical to the subscription event: this is why the per-watermark
    // ordering guard alone could not reject the stale writer.
    created: T0,
    data: {
      object: {
        id: "in_1",
        customer: CUSTOMER,
        status: "paid",
        parent: { subscription_details: { subscription: SUBSCRIPTION } },
        metadata: { atlas_org_id: ORG },
      },
    },
  };
}

function subscriptionCreatedEvent(): Record<string, unknown> {
  return {
    id: "evt_sub_created",
    type: "customer.subscription.created",
    created: T0,
    data: { object: dahliaSubscription() },
  };
}

describe("D2 — concurrent deliveries for one subscription", () => {
  it("a stale event landing last cannot erase the invoice outcome (live defect)", async () => {
    const store = createRacingStore(preCheckoutRow());

    const before = store.state.row;

    // Both invocations read the SAME pre-invoice snapshot, as concurrent
    // handlers on one subscription do.
    store.state.staleReads.push(before, before);

    // Invoice handler runs and writes first.
    const invoice = await processStripeWebhook(store, gateway, invoicePaidEvent());
    expect(invoice.result).toBe("processed");
    expect(store.state.row?.paymentStatus).toBe("paid");
    expect(store.state.row?.latestInvoiceId).toBe("in_1");

    // Subscription handler — whose snapshot predates the invoice write — lands
    // LAST. This is the delivery that used to clobber the record.
    const subscription = await processStripeWebhook(store, gateway, subscriptionCreatedEvent());
    expect(subscription.result).toBe("processed");

    const row = store.state.row!;
    // Pre-fix this was 'unknown' with both invoice fields NULL.
    expect(row.paymentStatus).toBe("paid");
    expect(row.latestInvoiceId).toBe("in_1");
    expect(row.latestInvoiceAt).toBe(T0 * 1000);
    // ...and the subscription state from the later delivery is intact, including
    // the period that D1 fixes.
    expect(row.status).toBe("active");
    expect(row.internalPlan).toBe("ATLAS_STARTER");
    expect(row.currentPeriodStart).toBe(DAHLIA_PERIOD_START * 1000);
    expect(row.currentPeriodEnd).toBe(DAHLIA_PERIOD_END * 1000);
    expect(store.state.billing.get(ORG)).toBe("active");
  });

  it("the reverse arrival order produces the same stored row", async () => {
    const store = createRacingStore(preCheckoutRow());
    const before = store.state.row;
    store.state.staleReads.push(before, before);

    await processStripeWebhook(store, gateway, subscriptionCreatedEvent());
    await processStripeWebhook(store, gateway, invoicePaidEvent());

    const row = store.state.row!;
    expect(row.paymentStatus).toBe("paid");
    expect(row.latestInvoiceId).toBe("in_1");
    expect(row.status).toBe("active");
    expect(row.currentPeriodEnd).toBe(DAHLIA_PERIOD_END * 1000);
  });

  it("a redelivered event is still idempotent", async () => {
    const store = createRacingStore(preCheckoutRow());

    const first = await processStripeWebhook(store, gateway, invoicePaidEvent());
    expect(first.result).toBe("processed");

    const after = { ...store.state.row! };
    const duplicate = await processStripeWebhook(store, gateway, invoicePaidEvent());

    expect(duplicate.result).toBe("duplicate");
    expect(store.state.row).toEqual(after);
  });
});
