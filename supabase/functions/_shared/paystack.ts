// ---------------------------------------------------------------------------
// Atlas Billing — Paystack server-only module
//
// The Paystack counterpart of _shared/stripe.ts. Everything here runs ONLY in
// Supabase Edge Functions: PAYSTACK_SECRET_KEY is read through Deno.env at
// call time and never logged, never returned, never imported by browser code.
//
// What this module provides — exactly what Atlas's billing lifecycle needs:
//   * environment / catalog configuration (plan codes + fixed ZAR prices)
//   * a deterministic, server-generated checkout reference (Paystack has no
//     Stripe-style idempotency keys — Atlas owns reference idempotency)
//   * REST client with strict error handling (non-2xx, malformed envelopes
//     and timeouts all throw — an API error is NEVER a successful payment)
//   * Initialize Transaction / Verify Transaction / Customer / Subscription
//     operations (official Paystack API: https://paystack.com/docs/api/)
//   * webhook signature verification: x-paystack-signature is an HMAC
//     SHA512 of the raw payload signed with the secret key
//
// Currency reality (do not invent capabilities): a South-Africa-based
// Paystack merchant charges and settles in ZAR only. Atlas's display pricing
// stays USD; the amount actually submitted to Paystack comes from the fixed,
// server-side PAYSTACK_PRICE_* catalog — never from the browser, never from
// a live FX rate.
//
// UNVERIFIED BEHAVIOUR (flagged for test-mode verification):
//   * whether Paystack rejects a re-initialized reference (we rely on the
//     reference being unique per transaction, per the API docs)
//   * webhook payload envelope details beyond the documented
//     { event, data } shape (handled defensively by the parser)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical Atlas billing vocabulary (mirrors _shared/stripe.ts so the
// webhook processor can write either provider into the same columns)
// ---------------------------------------------------------------------------

export type InternalPlan = "ATLAS_STARTER" | "ATLAS_GROWTH" | "ATLAS_SCALE";
export type BillingInterval = "monthly" | "annual";

export const ALL_INTERNAL_PLANS: InternalPlan[] = [
  "ATLAS_STARTER",
  "ATLAS_GROWTH",
  "ATLAS_SCALE",
];

export type AtlasSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused"
  | "canceled"
  | "unknown";

export type AtlasPaymentStatus = "paid" | "pending" | "failed" | "requires_action" | "unknown";

/** The canonical Atlas entitlement state written to tenants.billing_state. */
export type AtlasBillingState =
  | "active"
  | "past_due"
  | "payment_failed"
  | "cancelled"
  | "suspended"
  | "pending_checkout";

// ---------------------------------------------------------------------------
// Environment (read at call time; never logged, never returned)
// ---------------------------------------------------------------------------

export function paystackSecretKey(): string {
  return Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
}

/** Transaction/plan currency for this integration (e.g. "ZAR"). */
export function paystackCurrency(): string {
  return (Deno.env.get("PAYSTACK_CURRENCY") ?? "").trim().toUpperCase();
}

/** Public Atlas origin used for checkout callback URLs. */
export function paystackAppUrl(): string {
  const raw = Deno.env.get("ATLAS_APP_URL")?.trim();
  const base = raw && raw !== "" ? raw : "https://atlas-ai-os.com";
  return base.replace(/\/+$/, "");
}

/** `test` | `live` — from the documented key prefixes. Never a secret. */
export function paystackEnvironment(): "test" | "live" {
  return paystackSecretKey().startsWith("sk_live_") ? "live" : "test";
}

export function isPaystackConfigured(): boolean {
  return paystackSecretKey().startsWith("sk_");
}

// ---------------------------------------------------------------------------
// Plan / interval / price configuration (server-side, browser never sees it)
// ---------------------------------------------------------------------------

const PLAN_KEY: Record<InternalPlan, string> = {
  ATLAS_STARTER: "STARTER",
  ATLAS_GROWTH: "GROWTH",
  ATLAS_SCALE: "SCALE",
};

const PLAN_SLUGS: Record<string, InternalPlan> = {
  starter: "ATLAS_STARTER",
  growth: "ATLAS_GROWTH",
  scale: "ATLAS_SCALE",
};

