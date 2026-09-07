import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { useQuery } from "@/hooks/use-supabase";
import { Button } from "@/components/ui/button";
import { Loader2, Smile } from "lucide-react";
import type { Obj } from "@/lib/api";

interface BillingStateShape {
  isActive: boolean;
  plan?: string | null;
  status?: string;
  billingInterval?: string | null;
  provider?: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  trialStart?: number | null;
  trialEnd?: number | null;
  currentPeriodEnd?: number | null;
  nextBilledAt?: number | null;
  cancelAt?: number | null;
  canceledAt?: number | null;
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
      return state?.isActive ? "Trial" : "Trial ended";
    case "active":
      return state?.isActive ? "Active" : "Inactive";
    case "past_due":
      return "Past due";
    case "paused":
      return "Paused";
    case "canceled":
      return "Canceled";
    default:
      return "Not active";
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
    navigate("/auth?returnTo=/settings/billing");
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
              <span>Provider</span>
              <span className="text-foreground font-medium">
                {state?.provider === "paddle" ? "Paddle" : state?.provider ?? "—"}
              </span>
            </div>

            {state?.billingInterval && (
              <div className="flex justify-between text-muted-foreground">
                <span>Billing interval</span>
                <span className="text-foreground font-medium capitalize">
                  {state.billingInterval}
                </span>
              </div>
            )}

            {state?.status === "trialing" && state.trialEnd && (
              <div className="flex justify-between text-muted-foreground">
                <span>Trial ends</span>
                <span className="text-foreground">{formatDate(state.trialEnd)}</span>
              </div>
            )}

            {state?.isActive && (
              <>
                {state.nextBilledAt && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Next billing date</span>
                    <span className="text-foreground">{formatDate(state.nextBilledAt)}</span>
                  </div>
                )}
                {!state.nextBilledAt && state.currentPeriodEnd && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Current period ends</span>
                    <span className="text-foreground">{formatDate(state.currentPeriodEnd)}</span>
                  </div>
                )}
              </>
            )}

            {state?.cancelAt && (
              <div className="flex justify-between text-muted-foreground">
                <span>Cancellation effective</span>
                <span className="text-foreground">{formatDate(state.cancelAt)}</span>
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

          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="outline" size="sm" asChild>
              <a href="/dashboard/settings">
                Back to settings
              </a>
            </Button>
            {!state?.isActive && (
              <Button
                size="sm"
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
            Atlas billing is powered by Paddle. Payment processing, invoices,
            tax handling, and customer billing management are handled by Paddle
            as the Merchant of Record.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Atlas stores only the subscription identifiers and billing state
            needed to resolve access. No card details are stored in Atlas.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            New subscriptions start with a 1-day trial for $10, then bill at
            the plan's regular price on the selected billing interval.
            Cancellations and payment-method updates are handled through
            Paddle's checkout and the billing emails Paddle sends — a
            self-service customer portal is not yet wired into Atlas.
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