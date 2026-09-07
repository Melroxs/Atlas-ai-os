import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  PADDLE_ADAPTER,
  verifyPaddleWebhookSignature,
  mapPaddleStatus,
  paddleDateToMs,
} from "./paddle";

const SECRET = "pdl_ntfset_test_secret_key_1234567890";
const PRICE_IDS = {
  starterMonthly: "pri_test_starter_monthly",
  starterAnnual: "pri_test_starter_annual",
  growthMonthly: "pri_test_growth_monthly",
  growthAnnual: "pri_test_growth_annual",
  scaleMonthly: "pri_test_scale_monthly",
  scaleAnnual: "pri_test_scale_annual",
} as const;

function setEnv() {
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  process.env.PADDLE_API_KEY = "test_api_key";
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.PADDLE_STARTER_PRICE_ID_MONTHLY = PRICE_IDS.starterMonthly;
  process.env.PADDLE_STARTER_PRICE_ID_ANNUAL = PRICE_IDS.starterAnnual;
  process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY = PRICE_IDS.growthMonthly;
  process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL = PRICE_IDS.growthAnnual;
  process.env.PADDLE_SCALE_PRICE_ID_MONTHLY = PRICE_IDS.scaleMonthly;
  process.env.PADDLE_SCALE_PRICE_ID_ANNUAL = PRICE_IDS.scaleAnnual;
}

function clearEnv() {
  delete process.env.PADDLE_ENVIRONMENT;
  delete process.env.PADDLE_API_KEY;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_STARTER_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_STARTER_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_GROWTH_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_GROWTH_PRICE_ID_ANNUAL;
  delete process.env.PADDLE_SCALE_PRICE_ID_MONTHLY;
  delete process.env.PADDLE_SCALE_PRICE_ID_ANNUAL;
}

function signHeader(rawBody: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

describe("Paddle webhook signature verification", () => {
  beforeEach(setEnv);
  afterEach(clearEnv);

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created" });
    const payload = verifyPaddleWebhookSignature(body, signHeader(body));
    expect(payload.event_id).toBe("evt_1");
  });

  it("accepts a valid signature among rotated keys (second h1 matches)", () => {
    const body = JSON.stringify({ event_id: "evt_2" });
    const good = signHeader(body);
    const header = `ts=${Math.floor(Date.now() / 1000)};h1=${"0".repeat(64)};${good.split(";")[1]}`;
    expect(() => verifyPaddleWebhookSignature(body, header)).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ event_id: "evt_1", amount: 10 });
    const header = signHeader(body);
    const tampered = JSON.stringify({ event_id: "evt_1", amount: 9999 });
    expect(() => verifyPaddleWebhookSignature(tampered, header)).toThrow(
      "signature verification failed",
    );
  });

  it("rejects a signature made with a different secret", () => {
    const body = JSON.stringify({ event_id: "evt_1" });
    const header = signHeader(body, "wrong_secret");
    expect(() => verifyPaddleWebhookSignature(body, header)).toThrow(
      "signature verification failed",
    );
  });

  it("rejects a missing header", () => {
    expect(() => verifyPaddleWebhookSignature("{}", null)).toThrow(
      "Missing Paddle webhook signature header",
    );
  });

  it("rejects a malformed header (no ts or no h1)", () => {
    expect(() => verifyPaddleWebhookSignature("{}", "ts=123")).toThrow("malformed");
    expect(() => verifyPaddleWebhookSignature("{}", "h1=abcd")).toThrow("malformed");
  });

  it("rejects a replay (timestamp too old)", () => {
    const body = JSON.stringify({ event_id: "evt_1" });
    const oldTs = Math.floor(Date.now() / 1000) - 6 * 60;
    const header = signHeader(body, SECRET, oldTs);
    expect(() => verifyPaddleWebhookSignature(body, header)).toThrow(
      "outside tolerance",
    );
  });

  it("rejects a future timestamp", () => {
    const body = JSON.stringify({ event_id: "evt_1" });
    const futureTs = Math.floor(Date.now() / 1000) + 6 * 60;
    const header = signHeader(body, SECRET, futureTs);
    expect(() => verifyPaddleWebhookSignature(body, header)).toThrow(
      "outside tolerance",
    );
  });

  it("rejects malformed JSON bodies", () => {
    const body = "{not json";
    const header = signHeader(body);
    expect(() => verifyPaddleWebhookSignature(body, header)).toThrow(
      "not valid JSON",
    );
  });

  it("throws when the webhook secret is not configured", () => {
    delete process.env.PADDLE_WEBHOOK_SECRET;
    expect(() => verifyPaddleWebhookSignature("{}", "ts=1;h1=ab")).toThrow(
      "PADDLE_WEBHOOK_SECRET is not configured",
    );
  });
});

