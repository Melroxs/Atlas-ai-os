// supabase/functions/stripe-checkout/index.ts
//
// Creates a Stripe Checkout Session for subscription billing.
//
// Flow:
//   1. Authenticate the caller (must have a valid Supabase session)
//   2. Verify the requested plan is valid
//   3. Get or create a Stripe customer for the user
//   4. Create a Stripe Checkout Session with the correct price + tenant metadata
//   5. Return the checkout URL to the frontend
//
// Environment variables (set in Supabase Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY — Stripe API secret key
//
// Uses SUPABASE_SECRET_KEYS (modern built-in env var) for service-role access.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const ATLAS_ALLOWED_ORIGINS = [
  "https://atlas-ai-os.com",
  "https://atlasmvp.freebuff.app",
  "https://atlasuniversalos.freebuff.app",
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ATLAS_ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function respond(corsH: Record<string, string>, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsH, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const corsH = corsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsH });
  }

  try {
    // --- Authenticate the caller ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return respond(corsH, 401, { error: "Missing or invalid Authorization header" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEYS");

    if (!supabaseUrl || !serviceRoleKey) {
      return respond(corsH, 500, { error: "Server configuration error" });
    }

    // Verify the user's JWT via Supabase Auth API
    const token = authHeader.replace("Bearer ", "");
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: Deno.env.get("SUPABASE_ANON_KEY") || "",
      },
    });

    if (!userRes.ok) {
      return respond(corsH, 401, { error: "Invalid or expired session" });
    }

    const userData = await userRes.json();
    const userId = userData.id;
    const userEmail = userData.email;

    if (!userId || !userEmail) {
      return respond(corsH, 401, { error: "Could not identify user" });
    }

    // --- Validate the request ---
    const body = await req.json().catch(() => ({}));
    const plan = body.plan as string;
    const billing = body.billing as string;
    const tenantId = body.tenantId as string | undefined;

    if (!plan || !billing) {
      return respond(corsH, 400, { error: "Missing required fields: plan, billing" });
    }

    if (!["starter", "professional"].includes(plan)) {
      return respond(corsH, 400, { error: "Invalid plan. Must be 'starter' or 'professional'." });
    }

    if (!["monthly", "annual"].includes(billing)) {
      return respond(corsH, 400, { error: "Invalid billing interval. Must be 'monthly' or 'annual'." });
    }

    // --- Resolve tenant_id from the authenticated user's membership ---
    // NEVER trust tenant_id from the browser. Always resolve from the
    // server-side membership relationship.
    const membershipRes = await fetch(
      `${supabaseUrl}/rest/v1/memberships?userId=eq.${userId}&status=eq.active&select=tenantId,role`,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      }
    );
    const memberships = await membershipRes.json();
    if (!memberships?.length) {
      return respond(corsH, 403, { error: "You do not have an active organization membership." });
    }
    // Use the server-resolved tenant_id, not the client-provided one
    const resolvedTenantId = memberships[0].tenantId;
    if (!resolvedTenantId) {
      return respond(corsH, 403, { error: "No organization associated with your account." });
    }

    // --- Get Stripe configuration ---
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      return respond(corsH, 500, { error: "Stripe is not configured. Please contact support." });
    }

    // Resolve price ID from plan + billing
    const priceEnvKey = `STRIPE_${plan.toUpperCase()}_${billing.toUpperCase()}_PRICE_ID`;
    const priceId = Deno.env.get(priceEnvKey);
    if (!priceId) {
      return respond(corsH, 500, { error: `Price not configured for ${plan} ${billing}. Please contact support.` });
    }

    // --- Get or create Stripe customer ---
    let stripeCustomerId: string;

    // Check if this tenant already has a Stripe customer ID
    const customerCheckRes = await fetch(
      `${supabaseUrl}/rest/v1/stripe_customers?tenant_id=eq.${resolvedTenantId}&select=stripe_customer_id`,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      }
    );

    const existingCustomers = await customerCheckRes.json();

    if (existingCustomers?.length > 0 && existingCustomers[0].stripe_customer_id) {
      stripeCustomerId = existingCustomers[0].stripe_customer_id;
    } else {
      // Create new Stripe customer
      const customerRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: userEmail,
          name: userData.user_metadata?.full_name || "",
          "metadata[supabase_user_id]": userId,
          "metadata[atlas_tenant_id]": resolvedTenantId,
        }).toString(),
      });

      if (!customerRes.ok) {
        const err = await customerRes.json();
        return respond(corsH, 500, { error: `Failed to create Stripe customer: ${err.message}` });
      }

      const customerData = await customerRes.json();
      stripeCustomerId = customerData.id;

      // Save the mapping (tenant-scoped)
      await fetch(`${supabaseUrl}/rest/v1/stripe_customers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          user_id: userId,
          tenant_id: resolvedTenantId,
          stripe_customer_id: stripeCustomerId,
        }),
      });
    }

    // --- Create Checkout Session ---
    const appOrigin = req.headers.get("origin") || "https://atlas-ai-os.com";

    const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: stripeCustomerId,
        mode: "subscription",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        success_url: `${appOrigin}/pricing-success`,
        cancel_url: `${appOrigin}/pricing?cancelled=true`,
        // Metadata that the webhook will use to identify the Atlas tenant
        "metadata[supabase_user_id]": userId,
        "metadata[atlas_tenant_id]": resolvedTenantId,
        "metadata[plan]": plan,
        "metadata[billing]": billing,
      }).toString(),
    });

    if (!sessionRes.ok) {
      const err = await sessionRes.json();
      return respond(corsH, 500, { error: `Failed to create checkout session: ${err.message}` });
    }

    const sessionData = await sessionRes.json();

    return respond(corsH, 200, {
      url: sessionData.url,
      sessionId: sessionData.id,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe-checkout] Error:", msg);
    return respond(corsH, 500, { error: "Internal server error" });
  }
});
