// ---------------------------------------------------------------------------
// Atlas — Stripe shared server module (Deno Edge Functions)
//
// Stripe is the ONLY payment provider. This module is the single canonical
// place where Atlas:
//
//   * resolves the configured Stripe Price id for a plan + interval
//     (the browser may only ever ask for plan + interval — never a price id,
//     an amount, a currency or a customer)
//   * talks to the Stripe API with the SECRET key (server-only)
//   * verifies the `Stripe-Signature` header of an incoming webhook
//   * parses a verified event into the shape Atlas reasons about
//   * maps a Stripe subscription lifecycle status onto the canonical Atlas
//     entitlement state the access gate reads
//
// It is deliberately dependency-free (global fetch + Web Crypto only) so the
// exact bytes that run in production are also unit-testable under Node
// (supabase/functions/_shared/stripe.test.ts stubs a minimal Deno global, the
// same way the Supabase Edge Runtime provides it).
//
// Server-only secrets are read from Deno.env at CALL TIME and never returned
// to a caller. Nothing in this module is safe to import into the browser
// bundle (it never is — only edge functions import it).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical Atlas billing contract
// ---------------------------------------------------------------------------

export type InternalPlan = "ATLAS_STARTER" | "ATLAS_GROWTH" | "ATLAS_SCALE";
export type BillingInterval = "monthly" | "annual";

export const ALL_INTERNAL_PLANS: InternalPlan[] = [
  "ATLAS_STARTER",
  "ATLAS_GROWTH",
  "ATLAS_SCALE",
];

/**
 * Stripe subscription statuses Atlas is willing to persist.
 *
 * The set mirrors Stripe's documented lifecycle exactly (no invented values);
 * `unknown` is the defensive fallback when Stripe reports a status this build
 * does not know yet. The database CHECK constraint allows this same set.
 */
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

/** Invoice/subscription payment state — stored and displayed, never the sole entitlement input. */
export type AtlasPaymentStatus =
  | "paid"
  | "pending"
  | "failed"
  | "requires_action"
  | "unknown";

/**
 * The canonical Atlas entitlement state — the value written to
 * `tenants.billing_state` and read by the application access gate.
 *
 *   active          → paid access
 *   past_due        → grace period (Stripe is still retrying the charge)
 *   payment_failed  → dunning exhausted / first payment never completed → denied
 *   cancelled       → subscription ended or expired → denied
 *   suspended       → subscription paused → denied
 *   pending_checkout→ checkout started, never paid → denied
 */
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

export function stripeSecretKey(): string {
  return Deno.env.get("STRIPE_SECRET_KEY") ?? "";
}

export function stripeWebhookSecret(): string {
  return Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
}

/** Optional API version pin. When unset the account default is used. */
export function stripeApiVersion(): string | null {
  const v = Deno.env.get("STRIPE_API_VERSION");
  return v && v.trim() !== "" ? v.trim() : null;
}

/** Public Atlas origin used for checkout return URLs. */
export function atlasAppUrl(): string {
  const raw = Deno.env.get("ATLAS_APP_URL")?.trim();
  const base = raw && raw !== "" ? raw : "https://atlas-ai-os.com";
  return base.replace(/\/+$/, "");
}

/** `test` | `live` — recorded on Stripe metadata and logs, never a secret. */
export function stripeEnvironment(): "test" | "live" {
  return stripeSecretKey().startsWith("sk_live_") ? "live" : "test";
}

export function isStripeConfigured(): boolean {
  return stripeSecretKey().startsWith("sk_");
}

// ---------------------------------------------------------------------------
// Internal plan + interval ➜ Stripe Price id (authoritative mapping)
//
// The browser sends `plan` (starter|growth|scale) and `interval`
// (month|year). Only this mapping may turn that into a Price id. An unknown
// plan/interval — or an unconfigured price — fails closed.
// ---------------------------------------------------------------------------

