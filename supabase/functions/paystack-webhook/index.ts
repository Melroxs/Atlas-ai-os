// ---------------------------------------------------------------------------
// Atlas — paystack-webhook Edge Function
//
// Deploy with verify_jwt = false (supabase/config.toml): Paystack does not
// send a Supabase JWT. Authentication is the Paystack signature itself —
// x-paystack-signature, an HMAC SHA512 of the RAW request body signed with
// PAYSTACK_SECRET_KEY — verified before anything is parsed.
//
// Processing contract (mirrors stripe-webhook):
//   * exact-replay dedupe via the durable ledger (psk_<sha256(rawBody)>) —
//     Paystack signatures carry NO timestamp, so replay defence is
//     signature + ledger + idempotent reconciliation + monotonic watermarks
//   * charge.success NEVER trusts the payload: the transaction is re-verified
//     with GET /transaction/verify/:reference and validated against the
//     billing_transactions row persisted before checkout (amount, currency,
//     reference, organization, plan). Mismatch ⇒ rejected, never activated
//   * the durable ledger row is written LAST; transient failures return 5xx
//     so Paystack retries and the retry re-applies the same full state
//   * unknown events are recorded and answered 2xx without touching state
//
// Paystack is the payment processor. Atlas is the authorization system. This
// function is the ONLY Paystack bridge that grants or revokes paid access.
// ---------------------------------------------------------------------------

