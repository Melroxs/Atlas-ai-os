// ---------------------------------------------------------------------------
// Atlas Billing — provider selection (single server-side decision point)
//
// Exactly ONE place decides which payment provider Atlas bills through. The
// value comes from the `ATLAS_BILLING_PROVIDER` edge secret:
//
//   "stripe"   (default) — the existing, production Stripe path
//   "paystack"           — the Paystack path (test-mode gates first)
//
// The browser never sends, influences or observes this value: it submits
// plan + interval only (see billing-checkout / stripe-checkout).
//
// FAIL CLOSED: an unset value means "stripe" (the current production
// provider), but any *invalid* value resolves to null and the dispatcher
// refuses to run — a typo in production must never silently fall through to
// a provider nobody chose.
// ---------------------------------------------------------------------------

export type AtlasBillingProviderName = "stripe" | "paystack";

/**
 * The provider this environment bills through, or null when the configured
 * value is invalid (fail closed — the caller must refuse to continue).
 *
 * Read at call time so tests can stub Deno.env and operators can flip the
 * provider without a code change.
 */
export function billingProvider(): AtlasBillingProviderName | null {
  const raw = (Deno.env.get("ATLAS_BILLING_PROVIDER") ?? "").trim().toLowerCase();
  if (raw === "" || raw === "stripe") return "stripe";
  if (raw === "paystack") return "paystack";
  return null;
}
