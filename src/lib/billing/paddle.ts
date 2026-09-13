// ---------------------------------------------------------------------------
// Atlas Billing — Paddle Provider Adapter
//
// This adapter implements the BillingProviderAdapter interface for Paddle
// Billing. It is server-side only: it never ships to the browser.
//
// Sources of truth:
//   - Paddle Node SDK: https://developer.paddle.com/sdk
//   - Paddle API:      https://developer.paddle.com/api-reference
//   - Paddle webhooks: https://developer.paddle.com/webhooks
//
// Signature verification follows the documented Paddle scheme:
//   - header: `Paddle-Signature: ts=<unix-seconds>;h1=<hex>[;h1=<hex>…]`
//   - signed payload: `${ts}:${rawBody}`
//   - HMAC-SHA256 with the notification destination's secret key
//   - replay protection: reject timestamps outside the tolerance window
//
// Environment (server-side only — never VITE_/NEXT_PUBLIC_):
//   PADDLE_ENVIRONMENT        sandbox | live (default sandbox)
//   PADDLE_API_KEY            server API key (secret)
//   PADDLE_CLIENT_TOKEN       client-side token (only for Paddle.js overlay)
//   PADDLE_WEBHOOK_SECRET     notification destination secret (secret)
//   PADDLE_SELLER_ID          vendor id (secret, kept server-side)
//   PADDLE_APP_BASEPATH       base path used for redirects (unused in v1 API)
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProviderAdapter, ProviderSubscription } from "./provider";
import type { BillingWebhookEvent } from "./types";
import type {
  BillingInterval,
  BillingProvider,
  InternalPlan,
  OrganizationSubscription,
  SubscriptionStatus,
} from "./types";
import { SUBSCRIPTION_STATUSES } from "./types";
import {
  paddlePriceId,
  billingIntervalForPaddlePriceId,
  internalPlanForPaddlePriceId,
} from "./plans";

// ---------------------------------------------------------------------------
// Environment gating (read lazily so tests can set env vars per-case)
// ---------------------------------------------------------------------------

export type PaddleEnvironment = "sandbox" | "live";

function env(name: string): string {
  return process.env[name] ?? "";
}

function paddleEnvironment(): PaddleEnvironment {
  const v = env("PADDLE_ENVIRONMENT").toLowerCase();
  return v === "live" || v === "production" ? "live" : "sandbox";
}

function paddleApiKey(): string {
  return env("PADDLE_API_KEY");
}function paddleClientToken(): string {
  return env("PADDLE_CLIENT_TOKEN");
}

function paddleWebhookSecret(): string {
  return env("PADDLE_WEBHOOK_SECRET");
}

// PADDLE_SELLER_ID and PADDLE_APP_BASEPATH are reserved env names kept for
// configuration compatibility; the Billing v1 API does not require them.
// PADDLE_CLIENT_TOKEN is only needed for the Paddle.js overlay checkout.


/** Paddle API base for the configured environment. */
function paddleApiBase(): string {
  return paddleEnvironment() === "sandbox"
    ? "https://api.sandbox.paddle.com"
    : "https://api.paddle.com";
}

/** Paddle Checkout base for the configured environment. */
export function paddleCheckoutBase(): string {
  return paddleEnvironment() === "sandbox"
    ? "https://checkout.sandbox.paddle.com"
    : "https://checkout.paddle.com";
}

// ---------------------------------------------------------------------------
// HTTP helpers (minimal fetch wrapper)
// ---------------------------------------------------------------------------

