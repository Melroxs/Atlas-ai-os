import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import logo from "@/assets/logo.svg";
import { ThemeToggle } from "@/components/atlas-ui";
import {
  allPricingPlans,
  checkoutReturnTo,
  type PricingPlanData,
} from "@/lib/billing/checkout";
import { resolvePlanEntitlements } from "@/lib/billing/plans";
import type { InternalPlan } from "@/lib/billing/types";

/**
 * Display-only marketing lines. Limits, storage, AI tier and feature flags are
 * derived from the canonical plan entitlement contract (src/lib/billing/plans)
 * so the page can never advertise a limit the product does not enforce.
 */
const MARKETING_LINES: Partial<Record<InternalPlan, string[]>> = {
  ATLAS_SCALE: ["Custom integrations", "Custom deployment"],
};

const AI_TIER_LABEL: Record<string, string> = {
  basic: "Basic AI intelligence",
  advanced: "Advanced AI intelligence",
  enterprise: "Enterprise AI intelligence",
};

function planFeatures(plan: InternalPlan): string[] {
  const entitlements = resolvePlanEntitlements(plan);
  if (!entitlements) return [];
  const features: string[] = [
    entitlements.maxSeats === null
      ? "Unlimited team members"
      : `Up to ${entitlements.maxSeats} team members`,
    entitlements.maxStorageGb === null
      ? "Unlimited document storage"
      : `${entitlements.maxStorageGb} GB document storage`,
    AI_TIER_LABEL[entitlements.aiTier] ?? "AI intelligence",
    entitlements.prioritySupport ? "Priority support" : "Email support",
    entitlements.multipleOrganizations ? "Multiple organizations" : "Single organization",
  ];
  if (entitlements.customWorkflows) features.push("Custom workflows");
  if (entitlements.apiAccess) features.push("API access");
  if (entitlements.sso) features.push("SSO & advanced security");
  if (entitlements.sla) features.push("SLA guarantee");
  features.push(...(MARKETING_LINES[plan] ?? []));
  return features;
}

const POPULAR_PLAN: InternalPlan = "ATLAS_GROWTH";

const FAQ = [
  {
    q: "Can I switch plans later?",
    a: "Yes. Use Manage Billing in Atlas to open the Stripe billing portal, where you can upgrade or downgrade your plan. The change is reflected in Atlas automatically once Stripe confirms it.",
  },
  {
    q: "Is there a free trial?",
    a: "No. Atlas has no free trial, no introductory period and no setup fee: you pay the plan price shown here when you subscribe, and it renews on your chosen billing interval until you cancel.",
  },
  {
    q: "What payment methods do you accept?",
    a: "Payments are processed securely by Stripe. All major credit and debit cards are supported, along with the local payment methods Stripe offers in your region.",
  },
  {
    q: "What happens when my subscription renews?",
    a: "Your card is charged the plan price on the billing interval you chose, and your subscription continues until you cancel. See the Refund Policy for details.",
  },
  {
    q: "How do I cancel or update my card?",
    a: "Open the Stripe billing portal from Manage Billing in your Atlas billing settings — cancellation, payment method updates and invoices are handled there.",
  },
];