describe("Paddle Billing v1 webhook parsing", () => {
  beforeEach(setEnv);
  afterEach(clearEnv);

  it("parses subscription.trialing with trial dates, period and custom data", () => {
    const payload = {
      event_id: "evt_01h0trial1",
      event_type: "subscription.trialing",
      occurred_at: "2024-05-11T10:18:47.635628Z",
      data: {
        id: "sub_01h0trial1",
        status: "trialing",
        customer_id: "ctm_01h0trial1",
        items: [{ price_id: PRICE_IDS.growthMonthly, quantity: 1 }],
        custom_data: {
          atlas_organization_id: "11111111-1111-1111-1111-111111111111",
          atlas_internal_plan: "ATLAS_GROWTH",
          atlas_billing_interval: "monthly",
        },
        billing_cycle: { interval: "month", frequency: 1 },
        current_billing_period: {
          starts_at: "2024-05-11T10:18:47Z",
          ends_at: "2024-05-12T10:18:47Z",
        },
        trial_dates: {
          starts_at: "2024-05-11T10:18:47Z",
          ends_at: "2024-05-12T10:18:47Z",
        },
        next_billed_at: "2024-06-11T10:18:47Z",
        canceled_at: null,
        scheduled_change: null,
      },
    };

    const event = PADDLE_ADAPTER.parseWebhookEvent(payload);

    expect(event.providerEventId).toBe("evt_01h0trial1");
    expect(event.eventType).toBe("subscription.trialing");
    expect(event.status).toBe("trialing");
    expect(event.active).toBe(true);
    expect(event.providerSubscriptionId).toBe("sub_01h0trial1");
    expect(event.providerCustomerId).toBe("ctm_01h0trial1");
    expect(event.providerPriceId).toBe(PRICE_IDS.growthMonthly);
    expect(event.internalPlan).toBe("ATLAS_GROWTH");
    expect(event.billingInterval).toBe("monthly");
    expect(event.organizationIdHint).toBe("11111111-1111-1111-1111-111111111111");
    expect(event.trialStart).toBe(Date.parse("2024-05-11T10:18:47Z"));
    expect(event.trialEnd).toBe(Date.parse("2024-05-12T10:18:47Z"));
    expect(event.currentPeriodStart).toBe(Date.parse("2024-05-11T10:18:47Z"));
    expect(event.currentPeriodEnd).toBe(Date.parse("2024-05-12T10:18:47Z"));
    expect(event.nextBilledAt).toBe(Date.parse("2024-06-11T10:18:47Z"));
    expect(event.providerEventAt).toBe(Date.parse("2024-05-11T10:18:47.635628Z"));
  });

  it("maps price id → plan when custom data lacks the plan (never trusts display values)", () => {
    const payload = {
      event_id: "evt_2",
      event_type: "subscription.activated",
      occurred_at: "2024-05-12T10:18:47Z",
      data: {
        id: "sub_2",
        status: "active",
        customer_id: "ctm_2",
        items: [{ price_id: PRICE_IDS.scaleAnnual, quantity: 1 }],
        custom_data: { atlas_organization_id: "org-2" },
      },
    };
    const event = PADDLE_ADAPTER.parseWebhookEvent(payload);
    expect(event.internalPlan).toBe("ATLAS_SCALE");
    expect(event.billingInterval).toBe("annual");
    expect(event.status).toBe("active");
    expect(event.organizationIdHint).toBe("org-2");
  });

  it("extracts cancel-at-period-end from scheduled_change", () => {
    const payload = {
      event_id: "evt_3",
      event_type: "subscription.updated",
      occurred_at: "2024-05-13T10:18:47Z",
      data: {
        id: "sub_3",
        status: "active",
        customer_id: "ctm_3",
        items: [{ price_id: PRICE_IDS.starterMonthly, quantity: 1 }],
        scheduled_change: {
          action: "cancel",
          effective_at: "2024-06-11T10:18:47Z",
        },
      },
    };
    const event = PADDLE_ADAPTER.parseWebhookEvent(payload);
    expect(event.status).toBe("active");
    expect(event.cancelAt).toBe(Date.parse("2024-06-11T10:18:47Z"));
    expect(event.canceledAt).toBeNull();
  });

  it("parses subscription.canceled with canceled_at", () => {
    const payload = {
      event_id: "evt_4",
      event_type: "subscription.canceled",
      occurred_at: "2024-06-11T10:18:47Z",
      data: {
        id: "sub_4",
        status: "canceled",
        customer_id: "ctm_4",
        items: [{ price_id: PRICE_IDS.starterMonthly, quantity: 1 }],
        canceled_at: "2024-06-11T10:18:47Z",
      },
    };
    const event = PADDLE_ADAPTER.parseWebhookEvent(payload);
    expect(event.status).toBe("canceled");
    expect(event.active).toBe(false);
    expect(event.canceledAt).toBe(Date.parse("2024-06-11T10:18:47Z"));
  });

  it("rejects events without event_id or event_type", () => {
    expect(() =>
      PADDLE_ADAPTER.parseWebhookEvent({ event_type: "subscription.updated" }),
    ).toThrow("no event_id");
    expect(() =>
      PADDLE_ADAPTER.parseWebhookEvent({ event_id: "evt_5" }),
    ).toThrow("no event_type");
  });
});

describe("status and date helpers", () => {
  it("maps Paddle statuses into the Atlas model", () => {
    expect(mapPaddleStatus("active")).toBe("active");
    expect(mapPaddleStatus("trialing")).toBe("trialing");
    expect(mapPaddleStatus("past_due")).toBe("past_due");
    expect(mapPaddleStatus("paused")).toBe("paused");
    expect(mapPaddleStatus("canceled")).toBe("canceled");
    expect(mapPaddleStatus("ACTIVE")).toBe("active");
    expect(mapPaddleStatus("bogus")).toBe("unknown");
    expect(mapPaddleStatus(null)).toBe("unknown");
  });

  it("converts RFC3339 strings to Unix ms", () => {
    expect(paddleDateToMs("2024-05-11T10:18:47Z")).toBe(
      Date.parse("2024-05-11T10:18:47Z"),
    );
    expect(paddleDateToMs(null)).toBeNull();
    expect(paddleDateToMs("not-a-date")).toBeNull();
  });
});