const INTERVAL_ALIASES: Record<string, BillingInterval> = {
  month: "monthly",
  monthly: "monthly",
  year: "annual",
  annual: "annual",
  yearly: "annual",
};

/** Normalize a client-supplied plan slug. Null for anything unknown. */
export function internalPlanForSlug(raw: unknown): InternalPlan | null {
  if (typeof raw !== "string") return null;
  return PLAN_SLUGS[raw.trim().toLowerCase()] ?? null;
}

/** Normalize a client-supplied interval. Null for anything unknown. */
export function billingIntervalForInput(raw: unknown): BillingInterval | null {
  if (typeof raw !== "string") return null;
  return INTERVAL_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Environment variable name for a plan/interval pair (names only). */
export function paystackPlanEnvKey(plan: InternalPlan, interval: BillingInterval): string {
  return `PAYSTACK_PLAN_${PLAN_KEY[plan]}_${interval === "annual" ? "YEARLY" : "MONTHLY"}`;
}

/** Environment variable name for the fixed ZAR price (subunits). */
export function paystackPriceEnvKey(plan: InternalPlan, interval: BillingInterval): string {
  return `PAYSTACK_PRICE_${PLAN_KEY[plan]}_${interval === "annual" ? "YEARLY" : "MONTHLY"}`;
}

/** The configured Paystack plan code (null when unset). */
export function paystackPlanCode(plan: InternalPlan, interval: BillingInterval): string | null {
  const value = Deno.env.get(paystackPlanEnvKey(plan, interval))?.trim();
  return value && value !== "" ? value : null;
}

/**
 * The configured fixed price in currency subunits (e.g. ZAR cents).
 * NO dynamic FX conversion: the value is a configured business price.
 */
export function paystackPriceSubunits(plan: InternalPlan, interval: BillingInterval): number | null {
  const raw = Deno.env.get(paystackPriceEnvKey(plan, interval))?.trim();
  if (!raw) return null;
  // Canonical positive integer only: "899.5" and "899.00" are configuration
  // mistakes (subunits are integers), and a misread price must FAIL CLOSED
  // rather than silently charge 899x instead of R899.00.
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export interface PaystackCheckoutConfig {
  plan: InternalPlan;
  interval: BillingInterval;
  planCode: string;
  amountSubunits: number;
  currency: string;
}

/**
 * Resolve the full checkout configuration for a plan + interval, or the list
 * of missing/invalid environment keys. Fails closed: an unconfigured price or
 * plan code means checkout is unavailable — never a zero-amount charge.
 */
export function paystackCheckoutConfig(
  plan: InternalPlan,
  interval: BillingInterval,
): { ok: true; config: PaystackCheckoutConfig } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const planCode = paystackPlanCode(plan, interval);
  const amount = paystackPriceSubunits(plan, interval);
  const currency = paystackCurrency();
  if (!planCode) missing.push(paystackPlanEnvKey(plan, interval));
  if (amount === null) missing.push(paystackPriceEnvKey(plan, interval));
  if (!currency) missing.push("PAYSTACK_CURRENCY");
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { plan, interval, planCode: planCode!, amountSubunits: amount!, currency },
  };
}

// ---------------------------------------------------------------------------
// Deterministic checkout reference (Atlas-owned idempotency)
//
// Paystack documents no idempotency-key header, so Atlas generates its own
// reference: the same organization + plan + interval inside one short window
// resolves to the SAME reference, so a double-click cannot initialize (and
// therefore cannot charge) twice. The reference is persisted in
// billing_transactions BEFORE initialization, so retries and recovery always
// resolve back to the same Atlas billing attempt.
//
// Allowed characters per the API docs: only -, . = and alphanumeric.
// ---------------------------------------------------------------------------

export const PAYSTACK_REFERENCE_WINDOW_MS = 10 * 60 * 1000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

/**
 * Deterministic reference for a checkout attempt: `ATL` + 128 bits of
 * sha256(org | plan | interval | time-bucket). Server-generated only — the
 * browser can neither choose nor influence it.
 */
