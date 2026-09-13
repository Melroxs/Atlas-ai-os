/**
 * Checkout page — ensures the Atlas organization exists, then opens the real
 * Paddle checkout for the selected plan.
 *
 * Flow:
 *   1. User arrives from /auth with ?plan=starter&billing=monthly&company=Name
 *   2. Page ensures a tenant exists via tenants_init_for_checkout (idempotent)
 *   3. Calls the paddle-checkout Edge Function with plan + billing + tenant_id.
 *      The server resolves the canonical Paddle price id from the plan +
 *      interval — the browser never sends a price, an amount or a currency.
 *   4. Opens Paddle checkout:
 *        - Paddle.js overlay with the server-created transaction id (default)
 *        - hosted checkout URL redirect when no client-side token is set
 *   5. After payment, the verified paddle-webhook synchronizes subscription
 *      state into Supabase
 *   6. Paddle returns the customer to /pricing-success, which polls the
 *      authoritative server billing state before granting access
 *
 * The browser never holds Paddle secrets: the API key and the webhook secret
 * stay in the Edge Function. Only the publishable client-side token reaches
 * this page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useMutation } from "@/hooks/use-supabase";
import { Loader2 } from "lucide-react";
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";
import type { BillingInterval } from "@/lib/billing/types";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";

/** What the paddle-checkout Edge Function returns to the browser. */
interface CheckoutSession {
  transactionId?: string;
  /** Publishable client-side token for the Paddle.js overlay. */
  clientToken?: string | null;
  environment?: "sandbox" | "live";
  /** Hosted checkout URL; null when no default payment link is configured. */
  url?: string | null;
  successUrl?: string;
  cancelUrl?: string;
}

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const initForCheckout = useMutation(api.tenants.initForCheckout);

  const plan = searchParams.get("plan") || "starter";
  const billing = (searchParams.get("billing") || "monthly") as BillingInterval;
  const companyName = searchParams.get("company") || "";

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<"init" | "checkout" | "paying">("init");

  // Guards against React's double-invoked effects and against creating a
  // second Paddle transaction when the component re-renders.
  const startedRef = useRef(false);
  const paddleRef = useRef<Paddle | null>(null);

  const openPaddleCheckout = useCallback(
    async (session: CheckoutSession) => {
      const { transactionId, clientToken, environment, url, successUrl } = session;

      // Preferred: Paddle.js overlay against the server-created transaction.
      // This does not depend on a hosted checkout URL, which Paddle only
      // returns when the seller has a default payment link configured.
      if (clientToken && transactionId) {
        const paddle =
          paddleRef.current ??
          (await initializePaddle({
            token: clientToken,
            environment: environment === "live" ? "production" : "sandbox",
            eventCallback: (event) => {
              // `name` is a string enum, so compare on the string value.
              const name = String(event.name ?? "");
              if (name === "checkout.closed") {
                // The customer cancelled: nothing is charged and no access is
                // granted. Send them back to pricing with an honest message.
                navigate("/pricing");
              }
              if (name === "checkout.completed" && successUrl) {
                window.location.href = successUrl;
              }
            },
          })) ??
          null;

        if (paddle) {
          paddleRef.current = paddle;
          setPhase("paying");
          setLoading(false);
          paddle.Checkout.open({
            transactionId,
            settings: successUrl ? { successUrl } : undefined,
          });
          return;
        }
      }

      // Fallback: Paddle's hosted checkout page.
      if (url) {
        window.location.href = url;
        return;
      }

      setError(
        "We couldn't open the payment window. Please try again, or contact support if it keeps happening.",
      );
      setLoading(false);
    },
    [navigate],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      navigate(
        `/auth?returnTo=${encodeURIComponent(`/checkout?plan=${plan}&billing=${billing}&company=${encodeURIComponent(companyName)}`)}`,
      );
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

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

        console.info(
          "[checkout] Organization ready:",
          tenantId,
          initResult?.alreadyExisted ? "(existing)" : "(new)",
        );

        // --- Phase 2: Create the Paddle transaction (server-side) ---
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

        const response = await fetch(`${resolvedSupabaseUrl}/functions/v1/paddle-checkout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          },
          body: JSON.stringify({
            tenantId,
            plan,
            billing,
            companyName: orgName,
          }),
        });

        const result = (await response.json().catch(() => null)) as
          | (CheckoutSession & { error?: string })
          | null;

        if (!response.ok) {
          const serverMsg =
            result && typeof result === "object" && typeof result.error === "string"
              ? result.error
              : null;
          let msg: string;
          if (serverMsg) {
            msg = serverMsg;
          } else if (response.status === 404) {
            msg =
              "The billing service isn't available yet. Please contact support so we can finish setting it up.";
          } else if (response.status === 401 || response.status === 403) {
            msg = "Your session expired. Please sign in again to continue.";
          } else {
            msg = "Could not start checkout. Please try again in a moment.";
          }
          setError(msg);
          setLoading(false);
          return;
        }

        if (!result) {
          setError("Could not start checkout. Please try again in a moment.");
          setLoading(false);
          return;
        }

        await openPaddleCheckout(result);
      } catch {
        setError("Checkout couldn't be started. Please check your connection and try again.");
        setLoading(false);
      }
    };

    createCheckout();
  }, [
    authLoading,
    isAuthenticated,
    plan,
    billing,
    companyName,
    navigate,
    initForCheckout,
    user,
    openPaddleCheckout,
  ]);

  if (authLoading || loading || phase === "paying") {
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
                  : "Complete your payment in the checkout window."}
            </p>
            <p className="text-xs text-muted-foreground">
              {phase === "init"
                ? "Creating your Atlas workspace and team ownership."
                : phase === "checkout"
                  ? "Payments are handled securely by Paddle."
                  : "Your subscription starts as soon as the payment is confirmed."}
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
