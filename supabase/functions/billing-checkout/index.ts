// ---------------------------------------------------------------------------
// Atlas — billing-checkout Edge Function (provider-neutral entry point)
//
// The ONLY checkout URL the browser knows. Deploy with verify_jwt = true
// (supabase/config.toml).
//
// Dispatch is 100% server-side, centralized and deterministic:
//
//   ATLAS_BILLING_PROVIDER = "stripe"   (default) → the existing Stripe
//                                            handler (extracted verbatim)
//   ATLAS_BILLING_PROVIDER = "paystack"           → the Paystack handler
//   anything else                                 → FAIL CLOSED (503)
//
// The browser submits only { plan, interval, tenantId?, companyName? } — it
// never selects, observes or influences the provider. The request/response
// envelope is identical to the original stripe-checkout contract, so the
// existing client (src/lib/billing/checkout.ts) works unchanged apart from
// the function name it posts to.
//
// Stripe safety: nothing in this file contains Stripe logic — it delegates to
// the same handler stripe-checkout serves, so both entries behave the same.
// ---------------------------------------------------------------------------

import { atlasEdgeError } from "../_shared/edge-auth.ts";
import { billingProvider } from "../_shared/billing-config.ts";
import { handleStripeCheckout } from "../_shared/stripe-checkout-handler.ts";
import { handlePaystackCheckout } from "../_shared/paystack-checkout.ts";

Deno.serve(async (req) => {
  const provider = billingProvider();

  if (provider === "stripe") {
    return await handleStripeCheckout(req);
  }
  if (provider === "paystack") {
    return await handlePaystackCheckout(req);
  }

  // Invalid ATLAS_BILLING_PROVIDER — fail closed. A typo in production must
  // never fall through to some provider nobody chose.
  console.error("[billing-checkout] invalid ATLAS_BILLING_PROVIDER value");
  return atlasEdgeError("Billing is temporarily unavailable.", 503);
});
