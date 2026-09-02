/**
 * Checkout page — ensures the Atlas organization exists, then creates a
 * Stripe Checkout Session via the server-side Edge Function.
 *
 * Flow:
 *   1. User arrives from /auth with ?plan=starter&billing=monthly&company=Name
 *   2. Page ensures a tenant exists via tenants_init_for_checkout (idempotent)
 *   3. Calls stripe-checkout Edge Function with plan + billing + tenant_id
 *   4. Redirects to Stripe Checkout URL
 *   5. After payment, Stripe webhook activates subscription + tenant
 *   6. User is redirected back to /pricing-success
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useMutation } from "@/hooks/use-supabase";
import { Loader2 } from "lucide-react";
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";
import type { PlanName, BillingInterval } from "@/lib/stripe";

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const initForCheckout = useMutation(api.tenants.initForCheckout);

  const plan = (searchParams.get("plan") || "starter") as PlanName;
  const billing = (searchParams.get("billing") || "monthly") as BillingInterval;
  const companyName = searchParams.get("company") || "";

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"init" | "checkout">("init");

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      navigate(`/auth?returnTo=${encodeURIComponent(`/checkout?plan=${plan}&billing=${billing}&company=${encodeURIComponent(companyName)}`)}`);
      return;
    }

    const createCheckout = async () => {
      try {
        // --- Phase 1: Ensure tenant exists (idempotent) ---
        setPhase("init");

        const orgName = companyName.trim() || user?.name?.trim() || "My Organization";
        const initResult = await initForCheckout({ name: orgName });
        const tenantId = initResult?.tenantId;

        if (!tenantId) {
          setError("Could not create organization. Please try again.");
          setLoading(false);
          return;
        }

        console.info("[checkout] Organization ready:", tenantId, initResult?.alreadyExisted ? "(existing)" : "(new)");

        // --- Phase 2: Create Stripe Checkout Session ---
        setPhase("checkout");

        const supabase = getSupabaseClient();
        if (!supabase) {
          setError("Supabase is not configured.");
          setLoading(false);
          return;
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          navigate("/auth");
          return;
        }

        // Call the stripe-checkout Edge Function with tenant_id
        const response = await fetch(`${resolvedSupabaseUrl}/functions/v1/stripe-checkout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          },
          body: JSON.stringify({
            plan,
            billing,
            tenantId,  // Pass tenant_id so Stripe metadata includes it
          }),
        });

        const result = await response.json().catch(() => null);

        if (!response.ok) {
          const msg = result?.error || `HTTP ${response.status}`;
          setError(`Could not create checkout session: ${msg}`);
          setLoading(false);
          return;
        }

        const { url } = result as { url?: string };
        if (url) {
          window.location.href = url;
        } else {
          setError("No checkout URL returned. Please try again.");
          setLoading(false);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Checkout failed: ${msg}`);
        setLoading(false);
      }
    };

    createCheckout();
  }, [authLoading, isAuthenticated, plan, billing, companyName, navigate, initForCheckout, user]);

  if (authLoading || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="size-8 animate-spin text-teal-500" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {phase === "init" ? "Setting up your organization…" : "Creating your checkout session…"}
            </p>
            <p className="text-xs text-muted-foreground">
              {phase === "init"
                ? "Creating your Atlas workspace and team ownership."
                : "You'll be redirected to Stripe to complete payment."}
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
            <button
              type="button"
              onClick={() => navigate("/pricing")}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Back to Pricing
            </button>
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