export async function paystackCheckoutReference(input: {
  organizationId: string;
  plan: InternalPlan;
  interval: BillingInterval;
  nowMs?: number;
  windowMs?: number;
}): Promise<string> {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? PAYSTACK_REFERENCE_WINDOW_MS;
  const bucket = Math.floor(nowMs / windowMs);
  const digest = await sha256Hex(
    `${input.organizationId}|${input.plan}|${input.interval}|${bucket}`,
  );
  return `ATL${digest.slice(0, 32)}`;
}

/** Ledger identity for an EXACT webhook replay (see paystack-webhook.ts). */
export async function paystackWebhookEventId(rawBody: string): Promise<string> {
  return `psk_${await sha256Hex(rawBody)}`;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export class PaystackApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaystackApiError";
    this.status = status;
  }
}

/**
 * Call the Paystack API with the secret key.
 *
 * Throws PaystackApiError on any non-2xx response, on a `status: false`
 * envelope, and on a malformed/unparseable body — an API error is never
 * treated as a successful payment. A timeout aborts the request. The error
 * message never contains the secret key or the request body.
 */
export async function paystackRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const secret = paystackSecretKey();
  if (!secret) {
    throw new PaystackApiError("PAYSTACK_SECRET_KEY is not configured.", 503);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json",
  };
  let payload: string | undefined;
  if (body && method === "POST") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    throw new PaystackApiError(`Paystack request failed: ${msg}`, 0);
  }
  clearTimeout(timeout);

  const text = await response.text();
  let parsed: {
    status?: unknown;
    message?: unknown;
    data?: unknown;
  } | null = null;
  try {
    parsed = text ? (JSON.parse(text) as typeof parsed) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      typeof parsed?.message === "string" && parsed.message !== ""
        ? parsed.message
        : `Paystack API error (${response.status})`;
    throw new PaystackApiError(message, response.status);
  }

  if (!parsed || parsed.status !== true) {
    const message =
      typeof parsed?.message === "string" && parsed.message !== ""
        ? parsed.message
        : "Malformed Paystack response.";
    throw new PaystackApiError(message, 502);
  }

  return (parsed.data ?? {}) as T;
}

// ---------------------------------------------------------------------------
// Transactions — Initialize + Verify
// ---------------------------------------------------------------------------

export interface PaystackInitializeInput {
  email: string;
  amountSubunits: number;
  currency: string;
  reference: string;
  callbackUrl: string;
  /** Paystack plan code — makes this payment create the recurring subscription. */
  planCode: string;
  metadata: Record<string, unknown>;
}

export interface PaystackInitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/**
 * POST /transaction/initialize — start a Paystack-hosted checkout.
 *
 * The amount and currency come from the fixed server-side catalog; the plan
 * code ties the payment to the recurring subscription lifecycle.
 */
export async function initializePaystackTransaction(
  input: PaystackInitializeInput,
): Promise<PaystackInitializeResult> {
  const data = await paystackRequest<Record<string, unknown>>("POST", "/transaction/initialize", {
    email: input.email,
    amount: String(input.amountSubunits),
    currency: input.currency,
    reference: input.reference,
    callback_url: input.callbackUrl,
    plan: input.planCode,
    metadata: JSON.stringify(input.metadata),
  });

  const url = typeof data.authorization_url === "string" ? data.authorization_url : "";
  if (!url.startsWith("https://")) {
    throw new PaystackApiError("Paystack returned a checkout session without a URL.", 502);
  }
  return {
    authorizationUrl: url,
    accessCode: typeof data.access_code === "string" ? data.access_code : "",
    reference: typeof data.reference === "string" ? data.reference : input.reference,
  };
}

export interface PaystackVerifiedTransaction {
  id: number | null;
  status: string;
  reference: string;
  amount: number | null;
  currency: string;
  paidAt: string | null;
  customerEmail: string | null;
  customerCode: string | null;
  planCode: string | null;
  /** organization_id from the metadata Atlas wrote at initialization. */
  organizationId: string | null;
}

function parseMetadataOrganizationId(raw: unknown): string | null {
  let value = raw;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object") {
    const org = (value as Record<string, unknown>).organization_id;
    return typeof org === "string" && org !== "" ? org : null;
  }
  return null;
}

