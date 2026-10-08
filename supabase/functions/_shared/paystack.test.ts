/**
 * Tests for supabase/functions/_shared/paystack.ts — the canonical server-side
 * Paystack module (the counterpart of stripe.test.ts).
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
  PaystackApiError,
  PAYSTACK_REFERENCE_WINDOW_MS,
  billingIntervalForInput,
  createPaystackCustomer,
  disablePaystackSubscription,
  fetchPaystackCustomer,
  fetchPaystackSubscription,
  fetchPaystackTransaction,
  hmacSha512Hex,
  initializePaystackTransaction,
  internalPlanForSlug,
  isPaystackConfigured,
  paystackAppUrl,
  paystackCheckoutConfig,
  paystackCheckoutReference,
  paystackCurrency,
  paystackEnvironment,
  paystackPlanCode,
  paystackPlanEnvKey,
  paystackPriceEnvKey,
  paystackPriceSubunits,
  paystackRequest,
  paystackSecretKey,
  paystackWebhookEventId,
  timingSafeEqualHex,
  validateVerifiedPayment,
  verifyWebhookSignature,
} from "./paystack.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PLAN_CODES = {
  starterMonthly: "PLN_atlas_starter_monthly",
  starterYearly: "PLN_atlas_starter_yearly",
  growthMonthly: "PLN_atlas_growth_monthly",
  growthYearly: "PLN_atlas_growth_yearly",
  scaleMonthly: "PLN_atlas_scale_monthly",
  scaleYearly: "PLN_atlas_scale_yearly",
};

const BASE_ENV: Record<string, string> = {
  PAYSTACK_SECRET_KEY: "sk_test_atlas",
  PAYSTACK_CURRENCY: "zar",
  PAYSTACK_PLAN_STARTER_MONTHLY: PLAN_CODES.starterMonthly,
  PAYSTACK_PLAN_STARTER_YEARLY: PLAN_CODES.starterYearly,
  PAYSTACK_PLAN_GROWTH_MONTHLY: PLAN_CODES.growthMonthly,
  PAYSTACK_PLAN_GROWTH_YEARLY: PLAN_CODES.growthYearly,
  PAYSTACK_PLAN_SCALE_MONTHLY: PLAN_CODES.scaleMonthly,
  PAYSTACK_PLAN_SCALE_YEARLY: PLAN_CODES.scaleYearly,
  PAYSTACK_PRICE_STARTER_MONTHLY: "89900",
  PAYSTACK_PRICE_STARTER_YEARLY: "899000",
  PAYSTACK_PRICE_GROWTH_MONTHLY: "269900",
  PAYSTACK_PRICE_GROWTH_YEARLY: "2599000",
  PAYSTACK_PRICE_SCALE_MONTHLY: "549900",
  PAYSTACK_PRICE_SCALE_YEARLY: "5299000",
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

beforeEach(() => {
  stubDeno(BASE_ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).Deno;
});

// ---------------------------------------------------------------------------
// Environment / catalog configuration
// ---------------------------------------------------------------------------

describe("environment configuration", () => {
  it("detects Paystack configuration without exposing the key", () => {
    expect(isPaystackConfigured()).toBe(true);
    expect(paystackSecretKey()).toBe("sk_test_atlas");
    expect(paystackEnvironment()).toBe("test");
    stubDeno({ ...BASE_ENV, PAYSTACK_SECRET_KEY: "sk_live_real" });
    expect(paystackEnvironment()).toBe("live");
    stubDeno({ ...BASE_ENV, PAYSTACK_SECRET_KEY: "" });
    expect(isPaystackConfigured()).toBe(false);
  });

  it("normalizes currency to uppercase", () => {
    expect(paystackCurrency()).toBe("ZAR");
    stubDeno({ ...BASE_ENV, PAYSTACK_CURRENCY: "" });
    expect(paystackCurrency()).toBe("");
  });

  it("normalizes the app URL and defaults it", () => {
    expect(paystackAppUrl()).toBe("https://atlas-ai-os.com");
    stubDeno({ ...BASE_ENV, ATLAS_APP_URL: "https://staging.atlas-ai-os.com/" });
    expect(paystackAppUrl()).toBe("https://staging.atlas-ai-os.com");
    stubDeno({ ...BASE_ENV, ATLAS_APP_URL: "" });
    expect(paystackAppUrl()).toBe("https://atlas-ai-os.com");
  });
});

describe("plan + interval normalization (the browser sends only these)", () => {
  it("accepts canonical slugs and aliases, rejects everything else", () => {
    expect(internalPlanForSlug("starter")).toBe("ATLAS_STARTER");
    expect(internalPlanForSlug(" GROWTH ")).toBe("ATLAS_GROWTH");
    expect(internalPlanForSlug("SCALE")).toBe("ATLAS_SCALE");
    expect(internalPlanForSlug("enterprise")).toBeNull();
    expect(internalPlanForSlug(42)).toBeNull();
    expect(internalPlanForSlug(null)).toBeNull();

    expect(billingIntervalForInput("monthly")).toBe("monthly");
    expect(billingIntervalForInput("month")).toBe("monthly");
    expect(billingIntervalForInput("annual")).toBe("annual");
    expect(billingIntervalForInput("yearly")).toBe("annual");
    expect(billingIntervalForInput("weekly")).toBeNull();
    expect(billingIntervalForInput({})).toBeNull();
  });

  it("maps plan + interval to the documented env key names", () => {
    expect(paystackPlanEnvKey("ATLAS_STARTER", "monthly")).toBe(
      "PAYSTACK_PLAN_STARTER_MONTHLY",
    );
    expect(paystackPlanEnvKey("ATLAS_GROWTH", "annual")).toBe(
      "PAYSTACK_PLAN_GROWTH_YEARLY",
    );
    expect(paystackPriceEnvKey("ATLAS_SCALE", "annual")).toBe(
      "PAYSTACK_PRICE_SCALE_YEARLY",
    );
    expect(paystackPlanCode("ATLAS_STARTER", "monthly")).toBe(
      PLAN_CODES.starterMonthly,
    );
    expect(paystackPriceSubunits("ATLAS_STARTER", "monthly")).toBe(89900);
  });
});

describe("checkout configuration fails closed", () => {
  it("resolves the full fixed ZAR price when configured", () => {
    const resolved = paystackCheckoutConfig("ATLAS_GROWTH", "monthly");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config).toEqual({
        plan: "ATLAS_GROWTH",
        interval: "monthly",
        planCode: PLAN_CODES.growthMonthly,
        amountSubunits: 269900,
        currency: "ZAR",
      });
    }
  });

  it("reports the missing keys instead of a zero-amount charge", () => {
    const env = { ...BASE_ENV };
    delete env.PAYSTACK_PRICE_STARTER_MONTHLY;
    stubDeno(env);
    const resolved = paystackCheckoutConfig("ATLAS_STARTER", "monthly");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.missing).toContain("PAYSTACK_PRICE_STARTER_MONTHLY");
    }
  });

  it("rejects a non-integer or non-positive configured price", () => {
    // A decimal-looking price is a configuration mistake (subunits only) and
    // must fail closed instead of silently charging 899 subunits.
    for (const bad of ["899.00", "899.5", "-100", "1e5", "free"]) {
      stubDeno({ ...BASE_ENV, PAYSTACK_PRICE_STARTER_MONTHLY: bad });
      expect(
        paystackCheckoutConfig("ATLAS_STARTER", "monthly").ok,
        `price ${bad} must be rejected`,
      ).toBe(false);
    }
  });

  it("requires the currency to be configured", () => {
    stubDeno({ ...BASE_ENV, PAYSTACK_CURRENCY: "" });
    const resolved = paystackCheckoutConfig("ATLAS_STARTER", "monthly");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.missing).toContain("PAYSTACK_CURRENCY");
  });
});

// ---------------------------------------------------------------------------
// Deterministic references (Atlas-owned idempotency)
// ---------------------------------------------------------------------------

describe("checkout reference", () => {
  const input = {
    organizationId: "org-1",
    plan: "ATLAS_STARTER" as const,
    interval: "monthly" as const,
    nowMs: 1_800_000_000_000,
  };

  it("is deterministic for the same attempt inside the window", async () => {
    const a = await paystackCheckoutReference(input);
    const b = await paystackCheckoutReference({ ...input, nowMs: input.nowMs + 60_000 });
    expect(a).toBe(b);
  });

  it("changes across organizations, plans, intervals and windows", async () => {
    const base = await paystackCheckoutReference(input);
    expect(await paystackCheckoutReference({ ...input, organizationId: "org-2" })).not.toBe(base);
    expect(await paystackCheckoutReference({ ...input, plan: "ATLAS_GROWTH" })).not.toBe(base);
    expect(await paystackCheckoutReference({ ...input, interval: "annual" })).not.toBe(base);
    expect(
      await paystackCheckoutReference({ ...input, nowMs: input.nowMs + PAYSTACK_REFERENCE_WINDOW_MS }),
    ).not.toBe(base);
  });

  it("only uses Paystack-allowed characters (- . = alnum)", async () => {
    const reference = await paystackCheckoutReference(input);
    expect(reference).toMatch(/^ATL[A-Za-z0-9.-]+$/);
  });

  it("derives a stable, body-sensitive webhook event id", async () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });
    expect(await paystackWebhookEventId(body)).toBe(await paystackWebhookEventId(body));
    expect(await paystackWebhookEventId(body)).not.toBe(
      await paystackWebhookEventId(`${body} `),
    );
    expect(await paystackWebhookEventId(body)).toMatch(/^psk_[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

describe("paystackRequest", () => {
  it("sends the secret key as a bearer token and returns data on success", async () => {
    const { calls } = mockFetch(() => jsonResponse({ status: true, message: "ok", data: { hello: "world" } }));
    const result = await paystackRequest<{ hello: string }>("GET", "/customer/CUS_1");
    expect(result).toEqual({ hello: "world" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.paystack.co/customer/CUS_1");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_atlas");
  });

  it("refuses to run without a configured secret (fails closed)", async () => {
    stubDeno({ ...BASE_ENV, PAYSTACK_SECRET_KEY: "" });
    const { calls } = mockFetch(() => jsonResponse({ status: true, data: {} }));
    await expect(paystackRequest("GET", "/customer/CUS_1")).rejects.toThrow(PaystackApiError);
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-2xx response with the API message", async () => {
    mockFetch(() => jsonResponse({ status: false, message: "Invalid API key" }, 401));
    await expect(paystackRequest("GET", "/customer/CUS_1")).rejects.toMatchObject({
      name: "PaystackApiError",
      status: 401,
      message: "Invalid API key",
    });
  });

  it("throws on a 200 envelope with status:false", async () => {
    mockFetch(() => jsonResponse({ status: false, message: "Reference not found" }));
    await expect(paystackRequest("GET", "/transaction/verify/x")).rejects.toMatchObject({
      status: 502,
      message: "Reference not found",
    });
  });

  it("throws on a malformed (non-JSON) body", async () => {
    mockFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(paystackRequest("GET", "/customer/CUS_1")).rejects.toMatchObject({
      status: 502,
    });
  });

  it("throws on a transport error and never leaks the secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );
    const failure = await paystackRequest("GET", "/customer/CUS_1").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PaystackApiError);
    expect((failure as PaystackApiError).status).toBe(0);
    expect(String((failure as Error).message)).not.toContain("sk_test_atlas");
  });

  it("aborts on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(
      paystackRequest("GET", "/customer/CUS_1", undefined, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "PaystackApiError" });
  });
});

describe("initializePaystackTransaction", () => {
  const input = {
    email: "owner@atlas.test",
    amountSubunits: 89900,
    currency: "ZAR",
    reference: "ATLabcdef1234567890",
    callbackUrl: "https://atlas-ai-os.com/pricing-success",
    planCode: PLAN_CODES.starterMonthly,
    metadata: { organization_id: "org-1" },
  };

  it("posts the fixed server-side amount, currency, plan and reference", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/abc",
          access_code: "abc",
          reference: input.reference,
        },
      }),
    );
    const session = await initializePaystackTransaction(input);
    expect(session).toEqual({
      authorizationUrl: "https://checkout.paystack.com/abc",
      accessCode: "abc",
      reference: input.reference,
    });

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.amount).toBe("89900");
    expect(body.currency).toBe("ZAR");
    expect(body.plan).toBe(PLAN_CODES.starterMonthly);
    expect(body.reference).toBe(input.reference);
    expect(body.email).toBe(input.email);
    expect(JSON.parse(String(body.metadata))).toMatchObject({ organization_id: "org-1" });
    expect(calls[0].url).toBe("https://api.paystack.co/transaction/initialize");
  });

  it("rejects a session response without a checkout URL", async () => {
    mockFetch(() => jsonResponse({ status: true, data: { access_code: "abc" } }));
    await expect(initializePaystackTransaction(input)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("propagates an initialization failure as an API error", async () => {
    mockFetch(() => jsonResponse({ status: false, message: "Amount must be greater than 0" }, 400));
    await expect(initializePaystackTransaction(input)).rejects.toMatchObject({
      status: 400,
      message: "Amount must be greater than 0",
    });
  });
});

describe("fetchPaystackTransaction (verify)", () => {
  it("parses the authoritative verification payload", async () => {
    mockFetch(() =>
      jsonResponse({
        status: true,
        data: {
          id: 424242,
          status: "success",
          reference: "ATLabcdef1234567890",
          amount: 89900,
          currency: "zar",
          paid_at: "2026-10-07T10:00:00.000Z",
          customer: { email: "owner@atlas.test", customer_code: "CUS_1" },
          plan: { plan_code: PLAN_CODES.starterMonthly },
          metadata: { organization_id: "org-1" },
        },
      }),
    );
    const verified = await fetchPaystackTransaction("ATLabcdef1234567890");
    expect(verified).toEqual({
      id: 424242,
      status: "success",
      reference: "ATLabcdef1234567890",
      amount: 89900,
      currency: "ZAR",
      paidAt: "2026-10-07T10:00:00.000Z",
      customerEmail: "owner@atlas.test",
      customerCode: "CUS_1",
      planCode: PLAN_CODES.starterMonthly,
      organizationId: "org-1",
    });
  });

  it("returns null only for an unknown reference (404)", async () => {
    mockFetch(() => jsonResponse({ status: false, message: "Transaction not found" }, 404));
    await expect(fetchPaystackTransaction("ATLunknown")).resolves.toBeNull();
  });

  it("throws on any other failure (never guesses a payment)", async () => {
    mockFetch(() => jsonResponse({ status: false, message: "Paystack unavailable" }, 500));
    await expect(fetchPaystackTransaction("ATLabcdef1234567890")).rejects.toMatchObject({
      status: 500,
    });
  });

  it("tolerates a string metadata echo and absent metadata", async () => {
    mockFetch(() =>
      jsonResponse({
        status: true,
        data: {
          id: 1,
          status: "success",
          reference: "r",
          amount: 100,
          currency: "ZAR",
          metadata: "{\"organization_id\":\"org-9\"}",
        },
      }),
    );
    const echoed = await fetchPaystackTransaction("r");
    expect(echoed?.organizationId).toBe("org-9");

    mockFetch(() =>
      jsonResponse({
        status: true,
        data: { id: 1, status: "success", reference: "r", amount: 100, currency: "ZAR" },
      }),
    );
    const absent = await fetchPaystackTransaction("r");
    expect(absent?.organizationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payment validation — the ONLY path to activation
// ---------------------------------------------------------------------------

describe("validateVerifiedPayment", () => {
  const verified = {
    id: 424242,
    status: "success",
    reference: "ATLabcdef1234567890",
    amount: 89900,
    currency: "ZAR",
    paidAt: "2026-10-07T10:00:00.000Z",
    customerEmail: "owner@atlas.test",
    customerCode: "CUS_1",
    planCode: PLAN_CODES.starterMonthly,
    organizationId: "org-1",
  };
  const expected = {
    reference: "ATLabcdef1234567890",
    amountSubunits: 89900,
    currency: "ZAR",
    organizationId: "org-1",
    planCode: PLAN_CODES.starterMonthly,
  };

  it("accepts an exact match", () => {
    expect(validateVerifiedPayment(verified, expected)).toEqual({ ok: true });
  });

  it("rejects the wrong reference", () => {
    expect(validateVerifiedPayment(verified, { ...expected, reference: "ATLother" })).toEqual({
      ok: false,
      reason: "reference_mismatch",
    });
  });

  it("rejects a payment that is not successful", () => {
    expect(validateVerifiedPayment({ ...verified, status: "failed" }, expected)).toMatchObject({
      ok: false,
    });
    expect(
      validateVerifiedPayment({ ...verified, status: "abandoned" }, expected),
    ).toMatchObject({ reason: "payment_status_abandoned" });
  });

  it("rejects the wrong amount (including a missing amount)", () => {
    expect(
      validateVerifiedPayment({ ...verified, amount: 100 }, expected),
    ).toEqual({ ok: false, reason: "amount_mismatch" });
    expect(
      validateVerifiedPayment({ ...verified, amount: null }, expected),
    ).toEqual({ ok: false, reason: "amount_mismatch" });
  });

  it("rejects the wrong currency", () => {
    expect(
      validateVerifiedPayment({ ...verified, currency: "USD" }, expected),
    ).toEqual({ ok: false, reason: "currency_mismatch" });
    expect(
      validateVerifiedPayment({ ...verified, currency: "" }, expected),
    ).toEqual({ ok: false, reason: "currency_mismatch" });
  });

  it("rejects an organization echo that belongs to another tenant", () => {
    expect(
      validateVerifiedPayment({ ...verified, organizationId: "org-2" }, expected),
    ).toEqual({ ok: false, reason: "organization_mismatch" });
  });

  it("falls back to the stored reference binding when metadata is absent", () => {
    expect(validateVerifiedPayment({ ...verified, organizationId: null }, expected)).toEqual({
      ok: true,
    });
  });

  it("rejects a foreign plan code", () => {
    expect(
      validateVerifiedPayment({ ...verified, planCode: PLAN_CODES.growthMonthly }, expected),
    ).toEqual({ ok: false, reason: "plan_mismatch" });
    expect(
      validateVerifiedPayment({ ...verified, planCode: null }, expected),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Customers + subscriptions
// ---------------------------------------------------------------------------

describe("customer operations", () => {
  it("looks up an existing customer (404 ⇒ null, never a duplicate create)", async () => {
    mockFetch(() =>
      jsonResponse({ status: true, data: { customer_code: "CUS_1", email: "a@b.test" } }),
    );
    await expect(fetchPaystackCustomer("a@b.test")).resolves.toEqual({
      code: "CUS_1",
      email: "a@b.test",
    });

    mockFetch(() => jsonResponse({ status: false, message: "customer not found" }, 404));
    await expect(fetchPaystackCustomer("a@b.test")).resolves.toBeNull();
  });

  it("creates a customer once with Atlas org metadata", async () => {
    const { calls } = mockFetch(() =>
      jsonResponse({ status: true, data: { customer_code: "CUS_2", email: "a@b.test" } }),
    );
    const created = await createPaystackCustomer({
      email: "a@b.test",
      organizationId: "org-1",
    });
    expect(created.code).toBe("CUS_2");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.metadata).toMatchObject({ atlas_org_id: "org-1", atlas_environment: "test" });
  });

  it("rejects a customer response without a code", async () => {
    mockFetch(() => jsonResponse({ status: true, data: { email: "a@b.test" } }));
    await expect(
      createPaystackCustomer({ email: "a@b.test", organizationId: "org-1" }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("subscription operations", () => {
  it("fetches a subscription and returns null for unknown codes", async () => {
    mockFetch(() =>
      jsonResponse({
        status: true,
        data: {
          subscription_code: "SUB_1",
          email_token: "email_token_1",
          status: "active",
          plan: { plan_code: PLAN_CODES.starterMonthly },
          customer: { customer_code: "CUS_1" },
          next_payment_date: "2026-11-07",
        },
      }),
    );
    await expect(fetchPaystackSubscription("SUB_1")).resolves.toMatchObject({
      code: "SUB_1",
      emailToken: "email_token_1",
      status: "active",
      planCode: PLAN_CODES.starterMonthly,
      customerCode: "CUS_1",
      nextPaymentDate: "2026-11-07",
    });

    mockFetch(() => jsonResponse({ status: false, message: "not found" }, 404));
    await expect(fetchPaystackSubscription("SUB_missing")).resolves.toBeNull();
  });

  it("refuses to disable without a STORED email token", async () => {
    const { calls } = mockFetch(() => jsonResponse({ status: true, data: {} }));
    await expect(disablePaystackSubscription("SUB_1", "")).rejects.toMatchObject({
      status: 422,
    });
    expect(calls).toHaveLength(0);
  });

  it("disables with the stored token", async () => {
    const { calls } = mockFetch(() => jsonResponse({ status: true, data: {} }));
    await expect(disablePaystackSubscription("SUB_1", "email_token_1")).resolves.toBeUndefined();
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toEqual({ code: "SUB_1", token: "email_token_1" });
    expect(calls[0].url).toBe("https://api.paystack.co/subscription/disable");
  });
});

// ---------------------------------------------------------------------------
// Webhook signature verification (independent HMAC cross-check)
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const secret = "sk_test_atlas";
  const payload = { event: "charge.success", data: { reference: "ATL123", amount: 89900 } };
  const rawBody = JSON.stringify(payload);

  const sign = (body: string, key = secret): string =>
    createHmac("sha512", key).update(body).digest("hex");

  it("accepts a valid signature computed by an INDEPENDENT HMAC", async () => {
    const parsed = await verifyWebhookSignature(rawBody, sign(rawBody), { secret });
    expect(parsed).toEqual(payload);
  });

  it("accepts an uppercase signature header", async () => {
    const parsed = await verifyWebhookSignature(rawBody, sign(rawBody).toUpperCase(), {
      secret,
    });
    expect(parsed).toEqual(payload);
  });

  it("rejects an invalid signature", async () => {
    const bogus = createHmac("sha512", "wrong_secret").update(rawBody).digest("hex");
    await expect(verifyWebhookSignature(rawBody, bogus, { secret })).rejects.toThrow(
      /signature verification failed/i,
    );
  });

  it("rejects a missing signature header", async () => {
    await expect(verifyWebhookSignature(rawBody, null, { secret })).rejects.toThrow(
      /missing x-paystack-signature/i,
    );
  });

  it("rejects a body altered after signing", async () => {
    const signature = sign(rawBody);
    const tampered = rawBody.replace("89900", "1");
    await expect(verifyWebhookSignature(tampered, signature, { secret })).rejects.toThrow(
      /signature verification failed/i,
    );
  });

  it("parses only AFTER verification (valid sig, malformed JSON ⇒ error)", async () => {
    const broken = "{not json";
    await expect(verifyWebhookSignature(broken, sign(broken), { secret })).rejects.toThrow(
      /not valid JSON/i,
    );
  });

  it("fails closed when no secret is configured", async () => {
    stubDeno({ ...BASE_ENV, PAYSTACK_SECRET_KEY: "" });
    await expect(verifyWebhookSignature(rawBody, sign(rawBody))).rejects.toThrow(
      /not configured/i,
    );
  });

  it("cross-checks hmacSha512Hex against node:crypto", async () => {
    expect(await hmacSha512Hex(secret, rawBody)).toBe(sign(rawBody));
    expect(await hmacSha512Hex(secret, rawBody)).toBe(sign(rawBody, secret));
  });
});

describe("timingSafeEqualHex", () => {
  it("compares equal-length digests without early exit and rejects others", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualHex("abc123", "abc12")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
