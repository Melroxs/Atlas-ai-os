// ---------------------------------------------------------------------------
// Atlas — paystack-checkout handler (server-side)
//
// The ONLY way a browser starts an Atlas subscription through Paystack.
// Invoked by billing-checkout when ATLAS_BILLING_PROVIDER = "paystack".
// Mirrors stripe-checkout/index.ts step for step:
//
//   1. authenticate the Supabase user
//   2. resolve the caller's own organization (a client tenantId only has to
//      MATCH it — membership is never taken from the request)
//   3. authorize: workspace owner/admin (or platform admin)
//   4. validate plan + interval against the canonical Atlas catalog
//   5. resolve the fixed ZAR price + Paystack plan code server-side
//   6. refuse a second subscription — send existing subscribers to their
//      billing records instead (Paystack self-service is Phase 2)
//   7. reuse (or create exactly once) the organization's Paystack customer
//   8. generate the deterministic Atlas reference and PERSIST the billing
//      attempt (billing_transactions) BEFORE calling Paystack
//   9. POST /transaction/initialize (plan + amount + currency + metadata)
//  10. return only { url, reference, plan, interval } — never a secret
//
// The browser never sends a price, an amount, a currency, a provider or a
// reference.
// ---------------------------------------------------------------------------

import {
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "./edge-auth.ts";
import { atlasServiceClient, canManageAtlasBilling } from "./service-client.ts";
import {
  type BillingInterval,
  type InternalPlan,
  PaystackApiError,
  billingIntervalForInput,
  initializePaystackTransaction,
  internalPlanForSlug,
  isPaystackConfigured,
  paystackAppUrl,
  paystackCheckoutConfig,
  paystackCheckoutReference,
  paystackEnvironment,
} from "./paystack.ts";
import { ensurePaystackCustomer, loadPaystackOrgBilling } from "./paystack-org.ts";
import { hasLivePaystackSubscription } from "./paystack-webhook.ts";

// The duplicate-subscription guard now lives in _shared/paystack-webhook.ts
// (next to Stripe's hasManageableSubscription counterpart) so it is unit
// tested; it is re-exported here for the dispatcher's type surface.
export { hasLivePaystackSubscription };

/** Minimal structural view of the billing_transactions writes we need. */
interface BillingTransactionClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
      };
    };
    insert(values: Record<string, unknown>): PromiseLike<{ error: { message?: string; code?: string } | null }>;
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message?: string; code?: string } | null }>;
    };
  };
}

