import { useAuth } from "@/hooks/use-auth";
import { ShieldAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router";

const DENIAL_MESSAGES: Record<string, { title: string; message: string; cta: string; href: string }> = {
  pending: {
    title: "Subscription Required",
    message:
      "Your Atlas account has been created, but you need an active subscription to access Atlas. Choose a plan to get started.",
    cta: "View Plans",
    href: "/pricing",
  },
  pending_checkout: {
    title: "Complete Your Subscription",
    message:
      "Your organization has been created. Complete your subscription to access Atlas.",
    cta: "Complete Checkout",
    href: "/checkout?plan=starter&billing=monthly",
  },
  payment_failed: {
    title: "Payment Issue",
    message:
      "Your subscription payment could not be processed. Please update your payment method to continue using Atlas.",
    cta: "Update Payment",
    href: "/pricing",
  },
  cancelled: {
    title: "Subscription Cancelled",
    message:
      "Your Atlas subscription has been cancelled. Resubscribe to regain access.",
    cta: "Resubscribe",
    href: "/pricing",
  },
  missing_profile: {
    title: "Account Not Provisioned",
    message:
      "Your Atlas account has been created, but access has not yet been provisioned. Please contact your Atlas administrator.",
    cta: "Contact Support",
    href: "/",
  },
  suspended: {
    title: "Account Suspended",
    message:
      "Your Atlas access has been suspended. Please contact support for assistance.",
    cta: "Contact Support",
    href: "/",
  },
  revoked: {
    title: "Access Revoked",
    message:
      "Your Atlas access has been revoked. Please contact support for assistance.",
    cta: "Contact Support",
    href: "/",
  },
  unknown_status: {
    title: "Access Not Approved",
    message:
      "Your account status could not be determined. Please contact your Atlas administrator.",
    cta: "Contact Support",
    href: "/",
  },
};

const DEFAULT_DENIED = {
  title: "Subscription Required",
  message:
    "Your account is authenticated, but you need an active subscription to access Atlas. Choose a plan to get started.",
  cta: "View Plans",
  href: "/pricing",
};

export default function AccessDenied() {
  const { signOut } = useAuth();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason") ?? "pending";
  const config = DENIAL_MESSAGES[reason] ?? DEFAULT_DENIED;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center space-y-6">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {config.title}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {config.message}
          </p>
        </div>
        <div className="flex flex-col gap-3 items-center">
          <Link
            to={config.href}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {config.cta}
          </Link>
          <button
            type="button"
            onClick={() => signOut()}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