export default function Pricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");

  // A cancelled Stripe checkout returns here with ?checkout=cancelled.
  const checkoutCancelled = searchParams.get("checkout") === "cancelled";

  const plans = allPricingPlans(billing);

  const handleGetStarted = (plan: PricingPlanData) => {
    // Carry plan + interval through auth so checkout resumes after sign-up.
    const params = new URLSearchParams({
      mode: "signup",
      plan: plan.slug,
      interval: billing,
      returnTo: checkoutReturnTo({ plan: plan.slug, interval: billing }),
    });
    navigate(`/auth?${params.toString()}`);
  };

  const intervalLabel = (plan: PricingPlanData) =>
    billing === "monthly"
      ? `$${plan.intervalPrice}/month`
      : `$${plan.intervalPrice}/year`;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
          <a href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
            <img src={logo} alt="Atlas logo" width={36} height={36} className="size-9 rounded-lg" />
            <span className="text-lg font-semibold tracking-tight text-foreground">Atlas</span>
          </a>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Button variant="ghost" onClick={() => navigate("/auth")}>
              Sign In
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-6xl px-5 py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-teal-400/30 bg-teal-400/10 px-4 py-1.5 text-xs font-medium text-teal-700 dark:text-teal-300 mb-6">
            <Sparkles className="size-3.5" />
            Simple, transparent pricing
          </div>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Choose your plan
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
            Start with a plan that fits your team. No trial, no setup fee — you pay
            the plan price shown here and can cancel whenever you like.
          </p>

          {checkoutCancelled && (
            <div className="mx-auto mt-6 max-w-xl rounded-lg border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              Checkout was cancelled — nothing was charged. You can pick a plan again
              whenever you're ready.
            </div>
          )}

          {/* Billing Toggle */}
          <div className="mt-8 inline-flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                billing === "monthly"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                billing === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Annual
              <span className="ml-1.5 text-xs text-emerald-600 dark:text-emerald-400">Save 17%</span>
            </button>
          </div>
        </div>

        {/* Plans Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {plans.map((plan) => {
            const popular = plan.internalPlan === POPULAR_PLAN;
            return (
              <div
                key={plan.slug}
                className={cn(
                  "relative rounded-2xl border bg-card/60 p-8 transition-all",
                  popular
                    ? "border-teal-400/50 shadow-lg shadow-teal-400/10"
                    : "border-border/70 hover:border-teal-400/30"
                )}
              >
                {popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-teal-400 px-4 py-1 text-xs font-semibold text-teal-950">
                    Most Popular
                  </div>
                )}
                {billing === "annual" && (
                  <div className="absolute -top-3 right-4 rounded-full border border-teal-400/40 bg-teal-400/10 px-3 py-1 text-[11px] font-medium text-teal-700 dark:text-teal-300">
                    2 months free
                  </div>
                )}

                <div className="mb-6">
                  <h3 className="text-xl font-semibold text-foreground">
                    {plan.displayName.replace("Atlas ", "")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                </div>

                <div className="mb-8">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-foreground">
                      ${billing === "monthly" ? plan.price : Math.round(plan.intervalPrice / 12)}
                    </span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                  </div>
                  {billing === "annual" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Billed ${plan.intervalPrice} annually
                    </p>
                  )}
                </div>

                <ul className="mb-8 space-y-3">
                  {planFeatures(plan.internalPlan).map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-3 text-sm text-muted-foreground"
                    >
                      <Check className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <p className="mb-3 text-center text-xs text-muted-foreground">
                  Billed {intervalLabel(plan)}. Cancel anytime from your Atlas billing
                  settings.
                </p>

                <Button
                  onClick={() => handleGetStarted(plan)}
                  className={cn("w-full", popular ? "bg-teal-400 text-teal-950 hover:bg-teal-300" : "")}
                  variant={popular ? "default" : "outline"}
                >
                  Get Started
                </Button>
              </div>
            );
          })}
        </div>

        {/* Subscription agreement note */}
        <p className="mt-10 text-center text-xs text-muted-foreground">
          By subscribing, you agree to the{" "}
          <a href="/terms" className="underline underline-offset-2 transition-colors hover:text-teal-700 dark:hover:text-teal-200">
            Atlas Terms of Service
          </a>{" "}
          and acknowledge the{" "}
          <a href="/privacy" className="underline underline-offset-2 transition-colors hover:text-teal-700 dark:hover:text-teal-200">
            Privacy Policy
          </a>{" "}
          and{" "}
          <a href="/refunds" className="underline underline-offset-2 transition-colors hover:text-teal-700 dark:hover:text-teal-200">
            Refund Policy
          </a>
          .
        </p>

        {/* FAQ */}
        <div className="mt-20 max-w-3xl mx-auto">
          <h2 className="text-2xl font-semibold text-center mb-8">Frequently asked questions</h2>
          <div className="space-y-6">
            {FAQ.map((faq) => (
              <div key={faq.q} className="rounded-xl border border-border/60 bg-card/40 p-6">
                <h3 className="font-semibold text-foreground">{faq.q}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
