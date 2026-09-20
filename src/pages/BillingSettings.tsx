/**
 * Billing settings — the authoritative billing view.
 *
 * Every value on this page comes from Atlas (billing_get_state, written by the
 * verified stripe-webhook). The page never infers paid status from a URL
 * parameter, localStorage, frontend state or a successful navigation, and it
 * never contacts Stripe directly: "Manage Billing" asks the
 * stripe-customer-portal Edge Function for a portal URL.
 */

import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useQuery } from "@/hooks/use-supabase";
import { Button } from "@/components/ui/button";
import { CreditCard, Loader2, Smile } from "lucide-react";
import type { Obj } from "@/lib/api";
import { getSupabaseClient, resolvedSupabaseUrl } from "@/lib/supabase";
import { openBillingPortal } from "@/lib/billing/checkout";

interface BillingStateShape {
  isActive: boolean;
  plan?: string | null;
  status?: string;
  paymentStatus?: string;
  billingInterval?: string | null;
  provider?: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  trialStart?: number | null;
  trialEnd?: number | null;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  nextBilledAt?: number | null;
  cancelAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  accessSource?: "stripe" | "complimentary" | null;
  complimentary?: { expires_at?: number | null; reason?: string } | null;
}

function planDisplayName(plan?: string | null): string {
  if (plan === "ATLAS_STARTER") return "Atlas Starter";
  if (plan === "ATLAS_GROWTH") return "Atlas Growth";
  if (plan === "ATLAS_SCALE") return "Atlas Scale";
  return "Not on a paid plan";
}

function statusLabel(state?: BillingStateShape | null): string {
  switch (state?.status) {
    case "trialing":
      // Defensive: Atlas never creates a trial, but a subscription created
      // outside Atlas (Stripe dashboard/support) must still render correctly.
      return state?.isActive ? "Trialing" : "Trial ended";
    case "active":
      return state?.isActive ? "Active" : "Inactive";
    case "past_due":
      return "Past due — grace period";
    case "unpaid":
      return "Unpaid";
    case "incomplete":
      return "Payment incomplete";
    case "incomplete_expired":
      return "Expired";
    case "paused":
      return "Paused";
    case "canceled":
      return "Canceled";
    default:
      return "Not active";
  }
}

/** Honest payment-issue copy. Returns null when there is nothing to flag. */
function paymentIssueLabel(state?: BillingStateShape | null): string | null {
  switch (state?.paymentStatus) {
    case "failed":
      return "The last payment failed. Stripe will retry — update your card in Manage Billing to avoid interruption.";
    case "requires_action":
      return "Your bank needs to authenticate the last payment. Finish it in Manage Billing.";
    case "pending":
      return "A payment is pending confirmation.";
    default:
      return state?.status === "past_due"
        ? "A payment is overdue. Stripe is retrying — update your card in Manage Billing."
        : null;
  }
}