const PLAN_KEY: Record<InternalPlan, string> = {
  ATLAS_STARTER: "STARTER",
  ATLAS_GROWTH: "GROWTH",
  ATLAS_SCALE: "SCALE",
};

/** User-facing plan slugs accepted from the client. */
const PLAN_SLUGS: Record<string, InternalPlan> = {
  starter: "ATLAS_STARTER",
  growth: "ATLAS_GROWTH",
  scale: "ATLAS_SCALE",
};

/** Accepted interval spellings. Never a number, never a currency, never a price id. */
const INTERVAL_ALIASES: Record<string, BillingInterval> = {
  month: "monthly",
  monthly: "monthly",
  year: "annual",
  annual: "annual",
  yearly: "annual",
};

/** Normalize a client-supplied plan slug. Returns null for anything unknown. */
export function internalPlanForSlug(raw: unknown): InternalPlan | null {
  if (typeof raw !== "string") return null;
  return PLAN_SLUGS[raw.trim().toLowerCase()] ?? null;
}

/** Normalize a client-supplied interval. Returns null for anything unknown. */
export function billingIntervalForInput(raw: unknown): BillingInterval | null {
  if (typeof raw !== "string") return null;
  return INTERVAL_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** Environment variable name for a plan/interval (names only — never values). */
export function stripePriceEnvKey(
  plan: InternalPlan,
  interval: BillingInterval,
): string {
  return `STRIPE_PRICE_${PLAN_KEY[plan]}_${interval === "annual" ? "YEARLY" : "MONTHLY"}`;
}

/** The configured Stripe Price id for a plan + interval (null when unset). */
export function stripePriceId(
  plan: InternalPlan,
  interval: BillingInterval,
): string | null {
  const value = Deno.env.get(stripePriceEnvKey(plan, interval))?.trim();
  return value && value !== "" ? value : null;
}

/** Reverse lookup: Price id ➜ { plan, interval }. Null when not an Atlas price. */
export function planAndIntervalForStripePriceId(
  priceId: string | null | undefined,
): { plan: InternalPlan; interval: BillingInterval } | null {
  if (!priceId) return null;
  for (const plan of ALL_INTERNAL_PLANS) {
    for (const interval of ["monthly", "annual"] as BillingInterval[]) {
      if (stripePriceId(plan, interval) === priceId) return { plan, interval };
    }
  }
  return null;
}

/** Every configured plan/interval pair (used for readiness reporting). */
export function configuredStripePrices(): Array<{
  plan: InternalPlan;
  interval: BillingInterval;
  envKey: string;
  configured: boolean;
}> {
  const out: Array<{
    plan: InternalPlan;
    interval: BillingInterval;
    envKey: string;
    configured: boolean;
  }> = [];
  for (const plan of ALL_INTERNAL_PLANS) {
    for (const interval of ["monthly", "annual"] as BillingInterval[]) {
      out.push({
        plan,
        interval,
        envKey: stripePriceEnvKey(plan, interval),
        configured: stripePriceId(plan, interval) !== null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entitlement mapping — THE single decision point
//
// Every subscription change (created / updated / deleted / invoice paid /
// dunning) funnels through this function. No webhook branch may decide
// entitlement on its own.
// ---------------------------------------------------------------------------

/** Map a raw Stripe subscription status onto the Atlas status vocabulary. */
export function mapStripeSubscriptionStatus(
  raw: string | null | undefined,
): AtlasSubscriptionStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "incomplete_expired";
    case "paused":
      return "paused";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "unknown";
  }
}

/**
 * Canonical Stripe lifecycle status ➜ Atlas entitlement.
 *
 * FAIL-CLOSED: anything unrecognised denies paid access.
 * `past_due` is the documented Atlas grace period (Stripe is still retrying).
 * `unpaid` means dunning is exhausted → denied.
 */
export function resolveAtlasBillingState(
  status: AtlasSubscriptionStatus,
): AtlasBillingState {
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

/** Invoice ➜ Atlas payment status (display + operator signal). */
export function invoicePaymentStatus(invoice: {
  status?: string | null;
  paid?: boolean | null;
}): AtlasPaymentStatus {
  if (invoice.paid === true || invoice.status === "paid") return "paid";
  switch ((invoice.status ?? "").toLowerCase()) {
    case "open":
      return "pending";
    case "uncollectible":
      return "failed";
    case "void":
      return "unknown";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Stripe REST client
// ---------------------------------------------------------------------------

export class StripeApiError extends Error {
  status: number;
  code: string | null;
  param: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    param: string | null = null,
  ) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

/** Minimal form-encoder for Stripe's `application/x-www-form-urlencoded` API. */
export function formEncode(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
      return;
    }
    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix === "" ? key : `${prefix}[${key}]`, entry);
      }
      return;
    }
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return parts.join("&");
}

export interface StripeRequestOptions {
  /** Idempotency key — makes a retry of the same logical request safe. */
  idempotencyKey?: string;
}

/**
 * Call the Stripe API with the secret key.
 *
 * Throws StripeApiError on any non-2xx response (the message carries Stripe's
 * own error text, never the secret key). A timeout aborts the request.
 */
export async function stripeRequest<T = Record<string, unknown>>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  options: StripeRequestOptions = {},
): Promise<T> {
  const secret = stripeSecretKey();
  if (!secret) {
    throw new StripeApiError("STRIPE_SECRET_KEY is not configured.", 503);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json",
  };
  const version = stripeApiVersion();
  if (version) headers["Stripe-Version"] = version;
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  let payload: string | undefined;
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = formEncode(body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    // Never include the key or the request body in an error surfaced upward.
    throw new StripeApiError(`Stripe request failed: ${msg}`, 0);
  }
  clearTimeout(timeout);

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const error = (parsed as { error?: Record<string, unknown> } | null)?.error ?? {};
    const message =
      typeof error.message === "string"
        ? error.message
        : `Stripe API error (${response.status})`;
    throw new StripeApiError(
      message,
      response.status,
      typeof error.code === "string" ? error.code : null,
      typeof error.param === "string" ? error.param : null,
    );
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Customers (exactly one per Atlas organization)
// ---------------------------------------------------------------------------

export interface StripeCustomer {
  id: string;
  email?: string | null;
  deleted?: boolean;
}

/**
 * Create the Stripe customer for an Atlas organization.
 *
 * Metadata carries Atlas identifiers only (`atlas_org_id`, `atlas_environment`)
 * — never a Supabase user id, an email address or any other personal data
 * beyond the billing email Stripe itself needs.
 */
export async function createStripeCustomer(input: {
  organizationId: string;
  email?: string | null;
  name?: string | null;
}): Promise<StripeCustomer> {
  const params: Record<string, unknown> = {
    metadata: {
      atlas_org_id: input.organizationId,
      atlas_environment: stripeEnvironment(),
    },
  };
  if (input.email) params.email = input.email;
  if (input.name) params.name = input.name;

  // Idempotency: a retried checkout for the same organization must never
  // create a second Stripe customer.
  return await stripeRequest<StripeCustomer>("POST", "/v1/customers", params, {
    idempotencyKey: `atlas-customer-${input.organizationId}`,
  });
}

export async function fetchStripeCustomer(customerId: string): Promise<StripeCustomer | null> {
  try {
    return await stripeRequest<StripeCustomer>("GET", `/v1/customers/${customerId}`);
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchStripeSubscription(
  subscriptionId: string,
): Promise<StripeSubscription | null> {
  try {
    return await stripeRequest<StripeSubscription>(
      "GET",
      `/v1/subscriptions/${subscriptionId}`,
    );
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return null;
    throw e;
  }
}

/** Active-ish subscriptions already owned by a customer (duplicate guard). */
export async function listActiveSubscriptionsForCustomer(
  customerId: string,
): Promise<StripeSubscription[]> {
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("status", "all");
  params.set("limit", "10");
  const result = await stripeRequest<{ data?: StripeSubscription[] }>(
    "GET",
    `/v1/subscriptions?${params.toString()}`,
  );
  const all = result.data ?? [];
  return all.filter((s) =>
    ["active", "trialing", "past_due", "paused", "unpaid", "incomplete"].includes(
      String(s.status ?? ""),
    ),
  );
}

// ---------------------------------------------------------------------------
// Checkout Session
// ---------------------------------------------------------------------------

export interface StripeSubscription {
  id: string;
  customer: string | { id: string } | null;
  status: string;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  created?: number | null;
  latest_invoice?: string | { id?: string; status?: string } | null;
  metadata?: Record<string, string> | null;
  items?: {
    data?: Array<{
      price?: {
        id?: string;
        active?: boolean;
        currency?: string | null;
        recurring?: { interval?: string | null } | null;
        unit_amount?: number | null;
      } | null;
    }>;
  } | null;
}

export interface StripeCheckoutSession {
  id: string;
  url?: string | null;
  customer?: string | null;
  subscription?: string | null;
  status?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

export interface CreateCheckoutSessionInput {
  organizationId: string;
  plan: InternalPlan;
  interval: BillingInterval;
  priceId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  /** Dedupe key so a double-click cannot create two Checkout Sessions. */
  idempotencyKey?: string;
}

/**
 * Create a Stripe Checkout Session in subscription mode.
 *
 * The price ids are resolved server-side from the plan + interval; the client
 * never contributes an amount, a currency or a price id. Metadata is attached
 * to both the session and the subscription so every later webhook can resolve
 * the owning Atlas organization without guessing.
 *
 * Atlas creates NO trials: the session carries exactly one recurring line item
 * (the selected plan price), no `trial_period_days`, no one-time items, no
 * coupons and no introductory period. The customer is charged the full plan
 * price by Stripe immediately on completion.
 */
export async function createStripeCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<StripeCheckoutSession> {
  const metadata = {
    atlas_org_id: input.organizationId,
    atlas_plan: input.plan,
    atlas_interval: input.interval,
    atlas_environment: stripeEnvironment(),
  };

  const params: Record<string, unknown> = {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: input.organizationId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: { metadata },
    metadata,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: false,
  };

  return await stripeRequest<StripeCheckoutSession>(
    "POST",
    "/v1/checkout/sessions",
    params,
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {},
  );
}

/**
 * Bucketed idempotency key for checkout creation.
 *
 * Repeated clicks inside the same window resolve to the SAME Stripe session
 * (Stripe returns the stored response for a reused key), so a double submit
 * cannot create a second subscription. The bucket is short enough that a
 * customer who cancels and retries gets a fresh session.
 */
export function checkoutIdempotencyKey(
  organizationId: string,
  plan: InternalPlan,
  interval: BillingInterval,
  nowMs: number = Date.now(),
  windowMs = 10 * 60 * 1000,
): string {
  const bucket = Math.floor(nowMs / windowMs);
  return `atlas-checkout-${organizationId}-${plan}-${interval}-${bucket}`;
}

// ---------------------------------------------------------------------------
// Billing Portal
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Billing Portal session for an existing customer.
 *
 * The customer id always comes from Atlas storage — never from the browser.
 */
export async function createStripeBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ id: string; url: string }> {
  return await stripeRequest<{ id: string; url: string }>(
    "POST",
    "/v1/billing_portal/sessions",
    {
      customer: input.customerId,
      return_url: input.returnUrl,
    },
  );
}

// ---------------------------------------------------------------------------
// Webhook signature verification (mandatory)
// ---------------------------------------------------------------------------

export interface StripeSignatureParts {
  timestamp: number | null;
  signatures: string[];
}

/** Parse a `Stripe-Signature: t=...,v1=...` header. */
export function parseStripeSignatureHeader(header: string | null): StripeSignatureParts {
  const parts: StripeSignatureParts = { timestamp: null, signatures: [] };
  if (!header) return parts;
  for (const chunk of header.split(",")) {
    const [rawKey, rawValue] = chunk.split("=");
    if (!rawKey || !rawValue) continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === "t") {
      const ts = Number(value);
      if (Number.isFinite(ts)) parts.timestamp = ts;
    } else if (key === "v1") {
      parts.signatures.push(value);
    }
  }
  return parts;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time comparison for hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toHex(digest);
}

export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a Stripe webhook signature over the RAW request body.
 *
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the endpoint's
 * signing secret. Requirements enforced here:
 *   - the header must carry a timestamp and at least one v1 signature
 *   - the timestamp must be within the tolerance window (replay defence)
 *   - at least one signature must match (constant-time)
 *
 * Throws on any failure. Returns the parsed payload only when valid.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: {
    secret?: string;
    nowSeconds?: number;
    toleranceSeconds?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const secret = options.secret ?? stripeWebhookSecret();
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (timestamp === null || signatures.length === 0) {
    throw new Error("Missing or malformed Stripe-Signature header.");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new Error("Stripe webhook timestamp is outside the tolerance window.");
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  const matched = signatures.some((candidate) => timingSafeEqualHex(candidate, expected));
  if (!matched) {
    throw new Error("Stripe webhook signature verification failed.");
  }

  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error("Stripe webhook payload is not valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Verified event shape
// ---------------------------------------------------------------------------

export interface StripeEvent {
  id: string;
  type: string;
  createdMs: number;
  object: Record<string, unknown>;
}

/**
 * Normalize a SIGNATURE-VERIFIED Stripe payload.
 *
 * This only reads the envelope; the webhook processor decides what (if
 * anything) an event means. It never trusts a client-supplied status.
 */
export function parseStripeEvent(payload: Record<string, unknown>): StripeEvent {
  const id = typeof payload.id === "string" ? payload.id : "";
  const type = typeof payload.type === "string" ? payload.type : "";
  if (!id || !type) {
    throw new Error("Malformed Stripe event: missing id or type.");
  }
  const created = Number(payload.created);
  const data = payload.data as { object?: unknown } | undefined;
  const object = (data?.object ?? {}) as Record<string, unknown>;
  return {
    id,
    type,
    createdMs: Number.isFinite(created) ? created * 1000 : Date.now(),
    object,
  };
}

/** Read `metadata.atlas_org_id` from any event object that carries metadata. */
export function organizationIdHintFromObject(
  object: Record<string, unknown>,
): string | null {
  const direct = object.metadata as Record<string, unknown> | undefined;
  const fromMetadata = direct?.atlas_org_id;
  if (typeof fromMetadata === "string" && fromMetadata !== "") return fromMetadata;

  // Checkout Sessions also carry `client_reference_id`.
  const ref = object.client_reference_id;
  if (typeof ref === "string" && ref !== "") return ref;

  const parent = object.parent as { subscription_details?: { metadata?: Record<string, unknown> } } | undefined;
  const nested = parent?.subscription_details?.metadata?.atlas_org_id;
  if (typeof nested === "string" && nested !== "") return nested;

  return null;
}

/** Resolve a Stripe id that may be either a string or an expanded object. */
export function idOf(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/** The single recurring line item on a subscription (Atlas sells one plan at a time). */
export function primaryPriceOfSubscription(
  subscription: StripeSubscription,
): { priceId: string | null; active: boolean | null } {
  const item = subscription.items?.data?.[0];
  const price = item?.price ?? null;
  return {
    priceId: price?.id ?? null,
    active: typeof price?.active === "boolean" ? price.active : null,
  };
}