/**
 * GET /transaction/verify/:reference — the authoritative server-side check of
 * a payment. Returns null only when Paystack reports the reference as unknown
 * (404); transport/API failures throw so callers can retry instead of
 * guessing.
 */
export async function fetchPaystackTransaction(
  reference: string,
): Promise<PaystackVerifiedTransaction | null> {
  let data: Record<string, unknown>;
  try {
    data = await paystackRequest<Record<string, unknown>>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  } catch (e) {
    if (e instanceof PaystackApiError && e.status === 404) return null;
    throw e;
  }

  const customer = (data.customer ?? {}) as Record<string, unknown>;
  const plan = data.plan;
  const planCode =
    typeof plan === "string" && plan !== ""
      ? plan
      : plan && typeof plan === "object" && typeof (plan as Record<string, unknown>).plan_code === "string"
        ? ((plan as Record<string, unknown>).plan_code as string)
        : null;

  const amount = Number(data.amount);
  return {
    id: typeof data.id === "number" ? data.id : null,
    status: typeof data.status === "string" ? data.status : "",
    reference: typeof data.reference === "string" ? data.reference : "",
    amount: Number.isFinite(amount) ? amount : null,
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : "",
    paidAt: typeof data.paid_at === "string" ? data.paid_at : null,
    customerEmail: typeof customer.email === "string" ? customer.email : null,
    customerCode: typeof customer.customer_code === "string" ? customer.customer_code : null,
    planCode,
    organizationId: parseMetadataOrganizationId(data.metadata),
  };
}

// ---------------------------------------------------------------------------
// Payment verification — the ONLY path to activation
// ---------------------------------------------------------------------------

export interface ExpectedPayment {
  reference: string;
  amountSubunits: number;
  currency: string;
  organizationId: string;
  planCode: string;
}

/**
 * Validate a verified Paystack transaction against the Atlas billing attempt
 * recorded BEFORE checkout. Fails closed on any mismatch: wrong amount,
 * wrong currency, wrong reference, missing/failed payment, foreign plan —
 * none of them may ever activate a subscription.
 *
 * Organization: the reference itself is server-generated and persisted to a
 * known organization, which is the primary binding. The echoed metadata is
 * checked as a second signal: a MISMATCH is always rejected; an absent echo
 * falls back to the stored binding (documented, test-covered).
 */
