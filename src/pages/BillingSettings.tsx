import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Loader2, Smile } from "lucide-react";
import { isBillingProviderConfigured, type BillingState } from "@/lib/billing";

export default function BillingSettings() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setLoading(false);
      return;
    }

    // Billing state is resolved server-side. In a fully wired deploy this page
    // would fetch it from the backend; for now we render an honest placeholder
    // that reflects the current configuration.
    //
    // Once the billing RPC is deployed, replace this with a server-backed fetch
    // so the page never trusts client-provided plan/status values.
    const tick = async () => {
      setLoading(false);
      setState({
        isActive: false,
        plan: null,
        status: "unknown",
        provider: "paddle",
        providerCustomerId: null,
        providerSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAt: null,
        canceledAt: null,
        canUsePaidFeatures: false,
      });
    };

    tick();
  }, [authLoading, isAuthenticated]);

  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-teal-500" />
      </main>
    );
  }

  if (!isAuthenticated) {
    navigate("/auth?returnTo=/settings/billing");
    return null;
  }

  if (loading || !state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-teal-500" />
      </main>
    );
  }

  const planDisplayName =
    state.plan === "ATLAS_STARTER"
      ? "Atlas Starter"
      : state.plan === "ATLAS_GROWTH"
        ? "Atlas Growth"
        : state.plan === "ATLAS_SCALE"
          ? "Atlas Scale"
          : "Not on a paid plan";

  const statusLabel =
    state.status === "active" && !state.isActive
      ? "Inactive"
      : state.status === "canceled"
        ? "Canceled"
        : state.status === "past_due"
          ? "Past due"
          : state.status === "trialing"
            ? "Trialing"
            : state.status === "active"
              ? "Active"
              : "Not active";

  const manageBillingHref =
    isBillingProviderConfigured()
      ? "https://my.paddle.com"
      : "#";

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
                {planDisplayName}
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground">
              {statusLabel}
            </div>
          </div>

          <div className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Provider</span>
              <span className="text-foreground font-medium">
                {state.provider === "paddle" ? "Paddle" : state.provider}
              </span>
            </div>

            {state.providerCustomerId && (
              <div className="flex justify-between text-muted-foreground">
                <span>Customer ID</span>
                <span className="text-foreground font-mono text-xs">
                  {state.providerCustomerId}
                </span>
              </div>
            )}

            {state.providerSubscriptionId && (
              <div className="flex justify-between text-muted-foreground">
                <span>Subscription ID</span>
                <span className="text-foreground font-mono text-xs">
                  {state.providerSubscriptionId}
                </span>
              </div>
            )}

            {state.status === "active" && state.currentPeriodEnd && (
              <div className="flex justify-between text-muted-foreground">
                <span>Next billing date</span>
                <span className="text-foreground">
                  {new Date(state.currentPeriodEnd).toLocaleDateString(
                    undefined,
                    {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    },
                  )}
                </span>
              </div>
            )}
          </div>

          {isBillingProviderConfigured() && (
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                asChild
                className="shadow-none"
                size="sm"
              >
                <a
                  href={manageBillingHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage billing
                </a>
              </Button>

              <Button variant="outline" size="sm" asChild>
                <a href="/dashboard/settings">
                  Back to settings
                </a>
              </Button>
            </div>
          )}

          {!isBillingProviderConfigured() && (
            <div className="mt-6 rounded-lg border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
              Billing is not yet configured for this environment.
            </div>
          )}
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
