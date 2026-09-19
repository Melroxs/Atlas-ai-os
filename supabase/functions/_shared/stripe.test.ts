/**
 * Tests for supabase/functions/_shared/stripe.ts — the canonical server-side
 * Stripe module.
 *
 * The module reads secrets through Deno.env at call time, so we stub a minimal
 * Deno global (exactly what the Supabase Edge Runtime provides) and mock
 * globalThis.fetch. Signature verification is checked against an INDEPENDENT
 * implementation (node:crypto), so the tests cannot pass by reusing a buggy
 * in-repo HMAC.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  StripeApiError,
  atlasAppUrl,
  billingIntervalForInput,
  checkoutIdempotencyKey,
  configuredStripePrices,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripeCustomer,
  formEncode,
  internalPlanForSlug,
  invoicePaymentStatus,
  isStripeConfigured,
  listActiveSubscriptionsForCustomer,
  mapStripeSubscriptionStatus,
  organizationIdHintFromObject,
  parseStripeEvent,
  parseStripeSignatureHeader,
  planAndIntervalForStripePriceId,
  primaryPriceOfSubscription,
  resolveAtlasBillingState,
  stripeEnvironment,
  stripePriceEnvKey,
  stripePriceId,
  stripeRequest,
  timingSafeEqualHex,
  verifyStripeWebhookSignature,
} from "./stripe.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PRICE_IDS = {
  starterMonthly: "price_starter_monthly",
  starterYearly: "price_starter_yearly",
  growthMonthly: "price_growth_monthly",
  growthYearly: "price_growth_yearly",
  scaleMonthly: "price_scale_monthly",
  scaleYearly: "price_scale_yearly",
};

const BASE_ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_atlas",
  STRIPE_WEBHOOK_SECRET: "whsec_atlas_test",
  STRIPE_PRICE_STARTER_MONTHLY: PRICE_IDS.starterMonthly,
  STRIPE_PRICE_STARTER_YEARLY: PRICE_IDS.starterYearly,
  STRIPE_PRICE_GROWTH_MONTHLY: PRICE_IDS.growthMonthly,
  STRIPE_PRICE_GROWTH_YEARLY: PRICE_IDS.growthYearly,
  STRIPE_PRICE_SCALE_MONTHLY: PRICE_IDS.scaleMonthly,
  STRIPE_PRICE_SCALE_YEARLY: PRICE_IDS.scaleYearly,
  // Legacy trial configuration — must be ignored by the Stripe module.
  STRIPE_TRIAL_PRICE_ID: "price_trial_10",
  STRIPE_TRIAL_PERIOD_DAYS: "1",
  ATLAS_APP_URL: "https://atlas-ai-os.com",
};

function stubDeno(env: Record<string, string> = {}): void {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (key: string) => env[key] ?? "" },
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return await responder(call);
    }),
  );
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function form(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (body ?? "").split("&")) {
    if (!pair) continue;
    const [key, value] = pair.split("=");
    out[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
  }
  return out;
}

beforeEach(() => {
  stubDeno(BASE_ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).Deno;
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("environment configuration", () => {
  it("detects Stripe configuration without exposing the key", () => {
    expect(isStripeConfigured()).toBe(true);
    expect(stripeEnvironment()).toBe("test");
    stubDeno({ ...BASE_ENV, STRIPE_SECRET_KEY: "sk_live_real" });
    expect(stripeEnvironment()).toBe("live");
    stubDeno({ ...BASE_ENV, STRIPE_SECRET_KEY: "" });
    expect(isStripeConfigured()).toBe(false);
  });

  it("normalizes the app URL and defaults it", () => {
    expect(atlasAppUrl()).toBe("https://atlas-ai-os.com");
    stubDeno({ ...BASE_ENV, ATLAS_APP_URL: "https://staging.atlas-ai-os.com/" });
    expect(atlasAppUrl()).toBe("https://staging.atlas-ai-os.com");
    stubDeno({ ...BASE_ENV, ATLAS_APP_URL: "" });
    expect(atlasAppUrl()).toBe("https://atlas-ai-os.com");
  });
});

// ---------------------------------------------------------------------------
// Price mapping (the browser can only ask for plan + interval)
// ---------------------------------------------------------------------------

describe("plan + interval ➜ Stripe price id", () => {
  it("names the six price variables exactly as documented", () => {
    expect(stripePriceEnvKey("ATLAS_STARTER", "monthly")).toBe("STRIPE_PRICE_STARTER_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_STARTER", "annual")).toBe("STRIPE_PRICE_STARTER_YEARLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "monthly")).toBe("STRIPE_PRICE_GROWTH_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_GROWTH", "annual")).toBe("STRIPE_PRICE_GROWTH_YEARLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "monthly")).toBe("STRIPE_PRICE_SCALE_MONTHLY");
    expect(stripePriceEnvKey("ATLAS_SCALE", "annual")).toBe("STRIPE_PRICE_SCALE_YEARLY");
  });

  it("resolves all six combinations", () => {
    for (const plan of ["ATLAS_STARTER", "ATLAS_GROWTH", "ATLAS_SCALE"] as const) {
      for (const interval of ["monthly", "annual"] as const) {
        const priceId = stripePriceId(plan, interval);
        expect(priceId).toBeTruthy();
        expect(planAndIntervalForStripePriceId(priceId)).toEqual({ plan, interval });
      }
    }
  });

  it("fails closed when a price is unconfigured or unknown", () => {
    stubDeno({ ...BASE_ENV, STRIPE_PRICE_SCALE_YEARLY: "" });
    expect(stripePriceId("ATLAS_SCALE", "annual")).toBeNull();
    expect(planAndIntervalForStripePriceId(null)).toBeNull();
    expect(planAndIntervalForStripePriceId("price_unknown")).toBeNull();
  });

  it("reports configuration status without values", () => {
    const configured = configuredStripePrices();
    expect(configured).toHaveLength(6);
    expect(configured.every((entry) => entry.configured)).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(PRICE_IDS.starterMonthly);
  });

  it("normalizes client plan + interval input and rejects everything else", () => {
    expect(internalPlanForSlug("starter")).toBe("ATLAS_STARTER");
    expect(internalPlanForSlug(" scale ")).toBe("ATLAS_SCALE");
    expect(internalPlanForSlug("enterprise")).toBeNull();
    expect(internalPlanForSlug("price_123")).toBeNull();
    expect(internalPlanForSlug(42)).toBeNull();

    expect(billingIntervalForInput("month")).toBe("monthly");
    expect(billingIntervalForInput("year")).toBe("annual");
    expect(billingIntervalForInput("annual")).toBe("annual");
    expect(billingIntervalForInput("weekly")).toBeNull();
  });

  it("exposes no trial configuration at all", async () => {
    const stripe = await import("./stripe.ts");
    expect("stripeTrialPriceId" in stripe).toBe(false);
    expect("stripeTrialPeriodDays" in stripe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle ➜ entitlement mapping (the single decision point)
// ---------------------------------------------------------------------------

describe("Stripe lifecycle ➜ Atlas entitlement", () => {
  it("maps every documented Stripe status onto the Atlas vocabulary", () => {
    expect(mapStripeSubscriptionStatus("active")).toBe("active");
    expect(mapStripeSubscriptionStatus("trialing")).toBe("trialing");
    expect(mapStripeSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapStripeSubscriptionStatus("unpaid")).toBe("unpaid");
    expect(mapStripeSubscriptionStatus("incomplete")).toBe("incomplete");
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("incomplete_expired");
    expect(mapStripeSubscriptionStatus("paused")).toBe("paused");
    expect(mapStripeSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapStripeSubscriptionStatus("something_new")).toBe("unknown");
    expect(mapStripeSubscriptionStatus(null)).toBe("unknown");
  });

  it("grants paid access only for active/trialing", () => {
    expect(resolveAtlasBillingState("active")).toBe("active");
    expect(resolveAtlasBillingState("trialing")).toBe("active");
  });

  it("keeps the documented grace period for past_due", () => {
    expect(resolveAtlasBillingState("past_due")).toBe("past_due");
  });

  it("denies access for exhausted dunning, pause and cancellation", () => {
    expect(resolveAtlasBillingState("unpaid")).toBe("payment_failed");
    expect(resolveAtlasBillingState("incomplete")).toBe("payment_failed");
    expect(resolveAtlasBillingState("incomplete_expired")).toBe("cancelled");
    expect(resolveAtlasBillingState("canceled")).toBe("cancelled");
    expect(resolveAtlasBillingState("paused")).toBe("suspended");
  });

  it("fails closed for an unknown status", () => {
    expect(resolveAtlasBillingState("unknown")).toBe("payment_failed");
  });

  it("derives the payment status from an invoice", () => {
    expect(invoicePaymentStatus({ status: "paid", paid: true })).toBe("paid");
    expect(invoicePaymentStatus({ status: "open", paid: false })).toBe("pending");
    expect(invoicePaymentStatus({ status: "uncollectible" })).toBe("failed");
    expect(invoicePaymentStatus({ status: "void" })).toBe("unknown");
    expect(invoicePaymentStatus({})).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function sign(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

describe("verifyStripeWebhookSignature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1_700_000_000 });
  const now = 1_700_000_100;

  it("accepts a correctly signed payload", async () => {
    const header = `t=${now},v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, body, now)}`;
    const payload = await verifyStripeWebhookSignature(body, header, { nowSeconds: now });
    expect(payload.id).toBe("evt_1");
  });

  it("accepts a payload when one of several v1 signatures matches", async () => {
    const header = `t=${now},v1=deadbeef,v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, body, now)}`;
    await expect(
      verifyStripeWebhookSignature(body, header, { nowSeconds: now }),
    ).resolves.toMatchObject({ type: "invoice.paid" });
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const header = `t=${now},v1=${sign("whsec_attacker", body, now)}`;
    await expect(
      verifyStripeWebhookSignature(body, header, { nowSeconds: now }),
    ).rejects.toThrow(/verification failed/i);
  });

  it("rejects a tampered body (webhook forgery)", async () => {
    const header = `t=${now},v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, body, now)}`;
    const tampered = body.replace("invoice.paid", "customer.subscription.deleted");
    await expect(
      verifyStripeWebhookSignature(tampered, header, { nowSeconds: now }),
    ).rejects.toThrow(/verification failed/i);
  });

  it("rejects a stale timestamp (replay defence)", async () => {
    const stale = now - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 5;
    const header = `t=${stale},v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, body, stale)}`;
    await expect(
      verifyStripeWebhookSignature(body, header, { nowSeconds: now }),
    ).rejects.toThrow(/tolerance/i);
  });

  it("accepts a timestamp inside the tolerance window", async () => {
    const recent = now - STRIPE_SIGNATURE_TOLERANCE_SECONDS + 5;
    const header = `t=${recent},v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, body, recent)}`;
    await expect(
      verifyStripeWebhookSignature(body, header, { nowSeconds: now }),
    ).resolves.toBeTruthy();
  });

  it("rejects malformed or missing headers", async () => {
    await expect(verifyStripeWebhookSignature(body, null)).rejects.toThrow(/Malformed|Missing/i);
    await expect(verifyStripeWebhookSignature(body, "garbage")).rejects.toThrow(/Malformed|Missing/i);
    await expect(verifyStripeWebhookSignature(body, `t=${now}`)).rejects.toThrow(/Malformed|Missing/i);
  });

  it("rejects when the signing secret is not configured", async () => {
    stubDeno({ ...BASE_ENV, STRIPE_WEBHOOK_SECRET: "" });
    await expect(verifyStripeWebhookSignature(body, null)).rejects.toThrow(/not configured/i);
  });

  it("rejects a valid signature over a non-JSON body", async () => {
    const rawBody = "<not json>";
    const header = `t=${now},v1=${sign(BASE_ENV.STRIPE_WEBHOOK_SECRET, rawBody, now)}`;
    await expect(
      verifyStripeWebhookSignature(rawBody, header, { nowSeconds: now }),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("parses the signature header components", () => {
    expect(parseStripeSignatureHeader("t=123,v1=abc,v0=xyz")).toEqual({
      timestamp: 123,
      signatures: ["abc"],
    });
    expect(parseStripeSignatureHeader(null)).toEqual({ timestamp: null, signatures: [] });
  });

  it("compares digests without an early exit", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

describe("stripeRequest", () => {
  it("requires a configured secret key", async () => {
    stubDeno({ ...BASE_ENV, STRIPE_SECRET_KEY: "" });
    await expect(stripeRequest("GET", "/v1/customers/cus_1")).rejects.toMatchObject({
      name: "StripeApiError",
      status: 503,
    });
  });

  it("posts form-encoded bodies with the bearer key and idempotency header", async () => {
    const { calls } = mockFetch(() => jsonResponse({ id: "cus_1" }));
    const result = await stripeRequest<{ id: string }>(
      "POST",
      "/v1/customers",
      { email: "billing@example.com", metadata: { atlas_org_id: "org-1" } },
      { idempotencyKey: "atlas-customer-org-1" },
    );
    expect(result.id).toBe("cus_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_atlas");
    expect(headers["Idempotency-Key"]).toBe("atlas-customer-org-1");
    const parsed = form(String(calls[0].init.body));
    expect(parsed.email).toBe("billing@example.com");
    expect(parsed["metadata[atlas_org_id]"]).toBe("org-1");
  });

  it("sends the API version only when configured", async () => {
    const withVersion = mockFetch(() => jsonResponse({}));
    await stripeRequest("GET", "/v1/customers/cus_1");
    expect(
      (withVersion.calls[0].init.headers as Record<string, string>)["Stripe-Version"],
    ).toBeUndefined();

    stubDeno({ ...BASE_ENV, STRIPE_API_VERSION: "2025-01-01" });
    const pinned = mockFetch(() => jsonResponse({}));
    await stripeRequest("GET", "/v1/customers/cus_1");
    expect((pinned.calls[0].init.headers as Record<string, string>)["Stripe-Version"]).toBe(
      "2025-01-01",
    );
  });

  it("surfaces Stripe errors with status/code/param and no secret", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { message: "No such price: 'price_x'", code: "resource_missing", param: "line_items[0][price]" } },
        400,
      ),
    );
    try {
      await stripeRequest("POST", "/v1/checkout/sessions", {});
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StripeApiError);
      const error = e as StripeApiError;
      expect(error.status).toBe(400);
      expect(error.code).toBe("resource_missing");
      expect(error.param).toBe("line_items[0][price]");
      expect(error.message).toContain("No such price");
      expect(error.message).not.toContain("sk_test_atlas");
    }
  });

  it("treats a network failure or timeout abort as a transient error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    await expect(stripeRequest("GET", "/v1/customers/cus_1")).rejects.toMatchObject({
      name: "StripeApiError",
      status: 0,
    });
  });

  it("tolerates a non-JSON success body", async () => {
    mockFetch(() => new Response("", { status: 200 }));
    await expect(stripeRequest("GET", "/v1/customers/cus_1")).resolves.toBeNull();
  });
});

describe("formEncode", () => {
  it("encodes nested objects and arrays the way Stripe expects", () => {
    const encoded = formEncode({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      subscription_data: { trial_period_days: 1, metadata: { atlas_org_id: "org-1" } },
      skipped: undefined,
      alsoSkipped: null,
    });
    const parsed = form(String(encoded));
    expect(parsed.mode).toBe("subscription");
    expect(parsed["line_items[0][price]"]).toBe("price_1");
    expect(parsed["line_items[0][quantity]"]).toBe("1");
    expect(parsed["subscription_data[trial_period_days]"]).toBe("1");
    expect(parsed["subscription_data[metadata][atlas_org_id]"]).toBe("org-1");
    expect(encoded).not.toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

describe("customer + checkout session creation", () => {
  it("creates a customer with Atlas metadata and an idempotency key", async () => {
    const { calls } = mockFetch(() => jsonResponse({ id: "cus_new" }));
    const customer = await createStripeCustomer({
      organizationId: "org-42",
      email: "owner@example.com",
      name: "Acme Restoration",
    });
    expect(customer.id).toBe("cus_new");
    const parsed = form(String(calls[0].init.body));
    expect(parsed["metadata[atlas_org_id]"]).toBe("org-42");
    expect(parsed["metadata[atlas_environment]"]).toBe("test");
    expect(parsed.email).toBe("owner@example.com");
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "atlas-customer-org-42",
    );
  });

  it("omits empty personal fields from the customer payload", async () => {
    const { calls } = mockFetch(() => jsonResponse({ id: "cus_new" }));
    await createStripeCustomer({ organizationId: "org-42" });
    const body = String(calls[0].init.body);
    expect(body).not.toContain("email=");
    expect(body).not.toContain("name=");
  });

  it("creates a subscription-mode Checkout Session with only server-resolved prices", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
    );
    const session = await createStripeCheckoutSession({
      organizationId: "org-42",
      plan: "ATLAS_GROWTH",
      interval: "annual",
      priceId: PRICE_IDS.growthYearly,
      customerId: "cus_1",
      successUrl: "https://atlas-ai-os.com/pricing-success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://atlas-ai-os.com/pricing?checkout=cancelled",
      idempotencyKey: "atlas-checkout-org-42-ATLAS_GROWTH-annual-1",
    });

    expect(session.url).toContain("checkout.stripe.com");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");

    const parsed = form(String(calls[0].init.body));
    expect(parsed.mode).toBe("subscription");
    expect(parsed.customer).toBe("cus_1");
    expect(parsed.client_reference_id).toBe("org-42");
    expect(parsed["line_items[0][price]"]).toBe(PRICE_IDS.growthYearly);
    expect(parsed["line_items[0][quantity]"]).toBe("1");
    expect(parsed["subscription_data[metadata][atlas_org_id]"]).toBe("org-42");
    expect(parsed["metadata[atlas_plan]"]).toBe("ATLAS_GROWTH");
    expect(parsed["metadata[atlas_interval]"]).toBe("annual");
    expect(parsed["metadata[atlas_environment]"]).toBe("test");
    expect(parsed.success_url).toContain("/pricing-success");
    expect(parsed.cancel_url).toContain("/pricing");

    // No client-controllable amount, currency or arbitrary price may appear.
    expect(parsed).not.toHaveProperty("amount");
    expect(parsed).not.toHaveProperty("unit_amount");
    expect(parsed).not.toHaveProperty("currency");
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "atlas-checkout-org-42-ATLAS_GROWTH-annual-1",
    );
  });

  it("creates NO trial, one-time charge or coupon — even when legacy trial vars are set", async () => {
    // The legacy trial configuration is still present in the environment.
    expect(BASE_ENV.STRIPE_TRIAL_PRICE_ID).toBe("price_trial_10");

    const { calls } = mockFetch(() => jsonResponse({ id: "cs_2", url: "https://x.test" }));
    await createStripeCheckoutSession({
      organizationId: "org-42",
      plan: "ATLAS_STARTER",
      interval: "monthly",
      priceId: PRICE_IDS.starterMonthly,
      customerId: "cus_1",
      successUrl: "https://atlas-ai-os.com/pricing-success",
      cancelUrl: "https://atlas-ai-os.com/pricing",
    });

    const body = String(calls[0].init.body);
    const parsed = form(body);
    expect(parsed["line_items[0][price]"]).toBe(PRICE_IDS.starterMonthly);
    expect(body).not.toContain("trial_period_days");
    expect(body).not.toContain("trial");
    expect(body).not.toContain("add_invoice_items");
    expect(body).not.toContain("price_trial_10");
    expect(body).not.toContain("discounts");
    // Exactly one recurring line item.
    expect(body).not.toContain("line_items%5B1%5D");
  });

  it("buckets the checkout idempotency key so a double click reuses one session", () => {
    const now = 1_700_000_000_000;
    const first = checkoutIdempotencyKey("org-1", "ATLAS_STARTER", "monthly", now);
    const sameWindow = checkoutIdempotencyKey("org-1", "ATLAS_STARTER", "monthly", now + 60_000);
    const nextWindow = checkoutIdempotencyKey("org-1", "ATLAS_STARTER", "monthly", now + 11 * 60_000);
    expect(first).toBe(sameWindow);
    expect(nextWindow).not.toBe(first);
    expect(first).not.toContain("sk_");
  });

  it("creates a portal session for the stored customer", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ id: "bps_1", url: "https://billing.stripe.com/p/session/1" }),
    );
    const session = await createStripeBillingPortalSession({
      customerId: "cus_1",
      returnUrl: "https://atlas-ai-os.com/dashboard/billing",
    });
    expect(session.url).toBe("https://billing.stripe.com/p/session/1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const parsed = form(String(calls[0].init.body));
    expect(parsed.customer).toBe("cus_1");
    expect(parsed.return_url).toBe("https://atlas-ai-os.com/dashboard/billing");
  });

  it("filters manageable subscriptions for the duplicate guard", async () => {
    mockFetch(() =>
      jsonResponse({
        data: [
          { id: "sub_active", status: "active" },
          { id: "sub_canceled", status: "canceled" },
          { id: "sub_past_due", status: "past_due" },
        ],
      }),
    );
    const rows = await listActiveSubscriptionsForCustomer("cus_1");
    expect(rows.map((row) => row.id)).toEqual(["sub_active", "sub_past_due"]);
  });
});

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

describe("event parsing", () => {
  it("normalizes a verified event into milliseconds", () => {
    const event = parseStripeEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 1_700_000_000,
      data: { object: { id: "sub_1" } },
    });
    expect(event).toEqual({
      id: "evt_1",
      type: "customer.subscription.updated",
      createdMs: 1_700_000_000_000,
      object: { id: "sub_1" },
    });
  });

  it("rejects a malformed envelope", () => {
    expect(() => parseStripeEvent({ type: "invoice.paid" })).toThrow(/missing id or type/i);
    expect(() => parseStripeEvent({ id: "evt_1" })).toThrow(/missing id or type/i);
  });

  it("reads the Atlas organization hint from metadata or the checkout reference", () => {
    expect(organizationIdHintFromObject({ metadata: { atlas_org_id: "org-1" } })).toBe("org-1");
    expect(organizationIdHintFromObject({ client_reference_id: "org-2" })).toBe("org-2");
    expect(
      organizationIdHintFromObject({
        parent: { subscription_details: { metadata: { atlas_org_id: "org-3" } } },
      }),
    ).toBe("org-3");
    expect(organizationIdHintFromObject({ metadata: {} })).toBeNull();
    expect(organizationIdHintFromObject({})).toBeNull();
  });

  it("resolves the primary price and active flag of a subscription", () => {
    expect(
      primaryPriceOfSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: "price_1", active: true } }] },
      }),
    ).toEqual({ priceId: "price_1", active: true });

    expect(
      primaryPriceOfSubscription({
        id: "sub_2",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: "price_archived", active: false } }] },
      }),
    ).toEqual({ priceId: "price_archived", active: false });

    expect(
      primaryPriceOfSubscription({ id: "sub_3", customer: "cus_1", status: "active" }),
    ).toEqual({ priceId: null, active: null });
  });
});
