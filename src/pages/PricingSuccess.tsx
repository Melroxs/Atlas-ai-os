/**
 * Pricing success page — shown after Stripe redirects back following
 * successful payment. The webhook will have already activated the
 * subscription by the time the user sees this page.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { CheckCircle, Loader2 } from "lucide-react";
import logo from "@/assets/logo.svg";

export default function PricingSuccess() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      navigate("/auth");
      return;
    }

    // Auto-redirect to dashboard after countdown
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
  }, [isLoading, isAuthenticated, navigate]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-lg text-center space-y-6">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle className="h-8 w-8 text-emerald-500" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Welcome to Atlas!
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            Your subscription is active. Your account and organization have been set up
            and you're ready to start using Atlas.
          </p>
        </div>
        <div className="flex flex-col gap-3 items-center pt-2">
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
        </div>
        <div className="pt-8">
          <img src={logo} alt="Atlas" width={32} height={32} className="mx-auto rounded-lg opacity-50" />
        </div>
      </div>
    </main>
  );
}
