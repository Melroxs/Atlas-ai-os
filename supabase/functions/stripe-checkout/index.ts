/**
 * Stripe Checkout Edge Function
 *
 * Creates a Stripe Checkout Session for Atlas subscriptions.
 *
 * CRITICAL SECURITY:
 * - Validates plan + billing combination server-side (never trusts client)
 * - Maps to Stripe Price ID server-side (prevents manipulation)
 * - Uses STRIPE_SECRET_KEY server-side only
 * - Verifies user authentication via Supabase JWT
 *
 * Environment Variables Required:
 * - STRIPE_SECRET_KEY (server-only)
 * - STRIPE_PRICE_STARTER_MONTHLY
 * - STRIPE_PRICE_STARTER_ANNUAL
 * - STRIPE_PRICE_PRO_MONTHLY
 * - STRIPE_PRICE_PRO_ANNUAL
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Stripe Price ID mapping - environment-driven, server-side only
const PRICE_MAP: Record<string, Record<string, string>> = {
  starter: {
    monthly: Deno.env.get("STRIPE_PRICE_STARTER_MONTHLY") || "",
    annual: Deno.env.get("STRIPE_PRICE_STARTER_ANNUAL") || "",
  },
  professional: {
    monthly: Deno.env.get("STRIPE_PRICE_PRO_MONTHLY") || "",
    annual: Deno.env.get("STRIPE_PRICE_PRO_ANNUAL") || "",
  },
};

// Valid plans and billing intervals
const VALID_PLANS = ["starter", "professional"];
const VALID_BILLING = ["monthly", "annual"];

serve(async (req) => {
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify JWT and get user
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Parse and validate request body
    const body = await req.json();
    const { plan, billing, tenantId } = body;

    if (!plan || !billing) {
      return new Response(
        JSON.stringify({ error: "Missing plan or billing" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate plan and billing (prevents manipulation)
    if (!VALID_PLANS.includes(plan)) {
      return new Response(
        JSON.stringify({ error: "Invalid plan" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!VALID_BILLING.includes(billing)) {
      return new Response(
        JSON.stringify({ error: "Invalid billing interval" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Resolve Price ID server-side (never from client)
    const priceId = PRICE_MAP[plan]?.[billing];
    if (!priceId) {
      return new Response(
        JSON.stringify({ error: "Price not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Get or create Stripe customer
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      console.error("[stripe-checkout] STRIPE_SECRET_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if tenant already has a Stripe customer
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: tenant } = await adminClient
      .from("tenants")
      .select("id, stripe_customer_id, name")
      .eq("id", tenantId)
      .single();

    let customerId = tenant?.stripe_customer_id;

    if (!customerId) {
      // Create new Stripe customer
      const customerResponse = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: user.email || "",
          name: tenant?.name || user.user_metadata?.full_name || "",
          metadata: {
            atlas_user_id: user.id,
            atlas_tenant_id: tenantId,
          },
        }).toString(),
      });

      if (!customerResponse.ok) {
        const error = await customerResponse.text();
        console.error("[stripe-checkout] Customer creation failed:", error);
        return new Response(
          JSON.stringify({ error: "Failed to create customer" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const customer = await customerResponse.json();
      customerId = customer.id;

      // Save customer ID to tenant
      await adminClient
        .from("tenants")
        .update({ stripe_customer_id: customerId })
        .eq("id", tenantId);
    }

    // 5. Create Checkout Session
    const appUrl = Deno.env.get("APP_URL") || "https://atlas-ai-os.com";
    const successUrl = `${appUrl}/pricing-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${appUrl}/pricing`;

    const checkoutResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: customerId,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "metadata[atluser_id]": user.id,
        "metadata[atlas_tenant_id]": tenantId,
        "metadata[atlas_plan]": plan,
        "metadata[atlas_billing]": billing,
        "subscription_data[metadata][atluser_id]": user.id,
        "subscription_data[metadata][atlas_tenant_id]": tenantId,
      }).toString(),
    });

    if (!checkoutResponse.ok) {
      const error = await checkoutResponse.text();
      console.error("[stripe-checkout] Checkout session creation failed:", error);
      return new Response(
        JSON.stringify({ error: "Failed to create checkout session" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const session = await checkoutResponse.json();

    // 6. Return checkout URL
    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[stripe-checkout] Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
