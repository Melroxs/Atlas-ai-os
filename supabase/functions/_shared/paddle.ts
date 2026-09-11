// ---------------------------------------------------------------------------
// Atlas — Paddle shared helpers (Deno Edge Functions)
//
// Mirror of the canonical server-side logic in src/lib/billing/* (which runs
// under Node for tests/scripts). The Edge Functions cannot import from src/,
// so the small amount of shared logic lives here and MUST stay in sync with:
//   - src/lib/billing/plans.ts   (price id mapping)
//   - src/lib/billing/paddle.ts  (signature verification + transaction)
//
// Server-only secrets are read from Deno.env (never VITE_/client env):
//   PADDLE_ENVIRONMENT, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET,
//   PADDLE_*_PRICE_ID_{MONTHLY,ANNUAL}
// ---------------------------------------------------------------------------

export type InternalPlan = "ATLAS_STARTER" | "ATLAS_GROWTH" | "ATLAS_SCALE";
export type BillingInterval = "monthly" | "annual";
export type PaddleEnvironment = "sandbox" | "live";

export const ALL_INTERNAL_PLANS: InternalPlan[] = [
  "ATLAS_STARTER",
  "ATLAS_GROWTH",
  "ATLAS_SCALE",
];

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function paddleEnvironment(): PaddleEnvironment {
  const v = (Deno.env.get("PADDLE_ENVIRONMENT") ?? "sandbox").toLowerCase();
  return v === "live" || v === "production" ? "live" : "sandbox";
}

export function paddleApiBase(): string {
  return paddleEnvironment() === "sandbox"
    ? "https://api.sandbox.paddle.com"
    : "https://api.paddle.com";
}

export function paddleCheckoutBase(): string {
  return paddleEnvironment() === "sandbox"
    ? "https://checkout.sandbox.paddle.com"
    : "https://checkout.paddle.com";
}

// ---------------------------------------------------------------------------
// Plan ➜ Paddle price id mapping (authoritative: price id → plan/interval)
// ---------------------------------------------------------------------------

export function paddlePriceId(
  plan: InternalPlan,
  interval: BillingInterval,
): string | null {
  const key =
    "PADDLE_" +
    plan.replace("ATLAS_", "").toUpperCase() +
    "_PRICE_ID_" +
    interval.toUpperCase();
  return Deno.env.get(key) ?? null;
}

export function internalPlanForPaddlePriceId(
  priceId: string,
): InternalPlan | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (
      paddlePriceId(plan, "monthly") === priceId ||
      paddlePriceId(plan, "annual") === priceId
    ) {
      return plan;
    }
  }
  return null;
}

