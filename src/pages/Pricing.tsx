import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import logo from "@/assets/logo.svg";
import { ThemeToggle } from "@/components/atlas-ui";

const PLANS = [
  {
    name: "Starter",
    description: "For small teams getting started with intelligence.",
    monthlyPrice: 49,
    annualPrice: 470, // ~$39/mo billed annually
    features: [
      "Up to 5 team members",
      "10 GB document storage",
      "Basic AI intelligence",
      "Email support",
      "Single organization",
    ],
    cta: "Get Started",
    popular: false,
  },
  {
    name: "Growth",
    description: "For growing teams that need full intelligence capabilities.",
    monthlyPrice: 149,
    annualPrice: 1430, // ~$119/mo billed annually
    features: [
      "Up to 25 team members",
      "100 GB document storage",
      "Advanced AI intelligence",
      "Priority support",
      "Multiple organizations",
      "Custom workflows",
      "API access",
    ],
    cta: "Get Started",
    popular: true,
  },
  {
    name: "Scale",
    description: "For large organizations with heavier claim volume and multi-team workflows.",
    monthlyPrice: 299,
    annualPrice: 2870, // ~$239/mo billed annually
    features: [
      "Unlimited team members",
      "Unlimited document storage",
      "Enterprise AI intelligence",
      "Dedicated support",
      "Custom integrations",
      "SSO & advanced security",
      "SLA guarantee",
      "Custom deployment",
    ],
    cta: "Get Started",
    popular: false,
  },
];

export default function Pricing() {
  const navigate = useNavigate();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");

  const handleGetStarted = (plan: typeof PLANS[0]) => {
    // Navigate to auth with plan info and explicit signup intent.
    // The returnTo carries the plan + billing so Checkout receives them
    // after Auth redirects back (URLSearchParams properly encodes the
    // nested query string as a single value).
    const checkoutReturnTo = `/checkout?plan=${encodeURIComponent(plan.name.toLowerCase())}&billing=${encodeURIComponent(billing)}`;
    const params = new URLSearchParams({
      mode: "signup",
      plan: plan.name.toLowerCase(),
      billing,
      returnTo: checkoutReturnTo,
    });
    navigate(`/auth?${params.toString()}`);
  };

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
            Start with a plan that fits your team. Every plan starts with a
            1-day trial for $10 — then your plan's regular price applies.
          </p>

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
              <span className="ml-1.5 text-xs text-emerald-600 dark:text-emerald-400">Save 20%</span>
            </button>
          </div>
        </div>

        {/* Plans Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative rounded-2xl border bg-card/60 p-8 transition-all",
                plan.popular
                  ? "border-teal-400/50 shadow-lg shadow-teal-400/10"
                  : "border-border/70 hover:border-teal-400/30"
              )}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-teal-400 px-4 py-1 text-xs font-semibold text-teal-950">
                  Most Popular
                </div>
              )}
              {plan.monthlyPrice !== null && (
                <div className="absolute -top-3 right-4 rounded-full border border-teal-400/40 bg-teal-400/10 px-3 py-1 text-[11px] font-medium text-teal-700 dark:text-teal-300">
                  $10 · 1-day trial
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-xl font-semibold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
              </div>

              <div className="mb-8">
                {plan.monthlyPrice !== null ? (
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-foreground">
                      ${billing === "monthly" ? plan.monthlyPrice : Math.round(plan.annualPrice! / 12)}
                    </span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                  </div>
                ) : (
                  <div className="text-4xl font-bold text-foreground">Custom</div>
                )}
                {billing === "annual" && plan.annualPrice !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Billed ${plan.annualPrice} annually
                  </p>
                )}
              </div>

              <ul className="mb-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
                    {feature}
                  </li>
                ))}
              </ul>

              {plan.monthlyPrice !== null && (
                <p className="mb-3 text-center text-xs text-muted-foreground">
                  Start your 1-day trial for $10. After the trial, you'll be
                  billed {billing === "monthly" ? `$${plan.monthlyPrice}/month` : `$${plan.annualPrice} annually`}.
                </p>
              )}

              <Button
                onClick={() => handleGetStarted(plan)}
                className={cn(
                  "w-full",
                  plan.popular
                    ? "bg-teal-400 text-teal-950 hover:bg-teal-300"
                    : ""
                )}
                variant={plan.popular ? "default" : "outline"}
              >
                {plan.cta}
              </Button>
            </div>
          ))}
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
            {            [
              {
                q: "Can I switch plans later?",
                a: "Yes, you can upgrade or downgrade your plan at any time through Paddle, and changes are reflected in your subscription automatically.",
              },
              {
                q: "Is there a free trial?",
                a: "No — every plan starts with a 1-day trial for $10. You're charged $10 at checkout, and the plan's regular price applies once the trial ends.",
              },
              {
                q: "What payment methods do you accept?",
                a: "Payments are processed securely by Paddle. All major credit cards are supported, along with other local payment methods Paddle offers in your region.",
              },
              {
                q: "What happens when my trial ends?",
                a: "Your card is charged the plan's regular price on the billing interval you chose, and your subscription continues until you cancel. See the Refund Policy for details.",
              },
            ].map((faq) => (
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
