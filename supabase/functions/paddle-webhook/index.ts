// ---------------------------------------------------------------------------
// Atlas — paddle-webhook Edge Function
//
// Receives Paddle Billing webhooks, verifies the signature, and synchronizes
// the subscription state into Atlas (organization_subscriptions + the
// tenant.billing_state the access gate reads).
//
// Security:
//   - Deploy with --no-verify-jwt (Paddle does not send a Supabase JWT).
//   - Signature verification is mandatory: HMAC-SHA256 over
//     `ts:<rawBody>` with PADDLE_WEBHOOK_SECRET; stale/invalid events are
//     rejected before any processing.
//   - Idempotent: the same event_id is never applied twice (unique index on
//     processed_webhook_events(provider, provider_event_id)).
//   - Writes use the service role; clients cannot reach these tables.
//
// Paddle is the billing source of truth: every subscription.* event carries
// the full subscription state, so applying it twice is safe (full-state
// upsert, never an increment).
// ---------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  enforcePaddleWebhookIpAllowlist,
  errorResponse,
  jsonResponse,
  parsePaddleEvent,
  verifyPaddleWebhookSignature,
  type ParsedPaddleEvent,
} from "../_shared/paddle.ts";

const SUBSCRIPTION_EVENT_TYPES = new Set([
  "subscription.created",
  "subscription.trialing",
  "subscription.activated",
  "subscription.updated",
  "subscription.resumed",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
]);

const TRANSACTION_EVENT_TYPES = new Set([
  "transaction.completed",
  "transaction.payment_failed",
]);

