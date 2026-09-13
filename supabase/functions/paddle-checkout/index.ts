// ---------------------------------------------------------------------------
// Atlas — paddle-checkout Edge Function
//
// Creates a Paddle transaction for an authenticated user's organization and
// returns the hosted checkout URL.
//
// Security:
//   - The caller's Supabase JWT is verified by the platform (do NOT deploy
//     with --no-verify-jwt).
//   - The organization is resolved from the caller's own workspace
//     (tenants_get_my_workspace runs as the caller under RLS); the requested
//     tenantId is only accepted when it matches the caller's membership.
//   - PADDLE_API_KEY is read from Deno.env and never leaves this function.
//
// Flow: Pricing → Checkout page → this function → Paddle checkout (no trial;
// the catalog price is charged immediately) → webhook → Atlas DB.
// ---------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  CORS_HEADERS,
  createPaddleTransaction,
  paddleClientConfig,
  paddleCustomerExistsInEnvironment,
  isPaddleCustomerId,
  jsonResponse,
  errorResponse,
  type BillingInterval,
  type InternalPlan,
} from "../_shared/paddle.ts";

/**
 * Resolve the organization's real Paddle customer id (`ctm_...`) for Paddle
 * Retain (`pwCustomer`). The value originates from Paddle itself and is
 * persisted by the verified paddle-webhook into
 * organization_subscriptions.provider_customer_id — it is never an Atlas
 * organization id, a Supabase user id or an email address. Returns null for
 * a first-time subscriber (no Paddle customer exists yet) or when the stored
 * id belongs to a different Paddle environment.
 */
async function resolvePaddleCustomerId(
  organizationId: string,
): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return null;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin
    .from("organization_subscriptions")
    .select("provider_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const stored = data?.provider_customer_id ?? null;
  if (!isPaddleCustomerId(stored)) return null;
  return (await paddleCustomerExistsInEnvironment(stored)) ? stored : null;
}


const ATLAS_APP_URL = Deno.env.get("ATLAS_APP_URL") ?? "https://atlas-ai-os.com";

interface CheckoutBody {
  tenantId?: string;
  plan?: string;
  billing?: string;
  companyName?: string;
}

/** Normalize the pricing-page plan slug into an internal Atlas plan. */
function resolveInternalPlan(slug: string): InternalPlan | null {
  switch (slug.toLowerCase()) {
    case "starter":
      return "ATLAS_STARTER";
    case "growth":
    case "professional": // legacy pricing-page slug
      return "ATLAS_GROWTH";
    case "scale":
      return "ATLAS_SCALE";
    default:
      return null;
  }
}

function resolveInterval(slug: string): BillingInterval | null {
  if (slug === "annual") return "annual";
  if (slug === "monthly") return "monthly";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization) {
      return errorResponse("Unauthorized.", 401);
    }

    let body: CheckoutBody;
    try {
      body = (await req.json()) as CheckoutBody;
    } catch {
      return errorResponse("Invalid JSON body.", 400);
    }

    const plan = resolveInternalPlan(body.plan ?? "");
    const billing = resolveInterval(body.billing ?? "");
    if (!plan || !billing) {
      return errorResponse(
        "Invalid plan or billing interval. Expected plan in starter/growth/scale and billing in monthly/annual.",
        400,
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !anonKey) {
      return errorResponse("Billing is not configured for this environment.", 503);
    }

    // User-scoped client: RPCs run under RLS as the caller.
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(authorization.replace("Bearer ", ""));
    if (userError || !user) {
      return errorResponse("Unauthorized.", 401);
    }

    // Resolve the caller's workspace and confirm membership of the
    // organization they want to bill. Never trust a client-supplied org id
    // without verifying the caller belongs to it.
    const { data: workspace, error: workspaceError } = await supabase.rpc(
      "tenants_get_my_workspace",
    );
    if (workspaceError || !workspace) {
      return errorResponse(
        "Could not resolve your organization. Please try again.",
        500,
      );
    }

    // tenants_get_my_workspace serializes rows with their real column names:
    // tenants._id and memberships."tenantId" (quoted camelCase).
    const ws = workspace as Record<string, unknown>;
    const tenant =
      (ws.tenant as Record<string, unknown> | null) ?? null;
    const membership =
      (ws.membership as Record<string, unknown> | null) ?? null;
    const tenantId =
      (tenant?._id as string | undefined) ??
      (membership?.tenantId as string | undefined) ??
      "";

    if (!tenantId) {
      return errorResponse(
        "You need an organization before subscribing. Please set one up first.",
        400,
      );
    }
    if (body.tenantId && body.tenantId !== tenantId) {
      return errorResponse("You do not have access to this organization.", 403);
    }

    const successUrl = `${ATLAS_APP_URL}/pricing-success?tenantId=${encodeURIComponent(tenantId)}&plan=${encodeURIComponent(plan)}&billing=${encodeURIComponent(billing)}`;
    const cancelUrl = `${ATLAS_APP_URL}/pricing`;

    const { transactionId, url } = await createPaddleTransaction(
      tenantId,
      plan,
      billing,
      successUrl,
    );

    // Client-safe overlay config. The browser opens Paddle.js with the
    // transaction id when a client-side token is configured, and falls back to
    // the hosted checkout URL otherwise. At least one of the two must exist,
    // or the customer would reach a dead end.
    const { clientToken, environment } = paddleClientConfig();
    if (!clientToken && !url) {
      console.error("[paddle-checkout] no checkout surface available", {
        organization_id: tenantId,
        reason:
          "PADDLE_CLIENT_TOKEN is unset and Paddle returned no hosted checkout URL (no default payment link configured).",
      });
      return errorResponse(
        "Checkout isn't available yet. Our team has been notified — please try again shortly.",
        503,
      );
    }

    // Paddle Retain identification: only a Paddle-issued ctm_ id that exists
    // in this Paddle environment is ever returned.
    const paddleCustomerId = await resolvePaddleCustomerId(tenantId);

    console.info("[paddle-checkout] transaction created", {
      organization_id: tenantId,
      internal_plan: plan,
      billing_interval: billing,
      transaction_id: transactionId,
      surface: clientToken ? "overlay" : "hosted",
      retain_customer: paddleCustomerId ? "known" : "none",
      result: "ok",
    });

    return jsonResponse({
      transactionId,
      clientToken,
      paddleCustomerId,
      environment,
      url,
      successUrl,
      cancelUrl,
      plan,
      billingInterval: billing,
      providerType: "paddle",
      providerConfigured: true,
      canCheckout: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[paddle-checkout] failed", { detail: msg.slice(0, 200) });
    if (msg.includes("not configured for billing")) {
      return errorResponse("The selected Atlas plan is not configured for billing.", 422);
    }
    if (msg.includes("PADDLE_API_KEY is not configured")) {
      return errorResponse(
        "Billing isn't configured for this environment yet. Please contact support.",
        503,
      );
    }
    return errorResponse("We're unable to start checkout right now. Please try again.", 502);
  }

});