export async function handlePaystackCheckout(req: Request): Promise<Response> {
  const preflight = atlasEdgePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return atlasEdgeError("Method not allowed.", 405);
  }

  // ---- 1. Authenticate ----------------------------------------------------
  let caller: Awaited<ReturnType<typeof requireAtlasCaller>>;
  try {
    caller = await requireAtlasCaller(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return atlasEdgeError(
      status === 503 ? "Billing is temporarily unavailable." : "Your session expired. Please sign in again.",
      status,
    );
  }

  if (!caller.tenantId) {
    return atlasEdgeError(
      "You need an organization before subscribing. Please set one up first.",
      400,
    );
  }

  // ---- 2. Body (plan + interval only) ------------------------------------
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return atlasEdgeError("Invalid request body.", 400);
  }

  if (typeof body.tenantId === "string" && body.tenantId !== caller.tenantId) {
    // Authorization, not validation: never let a caller reach another org.
    return atlasEdgeError("You do not have access to this organization.", 403);
  }

  // ---- 3. Authorize ------------------------------------------------------
  const authorized = await canManageAtlasBilling({
    userId: caller.userId,
    role: caller.role,
  });
  if (!authorized) {
    return atlasEdgeError(
      "Only workspace owners and admins can manage billing for this organization.",
      403,
    );
  }

  // ---- 4. Validate plan + interval (server-side catalog only) ------------
  const plan = internalPlanForSlug(body.plan);
  if (!plan) {
    return atlasEdgeError("That plan is not available.", 422);
  }
  const interval = billingIntervalForInput(body.interval ?? body.billing);
  if (!interval) {
    return atlasEdgeError("That billing interval is not available.", 422);
  }

  // ---- 5. Provider + fixed price configuration ---------------------------
  if (!isPaystackConfigured()) {
    console.error("[paystack-checkout] PAYSTACK_SECRET_KEY is not configured");
    return atlasEdgeError(
      "Billing isn't configured for this environment yet. Please contact support.",
      503,
    );
  }

  const resolved = paystackCheckoutConfig(plan, interval);
  if (!resolved.ok) {
    console.error("[paystack-checkout] price not configured", {
      organization_id: caller.tenantId,
      internal_plan: plan,
      billing_interval: interval,
      missing: resolved.missing,
    });
    return atlasEdgeError("The selected Atlas plan is not configured for billing.", 422);
  }
  const config = resolved.config;

  if (!caller.email) {
    return atlasEdgeError("An email address is required to start checkout.", 400);
  }

  const client = atlasServiceClient();
  if (!client) {
    console.error("[paystack-checkout] SUPABASE_URL / service role key missing");
    return atlasEdgeError("Billing is temporarily unavailable.", 503);
  }

  try {
    // ---- 6. Duplicate-subscription guard --------------------------------
    const existing = await loadPaystackOrgBilling(client, caller.tenantId);
    if (hasLivePaystackSubscription(existing)) {
      return atlasEdgeError(
        "This organization already has an active subscription. Contact support to change plans.",
        409,
      );
    }

    // ---- 7. Exactly one Paystack customer per organization ---------------
    const { customerCode } = await ensurePaystackCustomer(client, {
      organizationId: caller.tenantId,
      existingCustomerId: existing?.providerCustomerId ?? null,
      email: caller.email,
      name: typeof body.companyName === "string" ? body.companyName : null,
    });

    // ---- 8. Deterministic reference + durable billing attempt ------------
    const reference = await paystackCheckoutReference({
      organizationId: caller.tenantId,
      plan,
      interval,
    });

    const txnClient = client as unknown as BillingTransactionClient;
    const existingTxn = await txnClient
      .from("billing_transactions")
      .select(
        "id, status, amount, currency, internal_plan, billing_interval, verified",
      )
      .eq("provider_reference", reference)
      .maybeSingle();

    if (existingTxn.error) {
      throw new Error(`transaction load failed: ${existingTxn.error.message ?? "unknown"}`);
    }

    const prior = existingTxn.data as Record<string, unknown> | null;
    if (prior && (prior.status === "success" || prior.verified === true)) {
      // The same reference already completed — never re-initialize a paid
      // attempt (the webhook owns activation; this page cannot).
      return atlasEdgeError(
        "This checkout attempt was already completed. Your subscription will activate shortly.",
        409,
      );
    }

    if (prior) {
      const upd = await txnClient
        .from("billing_transactions")
        .update({
          internal_plan: plan,
          billing_interval: interval,
          amount: config.amountSubunits,
          currency: config.currency,
          organization_id: caller.tenantId,
          updated_at: Date.now(),
        })
        .eq("provider_reference", reference);
      if (upd.error) {
        throw new Error(`transaction update failed: ${upd.error.message ?? "unknown"}`);
      }
    } else {
      const ins = await txnClient.from("billing_transactions").insert({
        organization_id: caller.tenantId,
        provider: "paystack",
        provider_reference: reference,
        internal_plan: plan,
        billing_interval: interval,
        amount: config.amountSubunits,
        currency: config.currency,
        status: "pending",
        verified: false,
      });
      if (ins.error) {
        // 23505 = a concurrent attempt inserted the same reference first.
        if (ins.error.code !== "23505") {
          throw new Error(`transaction insert failed: ${ins.error.message ?? "unknown"}`);
        }
      }
    }

    // ---- 9. Initialize the Paystack transaction --------------------------
    const session = await initializePaystackTransaction({
      email: caller.email,
      amountSubunits: config.amountSubunits,
      currency: config.currency,
      reference,
      callbackUrl: `${paystackAppUrl()}/pricing-success`,
      planCode: config.planCode,
      metadata: {
        organization_id: caller.tenantId,
        internal_plan: plan,
        billing_interval: interval,
        atlas_environment: paystackEnvironment(),
        provider: "paystack",
      },
    });

    const upd = await txnClient
      .from("billing_transactions")
      .update({ status: "initialized", updated_at: Date.now() })
      .eq("provider_reference", reference);
    if (upd.error) {
      // Non-fatal: the attempt row exists as `pending`; the webhook still
      // resolves activation through the reference.
      console.error("[paystack-checkout] transaction status update failed", {
        organization_id: caller.tenantId,
        detail: (upd.error.message ?? "").slice(0, 200),
      });
    }

    console.info("[paystack-checkout] initialized", {
      organization_id: caller.tenantId,
      atlas_user_id: caller.userId,
      internal_plan: plan,
      billing_interval: interval,
      paystack_customer_code: customerCode,
      paystack_reference: reference,
      amount_subunits: config.amountSubunits,
      currency: config.currency,
      environment: paystackEnvironment(),
      result: "ok",
    });

    // ---- 10. Return only what the browser needs --------------------------
    return atlasEdgeJson({
      url: session.authorizationUrl,
      reference,
      plan,
      interval,
      provider: "paystack",
    });
  } catch (e) {
    if (e instanceof PaystackApiError && e.status === 409) {
      return atlasEdgeError("You already completed this checkout attempt.", 409);
    }
    console.error("[paystack-checkout] failed", {
      organization_id: caller.tenantId,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return atlasEdgeError("We're unable to start checkout right now. Please try again.", 502);
  }
}

// Re-exported for the dispatcher's type surface (kept browser-neutral).
export type { BillingInterval, InternalPlan };