/** Map a Paddle subscription status to the Atlas access-gate billing_state. */
function billingStateForStatus(status: string | null): string | null {
  switch (status) {
    case "trialing":
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "paused":
      return "suspended";
    case "canceled":
      return "cancelled";
    default:
      return null; // unknown — leave access unchanged
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  // ---- 0. Optional sender IP allowlist (opt-in via env) ----
  // Paddle publishes its webhook-sending IPs at https://api.paddle.com/ips;
  // when enabled, anything not on that list is rejected before we spend any
  // work on signature verification. Signature verification remains mandatory.
  const ipCheck = await enforcePaddleWebhookIpAllowlist(req);
  if (!ipCheck.allowed) {
    console.error("[paddle-webhook] sender IP rejected", { reason: ipCheck.reason });
    return errorResponse("Webhook sender not allowed.", 403);
  }

  // Read the RAW body — parsing it first would break signature verification.
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("paddle-signature");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error("[paddle-webhook] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return errorResponse("Server configuration error.", 503);
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // ---- 1. Signature verification ----
  let payload: Record<string, unknown>;
  try {
    payload = await verifyPaddleWebhookSignature(rawBody, signatureHeader);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[paddle-webhook] signature verification failed", {
      detail: msg.slice(0, 200),
    });
    return errorResponse("Webhook signature verification failed.", 401);
  }

  // ---- 2. Event parsing ----
  let event: ParsedPaddleEvent;
  try {
    event = parsePaddleEvent(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[paddle-webhook] event parse failed", { detail: msg.slice(0, 200) });
    return errorResponse("Malformed webhook payload.", 400);
  }

  // ---- 3. Idempotency ----
  const { data: existing } = await supabase
    .from("processed_webhook_events")
    .select("id, result")
    .eq("provider", "paddle")
    .eq("provider_event_id", event.eventId)
    .maybeSingle();

  if (existing) {
    console.info("[paddle-webhook] duplicate event", {
      event_id: event.eventId,
      event_type: event.eventType,
      result: "duplicate",
    });
    return jsonResponse({ ok: true, duplicate: true });
  }

  const isSubscriptionEvent = SUBSCRIPTION_EVENT_TYPES.has(event.eventType);
  const isTransactionEvent = TRANSACTION_EVENT_TYPES.has(event.eventType);

  if (!isSubscriptionEvent && !isTransactionEvent) {
    await recordProcessed(supabase, event, event.organizationIdHint ?? null, "ignored");
    console.info("[paddle-webhook] ignored event type", { event_type: event.eventType });
    return jsonResponse({ ok: true, ignored: true });
  }

  // ---- 4. Organization resolution ----
  let organizationId: string | null = event.organizationIdHint;

  if (!organizationId && event.providerCustomerId) {
    const { data: byCustomer } = await supabase
      .from("organization_subscriptions")
      .select("organization_id")
      .eq("provider_customer_id", event.providerCustomerId)
      .limit(1)
      .maybeSingle();
    organizationId = byCustomer?.organization_id ?? null;
  }
  if (!organizationId && event.providerSubscriptionId) {
    const { data: bySubscription } = await supabase
      .from("organization_subscriptions")
      .select("organization_id")
      .eq("provider_subscription_id", event.providerSubscriptionId)
      .limit(1)
      .maybeSingle();
    organizationId = bySubscription?.organization_id ?? null;
  }

  if (!organizationId) {
    await recordProcessed(supabase, event, organizationId, "rejected");
    await appendAudit(supabase, event, organizationId, "rejected",
      "Could not resolve the owning organization; event rejected.");
    console.error("[paddle-webhook] unresolved organization", {
      event_id: event.eventId,
      event_type: event.eventType,
    });
    return jsonResponse({ ok: true, unresolved: true }, 200);
  }

  const logFields = {
    organization_id: organizationId,
    event_id: event.eventId,
    event_type: event.eventType,
    subscription_id: event.providerSubscriptionId ?? null,
    price_id: event.providerPriceId ?? null,
    internal_plan: event.internalPlan ?? null,
    billing_interval: event.billingInterval ?? null,
  };

  // ---- 5. Subscription state sync (subscription events only) ----
  if (isSubscriptionEvent) {
    const status = event.status ?? "unknown";
    const now = Date.now();

    const { data: existingSub } = await supabase
      .from("organization_subscriptions")
      .select("*")
      .eq("organization_id", organizationId)
      .maybeSingle();

    // ---- Event ordering guard ----
    // Paddle can deliver events out of order. Never let an older event
    // overwrite newer subscription state: when the stored row was synced from
    // a NEWER provider event, this event is recorded as processed (so a
    // retry is not reprocessed) but its state is discarded.
    if (
      existingSub?.provider_event_at != null &&
      event.providerEventAt != null &&
      event.providerEventAt < existingSub.provider_event_at
    ) {
      await appendAudit(supabase, event, organizationId, "ignored",
        "Out-of-order event; newer subscription state already applied.");
      await recordProcessed(supabase, event, organizationId, "ignored");
      console.info("[paddle-webhook] out-of-order event ignored", {
        ...logFields,
        event_occurred_at: event.providerEventAt,
        stored_provider_event_at: existingSub.provider_event_at,
      });
      return jsonResponse({ ok: true, outOfOrder: true });
    }

    const row = {
      organization_id: organizationId,
      billing_provider: "paddle",
      provider_customer_id:
        event.providerCustomerId ?? existingSub?.provider_customer_id ?? null,
      provider_subscription_id:
        event.providerSubscriptionId ?? existingSub?.provider_subscription_id ?? null,
      provider_price_id: event.providerPriceId ?? existingSub?.provider_price_id ?? null,
      internal_plan: event.internalPlan ?? existingSub?.internal_plan ?? null,
      billing_interval:
        event.billingInterval ?? existingSub?.billing_interval ?? null,
      status,
      trial_start: event.trialStart ?? existingSub?.trial_start ?? null,
      trial_end: event.trialEnd ?? existingSub?.trial_end ?? null,
      current_period_start:
        event.currentPeriodStart ?? existingSub?.current_period_start ?? null,
      current_period_end:
        event.currentPeriodEnd ?? existingSub?.current_period_end ?? null,
      next_billed_at: event.nextBilledAt ?? existingSub?.next_billed_at ?? null,
      cancel_at: event.cancelAt ?? existingSub?.cancel_at ?? null,
      canceled_at: event.canceledAt ?? existingSub?.canceled_at ?? null,
      provider_event_at:
        event.providerEventAt ?? existingSub?.provider_event_at ?? null,
      updated_at: now,
    };

    const { error: upsertError } = await supabase
      .from("organization_subscriptions")
      .upsert(row, { onConflict: "organization_id" });

    if (upsertError) {
      console.error("[paddle-webhook] subscription upsert failed", {
        ...logFields,
        detail: upsertError.message.slice(0, 200),
      });
      return errorResponse("Subscription sync failed.", 500);
    }

    // ---- 6. Access-gate state (server-authoritative) ----
    const billingState = billingStateForStatus(status);
    if (billingState) {
      const { error: stateError } = await supabase.rpc("billing_apply_state", {
        p_tenantid: organizationId,
        p_billing_state: billingState,
      });
      if (stateError) {
        console.error("[paddle-webhook] billing state apply failed", {
          ...logFields,
          billing_state: billingState,
          detail: stateError.message.slice(0, 200),
        });
        return errorResponse("Billing state sync failed.", 500);
      }
    }

    await appendAudit(supabase, event, organizationId, "processed",
      `Subscription state synchronized: ${status} | plan=${event.internalPlan ?? "none"} | interval=${event.billingInterval ?? "none"}`);
    await recordProcessed(supabase, event, organizationId, "processed");

    console.info("[paddle-webhook] subscription synchronized", logFields);
    return jsonResponse({ ok: true, organizationId });
  }

  // ---- Transaction events: informational (audit only) ----
  await appendAudit(supabase, event, organizationId, "informational",
    "Transaction event received; subscription state follows via subscription.* events.");
  await recordProcessed(supabase, event, organizationId, "ignored");

  console.info("[paddle-webhook] transaction event audited", logFields);
  return jsonResponse({ ok: true, informational: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recordProcessed(
  supabase: ReturnType<typeof createClient>,
  event: ParsedPaddleEvent,
  organizationId: string | null,
  result: string,
): Promise<void> {
  await supabase
    .from("processed_webhook_events")
    .insert({
      provider: "paddle",
      provider_event_id: event.eventId,
      event_type: event.eventType,
      organization_id: organizationId,
      provider_customer_id: event.providerCustomerId ?? null,
      provider_subscription_id: event.providerSubscriptionId ?? null,
      result,
      provider_event_at: event.providerEventAt,
    })
    .onConflict("provider, provider_event_id")
    .ignore();
}

async function appendAudit(
  supabase: ReturnType<typeof createClient>,
  event: ParsedPaddleEvent,
  organizationId: string | null,
  result: string,
  note: string,
): Promise<void> {
  await supabase.from("billing_audit_events").insert({
    organization_id: organizationId,
    provider: "paddle",
    provider_event_id: event.eventId,
    event_type: event.eventType,
    provider_customer_id: event.providerCustomerId ?? null,
    provider_subscription_id: event.providerSubscriptionId ?? null,
    result,
    note,
    provider_event_at: event.providerEventAt,
  });
}