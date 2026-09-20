// ---------------------------------------------------------------------------
// Atlas — stripe-checkout Edge Function
//
// The ONLY way a browser can start an Atlas subscription. Deploy with
// verify_jwt = true (supabase/config.toml).
//
// What the browser may send:
//   { plan: "starter" | "growth" | "scale", interval: "month" | "year",
//     tenantId?: string, companyName?: string }
//
// What it may NEVER send (and is therefore never accepted):
//   price ids, amounts, currencies, Stripe customer ids, subscription ids,
//   statuses, or any claim about payment.
//
// Server-side responsibilities:
//   1. authenticate the Supabase user
//   2. resolve the caller's own organization (a client tenantId only has to
//      MATCH it — membership is never taken from the request)
//   3. authorize: only workspace owner/admin (or platform admin) may manage
//      billing
//   4. validate plan + interval against the canonical Atlas catalog
//   5. resolve the Stripe Price id server-side
//   6. reuse (or create exactly once) the organization's Stripe customer
//   7. refuse to open a second subscription when one already exists — send the
//      customer to the Stripe Billing Portal instead
//   8. create a Stripe Checkout Session (mode=subscription, no trial,
//      metadata attached)
//   9. return only the hosted checkout URL + non-sensitive context
// ---------------------------------------------------------------------------

import {
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import { canManageAtlasBilling, atlasServiceClient } from "../_shared/service-client.ts";
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
} from "../_shared/stripe.ts";
import { ensureStripeCustomer, loadOrgSubscription } from "../_shared/stripe-org.ts";
import { hasManageableSubscription } from "../_shared/stripe-webhook.ts";

Deno.serve(async (req) => {
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
});
