import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setActiveAdapter, resolveBillingState } from "./provider";
import { PADDLE_ADAPTER } from "./paddle";
import { processPaddleWebhook, type BillingStorage } from "./webhook";
import type {
  OrganizationSubscription,
  ProcessedWebhookEvent,
} from "./types";

const PRICE_IDS = {
  starterMonthly: "pri_test_starter_monthly",
  starterAnnual: "pri_test_starter_annual",
  growthMonthly: "pri_test_growth_monthly",
  growthAnnual: "pri_test_growth_annual",
  scaleMonthly: "pri_test_scale_monthly",
  scaleAnnual: "pri_test_scale_annual",
} as const;

const ORG = "11111111-1111-1111-1111-111111111111";

class MemoryStorage implements BillingStorage {
  subscriptions = new Map<string, OrganizationSubscription>();
  webhookEvents = new Map<string, ProcessedWebhookEvent>();
  audits: Array<Record<string, unknown>> = [];
  byCustomer = new Map<string, string>();
  bySubscription = new Map<string, string>();
  saveSubscriptionCalls = 0;

  async loadSubscription(organizationId: string) {
    return this.subscriptions.get(organizationId) ?? null;
  }
  async saveSubscription(record: OrganizationSubscription) {
    this.saveSubscriptionCalls++;
    this.subscriptions.set(record.organization_id, { ...record });
  }
  async loadWebhookEvent(providerEventId: string) {
    return this.webhookEvents.get(providerEventId) ?? null;
  }
  async saveWebhookEvent(record: ProcessedWebhookEvent) {
    this.webhookEvents.set(record.provider_event_id, { ...record });
  }
  async appendAuditEntry(
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
  ) {
    this.audits.push({ ...event, organizationId, providerEventAt: providerEventAt ?? null });
  }
  async resolveOrganizationIdFromProviderCustomer(customerId: string) {
    return this.byCustomer.get(customerId) ?? null;
  }
  async resolveOrganizationIdFromProviderSubscription(subscriptionId: string) {
    return this.bySubscription.get(subscriptionId) ?? null;
  }
}

function subscriptionEvent(
  overrides: Partial<{
    eventId: string;
    eventType: string;
    subscriptionId: string;
    customerId: string;
    status: string;
    priceId: string;
    plan: string;
    interval: string;
    organizationIdHint: string | null;
    trialEnd: string | null;
    occurredAt: string;
  }>,
): Record<string, unknown> {
  const {
    eventId = "evt_default",
    eventType = "subscription.trialing",
    subscriptionId = "sub_1",
    customerId = "ctm_1",
    status = "trialing",
    priceId = PRICE_IDS.growthMonthly,
    plan = "ATLAS_GROWTH",
    interval = "monthly",
    organizationIdHint = ORG,
    trialEnd = "2024-05-12T10:18:47Z",
    occurredAt = "2024-05-11T10:18:47Z",
  } = overrides;

  return {
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    data: {
      id: subscriptionId,
      status,
      customer_id: customerId,
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: organizationIdHint
        ? {
            atlas_organization_id: organizationIdHint,
            atlas_internal_plan: plan,
            atlas_billing_interval: interval,
          }
        : {},
      current_billing_period: {
        starts_at: occurredAt,
        ends_at: trialEnd,
      },
      trial_dates: status === "trialing" ? { starts_at: occurredAt, ends_at: trialEnd } : null,
      next_billed_at: trialEnd,
      canceled_at: null,
      scheduled_change: null,
    },
  };
}

beforeAll(() => {
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  process.env.PADDLE_API_KEY = "test_api_key";
  process.env.PADDLE_WEBHOOK_SECRET = "test_secret";
  process.env.PADDLE_STARTER_PRICE_ID_MONTHLY = PRICE_IDS.starterMonthly;
  process.env.PADDLE_STARTER_PRICE_ID_ANNUAL = PRICE_IDS.starterAnnual;
  process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY = PRICE_IDS.growthMonthly;
  process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL = PRICE_IDS.growthAnnual;
  process.env.PADDLE_SCALE_PRICE_ID_MONTHLY = PRICE_IDS.scaleMonthly;
  process.env.PADDLE_SCALE_PRICE_ID_ANNUAL = PRICE_IDS.scaleAnnual;
  setActiveAdapter(PADDLE_ADAPTER);
});

afterAll(() => {
  delete process.env.PADDLE_ENVIRONMENT;
  delete process.env.PADDLE_API_KEY;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_STARTER_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_STARTER_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_SCALE_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_SCALE_PRICE_ID_ANNUAL;
});