import {
  fetchPaystackTransaction,
  isPaystackConfigured,
  verifyWebhookSignature,
} from "../_shared/paystack.ts";
import {
  type PaystackBillingStore,
  type PaystackBillingTransaction,
  type PaystackGateway,
  type PaystackSubscriptionRow,
  processPaystackEvent,
} from "../_shared/paystack-webhook.ts";
import { atlasServiceClient } from "../_shared/service-client.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Identifier-only structured log line (never bodies, never secrets). */
function log(event: string, fields: Record<string, unknown>): void {
  console.info(`[paystack-webhook] ${event}`, fields);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (!isPaystackConfigured()) {
    console.error("[paystack-webhook] PAYSTACK_SECRET_KEY is not configured");
    return json({ error: "Server configuration error." }, 503);
  }

  const client = atlasServiceClient();
  if (!client) {
    console.error("[paystack-webhook] SUPABASE_URL / service role key missing");
    return json({ error: "Server configuration error." }, 503);
  }

  // ---- 1. RAW body + signature verification ------------------------------
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  let payload: Record<string, unknown>;
  try {
    payload = await verifyWebhookSignature(rawBody, signature);
  } catch (e) {
    // The reason is logged without any part of the body or the secret.
    console.error("[paystack-webhook] signature verification failed", {
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      has_signature: Boolean(signature),
    });
    return json({ error: "Signature verification failed." }, 401);
  }

  const store = createPaystackBillingStore(client);
  const gateway: PaystackGateway = {
    verifyTransaction: (reference) => fetchPaystackTransaction(reference),
  };

  // ---- 2. Durable processing (single reconciliation path) ----------------
  try {
    const result = await processPaystackEvent(store, gateway, rawBody, payload);
    log("processed", {
      paystack_event_id: result.eventId,
      event_type: result.eventType,
      result: result.result,
      changed: result.changed,
      organization_id: result.organizationId,
      note: result.note.slice(0, 200),
    });
    return json({ received: true, result: result.result, changed: result.changed });
  } catch (e) {
    // Transient failure (Paystack API / database) or a payload whose shape
    // does not match our assumptions — answer 5xx so Paystack retries and the
    // failure stays visible. Nothing is recorded as processed.
    console.error("[paystack-webhook] processing failed", {
      event_type: typeof payload.event === "string" ? payload.event : null,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return json({ error: "Processing failed." }, 500);
  }
});

// ---------------------------------------------------------------------------
// Supabase-backed Paystack BillingStore
// ---------------------------------------------------------------------------

const PAYSTACK_SUBSCRIPTION_COLUMNS =
  "organization_id, provider_customer_id, provider_subscription_id, provider_price_id, " +
  "internal_plan, billing_interval, status, payment_status, trial_start, trial_end, " +
  "current_period_start, current_period_end, next_billed_at, cancel_at, " +
  "cancel_at_period_end, canceled_at, latest_invoice_id, latest_invoice_at, " +
  "provider_event_at, created_at, updated_at";

/** Database row ➜ processor row. */
function rowFromDb(row: Record<string, unknown>): PaystackSubscriptionRow {
  const now = Date.now();
  return {
    organizationId: String(row.organization_id),
    billingProvider: "paystack",
    providerCustomerId: (row.provider_customer_id as string | null) ?? null,
    providerSubscriptionId: (row.provider_subscription_id as string | null) ?? null,
    providerPriceId: (row.provider_price_id as string | null) ?? null,
    internalPlan: (row.internal_plan as PaystackSubscriptionRow["internalPlan"]) ?? null,
    billingInterval: (row.billing_interval as PaystackSubscriptionRow["billingInterval"]) ?? null,
    status: (row.status as PaystackSubscriptionRow["status"]) ?? "unknown",
    paymentStatus: (row.payment_status as PaystackSubscriptionRow["paymentStatus"]) ?? "unknown",
    trialStart: (row.trial_start as number | null) ?? null,
    trialEnd: (row.trial_end as number | null) ?? null,
    currentPeriodStart: (row.current_period_start as number | null) ?? null,
    currentPeriodEnd: (row.current_period_end as number | null) ?? null,
    nextBilledAt: (row.next_billed_at as number | null) ?? null,
    cancelAt: (row.cancel_at as number | null) ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    canceledAt: (row.canceled_at as number | null) ?? null,
    latestInvoiceId: (row.latest_invoice_id as string | null) ?? null,
    latestInvoiceAt: (row.latest_invoice_at as number | null) ?? null,
    providerEventAt: (row.provider_event_at as number | null) ?? null,
    createdAt: (row.created_at as number | null) ?? now,
    updatedAt: (row.updated_at as number | null) ?? now,
  };
}

/** Processor row ➜ database row for billing_upsert_subscription. */
function rowToDb(row: PaystackSubscriptionRow): Record<string, unknown> {
  return {
    organization_id: row.organizationId,
    billing_provider: "paystack",
    provider_customer_id: row.providerCustomerId,
    provider_subscription_id: row.providerSubscriptionId,
    provider_price_id: row.providerPriceId,
    internal_plan: row.internalPlan,
    billing_interval: row.billingInterval,
    status: row.status,
    payment_status: row.paymentStatus,
    trial_start: row.trialStart,
    trial_end: row.trialEnd,
    current_period_start: row.currentPeriodStart,
    current_period_end: row.currentPeriodEnd,
    next_billed_at: row.nextBilledAt,
    cancel_at: row.cancelAt,
    cancel_at_period_end: row.cancelAtPeriodEnd,
    canceled_at: row.canceledAt,
    latest_invoice_id: row.latestInvoiceId,
    latest_invoice_at: row.latestInvoiceAt,
    provider_event_at: row.providerEventAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function createPaystackBillingStore(
  client: NonNullable<ReturnType<typeof atlasServiceClient>>,
): PaystackBillingStore {
  return {
    async findProcessedEvent(eventId) {
      const { data, error } = await client
        .from("processed_webhook_events")
        .select("result, organization_id")
        .eq("provider", "paystack")
        .eq("provider_event_id", eventId)
        .maybeSingle();
      if (error) throw new Error(`idempotency lookup failed: ${error.message}`);
      if (!data) return null;
      return {
        result: String(data.result ?? "processed"),
        organizationId: (data.organization_id as string | null) ?? null,
      };
    },

    async recordEvent(entry) {
      const { error } = await client
        .from("processed_webhook_events")
        .insert({
          provider: "paystack",
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
      // 23505 = another worker recorded the same event concurrently. The
      // state it applied is the same full state, so this is a safe no-op.
      if (error && error.code !== "23505") {
        throw new Error(`idempotency record failed: ${error.message}`);
      }
    },

    async loadSubscription(organizationId) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select(PAYSTACK_SUBSCRIPTION_COLUMNS)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw new Error(`subscription load failed: ${error.message}`);
      return data ? rowFromDb(data as Record<string, unknown>) : null;
    },

    // Server-side function, not a client upsert: the merge of the incoming
    // snapshot over the stored row happens under a row lock with per-family
    // watermarks (migration 20260921) — a stale concurrent delivery cannot
    // roll newer billing fields backwards.
    async saveSubscription(row) {
      const { data, error } = await client.rpc("billing_upsert_subscription", {
        p_organization_id: row.organizationId,
        p_row: rowToDb(row),
      });
      if (error) throw new Error(`subscription save failed: ${error.message}`);
      const applied = data as { subscription_applied?: boolean } | null;
      if (applied && applied.subscription_applied === false) {
        console.warn("[paystack-webhook] stale subscription snapshot merged, not applied", {
          organization_id: row.organizationId,
        });
      }
    },

    async setBillingState(organizationId, billingState) {
      const { error } = await client.rpc("billing_apply_state", {
        p_tenantid: organizationId,
        p_billing_state: billingState,
      });
      if (error) throw new Error(`billing state write failed: ${error.message}`);
    },

    async findTransactionByReference(reference) {
      const { data, error } = await client
        .from("billing_transactions")
        .select(
          "id, organization_id, provider_reference, provider_transaction_id, internal_plan, " +
            "billing_interval, amount, currency, status, verified, verified_at",
        )
        .eq("provider", "paystack")
        .eq("provider_reference", reference)
        .maybeSingle();
      if (error) throw new Error(`transaction lookup failed: ${error.message}`);
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        organizationId: String(row.organization_id),
        providerReference: String(row.provider_reference),
        providerTransactionId:
          typeof row.provider_transaction_id === "number" ? row.provider_transaction_id : null,
        internalPlan: (row.internal_plan as PaystackBillingTransaction["internalPlan"]) ?? null,
        billingInterval:
          (row.billing_interval as PaystackBillingTransaction["billingInterval"]) ?? null,
        amount: Number(row.amount),
        currency: String(row.currency ?? ""),
        status: String(row.status ?? "pending"),
        verified: row.verified === true,
        verifiedAt: (row.verified_at as number | null) ?? null,
      };
    },

    async markTransactionVerified(transactionId, providerTransactionId) {
      const { error } = await client
        .from("billing_transactions")
        .update({
          verified: true,
          verified_at: Date.now(),
          provider_transaction_id: providerTransactionId,
          status: "success",
          updated_at: Date.now(),
        })
        .eq("id", transactionId);
      if (error) throw new Error(`transaction verify write failed: ${error.message}`);
    },

    async saveSubscriptionToken(organizationId, emailToken) {
      const { error } = await client
        .from("organization_subscriptions")
        .update({
          provider_subscription_token: emailToken,
          updated_at: Date.now(),
        })
        .eq("organization_id", organizationId);
      if (error) throw new Error(`subscription token write failed: ${error.message}`);
    },

    async resolveOrganizationIdByCustomer(customerCode) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select("organization_id")
        .eq("provider_customer_id", customerCode)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`customer lookup failed: ${error.message}`);
      return (data?.organization_id as string | null) ?? null;
    },

    async resolveOrganizationIdBySubscription(subscriptionCode) {
      const { data, error } = await client
        .from("organization_subscriptions")
        .select("organization_id")
        .eq("provider_subscription_id", subscriptionCode)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`subscription lookup failed: ${error.message}`);
      return (data?.organization_id as string | null) ?? null;
    },

    // Free Pilot detection: an ordinary tenant row, no billing tables involved.
    async isPilotOrganization(organizationId) {
      const { data, error } = await client
        .from("tenants")
        .select("account_type")
        .eq("_id", organizationId)
        .maybeSingle();
      if (error) throw new Error(`pilot lookup failed: ${error.message}`);
      return data?.account_type === "free_pilot";
    },

    // Reuses the single conversion RPC (super_admin OR trusted-server
    // authorized; the service role is trusted) and is idempotent — a race
    // where the organization converted between the check and this call is a
    // no-op: the RPC raises "not a Free Pilot organization" only, which is
    // treated as success so a duplicate delivery cannot fail the webhook.
    async convertPilotOrganization(organizationId, reason) {
      const { error } = await client.rpc("admin_convert_pilot_to_paid", {
        p_tenant_id: organizationId,
        p_reason: reason,
      });
      if (!error) return;
      if (/not a Free Pilot organization/i.test(error.message)) return;
      throw new Error(`pilot conversion failed: ${error.message}`);
    },
  };
}