export function validateVerifiedPayment(
  verified: PaystackVerifiedTransaction,
  expected: ExpectedPayment,
): { ok: true } | { ok: false; reason: string } {
  if (verified.reference !== expected.reference) {
    return { ok: false, reason: "reference_mismatch" };
  }
  if (verified.status !== "success") {
    return { ok: false, reason: `payment_status_${verified.status || "unknown"}` };
  }
  if (verified.amount === null || verified.amount !== expected.amountSubunits) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (!verified.currency || verified.currency !== expected.currency.toUpperCase()) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (verified.organizationId !== null && verified.organizationId !== expected.organizationId) {
    return { ok: false, reason: "organization_mismatch" };
  }
  if (verified.planCode !== null && verified.planCode !== expected.planCode) {
    return { ok: false, reason: "plan_mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface PaystackCustomer {
  code: string;
  email: string | null;
}

function customerFromData(data: Record<string, unknown>): PaystackCustomer | null {
  const code = typeof data.customer_code === "string" ? data.customer_code : "";
  if (!code) return null;
  return {
    code,
    email: typeof data.email === "string" ? data.email : null,
  };
}

/**
 * GET /customer/:email_or_code — used to find an existing customer before
 * creating one (never create a duplicate customer per checkout attempt).
 * 404 ⇒ null; any other failure throws.
 */
export async function fetchPaystackCustomer(emailOrCode: string): Promise<PaystackCustomer | null> {
  try {
    const data = await paystackRequest<Record<string, unknown>>(
      "GET",
      `/customer/${encodeURIComponent(emailOrCode)}`,
    );
    return customerFromData(data);
  } catch (e) {
    if (e instanceof PaystackApiError && e.status === 404) return null;
    throw e;
  }
}

/** POST /customer — create the customer once, with Atlas org metadata. */
export async function createPaystackCustomer(input: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  organizationId: string;
}): Promise<PaystackCustomer> {
  const body: Record<string, unknown> = {
    email: input.email,
    metadata: {
      atlas_org_id: input.organizationId,
      atlas_environment: paystackEnvironment(),
    },
  };
  if (input.firstName) body.first_name = input.firstName;
  if (input.lastName) body.last_name = input.lastName;
  const data = await paystackRequest<Record<string, unknown>>("POST", "/customer", body);
  const customer = customerFromData(data);
  if (!customer) {
    throw new PaystackApiError("Paystack returned a customer without a customer code.", 502);
  }
  return customer;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface PaystackSubscriptionInfo {
  code: string;
  emailToken: string | null;
  status: string;
  planCode: string | null;
  customerCode: string | null;
  nextPaymentDate: string | null;
}

function subscriptionFromData(data: Record<string, unknown>): PaystackSubscriptionInfo | null {
  const code =
    typeof data.subscription_code === "string"
      ? data.subscription_code
      : typeof data.code === "string"
        ? data.code
        : "";
  if (!code) return null;
  const plan = data.plan;
  const customer = data.customer;
  return {
    code,
    emailToken: typeof data.email_token === "string" ? data.email_token : null,
    status: typeof data.status === "string" ? data.status : "",
    planCode:
      plan && typeof plan === "object" && typeof (plan as Record<string, unknown>).plan_code === "string"
        ? ((plan as Record<string, unknown>).plan_code as string)
        : null,
    customerCode:
      customer && typeof customer === "object" &&
      typeof (customer as Record<string, unknown>).customer_code === "string"
        ? ((customer as Record<string, unknown>).customer_code as string)
        : null,
    nextPaymentDate:
      typeof data.next_payment_date === "string" ? data.next_payment_date : null,
  };
}

/** GET /subscription/:id_or_code — 404 ⇒ null; other failures throw. */
export async function fetchPaystackSubscription(
  idOrCode: string,
): Promise<PaystackSubscriptionInfo | null> {
  try {
    const data = await paystackRequest<Record<string, unknown>>(
      "GET",
      `/subscription/${encodeURIComponent(idOrCode)}`,
    );
    return subscriptionFromData(data);
  } catch (e) {
    if (e instanceof PaystackApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * POST /subscription/disable — requires the subscription code AND the
 * email token (both stored server-side from the verified webhook /
 * subscription fetch). Token from the request is NEVER accepted — callers
 * must pass the stored one.
 */
export async function disablePaystackSubscription(
  code: string,
  emailToken: string,
): Promise<void> {
  if (!emailToken) {
    throw new PaystackApiError("Missing stored subscription email token.", 422);
  }
  await paystackRequest<Record<string, unknown>>("POST", "/subscription/disable", {
    code,
    token: emailToken,
  });
}

// ---------------------------------------------------------------------------
// Webhook signature verification (mandatory, over the RAW body)
//
// Official docs: the x-paystack-signature header is an HMAC SHA512 of the
// event payload signed with your secret key. There is NO timestamp in the
// signature, so replay defence = this check + durable deduplication +
// idempotent reconciliation (see paystack-webhook.ts).
// ---------------------------------------------------------------------------

/** Constant-time comparison for hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hmacSha512Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(digest);
}

/**
 * Verify a Paystack webhook signature over the RAW request body and return
 * the parsed payload. Throws on a missing header, missing secret, signature
 * mismatch or invalid JSON — the caller must 401 before parsing anything.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { secret?: string } = {},
): Promise<Record<string, unknown>> {
  const secret = options.secret ?? paystackSecretKey();
  if (!secret) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  }
  const provided = (signatureHeader ?? "").trim().toLowerCase();
  if (!provided) {
    throw new Error("Missing x-paystack-signature header.");
  }
  const expected = await hmacSha512Hex(secret, rawBody);
  if (!timingSafeEqualHex(expected, provided)) {
    throw new Error("Paystack webhook signature verification failed.");
  }
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error("Paystack webhook payload is not valid JSON.");
  }
}
