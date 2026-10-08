// ---------------------------------------------------------------------------
// Atlas — stripe-checkout handler (extracted verbatim from
// supabase/functions/stripe-checkout/index.ts so the provider-neutral
// billing-checkout entry can dispatch to the SAME code path).
//
// BEHAVIOUR IS UNCHANGED: this is a pure file move of the original handler
// (authn → authz → catalog → duplicate guard → customer → session), plus the
// relative-import paths that moving into _shared requires. The original
// stripe-checkout function still serves this handler directly, so the
// deployed Stripe entry point keeps working even if billing-checkout is
// unavailable.
//
// The ONLY why for this extraction: Master Prompt 2 §8 permits "an absolutely
// necessary provider-neutral extraction ... a tiny modification" — one
// dispatcher needs to reach this logic without duplicating it.
// ---------------------------------------------------------------------------

import {
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "./edge-auth.ts";
import { canManageAtlasBilling, atlasServiceClient } from "./service-client.ts";
import {
  billingIntervalForInput,
  checkoutIdempotencyKey,
  createStripeCheckoutSession,
  internalPlanForSlug,
  isStripeConfigured,
  stripeEnvironment,
  stripePriceId,
  stripePriceEnvKey,
  atlasAppUrl,
} from "./stripe.ts";
import { ensureStripeCustomer, loadOrgSubscription } from "./stripe-org.ts";
import { hasManageableSubscription } from "./stripe-webhook.ts";

export async function handleStripeCheckout(req: Request): Promise<Response> {
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

  // ---- 5. Provider + price configuration ---------------------------------
  if (!isStripeConfigured()) {
    console.error("[stripe-checkout] STRIPE_SECRET_KEY is not configured");
    return atlasEdgeError(
      "Billing isn't configured for this environment yet. Please contact support.",
      503,
    );
  }

  const priceId = stripePriceId(plan, interval);
  if (!priceId) {
    console.error("[stripe-checkout] price not configured", {
      organization_id: caller.tenantId,
      internal_plan: plan,
      billing_interval: interval,
      env_key: stripePriceEnvKey(plan, interval),
    });
    return atlasEdgeError("The selected Atlas plan is not configured for billing.", 422);
  }

  const client = atlasServiceClient();
  if (!client) {
    console.error("[stripe-checkout] SUPABASE_URL / service role key missing");
    return atlasEdgeError("Billing is temporarily unavailable.", 503);
  }

  try {
    // ---- 6. Duplicate-subscription guard --------------------------------
    // A second Checkout Session for an organization that already has a live
    // subscription would create a SECOND subscription. Plan changes belong in
    // the Stripe Billing Portal.
    const existing = await loadOrgSubscription(client, caller.tenantId);
    if (hasManageableSubscription(existing)) {
      return atlasEdgeError(
        "This organization already has an active subscription. Use Manage Billing to change plans.",
        409,
      );
    }

    // ---- 7. Exactly one Stripe customer per organization ----------------
    const { customerId } = await ensureStripeCustomer(client, {
      organizationId: caller.tenantId,
      existingCustomerId: existing?.providerCustomerId ?? null,
      email: caller.email,
      name: typeof body.companyName === "string" ? body.companyName : null,
    });

    // ---- 8. Checkout Session (server-resolved price ids only) -----------
    // Exactly one recurring line item and NO trial: Atlas never creates a
    // trial, an introductory period or a one-time charge at checkout.
    const appUrl = atlasAppUrl();

    const session = await createStripeCheckoutSession({
      organizationId: caller.tenantId,
      plan,
      interval,
      priceId,
      customerId,
      successUrl:
        `${appUrl}/pricing-success?session_id={CHECKOUT_SESSION_ID}` +
        `&plan=${encodeURIComponent(plan)}&interval=${encodeURIComponent(interval)}`,
      cancelUrl: `${appUrl}/pricing?checkout=cancelled`,
      // A double-click inside the window resolves to the SAME session.
      idempotencyKey: checkoutIdempotencyKey(caller.tenantId, plan, interval),
    });

    if (!session.url) {
      console.error("[stripe-checkout] session created without a url", {
        organization_id: caller.tenantId,
        session_id: session.id,
      });
      return atlasEdgeError("We couldn't open the payment window. Please try again.", 502);
    }

    console.info("[stripe-checkout] session created", {
      organization_id: caller.tenantId,
      atlas_user_id: caller.userId,
      internal_plan: plan,
      billing_interval: interval,
      stripe_customer_id: customerId,
      stripe_session_id: session.id,
      environment: stripeEnvironment(),
      result: "ok",
    });

    // ---- 9. Return only what the browser needs -------------------------
    return atlasEdgeJson({
      url: session.url,
      sessionId: session.id,
      plan,
      interval,
      provider: "stripe",
    });
  } catch (e) {
    console.error("[stripe-checkout] failed", {
      organization_id: caller.tenantId,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return atlasEdgeError("We're unable to start checkout right now. Please try again.", 502);
  }
}
