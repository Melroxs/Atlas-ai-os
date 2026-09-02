import { useAuth } from "@/hooks/use-auth";
import { evaluateAtlasAccess } from "@/lib/auth/access-gate";
import { Loader2, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * Wraps children and only renders them when the user is:
 *   1. Authenticated (has a valid session)
 *   2. Authorized by the Atlas access gate (super_admin or active account)
 *
 * Authorization is independent of authentication — there is deliberately NO
 * provider-based bypass. A missing profile fails closed.
 */
export function RequireAccess({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    // This should normally be caught by RequireAuth first.
    // If we reach here, the user is not signed in at all.
    return (
      <AccessDenied
        message="You need to sign in to access Atlas."
        ctaText="Sign In"
        ctaHref="/auth"
      />
    );
  }

  const decision = evaluateAtlasAccess(user);

  if (decision.allowed) {
    return <>{children}</>;
  }

  // Suspended/revoked users
  if (decision.reason === "suspended" || decision.reason === "revoked") {
    return (
      <AccessDenied
        message="Your Atlas access has been suspended. Please contact support for assistance."
        ctaText="Contact Support"
        ctaHref="/"
      />
    );
  }

  // Pending / missing-profile / unknown users — access denied with
  // pricing CTA. No internal authorization details are revealed.
  return (
    <AccessDenied
      message="You need an active subscription to access Atlas. Choose a plan to get started."
      ctaText="View Plans"
      ctaHref="/pricing"
      showSignOut
    />
  );
}

function AccessDenied({
  message,
  ctaText,
  ctaHref,
  showSignOut,
}: {
  message: string;
  ctaText: string;
  ctaHref: string;
  showSignOut?: boolean;
}) {
  const { signOut } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center space-y-6">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Access Not Approved
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {message}
          </p>
        </div>
        <div className="flex flex-col gap-3 items-center">
          <Link
            to={ctaHref}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {ctaText}
          </Link>
          {showSignOut && (
            <button
              type="button"
              onClick={() => signOut()}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
