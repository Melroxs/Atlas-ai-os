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
// Where possible we use documented Paddle conventions rather than hard-coding
// assumptions. Any SDK function names / signature shapes below should be
// verified against the SDK version installed in package.json; this file pins
// the contract but must match the installed package.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProviderAdapter, ProviderSubscription } from "./provider";
import type { BillingWebhookEvent } from "./types";
import type {
  BillingProvider,
  OrganizationSubscription,
  SubscriptionStatus,
  InternalPlan,
} from "./types";
import { paddlePriceId, internalPlanForPaddlePriceId } from "./plans";
import { INTERNAL_PLANS, SUBSCRIPTION_STATUSES } from "./types";

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

/** Paddle environment: sandbox or live. */
export type PaddleEnvironment = "sandbox" | "live";

const PADDLE_ENV = (process.env.PADDLE_ENVIRONMENT ?? "sandbox") as PaddleEnvironment;
const PADDLE_API_KEY = process.env.PADDLE_API_KEY ?? "";
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN ?? "";
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET ?? "";
const PADDLE_SELLER_ID = process.env.PADDLE_SELLER_ID ?? "";
const PADDLE_APP_BASEPATH =
  process.env.PADDLE_APP_BASEPATH ?? "/api/webhooks/paddle";

// ---------------------------------------------------------------------------
// HTTP helpers (minimal, no fetch wrapper needed by the adapter)
// ---------------------------------------------------------------------------