async function paddleFetch(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  return fetch(`${paddleApiBase()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${paddleApiKey()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Checkout — transaction creation
// ---------------------------------------------------------------------------

/**
 * Create a Paddle transaction for the given plan/interval and return the
 * hosted checkout URL.
 *
 * Paddle is the billing source of truth: the $10 / 1-day trial and the
 * recurring price are configured on the catalog price, and Paddle creates the
 * subscription when the transaction completes. Atlas never charges the trial
 * itself and never starts its own trial timer.
 *
 * Custom data (flat string map) survives checkout → transaction →
 * subscription → webhook, which is how the webhook reconciles the
 * subscription back to the Atlas organization.
 */
export async function createPaddleCheckoutTransaction(
  organizationId: string,
  internalPlan: InternalPlan,
  interval: BillingInterval,
): Promise<{ transactionId: string; url: string }> {
  if (!paddleApiKey()) {
    throw new Error("PADDLE_API_KEY is not configured for the billing provider.");
  }

  const priceId = paddlePriceId(internalPlan, interval);
  if (!priceId) {
    throw new Error(
      `The selected Atlas plan is not configured for billing. ` +
        `Set PADDLE_${internalPlan.replace("ATLAS_", "").toUpperCase()}_PRICE_ID_${interval.toUpperCase()} in the server environment.`,
    );
  }

  const customData = {
    atlas_organization_id: organizationId,
    atlas_internal_plan: internalPlan,
    atlas_billing_interval: interval,
  };

  // Paddle Billing API endpoints carry no version prefix: the base URL is
  // already versioned (api.paddle.com / api.sandbox.paddle.com). A `/v1`
  // prefix yields HTTP 404 from Paddle.
  const response = await paddleFetch("/transactions", {
    method: "POST",
    body: {
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: customData,
    },
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Paddle checkout could not be created (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const data = (json.data as Record<string, unknown>) ?? json;
  const checkout = (data.checkout as Record<string, unknown>) ?? {};
  const url = (checkout.url as string) ?? (data.url as string) ?? "";

  if (!url) {
    throw new Error(
      "Paddle did not return a checkout URL for the transaction.",
    );
  }

  return {
    transactionId: (data.id as string) ?? "",
    url,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification (documented Paddle scheme)
// ---------------------------------------------------------------------------

/**
 * Verify a Paddle webhook signature.
 *
 * Paddle signs every webhook with HMAC-SHA256 over `ts:<rawBody>` using the
 * notification destination's secret key, and sends it in the
 * `Paddle-Signature` header as `ts=<unix>;h1=<hex>` (multiple `h1=` values
 * are allowed for key rotation).
 *
 * Throws when the signature is missing, malformed, stale, or invalid.
 * Returns the parsed JSON payload when verified.
 */
export function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  now?: number,
): Record<string, unknown> {
  if (!signatureHeader) {
    throw new Error("Missing Paddle webhook signature header.");
  }
  const secret = paddleWebhookSecret();
  if (!secret) {
    throw new Error(
      "PADDLE_WEBHOOK_SECRET is not configured; webhook verification is disabled.",
    );
  }

  // Header: `ts=1671552777;h1=eb4d…[;h1=…]`
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

  // Replay protection: reject events outside the tolerance window.
  const nowMs = now ?? Date.now();
  const eventAgeMs = nowMs - ts * 1000;
  const toleranceMs = 5 * 60 * 1000;
  if (Math.abs(eventAgeMs) > toleranceMs) {
    throw new Error(
      `Paddle webhook timestamp outside tolerance window (${Math.round(eventAgeMs)} ms).`,
    );
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}:${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  let matched = false;
  for (const candidate of signatures) {
    const actualBuf = Buffer.from(candidate.toLowerCase(), "hex");
    if (
      actualBuf.length === expectedBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf)
    ) {
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
// Paddle Billing v1 payload helpers
// ---------------------------------------------------------------------------

/** Parse a Paddle RFC3339 date-time string into Unix ms (null when absent). */
export function paddleDateToMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function getCustomData(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw =
    (data.custom_data as Record<string, unknown>) ??
    (data.customData as Record<string, unknown>) ??
    null;
  return raw && typeof raw === "object" ? raw : null;
}

function readCustomDataString(
  customData: Record<string, unknown> | null,
  dotted: string,
  flat: string,
): string | null {
  if (!customData) return null;
  const v = customData[dotted] ?? customData[flat];
  return typeof v === "string" && v ? v : null;
}

function subscriptionItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = data.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/** Resolve the price id from a Paddle subscription payload. */
function extractPriceId(data: Record<string, unknown>): string | null {
  const items = subscriptionItems(data);
  for (const item of items) {
    const priceId = (item.price_id as string) ?? (item.priceId as string);
    if (priceId) return priceId;
    const price = item.price as Record<string, unknown> | undefined;
    if (price && typeof price.id === "string") return price.id;
  }
  const direct =
    (data.price_id as string) ?? (data.priceId as string) ?? null;
  return typeof direct === "string" ? direct : null;
}

/** Resolve the billing interval from a subscription payload. */
function extractBillingCycleInterval(data: Record<string, unknown>): BillingInterval | null {
  const cycle = (data.billing_cycle as Record<string, unknown>) ??
    (data.billingCycle as Record<string, unknown>) ??
    null;
  const interval = cycle && typeof cycle === "object"
    ? (cycle.interval as string) ?? null
    : null;
  if (interval === "month") return "monthly";
  if (interval === "year") return "annual";
  return null;
}

/** Map a Paddle status string into the Atlas status model. */
export function mapPaddleStatus(status: string | undefined | null): SubscriptionStatus {
  const s = (status ?? "unknown").toLowerCase().trim();
  const valid = Object.values(SUBSCRIPTION_STATUSES) as string[];
  return valid.includes(s) ? (s as SubscriptionStatus) : "unknown";
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export function paddleAdapterInit(): void {
  if (!paddleApiKey()) {
    throw new Error("PADDLE_API_KEY is not configured for the billing provider.");
  }
  if (paddleEnvironment() === "live" && !paddleWebhookSecret()) {
    throw new Error("PADDLE_WEBHOOK_SECRET must be configured for the live environment.");
  }
}

export function canBuildPaddleCheckout(): boolean {
  return Boolean(paddleApiKey());
}

/** The Paddle adapter surface (contract + internal helpers used in tests). */
export interface PaddleAdapter extends BillingProviderAdapter {
  extractProviderCustomerId(data: Record<string, unknown>): string | null;
  extractProviderSubscriptionId(data: Record<string, unknown>): string | null;
  mapStatus(data: Record<string, unknown>): SubscriptionStatus;
  extractInternalPlan(data: Record<string, unknown>): InternalPlan | null;
  extractBillingInterval(data: Record<string, unknown>): BillingInterval | null;
  extractCurrentPeriodStart(data: Record<string, unknown>): number | null;
  extractCurrentPeriodEnd(data: Record<string, unknown>): number | null;
  extractNextBilledAt(data: Record<string, unknown>): number | null;
  extractCancelAt(data: Record<string, unknown>): number | null;
  extractCanceledAt(data: Record<string, unknown>): number | null;
  extractTrialStart(data: Record<string, unknown>): number | null;
  extractTrialEnd(data: Record<string, unknown>): number | null;
  mapProviderSubscription(json: Record<string, unknown>): ProviderSubscription;
  mapInternalPlanForSubscription(subscription: ProviderSubscription): InternalPlan | null;
  mapStatusForSubscription(subscription: ProviderSubscription): SubscriptionStatus;
}

export const PADDLE_ADAPTER: PaddleAdapter = {
  name: "paddle" as BillingProvider,

  init(): void {
    paddleAdapterInit();
  },

  canBuildCheckout(): boolean {
    return canBuildPaddleCheckout();
  },

  async buildCheckoutUrl(
    organizationId: string,
    internalPlan: InternalPlan,
    interval: "monthly" | "annual",
    _metadata: Record<string, string>,
  ): Promise<string> {
    const { url } = await createPaddleCheckoutTransaction(
      organizationId,
      internalPlan,
      interval,
    );
    return url;
  },

  // ---- Webhook verification ----

  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
    now?: number,
  ): Record<string, unknown> {
    return verifyPaddleWebhookSignature(rawBody, signatureHeader, now);
  },

  // ---- Webhook event parsing (Paddle Billing v1) ----

  parseWebhookEvent(payload: Record<string, unknown>): BillingWebhookEvent {
    const eventType = (payload.event_type as string) ?? "";
    const eventId = (payload.event_id as string) ?? "";

    if (!eventType) {
      throw new Error("Paddle webhook event has no event_type.");
    }
    if (!eventId) {
      throw new Error("Paddle webhook event has no event_id.");
    }

    const data = (payload.data as Record<string, unknown>) ?? {};
    const customData = getCustomData(data);

    // Subscription id: subscription.* events carry the subscription at
    // data.id; transaction.* events may reference data.subscription_id.
    const providerSubscriptionId =
      this.extractProviderSubscriptionId(data);

    const providerCustomerId = this.extractProviderCustomerId(data);

    const status = this.mapStatus(data);
    const internalPlan = this.extractInternalPlan(data);
    const billingInterval = this.extractBillingInterval(data);

    const priceId = extractPriceId(data);

    // The price id is the authoritative mapping: when an event carries a
    // price id that is not one of Atlas's configured prices, the plan stays
    // null (never infer from custom data alone). Custom data is only used as
    // a fallback when the event carries no price id at all.
    const resolvedPlan = priceId
      ? internalPlanForPaddlePriceId(priceId) ?? null
      : internalPlan;
    const resolvedInterval = priceId
      ? billingIntervalForPaddlePriceId(priceId) ?? null
      : billingInterval;

    // Organization id embedded at checkout time survives into the webhook via
    // custom data — this is how a brand-new subscription is reconciled.
    const organizationIdHint = readCustomDataString(
      customData,
      "atlas.organization_id",
      "atlas_organization_id",
    );

    return {
      providerEventId: eventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      providerPriceId: priceId,
      organizationIdHint,
      internalPlan: resolvedPlan,
      billingInterval: resolvedInterval,
      active: status === "active" || status === "trialing",
      status,
      currentPeriodStart: this.extractCurrentPeriodStart(data),
      currentPeriodEnd: this.extractCurrentPeriodEnd(data),
      nextBilledAt: this.extractNextBilledAt(data),
      cancelAt: this.extractCancelAt(data),
      canceledAt: this.extractCanceledAt(data),
      trialStart: this.extractTrialStart(data),
      trialEnd: this.extractTrialEnd(data),
      providerEventAt: paddleDateToMs(payload.occurred_at),
    };
  },

  // ---- Subscription sync ----

  async fetchSubscription(
    _providerCustomerId: string,
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    try {
      const response = await paddleFetch(
        `/subscriptions/${providerSubscriptionId}`,
        {},
      );
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Paddle subscription fetch failed: ${response.status}`);
      }
      const json = (await response.json()) as Record<string, unknown>;
      return this.mapProviderSubscription(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Paddle subscription fetch failed: ${msg}`);
    }
  },

  mapSubscriptionToRecord(
    providerCustomerId: string,
    providerSubscription: ProviderSubscription,
    existing: OrganizationSubscription | null,
  ): OrganizationSubscription {
    const now = Date.now();
    const priceId = providerSubscription.priceId ?? null;
    const internalPlan =
      (priceId ? internalPlanForPaddlePriceId(priceId) : null) ??
      this.mapInternalPlanForSubscription(providerSubscription);
    const billingInterval =
      (priceId ? billingIntervalForPaddlePriceId(priceId) : null) ??
      (providerSubscription.billingCycle === "annual" ? "annual" : "monthly");

    return {
      organization_id: existing?.organization_id ?? "",
      billing_provider: "paddle",
      provider_customer_id: providerCustomerId,
      provider_subscription_id: providerSubscription.id,
      provider_price_id: priceId,
      internal_plan: internalPlan,
      billing_interval: billingInterval,
      status: this.mapStatusForSubscription(providerSubscription),
      trial_start: providerSubscription.trialStartDate ?? null,
      trial_end: providerSubscription.trialEndDate ?? null,
      current_period_start: providerSubscription.currentPeriodStart ?? null,
      current_period_end: providerSubscription.currentPeriodEnd ?? null,
      next_billed_at: providerSubscription.nextBilledAt ?? null,
      cancel_at: providerSubscription.cancelAt ?? null,
      canceled_at: providerSubscription.canceledAt ?? null,
      // The event timestamp that produced this provider state; preserved
      // from the existing row when the fetch/sync did not carry an event.
      provider_event_at: existing?.provider_event_at ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  },

  // ---- Internal helpers ----

  extractProviderCustomerId(
    data: Record<string, unknown>,
  ): string | null {
    const customer =
      (data.customer_id as string) ??
      (data.customerId as string) ??
      null;
    if (typeof customer === "string") return customer;
    const customerObj = data.customer as Record<string, unknown> | undefined;
    if (customerObj && typeof customerObj === "object") {
      return (customerObj.id as string) ?? null;
    }
    return null;
  },

  extractProviderSubscriptionId(
    data: Record<string, unknown>,
  ): string | null {
    const direct =
      (data.id as string) ??
      (data.subscription_id as string) ??
      (data.subscriptionId as string) ??
      null;
    if (typeof direct === "string") return direct;
    const sub = data.subscription as Record<string, unknown> | undefined;
    if (sub && typeof sub === "object") {
      return (sub.id as string) ?? null;
    }
    return null;
  },

  mapStatus(data: Record<string, unknown>): SubscriptionStatus {
    const status =
      (data.status as string) ??
      (data.subscriptionStatus as string) ??
      "unknown";
    return mapPaddleStatus(status);
  },

  mapStatusForSubscription(
    subscription: ProviderSubscription,
  ): SubscriptionStatus {
    return mapPaddleStatus(subscription.status);
  },

  extractInternalPlan(
    data: Record<string, unknown>,
  ): InternalPlan | null {
    const customData = getCustomData(data);
    const plan = readCustomDataString(
      customData,
      "atlas.internal_plan",
      "atlas_internal_plan",
    );
    if (
      plan === "ATLAS_STARTER" ||
      plan === "ATLAS_GROWTH" ||
      plan === "ATLAS_SCALE"
    ) {
      return plan as InternalPlan;
    }
    return null;
  },

  extractBillingInterval(
    data: Record<string, unknown>,
  ): BillingInterval | null {
    const customData = getCustomData(data);
    const custom = readCustomDataString(
      customData,
      "atlas.billing_interval",
      "atlas_billing_interval",
    );
    if (custom === "monthly" || custom === "annual") return custom;
    return extractBillingCycleInterval(data);
  },

  extractCurrentPeriodStart(
    data: Record<string, unknown>,
  ): number | null {
    const period = (data.current_billing_period as Record<string, unknown>) ??
      (data.currentBillingPeriod as Record<string, unknown>) ??
      null;
    if (period && typeof period === "object") {
      const v = paddleDateToMs(period.starts_at ?? period.startsAt);
      if (v !== null) return v;
    }
    return paddleDateToMs(data.current_period_start ?? data.currentPeriodStart);
  },

  extractCurrentPeriodEnd(
    data: Record<string, unknown>,
  ): number | null {
    const period = (data.current_billing_period as Record<string, unknown>) ??
      (data.currentBillingPeriod as Record<string, unknown>) ??
      null;
    if (period && typeof period === "object") {
      const v = paddleDateToMs(period.ends_at ?? period.endsAt);
      if (v !== null) return v;
    }
    return paddleDateToMs(data.current_period_end ?? data.currentPeriodEnd);
  },

  extractNextBilledAt(
    data: Record<string, unknown>,
  ): number | null {
    return paddleDateToMs(data.next_billed_at ?? data.nextBilledAt);
  },

  extractCancelAt(
    data: Record<string, unknown>,
  ): number | null {
    // scheduled_change.action = "cancel" carries the effective cancellation
    // date; this is the "cancel at period end" signal.
    const scheduled = (data.scheduled_change as Record<string, unknown>) ??
      (data.scheduledChange as Record<string, unknown>) ??
      null;
    if (scheduled && typeof scheduled === "object") {
      const action = scheduled.action as string;
      if (action === "cancel") {
        const v = paddleDateToMs(scheduled.effective_at ?? scheduled.effectiveAt);
        if (v !== null) return v;
      }
    }
    return paddleDateToMs(data.cancel_at ?? data.cancelAt);
  },

  extractCanceledAt(
    data: Record<string, unknown>,
  ): number | null {
    return paddleDateToMs(data.canceled_at ?? data.canceledAt);
  },

  extractTrialStart(
    data: Record<string, unknown>,
  ): number | null {
    const trial = (data.trial_dates as Record<string, unknown>) ??
      (data.trialDates as Record<string, unknown>) ??
      null;
    if (trial && typeof trial === "object") {
      const v = paddleDateToMs(trial.starts_at ?? trial.startsAt);
      if (v !== null) return v;
    }
    return paddleDateToMs(data.trial_start ?? data.trialStart);
  },

  extractTrialEnd(
    data: Record<string, unknown>,
  ): number | null {
    const trial = (data.trial_dates as Record<string, unknown>) ??
      (data.trialDates as Record<string, unknown>) ??
      null;
    if (trial && typeof trial === "object") {
      const v = paddleDateToMs(trial.ends_at ?? trial.endsAt);
      if (v !== null) return v;
    }
    return paddleDateToMs(data.trial_end ?? data.trialEnd);
  },

  mapProviderSubscription(
    json: Record<string, unknown>,
  ): ProviderSubscription {
    const s = ((json.data as Record<string, unknown>) ?? json) as Record<string, unknown>;
    const items = subscriptionItems(s);
    const priceId = extractPriceId(s);
    return {
      id: (s.id as string) ?? "",
      customerId: (s.customer_id as string) ?? (s.customerId as string) ?? "",
      status: (s.status as string) ?? "unknown",
      planId: (s.plan_id as string) ?? null,
      priceId: priceId,
      billingCycle:
        extractBillingCycleInterval(s) ??
        "monthly",
      trialStartDate: this.extractTrialStart(s),
      trialEndDate: this.extractTrialEnd(s),
      currentPeriodStart: this.extractCurrentPeriodStart(s),
      currentPeriodEnd: this.extractCurrentPeriodEnd(s),
      nextBilledAt: this.extractNextBilledAt(s),
      cancelAt: this.extractCancelAt(s),
      canceledAt: this.extractCanceledAt(s),
      amount: typeof s.amount === "number" ? s.amount : null,
      currency: (s.currency_code as string) ?? (s.currency as string) ?? null,
    };
  },

  mapInternalPlanForSubscription(
    subscription: ProviderSubscription,
  ): InternalPlan | null {
    if (subscription.priceId) {
      return internalPlanForPaddlePriceId(subscription.priceId);
    }
    return null;
  },
};