export function billingIntervalForPaddlePriceId(
  priceId: string,
): BillingInterval | null {
  for (const plan of ALL_INTERNAL_PLANS) {
    if (paddlePriceId(plan, "monthly") === priceId) return "monthly";
    if (paddlePriceId(plan, "annual") === priceId) return "annual";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhook signature verification (documented Paddle scheme)
//
// Header: `Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>…]`
// Signed payload: `${ts}:${rawBody}` — HMAC-SHA256 with the notification
// destination secret. Replay window: 5 minutes.
// ---------------------------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  nowMs?: number,
): Promise<Record<string, unknown>> {
  if (!signatureHeader) {
    throw new Error("Missing Paddle webhook signature header.");
  }
  const secret = Deno.env.get("PADDLE_WEBHOOK_SECRET") ?? "";
  if (!secret) {
    throw new Error(
      "PADDLE_WEBHOOK_SECRET is not configured; webhook verification is disabled.",
    );
  }

  const parts = signatureHeader.split(";");
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "ts") timestamp = value;
    else if (key === "h1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) {
    throw new Error(
      "Paddle webhook signature header is malformed: expected ts=<unix>;h1=<hex>.",
    );
  }

  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || ts <= 0) {
    throw new Error("Paddle webhook timestamp is not a valid Unix timestamp.");
  }

  const now = nowMs ?? Date.now();
  const toleranceMs = 5 * 60 * 1000;
  if (Math.abs(now - ts * 1000) > toleranceMs) {
    throw new Error("Paddle webhook timestamp outside tolerance window.");
  }

  const expected = await hmacHex(secret, `${timestamp}:${rawBody}`);
  let matched = false;
  for (const candidate of signatures) {
    if (constantTimeEqualHex(expected, candidate.toLowerCase())) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new Error("Paddle webhook signature verification failed.");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error("Paddle webhook body is not valid JSON.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Paddle webhook payload is not a JSON object.");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Webhook event parsing (Paddle Billing v1)
// ---------------------------------------------------------------------------

export interface ParsedPaddleEvent {
  eventId: string;
  eventType: string;
  organizationIdHint: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerPriceId: string | null;
  internalPlan: InternalPlan | null;
  billingInterval: BillingInterval | null;
  status: string | null;
  trialStart: number | null;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  nextBilledAt: number | null;
  cancelAt: number | null;
  canceledAt: number | null;
  providerEventAt: number | null;
}

function dateToMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function customData(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = (data.custom_data as Record<string, unknown>) ?? null;
  return raw && typeof raw === "object" ? raw : null;
}

function customString(
  data: Record<string, unknown>,
  dotted: string,
  flat: string,
): string | null {
  const cd = customData(data);
  if (!cd) return null;
  const v = cd[dotted] ?? cd[flat];
  return typeof v === "string" && v ? v : null;
}

function itemsOf(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
}

function priceIdOf(data: Record<string, unknown>): string | null {
  for (const item of itemsOf(data)) {
    const id = item.price_id ?? item.priceId;
    if (typeof id === "string") return id;
  }
  const direct = data.price_id ?? data.priceId;
  return typeof direct === "string" ? direct : null;
}

function periodOf(
  data: Record<string, unknown>,
  field: "starts_at" | "ends_at",
): number | null {
  const period = (data.current_billing_period as Record<string, unknown>) ?? null;
  if (period && typeof period === "object") {
    return dateToMs(period[field]);
  }
  return null;
}

/** Parse a verified Paddle webhook payload into the fields Atlas needs. */
export function parsePaddleEvent(
  payload: Record<string, unknown>,
): ParsedPaddleEvent {
  const eventId = (payload.event_id as string) ?? "";
  const eventType = (payload.event_type as string) ?? "";
  if (!eventId) throw new Error("Paddle webhook event has no event_id.");
  if (!eventType) throw new Error("Paddle webhook event has no event_type.");

  const data = (payload.data as Record<string, unknown>) ?? {};
  const priceId = priceIdOf(data);
  const internalPlan =
    (priceId ? internalPlanForPaddlePriceId(priceId) : null) ??
    (customString(data, "atlas.internal_plan", "atlas_internal_plan") as InternalPlan | null);
  const billingInterval =
    (priceId ? billingIntervalForPaddlePriceId(priceId) : null) ??
    (customString(data, "atlas.billing_interval", "atlas_billing_interval") as BillingInterval | null);

  const scheduled = (data.scheduled_change as Record<string, unknown>) ?? null;
  const cancelAt =
    scheduled && typeof scheduled === "object" && scheduled.action === "cancel"
      ? dateToMs(scheduled.effective_at)
      : null;

  const trial = (data.trial_dates as Record<string, unknown>) ?? null;

  return {
    eventId,
    eventType,
    organizationIdHint: customString(
      data,
      "atlas.organization_id",
      "atlas_organization_id",
    ),
    providerCustomerId: (data.customer_id as string) ?? null,
    providerSubscriptionId: (data.id as string) ?? null,
    providerPriceId: priceId,
    internalPlan,
    billingInterval,
    status: (data.status as string) ?? null,
    trialStart:
      trial && typeof trial === "object" ? dateToMs(trial.starts_at) : null,
    trialEnd:
      trial && typeof trial === "object" ? dateToMs(trial.ends_at) : null,
    currentPeriodStart: periodOf(data, "starts_at"),
    currentPeriodEnd: periodOf(data, "ends_at"),
    nextBilledAt: dateToMs(data.next_billed_at),
    cancelAt,
    canceledAt: dateToMs(data.canceled_at),
    providerEventAt: dateToMs(payload.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// Checkout — transaction creation
// ---------------------------------------------------------------------------

export async function createPaddleTransaction(
  organizationId: string,
  plan: InternalPlan,
  interval: BillingInterval,
): Promise<{ transactionId: string; url: string }> {
  const apiKey = Deno.env.get("PADDLE_API_KEY") ?? "";
  if (!apiKey) {
    throw new Error("PADDLE_API_KEY is not configured.");
  }
  const priceId = paddlePriceId(plan, interval);
  if (!priceId) {
    throw new Error("The selected Atlas plan is not configured for billing.");
  }

  // Paddle Billing API endpoints carry no version prefix: the base URL is
  // already versioned (api.paddle.com / api.sandbox.paddle.com). A `/v1`
  // prefix yields HTTP 404 from Paddle.
  const response = await fetch(`${paddleApiBase()}/transactions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // Note: Paddle's create-transaction API has no top-level `description`
    // field — sending undocumented fields risks a 400. The price name/plan
    // is carried by the catalog price itself and custom_data below.
    body: JSON.stringify({
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: {
        atlas_organization_id: organizationId,
        atlas_internal_plan: plan,
        atlas_billing_interval: interval,
      },
    }),
  });

  if (!response.ok) {
    // Include the sanitized Paddle error detail in the thrown message so the
    // Edge Function log identifies the real failure; the client never sees
    // this message (paddle-checkout maps it to a generic 502 response).
    const detail = await response
      .text()
      .then((t) => t.slice(0, 300))
      .catch(() => "");
    throw new Error(
      `Paddle checkout could not be created (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const data = (json.data as Record<string, unknown>) ?? json;
  const checkout = (data.checkout as Record<string, unknown>) ?? {};
  const url = (checkout.url as string) ?? (data.url as string) ?? "";

  if (!url) {
    throw new Error("Paddle did not return a checkout URL for the transaction.");
  }
  return { transactionId: (data.id as string) ?? "", url };
}

// ---------------------------------------------------------------------------
// Webhook sender IP allowlist
//
// Paddle publishes the current webhook-sending IPs at https://api.paddle.com/ips
// (also api.sandbox.paddle.com for sandbox). The list is fetched and cached
// rather than hard-coded, because it can change. Enforcement in the webhook
// function is opt-in via PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST=1, so an
// infrastructure mismatch (e.g. a proxy that rewrites source IPs) cannot
// silently break live webhook delivery; signature verification remains the
// mandatory control. All current entries are /32 IPv4.
// ---------------------------------------------------------------------------

const PADDLE_IPS_URL = "https://api.paddle.com/ips";
const PADDLE_IPS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PADDLE_IPS_CACHE_KEY = "atlas_paddle_ips_cache";

interface PaddleIpsCache {
  cidrs: string[];
  fetchedAt: number;
}

export function ipToBytes(ip: string): Uint8Array | null {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const n = Number(parts[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      bytes[i] = n;
    }
    return bytes;
  }
  if (ip.includes(":")) {
    // Expanded IPv6 only (Paddle currently publishes IPv4 /32s; IPv6 support
    // is handled as a safety fallback rather than a full parser).
    const parts = ip.split(":");
    if (parts.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(parts[i])) return null;
      const n = parseInt(parts[i], 16);
      bytes[i * 2] = (n >> 8) & 0xff;
      bytes[i * 2 + 1] = n & 0xff;
    }
    return bytes;
  }
  return null;
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split("/");
  if (!network || prefixStr === undefined) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  const ipBytes = ipToBytes(ip);
  const netBytes = ipToBytes(network);
  if (!ipBytes || !netBytes || ipBytes.length !== netBytes.length) return false;
  const maxBits = ipBytes.length * 8;
  if (prefix > maxBits) return false;
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== netBytes[i]) return false;
  }
  const remainingBits = prefix % 8;
  if (remainingBits > 0 && fullBytes < ipBytes.length) {
    const mask = 0xff << (8 - remainingBits);
    if ((ipBytes[fullBytes] & mask) !== (netBytes[fullBytes] & mask)) return false;
  }
  return true;
}

async function fetchPaddleWebhookIps(): Promise<string[]> {
  const globalKey = PADDLE_IPS_CACHE_KEY as unknown as string;
  const cached = (globalThis as Record<string, unknown>)[globalKey] as
    | PaddleIpsCache
    | undefined;
  if (cached && Date.now() - cached.fetchedAt < PADDLE_IPS_TTL_MS) {
    return cached.cidrs;
  }
  const response = await fetch(PADDLE_IPS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Paddle IP list fetch failed (HTTP ${response.status}).`);
  }
  const json = (await response.json()) as { data?: { ipv4_cidrs?: string[] } };
  const cidrs = json.data?.ipv4_cidrs ?? [];
  if (cidrs.length === 0) {
    throw new Error("Paddle IP list returned no CIDRs.");
  }
  (globalThis as Record<string, unknown>)[globalKey] = {
    cidrs,
    fetchedAt: Date.now(),
  };
  return cidrs;
}

/**
 * Resolve the caller's IP from a Deno edge request. Supabase sets the
 * x-forwarded-for / x-real-ip headers; falls back to conn.remoteAddr.
 */
export function webhookClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip") ?? "";
  if (xri) return xri.trim();
  const remote = req.headers.get("cf-connecting-ip");
  if (remote) return remote.trim();
  return null;
}

/**
 * Allowlist check against Paddle's published webhook sender IPs.
 * Throws if the caller is not in the allowlist (403) or if the list could
 * not be fetched (fail-open is NOT applied here: the caller decides via
 * enforce flag; see isPaddleWebhookSource).
 */
export async function isPaddleWebhookSource(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const cidrs = await fetchPaddleWebhookIps();
  return cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

/**
 * Run the allowlist check when PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST=1.
 * Fails OPEN (returns true, logs a warning) if the IP list cannot be fetched
 * or the caller IP is unknown, so an infrastructure hiccup cannot brick live
 * webhook delivery; signature verification remains the mandatory control.
 */
export async function enforcePaddleWebhookIpAllowlist(req: Request): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  if ((Deno.env.get("PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST") ?? "") !== "1") {
    return { allowed: true }; // feature off
  }
  const ip = webhookClientIp(req);
  if (!ip) {
    console.warn("[paddle-webhook] IP allowlist enabled but caller IP unavailable; allowing (signature still required).");
    return { allowed: true };
  }
  try {
    const allowed = await isPaddleWebhookSource(ip);
    return { allowed, reason: allowed ? undefined : `caller IP ${ip} not in Paddle webhook allowlist` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[paddle-webhook] IP allowlist check failed; allowing (signature still required):", msg);
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, paddle-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}