async function paddleFetch(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  const url =
    PADDLE_ENV === "sandbox"
      ? `https://api.sandbox.paddle.com${path}`
      : `https://api.paddle.com${path}`;

  return fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${PADDLE_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Checkout URL construction
// ---------------------------------------------------------------------------

/**
 * Build a Paddle checkout URL for a given organization.
 *
 * We carry the organization id through Paddle's checkout custom data so the
 * webhook can reconcile the subscription to the right organization later.
 * Custom data is the documented Paddle mechanism for passing application
 * context through checkout ➜ transaction ➜ subscription ➜ webhook.
 */
export function buildPaddleCheckoutUrl(
  organizationId: string,
  internalPlan: InternalPlan,
  interval: "monthly" | "annual",
  metadata: Record<string, string>,
): string {
  const priceId = paddlePriceId(internalPlan, interval);
  if (!priceId) {
    throw new Error(
      `No Paddle price ID configured for plan ${internalPlan} + ${interval}. ` +
        "Set PADDLE_*_PRICE_ID_MONTHLY/ANNUAL in the server environment.",
    );
  }

  const customData: Record<string, string> = {
    ...metadata,
    "atlas.organization_id": organizationId,
    "atlas.internal_plan": internalPlan,
    "atlas.billing_interval": interval,
    "atlas.checkout_source": "atlas_billing",
  };

  const baseUrl =
    PADDLE_ENV === "sandbox"
      ? "https://checkout.sandbox.paddle.com"
      : "https://checkout.paddle.com";
  const checkoutPath = "/checkout";

  const params = new URLSearchParams({
    // Paddle Checkout uses vendor/products/prices identifiers; we pass the
    // price id for a single-product checkout.
    items: JSON.stringify([
      {
        priceId,
        quantity: 1,
      },
    ]),
    // Custom data is sent through checkout and returned in the transaction
    // / subscription webhook payloads, preserving the organization context.
    customData: JSON.stringify(customData),
    // Allow the buyer to enter billing details; we create the customer at
    // checkout time so the webhook can associate the subscription.
    allowLogin: "false",
    // Base path to our webhook endpoint (used by the merchant dashboard link
    // and any redirects back to Atlas).
    appBasePath: PADDLE_APP_BASEPATH,
  });

  return `${baseUrl}${checkoutPath}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Paddle adapter implementation
// ---------------------------------------------------------------------------

export function paddleAdapterInit() {
  if (!PADDLE_API_KEY) {
    throw new Error(
      "PADDLE_API_KEY is not configured for the billing provider.",
    );
  }
  if (PADDLE_ENV === "live" && !PADDLE_WEBHOOK_SECRET) {
    throw new Error(
      "PADDLE_WEBHOOK_SECRET must be configured for the live environment.",
    );
  }
}

export function canBuildPaddleCheckout(): boolean {
  return Boolean(PADDLE_API_KEY && PADDLE_CLIENT_TOKEN);
}

/**
 * The Paddle adapter surface, including the internal extraction/mapping
 * helpers used by parseWebhookEvent / mapSubscriptionToRecord.
 */
interface PaddleAdapter extends BillingProviderAdapter {
  extractProviderCustomerId(data: Record<string, unknown>): string | null;
  extractProviderSubscriptionId(data: Record<string, unknown>): string | null;
  mapStatus(data: Record<string, unknown>): SubscriptionStatus;
  extractInternalPlan(data: Record<string, unknown>): InternalPlan | null;
  extractCurrentPeriodStart(data: Record<string, unknown>): number | null;
  extractCurrentPeriodEnd(data: Record<string, unknown>): number | null;
  extractCancelAt(data: Record<string, unknown>): number | null;
  extractCanceledAt(data: Record<string, unknown>): number | null;
  extractTrialStart(data: Record<string, unknown>): number | null;
  extractTrialEnd(data: Record<string, unknown>): number | null;
  mapProviderSubscription(json: Record<string, unknown>): ProviderSubscription;
  mapInternalPlanForSubscription(
    subscription: ProviderSubscription,
  ): InternalPlan | null;
  mapStatusForSubscription(
    subscription: ProviderSubscription,
  ): SubscriptionStatus;
}

export const PADDLE_ADAPTER: PaddleAdapter = {
  name: "paddle" as BillingProvider,

  init(): void {
    paddleAdapterInit();
  },

  canBuildCheckout(): boolean {
    return canBuildPaddleCheckout();
  },

  buildCheckoutUrl(
    organizationId: string,
    internalPlan: InternalPlan,
    interval: "monthly" | "annual",
    metadata: Record<string, string>,
  ): string {
    return buildPaddleCheckoutUrl(organizationId, internalPlan, interval, metadata);
  },

  // ---- Webhook verification ----

  /**
   * Verify a Paddle webhook signature.
   *
   * Paddle signs webhook requests with an HMAC-SHA256 signature sent in the
   * `Paddle-Signature` header. The signature covers the raw request body and
   * a timestamp. The documented verification flow:
   *   1. Parse the header into timestamp + signature.
   *   2. Reject events with a timestamp too old.
   *   3. Compute HMAC-SHA256(webhook_secret, timestamp + raw_body).
   *   4. Compare against the signature using a constant-time comparison.
   *
   * This implementation uses Node's built-in crypto. If the installed Paddle
   * SDK exposes a documented verifyWebhookSignature function, prefer it and
   * replace this with the SDK's verified implementation.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
    now?: number,
  ): Record<string, unknown> {
    if (!signatureHeader) {
      throw new Error("Missing Paddle webhook signature header.");
    }
    if (!PADDLE_WEBHOOK_SECRET) {
      throw new Error(
        "PADDLE_WEBHOOK_SECRET is not configured; webhook verification is disabled.",
      );
    }

    const parts = signatureHeader.split(",");
    const header: Record<string, string> = {};
    for (const part of parts) {
      const [key, value] = part.split("=");
      if (key && value) header[key.trim()] = value.trim();
    }

    const timestamp = header["t"];
    const signature = header["v1"] ?? header["v2"] ?? header["signature"];
    const ts = Number(timestamp);

    if (!timestamp || !signature) {
      throw new Error(
        "Paddle webhook signature header is malformed: missing t / signature.",
      );
    }

    // Reject events whose timestamp is not a safe integer.
    if (!Number.isSafeInteger(ts)) {
      throw new Error(
        "Paddle webhook timestamp is not a safe integer.",
      );
    }

    // Reject events older than 5 minutes.
    const nowMs = now ?? Date.now();
    const eventAge = nowMs - ts;
    if (eventAge > 5 * 60 * 1000) {
      throw new Error(
        `Paddle webhook timestamp too old (${Math.round(eventAge)} ms).`,
      );
    }

    const expected = createHmac("sha256", PADDLE_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    const actual = signature.toLowerCase();

    // Constant-time comparison on fixed-length buffers.
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(actual, "hex");
    if (expectedBuf.length !== actualBuf.length) {
      throw new Error("Paddle webhook signature verification failed.");
    }
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
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
  },

  // ---- Webhook event parsing ----

  parseWebhookEvent(payload: Record<string, unknown>): BillingWebhookEvent {
    const eventType =
      (payload.event_type as string) ??
      (payload.type as string) ??
      "";

    if (!eventType) {
      throw new Error("Paddle webhook event has no event_type.");
    }

    const data = (payload.data as Record<string, unknown>) ?? {};

    const providerCustomerId = this.extractProviderCustomerId(data);
    const providerSubscriptionId = this.extractProviderSubscriptionId(data);
    const status = this.mapStatus(data);
    const internalPlan = this.extractInternalPlan(data);
    const currentPeriodStart = this.extractCurrentPeriodStart(data);
    const currentPeriodEnd = this.extractCurrentPeriodEnd(data);
    const cancelAt = this.extractCancelAt(data);
    const canceledAt = this.extractCanceledAt(data);
    const trialStart = this.extractTrialStart(data);
    const trialEnd = this.extractTrialEnd(data);

    const active =
      status === "active" || status === "trialing";

    // Provider event id for idempotency.
    const providerEventId =
      (payload.event_id as string) ??
      (payload.id as string) ??
      "";

    if (!providerEventId) {
      throw new Error("Paddle webhook event has no event_id.");
    }

    const providerEventAt =
      (payload.event_date as number) ?? null;

    return {
      providerEventId,
      eventType,
      providerCustomerId,
      providerSubscriptionId,
      internalPlan,
      active,
      status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAt,
      canceledAt,
      trialStart,
      trialEnd,
      providerEventAt,
    };
  },

  // ---- Subscription sync ----

  async fetchSubscription(
    providerCustomerId: string,
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    try {
      const response = await paddleFetch(
        `/v1/subscriptions/${providerSubscriptionId}`,
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

    return {
      organization_id: existing?.organization_id ?? "",
      billing_provider: "paddle",
      provider_customer_id: providerCustomerId,
      provider_subscription_id: providerSubscription.id,
      internal_plan: this.mapInternalPlanForSubscription(providerSubscription),
      provider_price_id: providerSubscription.priceId ?? null,
      status: this.mapStatusForSubscription(providerSubscription),
      current_period_start: providerSubscription.currentPeriodStart ?? null,
      current_period_end: providerSubscription.currentPeriodEnd ?? null,
      cancel_at: providerSubscription.cancelAt ?? null,
      canceled_at: providerSubscription.canceledAt ?? null,
      trial_start: providerSubscription.trialStartDate ?? null,
      trial_end: providerSubscription.trialEndDate ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  },

  // ---- Internal helpers ----

  extractProviderCustomerId(
    data: Record<string, unknown>,
  ): string | null {
    // Paddle returns the customer id in different shapes depending on the
    // event. Try a few documented shapes.
    const customer =
      (data.customer as Record<string, unknown>) ??
      (data.customerId as string) ??
      (data.customer_id as string) ??
      null;
    if (customer && typeof customer === "object") {
      return (customer.id as string) ?? null;
    }
    if (typeof customer === "string") return customer;
    return null;
  },

  extractProviderSubscriptionId(
    data: Record<string, unknown>,
  ): string | null {
    const subscription =
      (data.subscription as Record<string, unknown>) ??
      (data.subscriptionId as string) ??
      (data.subscription_id as string) ??
      null;
    if (subscription && typeof subscription === "object") {
      return (subscription.id as string) ?? null;
    }
    if (typeof subscription === "string") return subscription;
    return null;
  },

  mapStatus(data: Record<string, unknown>): SubscriptionStatus {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    const status =
      (data.status as string) ??
      (subs?.status as string) ??
      (data.subscriptionStatus as string) ??
      "unknown";

    return (SUBSCRIPTION_STATUSES as Record<string, SubscriptionStatus>)[
      status
    ] ?? "unknown";
  },

  mapStatusForSubscription(
    subscription: ProviderSubscription,
  ): SubscriptionStatus {
    return (SUBSCRIPTION_STATUSES as Record<string, SubscriptionStatus>)[
      subscription.status
    ] ?? "unknown";
  },

  extractInternalPlan(
    data: Record<string, unknown>,
  ): InternalPlan | null {
    // If the checkout custom data survived into the webhook payload, we can
    // map the plan directly. Otherwise fall back to the price-id mapping.
    const customData =
      (data.customData as Record<string, unknown>) ??
      (data.custom_data as Record<string, unknown>) ??
      (data.metadata as Record<string, unknown>) ??
      null;

    if (customData) {
      const plan = (customData["atlas.internal_plan"] as string) ?? null;
      if (plan && Object.values(INTERNAL_PLANS).includes(plan as InternalPlan)) {
        return plan as InternalPlan;
      }
    }

    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    const priceId =
      (data.priceId as string) ??
      (data.price_id as string) ??
      (subs?.priceId as string) ??
      null;

    if (priceId) {
      return internalPlanForPaddlePriceId(priceId);
    }

    return null;
  },

  extractCurrentPeriodStart(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.currentPeriodStart as number) ??
        (subs.current_period_start as number);
      if (typeof v === "number") return v;
    }
    const v = (data.currentPeriodStart as number) ??
      (data.current_period_start as number);
    return typeof v === "number" ? v : null;
  },

  extractCurrentPeriodEnd(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.currentPeriodEnd as number) ??
        (subs.current_period_end as number);
      if (typeof v === "number") return v;
    }
    const v = (data.currentPeriodEnd as number) ??
      (data.current_period_end as number);
    return typeof v === "number" ? v : null;
  },

  extractCancelAt(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.cancelAt as number) ?? (subs.cancel_at as number);
      if (typeof v === "number") return v;
    }
    const v = (data.cancelAt as number) ?? (data.cancel_at as number);
    return typeof v === "number" ? v : null;
  },

  extractCanceledAt(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.canceledAt as number) ?? (subs.canceled_at as number);
      if (typeof v === "number") return v;
    }
    const v = (data.canceledAt as number) ?? (data.canceled_at as number);
    return typeof v === "number" ? v : null;
  },

  extractTrialStart(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.trialStartDate as number) ?? (subs.trial_start as number);
      if (typeof v === "number") return v;
    }
    const v = (data.trialStartDate as number) ?? (data.trial_start as number);
    return typeof v === "number" ? v : null;
  },

  extractTrialEnd(
    data: Record<string, unknown>,
  ): number | null {
    const subs =
      data.subscription && typeof data.subscription === "object"
        ? (data.subscription as Record<string, unknown>)
        : undefined;
    if (subs) {
      const v = (subs.trialEndDate as number) ?? (subs.trial_end as number);
      if (typeof v === "number") return v;
    }
    const v = (data.trialEndDate as number) ?? (data.trial_end as number);
    return typeof v === "number" ? v : null;
  },

  mapProviderSubscription(
    json: Record<string, unknown>,
  ): ProviderSubscription {
    return {
      id: (json.id as string) ?? "",
      customerId: (json.customerId as string) ??
        (json.customer_id as string) ??
        "",
      status: (json.status as string) ?? "unknown",
      planId: (json.planId as string) ?? null,
      priceId: (json.priceId as string) ?? null,
      billingCycle:
        (json.billingCycle as string) ??
        (json.billing_cycle as string) ??
        "monthly",
      trialStartDate: (json.trialStartDate as number) ??
        (json.trial_start as number) ??
        null,
      trialEndDate: (json.trialEndDate as number) ??
        (json.trial_end as number) ??
        null,
      currentPeriodStart: (json.currentPeriodStart as number) ??
        (json.current_period_start as number) ??
        null,
      currentPeriodEnd: (json.currentPeriodEnd as number) ??
        (json.current_period_end as number) ??
        null,
      cancelAt: (json.cancelAt as number) ??
        (json.cancel_at as number) ??
        null,
      canceledAt: (json.canceledAt as number) ??
        (json.canceled_at as number) ??
        null,
      amount: (json.amount as number) ?? null,
      currency:
        (json.currency as string) ??
        null,
    };
  },

  mapInternalPlanForSubscription(
    subscription: ProviderSubscription,
  ): InternalPlan | null {
    if (subscription.priceId) {
      return internalPlanForPaddlePriceId(subscription.priceId);
    }
    if (subscription.planId) {
      // If Paddle plan ids align with our internal plan naming, map here.
      const plan = internalPlanForPaddlePriceId(subscription.planId);
      if (plan) return plan;
    }
    return null;
  },
};
