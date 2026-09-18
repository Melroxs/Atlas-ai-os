/**
 * Atlas — Paddle billing repair regression suite
 *
 * Pins the two defects proven by the forensic audit and the environment/security
 * contracts that the repair depends on, so none of them can silently return:
 *
 *   A. The webhook idempotency write must use the supported PostgREST conflict
 *      mechanism (`upsert()` + `onConflict` + `ignoreDuplicates`) and must never
 *      turn a successfully applied event into an HTTP 500.
 *   B. Atlas's `/pricing-success` URL must never be sent to Paddle as the
 *      transaction's `checkout.url` (that field is the PAYMENT-LINK base URL).
 *   C. A missing client token must never let Atlas's own success page be treated
 *      as a Paddle checkout surface.
 *   D. A missing/invalid PADDLE_ENVIRONMENT must fail closed, never defaulting
 *      to the Paddle sandbox.
 *   E. An anonymous caller must not be able to invoke the privileged billing
 *      activation / state-mutation RPCs.
 *
 * It also pins the canonical price catalogue and the absence of the removed
 * "$10 · 1-day trial" claim, which the transaction flow never implemented.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  createPaddleTransaction,
  isGenuinePaddleCheckoutUrl,
  paddleApiBase,
  paddleClientConfig,
  paddleEnvironment,
} from "./paddle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const WEBHOOK = resolve(ROOT, "supabase/functions/paddle-webhook/index.ts");
const CHECKOUT_FN = resolve(ROOT, "supabase/functions/paddle-checkout/index.ts");
const HARDENING = resolve(
  ROOT,
  "supabase/migrations/20260918_atlas_security_hardening.sql",
);
const PLANS = resolve(ROOT, "src/lib/billing/plans.ts");
const PRICING_PAGE = resolve(ROOT, "src/pages/Pricing.tsx");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `// line comments` so commented-out code is not treated as active. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function stubDeno(env: Record<string, string> = {}) {
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (k: string) => env[k] ?? "" },
  };
}

/** Read a plpgsql `array['a','b']` literal assigned to a variable. */
function arrayLiteral(sql: string, varName: string): string[] {
  const re = new RegExp(
    varName + String.raw`\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]`,
  );
  const m = sql.match(re);
  if (!m) throw new Error(`array literal ${varName} not found`);
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

beforeEach(() => {
  stubDeno();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).Deno;
});

// ---------------------------------------------------------------------------
// A. Webhook idempotency write
// ---------------------------------------------------------------------------

