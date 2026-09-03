/**
 * Stripe Webhook Edge Function
 *
 * Handles Stripe webhook events for subscription lifecycle management.
 *
 * CRITICAL SECURITY:
 * - Verifies Stripe webhook signature before processing
 * - Uses STRIPE_WEBHOOK_SECRET for signature verification
 * - Processes events idempotently (safe for retries)
 * - Updates Supabase subscription state server-side
 *
 * Events Handled:
 * - checkout.session.completed
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.paid
 * - invoice.payment_failed
 *
 * Environment Variables Required:
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Stripe webhook signature verification
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const parts = signature.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);

  if (!timestamp || !v1) return false;

  // Check timestamp tolerance (5 minutes)
  const currentTime = Math.floor(Date.now() / 1000);
  const webhookTime = parseInt(timestamp, 10);
  if (Math.abs(currentTime - webhookTime) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computedSignature === v1;
}

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
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured");
      return new Response(
        JSON.stringify({ error: "Webhook not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Get request body and signature
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response(
        JSON.stringify({ error: "Missing signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Verify webhook signature
    const isValid = await verifyWebhookSignature(body, signature, webhookSecret);
    if (!isValid) {
      console.error("[stripe-webhook] Invalid signature");
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Parse event
    const event = JSON.parse(body);
    console.info("[stripe-webhook] Received event:", event.type);

    // 4. Initialize Supabase admin client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 5. Handle event
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = session.metadata?.atlas_tenant_id;
        const userId = session.metadata?.atluser_id;
        const plan = session.metadata?.atlas_plan;
        const billing = session.metadata?.atlas_billing;

        if (!tenantId) {
          console.error("[stripe-webhook] No tenant_id in session metadata");
          break;
        }

        // Update tenant with subscription info
        const { error } = await supabase
          .from("tenants")
          .update({
            stripe_subscription_id: session.subscription,
            stripe_price_id: session.metadata?.stripe_price_id,
            subscription_status: "active",
            subscription_plan: plan,
            subscription_billing: billing,
            current_period_start: new Date().toISOString(),
            cancel_at_period_end: false,
          })
          .eq("id", tenantId);

        if (error) {
          console.error("[stripe-webhook] Failed to update tenant:", error);
        }

        // Activate tenant
        await supabase.rpc("tenants_activate_after_payment", {
          p_tenant_id: tenantId,
        });

        console.info("[stripe-webhook] Subscription activated for tenant:", tenantId);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object;
        const tenantId = subscription.metadata?.atlas_tenant_id;

        if (!tenantId) {
          console.error("[stripe-webhook] No tenant_id in subscription metadata");
          break;
        }

        // Update subscription status
        const { error } = await supabase
          .from("tenants")
          .update({
            subscription_status: subscription.status,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
          })
          .eq("id", tenantId);

        if (error) {
          console.error("[stripe-webhook] Failed to update subscription:", error);
        }

        console.info("[stripe-webhook] Subscription updated for tenant:", tenantId);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const tenantId = subscription.metadata?.atlas_tenant_id;

        if (!tenantId) {
          console.error("[stripe-webhook] No tenant_id in subscription metadata");
          break;
        }

        // Handle subscription cancellation
        const { error } = await supabase
          .from("tenants")
          .update({
            subscription_status: "cancelled",
            stripe_subscription_id: null,
          })
          .eq("id", tenantId);

        if (error) {
          console.error("[stripe-webhook] Failed to cancel subscription:", error);
        }

        // Deactivate tenant
        await supabase.rpc("tenants_handle_subscription_cancelled", {
          p_tenant_id: tenantId,
        });

        console.info("[stripe-webhook] Subscription cancelled for tenant:", tenantId);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const tenantId = invoice.metadata?.atlas_tenant_id;

        if (tenantId) {
          // Update payment status
          await supabase
            .from("tenants")
            .update({
              last_payment_date: new Date().toISOString(),
              payment_status: "paid",
            })
            .eq("id", tenantId);
        }

        console.info("[stripe-webhook] Invoice paid for tenant:", tenantId);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const tenantId = invoice.metadata?.atlas_tenant_id;

        if (tenantId) {
          // Handle payment failure
          const { error } = await supabase
            .from("tenants")
            .update({
              payment_status: "failed",
              last_payment_error: invoice.last_finalization_error?.message || "Payment failed",
            })
            .eq("id", tenantId);

          if (error) {
            console.error("[stripe-webhook] Failed to update payment status:", error);
          }

          // Handle payment failure in business logic
          await supabase.rpc("tenants_handle_payment_failure", {
            p_tenant_id: tenantId,
          });
        }

        console.info("[stripe-webhook] Invoice payment failed for tenant:", tenantId);
        break;
      }

      default:
        console.info("[stripe-webhook] Unhandled event type:", event.type);
    }

    // 6. Return success (Stripe requires 200 response)
    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[stripe-webhook] Error:", error);
    // Still return 200 to prevent Stripe retries for processing errors
    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