function formatDate(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function BillingSettings() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [portalError, setPortalError] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  // tenants_get_my_workspace serializes rows with their real column names:
  // tenants._id and memberships."tenantId" (quoted camelCase).
  const workspace = useQuery(api.tenants.getMyWorkspace);
  const tenantId =
    (workspace?.tenant as Obj | null | undefined)?._id ??
    (workspace?.membership as Obj | null | undefined)?.tenantId ??
    null;

  const state = useQuery<Obj | null>(
    api.billing.getState,
    { tenantId },
    { enabled: Boolean(isAuthenticated && tenantId) },
  ) as BillingStateShape | null | undefined;

  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-teal-500" />
      </main>
    );
  }

  if (!isAuthenticated) {
    // Never wait on the workspace query here: without a session the RPC
    // cannot resolve, so an unauthenticated visitor must be redirected
    // immediately (RequireAuth normally handles this; this is the fallback).
    navigate("/auth?returnTo=/dashboard/billing");
    return null;
  }

  const loading = workspace === undefined || (Boolean(tenantId) && state === undefined);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-teal-500" />
      </main>
    );
  }

  const complimentary = state?.accessSource === "complimentary";
  const hasBillingProfile = Boolean(state?.providerCustomerId);
  const billingInterval = state?.billingInterval ?? null;
  const issue = paymentIssueLabel(state);

  const handleManageBilling = async () => {
    setPortalError(null);
    setOpeningPortal(true);
    try {
      const supabase = getSupabaseClient();
      const {
        data: { session },
      } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
      if (!session?.access_token) {
        navigate("/auth?returnTo=/dashboard/billing");
        return;
      }
      const result = await openBillingPortal({
        accessToken: session.access_token,
        functionsBaseUrl: resolvedSupabaseUrl,
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      });
      if (!result.ok) {
        setPortalError(result.message);
        return;
      }
      window.location.assign(result.url);
    } catch {
      setPortalError("Billing management couldn't be opened. Please try again.");
    } finally {
      setOpeningPortal(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
          <a
            href="/dashboard/settings"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-85"
          >
            <span className="text-lg font-semibold tracking-tight text-foreground">
              Settings
            </span>
          </a>
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => navigate("/dashboard")}>
              Back to Atlas
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Billing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your Atlas subscription, billing, and payment method.
        </p>

        {complimentary && (
          <div className="mt-6 rounded-xl border border-teal-400/30 bg-teal-400/10 p-4">
            <p className="text-sm font-medium text-teal-700 dark:text-teal-300">
              This organization has complimentary Atlas access
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              No subscription or payment is required
              {state?.complimentary?.expires_at
                ? ` until ${formatDate(state.complimentary.expires_at)}`
                : ""}
              . Adding a paid plan is optional.
            </p>
          </div>
        )}

        <div className="mt-8 rounded-xl border border-border/60 bg-card/40 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Current plan
              </p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {planDisplayName(state?.plan)}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground">
              {statusLabel(state)}
            </div>
          </div>

          <div className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Billing provider</span>
              <span className="text-foreground font-medium">Stripe</span>
            </div>

            {billingInterval && (
              <div className="flex justify-between text-muted-foreground">
                <span>Billing interval</span>
                <span className="text-foreground font-medium capitalize">
                  {billingInterval}
                </span>
              </div>
            )}

            {state?.status === "trialing" && state.trialEnd && (
              <div className="flex justify-between text-muted-foreground">
                <span>Trial ends</span>
                <span className="text-foreground">{formatDate(state.trialEnd)}</span>
              </div>
            )}

            {state?.isActive && state.cancelAtPeriodEnd && (
              <div className="flex justify-between text-muted-foreground">
                <span>Cancels on</span>
                <span className="text-foreground">
                  {formatDate(state.cancelAt ?? state.currentPeriodEnd) ?? "period end"}
                </span>
              </div>
            )}

            {state?.isActive && !state.cancelAtPeriodEnd && (state.nextBilledAt || state.currentPeriodEnd) && (
              <div className="flex justify-between text-muted-foreground">
                <span>Next billing date</span>
                <span className="text-foreground">
                  {formatDate(state.nextBilledAt ?? state.currentPeriodEnd)}
                </span>
              </div>
            )}

            {!state?.isActive && state?.canceledAt && (
              <div className="flex justify-between text-muted-foreground">
                <span>Canceled on</span>
                <span className="text-foreground">{formatDate(state.canceledAt)}</span>
              </div>
            )}

            {state?.providerSubscriptionId && (
              <div className="flex justify-between text-muted-foreground">
                <span>Subscription ID</span>
                <span className="text-foreground font-mono text-xs">
                  {state.providerSubscriptionId}
                </span>
              </div>
            )}
          </div>

          {issue && (
            <div className="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3">
              <p className="text-sm text-amber-700 dark:text-amber-300">{issue}</p>
            </div>
          )}

          {portalError && (
            <div className="mt-5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3">
              <p className="text-sm text-rose-600 dark:text-rose-300">{portalError}</p>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {hasBillingProfile && (
              <Button
                size="sm"
                onClick={handleManageBilling}
                disabled={openingPortal}
                className="gap-2 shadow-none"
              >
                {openingPortal ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CreditCard className="size-4" />
                )}
                Manage Billing
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <a href="/dashboard/settings">Back to settings</a>
            </Button>
            {!state?.isActive && !complimentary && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate("/pricing")}
                className="shadow-none"
              >
                View plans
              </Button>
            )}
          </div>
        </div>

        <div className="mt-10 rounded-xl border border-border/60 bg-card/40 p-6">
          <h2 className="text-lg font-semibold text-foreground">
            About Atlas billing
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Atlas subscriptions are billed through Stripe. Payment processing,
            invoices, receipts, tax handling, plan changes and cancellations are
            handled in the Stripe billing portal, opened from Manage Billing.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Atlas stores only the Stripe customer and subscription identifiers and
            the billing state needed to resolve access. No card details are ever
            stored in Atlas, and paid access is granted only after Stripe confirms
            the subscription through a verified webhook.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Atlas subscriptions bill at the plan price on the selected billing
            interval — no trial, no setup fee. You can cancel at any time from the
            billing portal and keep access until the end of the period you paid for.
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-border/60 bg-card/40 p-6">
          <div className="flex items-start gap-3">
            <Smile className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Need help with billing?
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                If something looks wrong with your subscription or invoice,
                contact the Atlas team through your account.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
