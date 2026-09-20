// ---------------------------------------------------------------------------
// Atlas — stripe-webhook Edge Function
//
// Deploy with verify_jwt = false (supabase/config.toml): Stripe does not send a
// Supabase JWT. Authentication is the Stripe signature itself, verified over
// the RAW request body with STRIPE_WEBHOOK_SECRET before anything is parsed.
//
// Processing contract (see ../_shared/stripe-webhook.ts):
//   * every event id is processed at most once (durable ledger row written last)
//   * a retried delivery after a partial failure re-applies the same full state
//   * unknown events / unknown prices never change entitlement
//   * 2xx is returned only after processing is durable; transient failures
//     return 5xx so Stripe retries
//
// Stripe is the payment processor. Atlas is the authorization system. This
// function is the ONLY bridge that grants or revokes paid access.
// ---------------------------------------------------------------------------

import {
  fetchStripeSubscription,
  stripeWebhookSecret,
  verifyStripeWebhookSignature,
} from "../_shared/stripe.ts";
import {
  type AuditEntry,
  type BillingStore,
  type StripeGateway,
  processStripeWebhook,
} from "../_shared/stripe-webhook.ts";
import {
  SUBSCRIPTION_COLUMNS,
  rowFromDb,
  rowToDb,
} from "../_shared/stripe-rows.ts";
import { atlasServiceClient } from "../_shared/service-client.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Identifier-only structured log line (never bodies, never secrets). */
function log(event: string, fields: Record<string, unknown>): void {
  console.info(`[stripe-webhook] ${event}`, fields);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (!stripeWebhookSecret()) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return json({ error: "Server configuration error." }, 503);
  }

  const client = atlasServiceClient();
  if (!client) {
    console.error("[stripe-webhook] SUPABASE_URL / service role key missing");
    return json({ error: "Server configuration error." }, 503);
  }

  // ---- 1. RAW body + signature verification ------------------------------
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  let payload: Record<string, unknown>;
  try {
    payload = await verifyStripeWebhookSignature(rawBody, signature);
  } catch (e) {
    // The reason is logged without any part of the body or the secret.
    console.error("[stripe-webhook] signature verification failed", {
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      has_signature: Boolean(signature),
    });
    return json({ error: "Signature verification failed." }, 401);
  }

  // ---- 2. Durable processing (single reconciliation path) ----------------
  const store = createSupabaseBillingStore(client);
  const gateway: StripeGateway = {
    fetchSubscription: (id) => fetchStripeSubscription(id),
  };

  try {
    const result = await processStripeWebhook(store, gateway, payload);
    log("processed", {
      stripe_event_id: result.eventId,
      event_type: result.eventType,
      result: result.result,
      changed: result.changed,
      organization_id: result.organizationId,
      stripe_customer_id: result.providerCustomerId,
      stripe_subscription_id: result.providerSubscriptionId,
    });
    return json({ received: true, result: result.result });
  } catch (e) {
    // Transient failure (Stripe API / database): answer 5xx so Stripe retries.
    // Nothing is recorded as processed, so the retry re-applies full state.
    console.error("[stripe-webhook] processing failed", {
      stripe_event_id: typeof payload.id === "string" ? payload.id : null,
      event_type: typeof payload.type === "string" ? payload.type : null,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return json({ error: "Processing failed." }, 500);
  }
});

// ---------------------------------------------------------------------------
// Supabase-backed BillingStore
// ---------------------------------------------------------------------------

function createSupabaseBillingStore(
  client: NonNullable<ReturnType<typeof atlasServiceClient>>,
): BillingStore {
  return {
    async findProcessedEvent(eventId) {
      const { data, error } = await client
        .from("processed_webhook_events")
        .select("result, organization_id")
        .eq("provider", "stripe")
        .eq("provider_event_id", eventId)
        .maybeSingle();
      if (error) throw new Error(`idempotency lookup failed: ${error.message}`);
      if (!data) return null;
      return {
        result: String(data.result ?? "processed"),
        organizationId: (data.organization_id as string | null) ?? null,
      };
    },

    async recordEvent(entry: AuditEntry) {
      const { error } = await client
        .from("processed_webhook_events")
        .insert({
          provider: "stripe",
          provider_event_id: entry.providerEventId,
          event_type: entry.eventType,
          organization_id: entry.organizationId,
          provider_customer_id: entry.providerCustomerId,
          provider_subscription_id: entry.providerSubscriptionId,
          result: entry.result,
          provider_event_at: entry.providerEventAt,
        })
        .select("id")
        .maybeSingle();
      // 23505 = another worker recorded the same event concurrently. The state
      // it applied is the same full state, so this is a safe no-op.
      if (error && error.code !== "23505") {
        throw new Error(`idempotency record failed: ${error.message}`);
      }
    },

    async loadSubscription(organizationId) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw new Error(`subscription load failed: ${error.message}`);
      return data ? rowFromDb(data as Record<string, unknown>) : null;
    },

    async saveSubscription(row) {
      const { error } = await client
        .from("organization_subscriptions")
        .upsert(rowToDb(row), { onConflict: "organization_id" });
      if (error) throw new Error(`subscription save failed: ${error.message}`);
    },

    async setBillingState(organizationId, billingState) {
      const { error } = await client.rpc("billing_apply_state", {
        p_tenantid: organizationId,
        p_billing_state: billingState,
      });
      if (error) throw new Error(`billing state write failed: ${error.message}`);
    },

    async appendAudit(entry) {
      const { error } = await client.from("billing_audit_events").insert({
        organization_id: entry.organizationId,
        provider: "stripe",
        provider_event_id: entry.providerEventId,
        event_type: entry.eventType,
        provider_customer_id: entry.providerCustomerId,
        provider_subscription_id: entry.providerSubscriptionId,
        result: entry.result,
        note: entry.note,
        provider_event_at: entry.providerEventAt,
      });
      // Audit is best-effort: never fail a correctly processed payment because
      // the audit insert hiccuped. The failure is logged for an operator.
      if (error) {
        console.error("[stripe-webhook] audit insert failed", {
          provider_event_id: entry.providerEventId,
          detail: error.message.slice(0, 200),
        });
      }
    },

    async resolveOrganizationIdByCustomer(customerId) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select("organization_id")
        .eq("provider_customer_id", customerId)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`customer lookup failed: ${error.message}`);
      return (data?.organization_id as string | null) ?? null;
    },

    async resolveOrganizationIdBySubscription(subscriptionId) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select("organization_id")
        .eq("provider_subscription_id", subscriptionId)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`subscription lookup failed: ${error.message}`);
      return (data?.organization_id as string | null) ?? null;
    },
  };
}