describe("processPaddleWebhook", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("creates a trialing subscription and grants trial access", async () => {
    const result = await processPaddleWebhook(
      storage,
      subscriptionEvent({}),
      "paddle",
    );

    expect(result.accepted).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.organizationId).toBe(ORG);

    const record = await storage.loadSubscription(ORG);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("trialing");
    expect(record!.internal_plan).toBe("ATLAS_GROWTH");
    expect(record!.billing_interval).toBe("monthly");
    expect(record!.provider_subscription_id).toBe("sub_1");
    expect(record!.trial_end).toBe(Date.parse("2024-05-12T10:18:47Z"));

    // A paid Paddle trial grants the plan's entitlements.
    const state = resolveBillingState(record);
    expect(state.isActive).toBe(true);
    expect(state.canUsePaidFeatures).toBe(true);
    expect(state.plan).toBe("ATLAS_GROWTH");
  });

  it("is idempotent: the same event id is applied exactly once", async () => {
    const payload = subscriptionEvent({ eventId: "evt_dup" });
    const first = await processPaddleWebhook(storage, payload, "paddle");
    expect(first.changed).toBe(true);

    const callsAfterFirst = storage.saveSubscriptionCalls;
    const second = await processPaddleWebhook(storage, payload, "paddle");

    expect(second.accepted).toBe(true);
    expect(second.changed).toBe(false);
    expect(storage.saveSubscriptionCalls).toBe(callsAfterFirst);
    expect(storage.subscriptions.size).toBe(1);
    expect(storage.webhookEvents.get("evt_dup")?.result).toBe("processed");
    expect(storage.audits.some((a) => a.result === "duplicate")).toBe(true);
  });

  it("walks the lifecycle: trialing → active → past_due → canceled → resumed", async () => {
    const mk = (eventId: string, eventType: string, status: string) =>
      subscriptionEvent({ eventId, eventType, status, subscriptionId: "sub_life" });

    await processPaddleWebhook(storage, mk("e1", "subscription.trialing", "trialing"), "paddle");
    await processPaddleWebhook(storage, mk("e2", "subscription.activated", "active"), "paddle");

    let record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("active");
    expect(resolveBillingState(record).isActive).toBe(true);

    await processPaddleWebhook(storage, mk("e3", "subscription.past_due", "past_due"), "paddle");
    record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("past_due");
    expect(resolveBillingState(record).isActive).toBe(false);

    await processPaddleWebhook(storage, mk("e4", "subscription.canceled", "canceled"), "paddle");
    record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("canceled");
    expect(resolveBillingState(record).isActive).toBe(false);

    await processPaddleWebhook(storage, mk("e5", "subscription.resumed", "active"), "paddle");
    record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("active");
    expect(resolveBillingState(record).isActive).toBe(true);

    // Plan/interval survive across transitions.
    expect(record!.internal_plan).toBe("ATLAS_GROWTH");
    expect(record!.billing_interval).toBe("monthly");
  });

  it("syncs a plan/interval change via subscription.updated", async () => {
    await processPaddleWebhook(
      storage,
      subscriptionEvent({ eventId: "e1", eventType: "subscription.trialing", status: "trialing", priceId: PRICE_IDS.starterMonthly, plan: "ATLAS_STARTER", interval: "monthly" }),
      "paddle",
    );
    await processPaddleWebhook(
      storage,
      subscriptionEvent({
        eventId: "e2",
        eventType: "subscription.updated",
        status: "active",
        priceId: PRICE_IDS.scaleAnnual,
        plan: "ATLAS_SCALE",
        interval: "annual",
      }),
      "paddle",
    );

    const record = await storage.loadSubscription(ORG);
    expect(record!.internal_plan).toBe("ATLAS_SCALE");
    expect(record!.billing_interval).toBe("annual");
    expect(record!.status).toBe("active");
  });

  it("resolves the organization from custom data", async () => {
    const result = await processPaddleWebhook(
      storage,
      subscriptionEvent({ eventId: "evt_org_hint" }),
      "paddle",
    );
    expect(result.organizationId).toBe(ORG);
  });

  it("falls back to provider customer id when custom data is absent", async () => {
    storage.byCustomer.set("ctm_fallback", ORG);
    const result = await processPaddleWebhook(
      storage,
      subscriptionEvent({
        eventId: "evt_org_customer",
        organizationIdHint: null,
        customerId: "ctm_fallback",
        subscriptionId: "sub_fallback",
      }),
      "paddle",
    );
    expect(result.organizationId).toBe(ORG);
  });

  it("rejects events that cannot be resolved to an organization", async () => {
    await expect(
      processPaddleWebhook(
        storage,
        subscriptionEvent({
          eventId: "evt_unknown_org",
          organizationIdHint: null,
          customerId: "ctm_unknown",
          subscriptionId: "sub_unknown",
        }),
        "paddle",
      ),
    ).rejects.toThrow("could not be resolved to an organization");
  });

  it("ignores unknown event types safely", async () => {
    const result = await processPaddleWebhook(
      storage,
      {
        event_id: "evt_unknown_type",
        event_type: "product.updated",
        occurred_at: "2024-05-11T10:18:47Z",
        data: {},
      },
      "paddle",
    );
    expect(result.accepted).toBe(true);
    expect(result.changed).toBe(false);
    expect(storage.subscriptions.size).toBe(0);
    expect(storage.webhookEvents.get("evt_unknown_type")?.result).toBe("ignored");
  });

  it("treats transaction.completed as informational (no subscription state change)", async () => {
    const result = await processPaddleWebhook(
      storage,
      {
        event_id: "evt_txn_completed",
        event_type: "transaction.completed",
        occurred_at: "2024-05-11T10:18:47Z",
        data: {
          id: "txn_1",
          customer_id: "ctm_1",
          custom_data: { atlas_organization_id: ORG },
          items: [{ price_id: PRICE_IDS.growthMonthly, quantity: 1 }],
        },
      },
      "paddle",
    );
    expect(result.accepted).toBe(true);
    expect(result.changed).toBe(false);
    expect(storage.subscriptions.size).toBe(0);
    expect(storage.webhookEvents.get("evt_txn_completed")?.result).toBe("ignored");
  });

  it("ignores an out-of-order event: an older delivery never overwrites newer state", async () => {
    // Newer event first (trialing, occurred 2024-05-11).
    const newer = await processPaddleWebhook(
      storage,
      subscriptionEvent({
        eventId: "evt_newer",
        eventType: "subscription.trialing",
        status: "trialing",
        occurredAt: "2024-05-11T10:18:47Z",
        trialEnd: "2024-05-12T10:18:47Z",
      }),
      "paddle",
    );
    expect(newer.changed).toBe(true);

    // Older event arrives late (canceled, occurred 2024-05-09) — it must be
    // recorded as processed (so a retry is not reprocessed) but its state
    // must NOT overwrite the newer trialing state.
    const older = await processPaddleWebhook(
      storage,
      subscriptionEvent({
        eventId: "evt_older",
        eventType: "subscription.canceled",
        status: "canceled",
        occurredAt: "2024-05-09T10:18:47Z",
        trialEnd: "2024-05-12T10:18:47Z",
      }),
      "paddle",
    );

    expect(older.accepted).toBe(true);
    expect(older.changed).toBe(false);

    const record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("trialing");
    expect(record!.provider_event_at).toBe(Date.parse("2024-05-11T10:18:47Z"));

    // The stale event is ledgered as ignored (never replayed) and audited.
    expect(storage.webhookEvents.get("evt_older")?.result).toBe("ignored");
    expect(
      storage.audits.some(
        (a) =>
          a.providerEventId === "evt_older" &&
          a.result === "ignored" &&
          String(a.note).includes("Out-of-order"),
      ),
    ).toBe(true);
  });

  it("applies an equal-timestamp event (full-state upsert is safe)", async () => {
    await processPaddleWebhook(
      storage,
      subscriptionEvent({ eventId: "evt_a", status: "trialing", occurredAt: "2024-05-11T10:18:47Z" }),
      "paddle",
    );
    // Same occurred_at, different event id → applied, never rejected.
    const same = await processPaddleWebhook(
      storage,
      subscriptionEvent({ eventId: "evt_b", status: "active", occurredAt: "2024-05-11T10:18:47Z" }),
      "paddle",
    );
    expect(same.changed).toBe(true);
    const record = await storage.loadSubscription(ORG);
    expect(record!.status).toBe("active");
  });

  it("grants the paid trial access but never from a browser-supplied value", async () => {
    // The browser could claim plan=scale + status=active, but the webhook
    // processor derives state from the verified payload's price id — a
    // payload carrying an unconfigured price id resolves to no plan.
    const result = await processPaddleWebhook(
      storage,
      subscriptionEvent({
        eventId: "evt_forged",
        status: "active",
        priceId: "pri_forged_not_configured",
        plan: "ATLAS_SCALE",
      }),
      "paddle",
    );
    expect(result.changed).toBe(true);

    const record = await storage.loadSubscription(ORG);
    // Status is trusted from the provider; plan resolution must NOT trust the
    // forged custom data when the price id is unknown.
    expect(record!.status).toBe("active");
    expect(record!.internal_plan).toBeNull();
    expect(resolveBillingState(record).plan).toBeNull();
  });
});