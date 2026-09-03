/**
 * Pricing success page — shown after Stripe redirects back following
 * successful payment. The webhook will have already activated the
 * subscription by the time the user sees this page.
 *
 * This page is PUBLIC — it renders for both authenticated and unauthenticated
 * users. The dashboard auto-redirect and "Go to Dashboard" button only appear
 * when an active Supabase session exists.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { CheckCircle } from "lucide-react";
import logo from "@/assets/logo.svg";

export default function PricingSuccess() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const [countdown, setCountdown] = useState(5);

  // Only auto-redirect to dashboard when authenticated
  useEffect(() => {
    if (isLoading || !isAuthenticated) return;

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
          {isAuthenticated && (
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
