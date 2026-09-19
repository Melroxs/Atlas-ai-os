/**
 * Checkout page — ensures the Atlas organization exists, then starts a
 * server-side Stripe Checkout Session and redirects the customer to Stripe.
 *
 * Flow:
 *   1. User arrives from /auth or /pricing with ?plan=starter&interval=month
 *   2. Page ensures a tenant exists via tenants_init_for_checkout (idempotent)
 *   3. Calls the `stripe-checkout` Edge Function with plan + interval ONLY.
 *      The server authenticates the user, authorizes the organization, resolves
 *      the Stripe Price id from the canonical catalog and creates the Checkout
 *      Session. The browser never sends a price, an amount or a currency.
 *   4. Redirects to the Stripe-hosted checkout URL.
 *   5. Stripe returns the customer to /pricing-success, which polls the
 *      server-authored billing state. The redirect itself is NEVER proof of
 *      payment — access is granted only by the verified stripe-webhook.
 *
 * Handling of the awkward cases:
 *   - user closes/cancels Stripe checkout → Stripe redirects to /pricing
 *   - network failure / server error → inline error with retry
 *   - duplicate click → a single attempt per mount (startedRef) plus the
 *     server's bucketed idempotency key and its active-subscription check
 *   - organization already subscribed → 409 → route to Manage Billing instead
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useMutation } from "@/hooks/use-supabase";
import { Loader2 } from "lucide-react";
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";
import { startCheckout } from "@/lib/billing/checkout";
import { intervalForInput, planForSlug } from "@/lib/billing/plans";
import type { BillingInterval, InternalPlan } from "@/lib/billing/types";

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const initForCheckout = useMutation(api.tenants.initForCheckout);

  // `interval` is the current parameter; `billing` is accepted for links that
  // predate the Stripe migration.
  const rawPlan = searchParams.get("plan") || "starter";
  const rawInterval = searchParams.get("interval") || searchParams.get("billing") || "month";
  const companyName = searchParams.get("company") || "";

  const plan: InternalPlan | null = planForSlug(rawPlan);
  const interval: BillingInterval | null = intervalForInput(rawInterval);

  const [error, setError] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"init" | "checkout" | "redirecting">("init");

  // Guards React's double-invoked effects: one checkout attempt per mount.
  const startedRef = useRef(false);

  const beginCheckout = useCallback(async () => {
    if (!plan || !interval) {
      setError("That plan or billing interval is not available.");
      setLoading(false);
      return;
    }

    try {
      // --- Phase 1: ensure the organization exists (idempotent) ---
      setPhase("init");
      const orgName = companyName.trim() || user?.name?.trim() || "My Organization";
      const initResult = await initForCheckout({ name: orgName });
      const tenantId = initResult?.tenantId;
      if (!tenantId) {
        setError("Could not create organization. Please try again.");
        setLoading(false);
        return;
      }

      // --- Phase 2: server-side Stripe Checkout Session ---
      setPhase("checkout");
      const supabase = getSupabaseClient();
      if (!supabase) {
        setError("Billing is unavailable right now. Please try again shortly.");
        setLoading(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        navigate("/auth");
        return;
      }

      const result = await startCheckout({
        plan,
        interval,
        accessToken: session.access_token,
        functionsBaseUrl: resolvedSupabaseUrl,
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        tenantId,
        companyName: orgName,
      });

      if (!result.ok) {
        setAlreadySubscribed(result.alreadySubscribed);
        setError(result.message);
        setLoading(false);
        return;
      }

      // --- Phase 3: hand off to Stripe's hosted checkout ---
      setPhase("redirecting");
      window.location.assign(result.url);
    } catch {
      setError("Checkout couldn't be started. Please check your connection and try again.");
      setLoading(false);
    }
  }, [plan, interval, companyName, user, initForCheckout, navigate]);

  useEffect(() => {
    if (authLoading) return;

    if (!isAuthenticated) {
      const returnTo = `/checkout?plan=${encodeURIComponent(rawPlan)}&interval=${encodeURIComponent(rawInterval)}&company=${encodeURIComponent(companyName)}`;
      navigate(`/auth?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    if (startedRef.current) return;
    startedRef.current = true;
    beginCheckout();
  }, [
    authLoading,
    isAuthenticated,
    rawPlan,
    rawInterval,
    companyName,
    navigate,
    beginCheckout,
  ]);

  if (authLoading || loading || phase === "redirecting") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="size-8 animate-spin text-teal-500" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {phase === "init"
                ? "Setting up your organization…"
                : phase === "checkout"
                  ? "Preparing your secure checkout…"
                  : "Taking you to Stripe…"}
            </p>
            <p className="text-xs text-muted-foreground">
              {phase === "init"
                ? "Creating your Atlas workspace and team ownership."
                : phase === "checkout"
                  ? "Payments are processed securely by Stripe."
                  : "Complete your payment on Stripe's secure page."}
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-6">
          <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3">
            <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p>
          </div>
          <div className="flex gap-3 justify-center">
            {alreadySubscribed ? (
              <button
                type="button"
                onClick={() => navigate("/dashboard/billing")}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Manage Billing
              </button>
            ) : (
              <button
                type="button"
                onClick={() => navigate("/pricing")}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Back to Pricing
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center rounded-md border border-border/70 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </main>
    );
  }

  return null;
}
