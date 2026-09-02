// supabase/functions/stripe-webhook/index.ts
//
// Processes Stripe webhook events for subscription management.
//
// Events handled:
//   - checkout.session.completed — Activate subscription + tenant
//   - customer.subscription.created — Record new subscription
//   - customer.subscription.updated — Sync subscription status changes
//   - customer.subscription.deleted — Mark subscription as canceled + tenant
//   - invoice.payment_failed — Mark subscription as past_due + tenant
//
// Security:
//   - Verifies webhook signature using STRIPE_WEBHOOK_SECRET
//   - Never exposes secret keys to the client
//
// Uses SUPABASE_SECRET_KEYS (modern built-in env var) for service-role access.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

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
      "authorization, x-client-info, apikey, content-type, stripe-signature",
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

/**
 * Verify Stripe webhook signature.
 * Uses Deno's Web Crypto API for HMAC-SHA256.
 */
async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    const parts = signatureHeader.split(",").reduce((acc, part) => {
      const [key, value] = part.split("=");
      acc[key] = value;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts["t"];
    const signature = parts["v1"];

    if (!timestamp || !signature) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload),
    );

    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return expectedSignature === signature;
  } catch {
    return false;
  }
}

serve(async (req: Request) => {
  const corsH = corsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsH });
  }

  try {
    // --- Verify webhook signature ---
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured");
      return respond(corsH, 500, { error: "Webhook not configured" });
    }

    const signatureHeader = req.headers.get("stripe-signature");
    if (!signatureHeader) {
      return respond(corsH, 400, { error: "Missing stripe-signature header" });
    }

    const body = await req.text();

    const isValid = await verifyWebhookSignature(body, signatureHeader, webhookSecret);
    if (!isValid) {
      return respond(corsH, 401, { error: "Invalid webhook signature" });
    }

    // --- Parse and process the event ---
    const event = JSON.parse(body);
    const eventType = event.type as string;
    const eventData = event.data?.object;

    if (!eventData) {
      return respond(corsH, 200, { received: true, skipped: "no event data" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEYS");

    if (!supabaseUrl || !serviceRoleKey) {
      return respond(corsH, 500, { error: "Server configuration error" });
    }

    console.log(`[stripe-webhook] Processing event: ${eventType}`);

    switch (eventType) {
      case "checkout.session.completed": {
        // --- Subscription activated after successful payment ---
        const subscriptionId = eventData.subscription as string;
        const customerId = eventData.customer as string;
        const userId = eventData.metadata?.supabase_user_id;
        const tenantId = eventData.metadata?.atlas_tenant_id;

        if (!subscriptionId || !userId) {
          console.warn("[stripe-webhook] checkout.session.completed missing critical data");
          break;
        }

        // Fetch the subscription details from Stripe
        const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        const sub = await subRes.json();

        // Get the price ID from the subscription
        const priceId = sub.items?.data?.[0]?.price?.id;
        const billing = sub.items?.data?.[0]?.price?.recurring?.interval === "year" ? "annual" : "monthly";

        // Determine plan from metadata or price
        const plan = eventData.metadata?.plan || "starter";

        // Upsert subscription record (with tenant_id)
        await fetch(`${supabaseUrl}/rest/v1/subscriptions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: userId,
            tenant_id: tenantId || null,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            status: "active",
            plan_name: plan,
            billing_interval: billing,
            current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            cancel_at_period_end: sub.cancel_at_period_end || false,
          }),
        });

        // Update the user's profile to active if it was pending
        await fetch(`${supabaseUrl}/rest/v1/profiles?_id=eq.${userId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ account_status: "active" }),
        });

        // --- Activate the tenant (the core SaaS activation) ---
        if (tenantId) {
          // Call the server-side RPC to activate the tenant
          await fetch(`${supabaseUrl}/rest/v1/rpc/tenants_activate_after_payment`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ p_tenant_id: tenantId }),
          });
          console.log(`[stripe-webhook] Tenant ${tenantId} activated after payment`);
        } else {
          // Fallback: find tenant by user membership and activate
          const memberRes = await fetch(
            `${supabaseUrl}/rest/v1/memberships?userId=eq.${userId}&role=eq.owner&select=tenantId`,
            {
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
              },
            }
          );
          const memberships = await memberRes.json();
          if (memberships?.length > 0) {
            const fallbackTenantId = memberships[0].tenantId;
            await fetch(`${supabaseUrl}/rest/v1/rpc/tenants_activate_after_payment`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({ p_tenant_id: fallbackTenantId }),
            });
            console.log(`[stripe-webhook] Tenant ${fallbackTenantId} activated (fallback by user membership)`);
          }
        }

        console.log(`[stripe-webhook] Subscription activated for user ${userId}`);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscriptionId = eventData.id as string;
        const status = eventData.status as string;
        const cancelAtPeriodEnd = eventData.cancel_at_period_end || false;

        // Map Stripe status to our status
        let mappedStatus = status;
        if (status === "active" && cancelAtPeriodEnd) {
          mappedStatus = "active"; // Still active until period end
        } else if (status === "past_due") {
          mappedStatus = "past_due";
        } else if (status === "canceled") {
          mappedStatus = "canceled";
        }

        // Update subscription record
        await fetch(`${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            status: mappedStatus,
            cancel_at_period_end: cancelAtPeriodEnd,
            current_period_start: eventData.current_period_start
              ? new Date(eventData.current_period_start * 1000).toISOString()
              : undefined,
            current_period_end: eventData.current_period_end
              ? new Date(eventData.current_period_end * 1000).toISOString()
              : undefined,
            updated_at: new Date().toISOString(),
          }),
        });

        // If subscription moved to past_due, update tenant
        if (mappedStatus === "past_due") {
          const subRes = await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}&select=tenant_id`,
            {
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
              },
            }
          );
          const subs = await subRes.json();
          if (subs?.[0]?.tenant_id) {
            await fetch(`${supabaseUrl}/rest/v1/rpc/tenants_handle_payment_failure`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({ p_tenant_id: subs[0].tenant_id }),
            });
          }
        }

        console.log(`[stripe-webhook] Subscription ${subscriptionId} updated: ${mappedStatus}`);
        break;
      }

      case "customer.subscription.deleted": {
        const subscriptionId = eventData.id as string;

        // Find the subscription to get tenant_id
        const subRes = await fetch(
          `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}&select=tenant_id`,
          {
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
            },
          }
        );
        const subs = await subRes.json();

        // Mark subscription as canceled
        await fetch(`${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            status: "canceled",
            updated_at: new Date().toISOString(),
          }),
        });

        // Update tenant billing state
        if (subs?.[0]?.tenant_id) {
          await fetch(`${supabaseUrl}/rest/v1/rpc/tenants_handle_subscription_cancelled`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ p_tenant_id: subs[0].tenant_id }),
          });
        }

        console.log(`[stripe-webhook] Subscription ${subscriptionId} canceled`);
        break;
      }

      case "invoice.payment_failed": {
        const customerId = eventData.customer as string;
        const subscriptionId = eventData.subscription as string;

        if (subscriptionId) {
          // Find subscription to get tenant_id
          const subRes = await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}&select=tenant_id`,
            {
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
              },
            }
          );
          const subs = await subRes.json();

          // Mark subscription as past_due
          await fetch(`${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              status: "past_due",
              updated_at: new Date().toISOString(),
            }),
          });

          // Update tenant billing state
          if (subs?.[0]?.tenant_id) {
            await fetch(`${supabaseUrl}/rest/v1/rpc/tenants_handle_payment_failure`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
                apikey: serviceRoleKey,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({ p_tenant_id: subs[0].tenant_id }),
            });
          }
        }

        console.log(`[stripe-webhook] Payment failed for customer ${customerId}`);
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${eventType}`);
    }

    return respond(corsH, 200, { received: true });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe-webhook] Error:", msg);
    return respond(corsH, 500, { error: "Webhook processing failed" });
  }
});
