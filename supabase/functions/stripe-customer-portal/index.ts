// ---------------------------------------------------------------------------
// Atlas — stripe-customer-portal Edge Function
//
// Deploy with verify_jwt = true. Opens the Stripe Billing Portal so a customer
// can update their payment method, view invoices, change plan, or cancel —
// Stripe performs those operations, Atlas only ever reads their result back
// through the verified webhook.
//
// Authorization chain (all enforced server-side):
//   1. authenticate the Supabase user
//   2. resolve the caller's OWN organization from their membership
//   3. authorize: workspace owner/admin (or platform admin)
//   4. resolve the Stripe customer id from ATLAS storage — a customer id from
//      the request body is never used
//   5. verify the customer still exists in this Stripe environment
//   6. create a short-lived portal session and return ONLY its URL
// ---------------------------------------------------------------------------

import {
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import { atlasServiceClient, canManageAtlasBilling } from "../_shared/service-client.ts";
import {
  atlasAppUrl,
  createStripeBillingPortalSession,
  fetchStripeCustomer,
  isStripeConfigured,
} from "../_shared/stripe.ts";
import { loadOrgSubscription } from "../_shared/stripe-org.ts";

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
      status === 503
        ? "Billing is temporarily unavailable."
        : "Your session expired. Please sign in again.",
      status,
    );
  }

  if (!caller.tenantId) {
    return atlasEdgeError("You need an organization to manage billing.", 400);
  }

  // ---- 2. Authorize -------------------------------------------------------
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

  if (!isStripeConfigured()) {
    console.error("[stripe-customer-portal] STRIPE_SECRET_KEY is not configured");
    return atlasEdgeError("Billing isn't configured for this environment yet.", 503);
  }

  const client = atlasServiceClient();
  if (!client) {
    console.error("[stripe-customer-portal] SUPABASE_URL / service role key missing");
    return atlasEdgeError("Billing is temporarily unavailable.", 503);
  }

  try {
    // ---- 3. Resolve the customer from Atlas storage only ------------------
    const subscription = await loadOrgSubscription(client, caller.tenantId);
    const customerId = subscription?.providerCustomerId ?? null;

    if (!customerId) {
      // Handled safely: no billing profile is a normal state for an
      // organization that has never completed a checkout.
      return atlasEdgeError(
        "This organization doesn't have a billing profile yet. Choose a plan to get started.",
        404,
      );
    }

    const customer = await fetchStripeCustomer(customerId);
    if (!customer || customer.deleted) {
      console.error("[stripe-customer-portal] stored customer is not usable", {
        organization_id: caller.tenantId,
        stripe_customer_id: customerId,
      });
      return atlasEdgeError(
        "We couldn't find your billing profile. Please contact support.",
        409,
      );
    }

    // ---- 4. Portal session ------------------------------------------------
    const session = await createStripeBillingPortalSession({
      customerId: customer.id,
      returnUrl: `${atlasAppUrl()}/dashboard/billing`,
    });

    if (!session?.url) {
      console.error("[stripe-customer-portal] portal session without url", {
        organization_id: caller.tenantId,
        stripe_customer_id: customer.id,
      });
      return atlasEdgeError("We couldn't open billing management. Please try again.", 502);
    }

    console.info("[stripe-customer-portal] portal session created", {
      organization_id: caller.tenantId,
      atlas_user_id: caller.userId,
      stripe_customer_id: customer.id,
      result: "ok",
    });

    return atlasEdgeJson({ url: session.url });
  } catch (e) {
    console.error("[stripe-customer-portal] failed", {
      organization_id: caller.tenantId,
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return atlasEdgeError("We couldn't open billing management right now. Please try again.", 502);
  }
});
