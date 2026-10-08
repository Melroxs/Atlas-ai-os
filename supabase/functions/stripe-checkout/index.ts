// ---------------------------------------------------------------------------
// Atlas — stripe-checkout Edge Function
//
// The Stripe-specific way a browser starts an Atlas subscription. Deploy with
// verify_jwt = true (supabase/config.toml).
//
// The handler body now lives in ../_shared/stripe-checkout-handler.ts (a
// verbatim extraction) so the provider-neutral billing-checkout entry can
// dispatch to exactly the same code path. This function still serves it
// directly: the deployed Stripe entry point is unchanged, and it keeps working
// even if billing-checkout is unavailable.
//
// What the browser may send:
//   { plan: "starter" | "growth" | "scale", interval: "month" | "year",
//     tenantId?: string, companyName?: string }
//
// What it may NEVER send (and is therefore never accepted):
//   price ids, amounts, currencies, Stripe customer ids, subscription ids,
//   statuses, or any claim about payment.
// ---------------------------------------------------------------------------

import { handleStripeCheckout } from "../_shared/stripe-checkout-handler.ts";

Deno.serve(handleStripeCheckout);
