/**
 * Pricing success page — shown when Paddle redirects back after checkout.
 *
 * We NEVER assume payment succeeded just because the user returned: the page
 * polls Atlas's server-side billing state (written by the verified Paddle
 * webhook) until the subscription appears. Possible outcomes:
 *   - "Activating your Atlas subscription…"  (webhook still in flight)
 *   - "Your Atlas trial is active."          (trialing / active confirmed)
 *   - "We couldn't confirm your subscription yet." (stalled / not active)
 *
 * This page is PUBLIC — it renders for both authenticated and unauthenticated
 * users. The dashboard auto-redirect only appears when an active session
 * exists and the subscription is confirmed.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useQuery } from "@/hooks/use-supabase";
import { CheckCircle, Loader2, RefreshCw, Clock } from "lucide-react";
import logo from "@/assets/logo.svg";
import type { Obj } from "@/lib/api";

interface BillingStateShape {
  isActive: boolean;
  status?: string;
  plan?: string | null;
  billingInterval?: string | null;
  trialEnd?: number | null;
  currentPeriodEnd?: number | null;
  nextBilledAt?: number | null;
}

function planDisplayName(plan?: string | null): string {
  if (plan === "ATLAS_STARTER") return "Atlas Starter";
  if (plan === "ATLAS_GROWTH") return "Atlas Growth";
  if (plan === "ATLAS_SCALE") return "Atlas Scale";
  return "your plan";
}

function formatDate(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const POLL_MS = 2500;
const STALL_AFTER_MS = 30000;

export default function PricingSuccess() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();

  const workspace = useQuery(api.tenants.getMyWorkspace);
  const tenantId =
    (workspace?.tenant as Obj | null | undefined)?.id ??
    (workspace?.membership as Obj | null | undefined)?.tenant_id ??
    null;

  const billing = useQuery<Obj | null>(
    api.billing.getState,
    { tenantId },
    {
      enabled: Boolean(tenantId),
      refreshIntervalMs: POLL_MS,
    },
  ) as BillingStateShape | null | undefined;

  const [stalled, setStalled] = useState(false);
  const [countdown, setCountdown] = useState(5);

  // Mark the confirmation as stalled after a grace period so the page never
  // spins forever without an honest message.
  useEffect(() => {
    if (billing?.isActive) return;
    const t = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    return () => clearTimeout(t);
  }, [billing?.isActive]);

  const confirmed = Boolean(billing?.isActive);

  // Auto-redirect to dashboard once confirmed (authenticated users only).
  useEffect(() => {
    if (isLoading || !isAuthenticated || !confirmed) return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          navigate("/dashboard");
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isLoading, isAuthenticated, confirmed, navigate]);

  const showActivating = !confirmed && !stalled;
  const showUnconfirmed = !confirmed && stalled;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-lg text-center space-y-6">
        {confirmed ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle className="h-8 w-8 text-emerald-500" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {billing?.status === "trialing"
                  ? "Your Atlas trial is active."
                  : "Your Atlas subscription is active."}
              </h1>
              <p className="text-muted-foreground leading-relaxed">
                {billing?.status === "trialing"
                  ? `You're on ${planDisplayName(billing?.plan)} (${billing?.billingInterval === "annual" ? "annual" : "monthly"} billing). Your trial ends ${
                      formatDate(billing?.trialEnd) ?? "soon"
                    } — then the plan's regular price applies.`
                  : `You're on ${planDisplayName(billing?.plan)}. Everything is set up and ready to use.`}
              </p>
              {billing?.trialEnd && (
                <p className="text-xs text-muted-foreground">
                  Next billing date: {formatDate(billing?.nextBilledAt ?? billing?.currentPeriodEnd) ?? "to be confirmed"}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-teal-500/10">
              {showActivating ? (
                <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
              ) : (
                <Clock className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {showActivating
                  ? "Activating your Atlas subscription…"
                  : "We couldn't confirm your subscription yet."}
              </h1>
              <p className="text-muted-foreground leading-relaxed">
                {showActivating
                  ? "Your payment is being confirmed with our billing provider. This usually takes a few seconds — hold tight."
                  : "Your payment may still be processing. Refresh in a moment, or contact support if this persists."}
              </p>
            </div>
          </>
        )}

        <div className="flex flex-col gap-3 items-center pt-2">
          {confirmed && isAuthenticated && (
            <>
              <button
                type="button"
                onClick={() => navigate("/dashboard")}
                className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Go to Atlas Dashboard
              </button>
              <p className="text-xs text-muted-foreground">
                Redirecting in {countdown} seconds…
              </p>
            </>
          )}
          {showUnconfirmed && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-border/70 px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-4" />
              Check again
            </button>
          )}
          {!isAuthenticated && !isLoading && (
            <p className="text-sm text-muted-foreground">
              Sign in to access your dashboard.
            </p>
          )}
        </div>

        <div className="pt-8">
          <img src={logo} alt="Atlas" width={32} height={32} className="mx-auto rounded-lg opacity-50" />
        </div>
      </div>
    </main>
  );
}