describe("A. webhook processed-event persistence", () => {
  const source = read(WEBHOOK);
  const active = stripLineComments(source);

  it("the invalid chain does not exist on the installed PostgREST client", () => {
    // Why the old code always threw: `.insert(...)` returns a
    // PostgrestFilterBuilder, which has neither `.onConflict()` nor `.ignore()`.
    // Conflict handling is an OPTION of `upsert()`.
    const supabase = createClient("https://example.supabase.co", "test-key");
    const builder = supabase.from("processed_webhook_events").insert({});
    expect(typeof (builder as unknown as Record<string, unknown>).onConflict).toBe(
      "undefined",
    );
    expect(typeof (builder as unknown as Record<string, unknown>).ignore).toBe(
      "undefined",
    );
  });

  it("uses upsert() with the supported onConflict/ignoreDuplicates options", () => {
    expect(active).toContain('.from("processed_webhook_events")');
    expect(active).toContain(".upsert(");
    expect(active).toContain('onConflict: "provider,provider_event_id"');
    expect(active).toContain("ignoreDuplicates: true");
  });

  it("never chains .onConflict(...) or .ignore() after insert()", () => {
    expect(active).not.toMatch(/\.insert\([\s\S]*?\)\s*\.onConflict\(/);
    expect(active).not.toContain(".ignore()");
  });

  it("keeps the ledger row shape identical to the database contract", () => {
    // No new columns: the row must still match processed_webhook_events.
    for (const column of [
      "provider",
      "provider_event_id",
      "event_type",
      "organization_id",
      "provider_customer_id",
      "provider_subscription_id",
      "result",
      "provider_event_at",
    ]) {
      expect(active).toContain(column);
    }
  });

  it("bookkeeping failures cannot become a Paddle-visible HTTP 500", () => {
    const recordProcessed = active.slice(active.indexOf("async function recordProcessed"));
    const appendAudit = active.slice(active.indexOf("async function appendAudit"));
    expect(recordProcessed).toContain("try {");
    expect(recordProcessed).toContain("catch (e)");
    expect(appendAudit).toContain("try {");
    expect(appendAudit).toContain("catch (e)");
    // The critical failures must still return real error responses.
    expect(source).toContain('errorResponse("Webhook signature verification failed.", 401)');
    expect(source).toContain('errorResponse("Subscription sync failed.", 500)');
    expect(source).toContain('errorResponse("Billing state sync failed.", 500)');
  });

  it("keeps the duplicate pre-check so a replayed event is not re-applied", () => {
    expect(active).toContain('.eq("provider_event_id", event.eventId)');
    expect(active).toContain("duplicate: true");
  });
});

// ---------------------------------------------------------------------------
// B. Checkout URL separation
// ---------------------------------------------------------------------------

describe("B. Paddle checkout.url is not the Atlas success URL", () => {
  const PRICE_ENV = {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_test",
    PADDLE_STARTER_PRICE_ID_MONTHLY: "pri_test_starter_monthly",
  };
  const SUCCESS_URL =
    "https://atlas-ai-os.com/pricing-success?tenantId=11111111-1111-1111-1111-111111111111&plan=ATLAS_STARTER&billing=monthly";

  function mockPaddle(checkoutUrl: string | null) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            data: {
              id: "txn_01k9atlas0000000000000000",
              checkout: checkoutUrl ? { url: checkoutUrl } : null,
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return calls;
  }

  it("never sends a checkout object containing the Atlas success URL", async () => {
    stubDeno(PRICE_ENV);
    const calls = mockPaddle("https://checkout.paddle.com/checkout?_ptxn=txn_1");

    await createPaddleTransaction(
      "11111111-1111-1111-1111-111111111111",
      "ATLAS_STARTER",
      "monthly",
    );

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body).not.toHaveProperty("checkout");
    expect(JSON.stringify(body)).not.toContain("pricing-success");
    expect(JSON.stringify(body)).not.toContain(SUCCESS_URL);
  });

  it("still carries the canonical item and identity custom data", async () => {
    stubDeno(PRICE_ENV);
    const calls = mockPaddle("https://checkout.paddle.com/checkout?_ptxn=txn_1");

    await createPaddleTransaction(
      "11111111-1111-1111-1111-111111111111",
      "ATLAS_STARTER",
      "monthly",
    );

    expect(calls[0].url).toBe("https://api.sandbox.paddle.com/transactions");
    expect(calls[0].body.items).toEqual([
      { price_id: "pri_test_starter_monthly", quantity: 1 },
    ]);
    expect(calls[0].body.custom_data).toEqual({
      atlas_organization_id: "11111111-1111-1111-1111-111111111111",
      atlas_internal_plan: "ATLAS_STARTER",
      atlas_billing_interval: "monthly",
    });
  });

  it("the checkout function does not pass a success URL to transaction creation", () => {
    const fn = read(CHECKOUT_FN);
    expect(fn).toMatch(/createPaddleTransaction\(\s*tenantId,\s*plan,\s*billing,?\s*\)/);
    expect(fn).not.toMatch(/createPaddleTransaction\([\s\S]{0,120}successUrl/);
    // The success URL is still delivered to the browser for the overlay.
    expect(fn).toContain("successUrl");
    expect(fn).toContain("/pricing-success");
  });

  it("the frontend still applies the success URL through Paddle.js settings", () => {
    const page = read(resolve(ROOT, "src/pages/Checkout.tsx"));
    expect(page).toContain("paddle.Checkout.open(");
    expect(page).toContain("transactionId");
    expect(page).toContain("settings: successUrl ? { successUrl } : undefined");
  });
});

// ---------------------------------------------------------------------------
// C. No fake hosted checkout
// ---------------------------------------------------------------------------

describe("C. missing client token cannot fake a checkout", () => {
  it("rejects Atlas's own URLs as checkout surfaces", () => {
    expect(
      isGenuinePaddleCheckoutUrl(
        "https://atlas-ai-os.com/pricing-success?tenantId=x&plan=y&billing=z",
      ),
    ).toBe(false);
    expect(
      isGenuinePaddleCheckoutUrl(
        "https://atlas-ai-os.com/pricing-success?tenantId=x&_ptxn=txn_01k9",
      ),
    ).toBe(false);
    expect(isGenuinePaddleCheckoutUrl("https://evilpaddle.com/checkout")).toBe(false);
    expect(isGenuinePaddleCheckoutUrl("http://checkout.paddle.com/checkout")).toBe(false);
    expect(isGenuinePaddleCheckoutUrl("")).toBe(false);
    expect(isGenuinePaddleCheckoutUrl(null)).toBe(false);
    expect(isGenuinePaddleCheckoutUrl("not-a-url")).toBe(false);
  });

  it("accepts only Paddle-served hosts", () => {
    expect(isGenuinePaddleCheckoutUrl("https://checkout.paddle.com/checkout")).toBe(true);
    expect(
      isGenuinePaddleCheckoutUrl("https://sandbox-checkout.paddle.com/checkout?_ptxn=txn_1"),
    ).toBe(true);
  });

  it("drops a Paddle payment link that points back at Atlas", async () => {
    stubDeno({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_test",
      PADDLE_STARTER_PRICE_ID_MONTHLY: "pri_test_starter_monthly",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "txn_01k9atlas0000000000000000",
              // What Paddle returns when the account's default payment link
              // points at the Atlas success page.
              checkout: {
                url: "https://atlas-ai-os.com/pricing-success?_ptxn=txn_01k9atlas0000000000000000",
              },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await createPaddleTransaction(
      "11111111-1111-1111-1111-111111111111",
      "ATLAS_STARTER",
      "monthly",
    );

    // null forces paddle-checkout into its explicit 503 rather than a silent
    // redirect to /pricing-success.
    expect(result.url).toBeNull();
    expect(result.transactionId).toBe("txn_01k9atlas0000000000000000");
  });

  it("paddle-checkout returns a non-2xx instead of a fake checkout surface", () => {
    const fn = read(CHECKOUT_FN);
    expect(fn).toContain("if (!clientToken && !url) {");
    expect(fn).toMatch(/Checkout isn't available yet[\s\S]{0,80}503/);
  });
});

// ---------------------------------------------------------------------------
// D. Environment fail-closed
// ---------------------------------------------------------------------------

describe("D. Paddle environment fails closed", () => {
  it("throws instead of defaulting to sandbox when unset", () => {
    stubDeno({});
    expect(() => paddleEnvironment()).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleApiBase()).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleClientConfig()).toThrow(/PADDLE_ENVIRONMENT/);
  });

  it("throws for an unsupported environment value", () => {
    stubDeno({ PADDLE_ENVIRONMENT: "staging" });
    expect(() => paddleEnvironment()).toThrow(/PADDLE_ENVIRONMENT/);
  });

  it("keeps sandbox explicitly selectable", () => {
    stubDeno({ PADDLE_ENVIRONMENT: "sandbox" });
    expect(paddleEnvironment()).toBe("sandbox");
    expect(paddleApiBase()).toBe("https://api.sandbox.paddle.com");
  });

  it("maps live and production to the live API", () => {
    for (const value of ["live", "LIVE", " production "]) {
      stubDeno({ PADDLE_ENVIRONMENT: value });
      expect(paddleEnvironment()).toBe("live");
      expect(paddleApiBase()).toBe("https://api.paddle.com");
    }
  });

  it("keeps the environment/client-token mismatch guard", () => {
    stubDeno({ PADDLE_ENVIRONMENT: "live", PADDLE_CLIENT_TOKEN: "test_abc" });
    expect(paddleClientConfig()).toEqual({ clientToken: null, environment: "live" });

    stubDeno({ PADDLE_ENVIRONMENT: "sandbox", PADDLE_CLIENT_TOKEN: "live_abc" });
    expect(paddleClientConfig()).toEqual({ clientToken: null, environment: "sandbox" });

    stubDeno({ PADDLE_ENVIRONMENT: "live", PADDLE_CLIENT_TOKEN: "live_abc" });
    expect(paddleClientConfig()).toEqual({ clientToken: "live_abc", environment: "live" });
  });

  it("never silently rewrites PADDLE_ENVIRONMENT in the shared module", () => {
    const shared = stripLineComments(read(resolve(HERE, "paddle.ts")));
    expect(shared).not.toMatch(/PADDLE_ENVIRONMENT"\)\s*\?\?\s*"sandbox"/);
  });
});

// ---------------------------------------------------------------------------
// E. Security regression — privileged billing RPCs stay server-only
// ---------------------------------------------------------------------------

describe("E. privileged billing RPCs remain server-only", () => {
  const sql = read(HARDENING);
  const active = stripLineComments(sql);
  const serviceOnly = arrayLiteral(sql, "v_service_only");
  const anonAllow = [
    ...arrayLiteral(sql, "v_anon_helpers"),
    ...arrayLiteral(sql, "v_anon_public"),
  ];
  const billingWriters = [
    "tenants_activate_after_payment",
    "billing_apply_state",
    "tenants_handle_payment_failure",
    "tenants_handle_subscription_cancelled",
  ];

  it.each(billingWriters)("%s is service-only", (fn) => {
    expect(serviceOnly).toContain(fn);
  });

  it.each(billingWriters)("%s is not granted to anon", (fn) => {
    expect(anonAllow).not.toContain(fn);
  });

  it("the hardening migration revokes every service-only function from client roles", () => {
    expect(active).toContain(
      "revoke execute on all functions in schema public from public, anon, authenticated",
    );
    expect(active).toContain("and p.proname = any (v_service_only)");
    expect(active).toContain(
      "execute format('revoke execute on function %s from public, anon, authenticated', r.sig)",
    );
    expect(active).toContain(
      "execute format('grant execute on function %s to service_role', r.sig)",
    );
  });

  it.each(billingWriters)("%s was literally revoked from every client role", (fn) => {
    const earlier = read(
      resolve(ROOT, "supabase/migrations/20260908_paddle_billing_hardening.sql"),
    );
    expect(earlier).toContain(`revoke execute on function public.${fn}`);
    expect(earlier).toContain(`from public, anon, authenticated`);
  });

  it("the webhook remains the only billing mutation path reachable by the flow", () => {
    const fn = read(resolve(ROOT, "supabase/functions/paddle-webhook/index.ts"));
    expect(fn).toContain('rpc("billing_apply_state"');
    // No client-callable activation RPC was introduced: none of the
    // privileged billing writers is registered as an RPC the browser can call
    // (comments that mention them as deliberately absent are ignored).
    const api = stripLineComments(read(resolve(ROOT, "src/lib/api.ts")));
    for (const name of billingWriters) {
      expect(api).not.toContain(`"${name}"`);
      expect(api).not.toContain(`'${name}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Price catalogue + trial messaging
// ---------------------------------------------------------------------------

describe("F. canonical price catalogue and no false trial messaging", () => {
  /**
   * Verified against the LIVE Paddle catalogue with
   * `scripts/verify-paddle-live-readiness.mjs` (read-only GET /prices/{id}):
   * all six prices are active, recurring, USD, and priced at exactly these
   * amounts. The app-facing prices must match the catalogue the checkout
   * actually charges.
   */
  const CANONICAL = {
    ATLAS_STARTER: [49, 470],
    ATLAS_GROWTH: [149, 1430],
    ATLAS_SCALE: [299, 2870],
  };

  it("PLAN_METADATA matches the canonical catalogue", () => {
    const plans = read(PLANS);
    for (const [plan, [monthly, annual]] of Object.entries(CANONICAL)) {
      const block = plans.slice(plans.indexOf(plan));
      expect(block).toContain(`monthly: ${monthly},`);
      expect(block).toContain(`annual: ${annual},`);
    }
  });

  it("the pricing page shows the canonical prices", () => {
    const page = read(PRICING_PAGE);
    for (const [monthly, annual] of Object.values(CANONICAL)) {
      expect(page).toContain(`monthlyPrice: ${monthly},`);
      expect(page).toContain(`annualPrice: ${annual},`);
    }
  });

  it("charges the prices the live catalogue actually carries", () => {
    // Guard against re-introducing a price that Paddle cannot charge: the
    // checkout charges whatever the price ids are configured with, so an
    // app-facing price that differs from the catalogue is a real defect.
    const plans = read(PLANS);
    expect(plans).not.toMatch(/monthly:\s*(10|40|120),/);
    expect(read(PRICING_PAGE)).not.toMatch(/monthlyPrice:\s*(10|40|120),/);
  });

  it("no trial claim remains in the pricing surfaces", () => {
    const page = read(PRICING_PAGE);
    expect(page).not.toMatch(/1-day trial/i);
    expect(page).not.toMatch(/\$10 · 1-day trial/i);
    const billingSettings = read(resolve(ROOT, "src/pages/BillingSettings.tsx"));
    expect(billingSettings).not.toMatch(/1-day trial/i);
  });

  it("keeps the six price-id environment variable names unchanged", () => {
    const plans = read(PLANS);
    const shared = read(resolve(HERE, "paddle.ts"));
    for (const name of [
      "PADDLE_STARTER_PRICE_ID_MONTHLY",
      "PADDLE_STARTER_PRICE_ID_ANNUAL",
      "PADDLE_GROWTH_PRICE_ID_MONTHLY",
      "PADDLE_GROWTH_PRICE_ID_ANNUAL",
      "PADDLE_SCALE_PRICE_ID_MONTHLY",
      "PADDLE_SCALE_PRICE_ID_ANNUAL",
    ]) {
      expect(plans).toContain(name);
    }
    // Both price mappers derive the key the same way; neither may be renamed.
    expect(plans).toContain('"PADDLE_" +');
    expect(shared).toContain('"PADDLE_" +');
  });

  it("the documented readiness script exists and never prints secret values", () => {
    const script = read(resolve(ROOT, "scripts/verify-paddle-live-readiness.mjs"));
    expect(script).toContain("PADDLE_ENVIRONMENT");
    expect(script).toContain("PADDLE_WEBHOOK_SECRET");
    expect(script).toContain("value never printed");
    // Credential values are never interpolated into output.
    expect(script).not.toContain("${apiKey}");
    expect(script).not.toContain("${clientToken}");
    expect(script).not.toMatch(/\$\{readEnv\("PADDLE_(API_KEY|CLIENT_TOKEN|WEBHOOK_SECRET)"\)\}/);
  });
});
