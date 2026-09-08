import { useAuth } from "@/hooks/use-auth";
import {
  canAccessPilotAdmin,
  canAccessCRM,
  canAccessMail,
  canAccessUserAdmin,
  canAccessSuperAdmin,
  type AtlasRole,
} from "@/lib/auth/access-gate";
import { Loader2, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";

/**
 * Which internal section this guard protects.
 * Each section has specific role requirements.
 */
type InternalSection = "pilot" | "crm" | "mail" | "users" | "superadmin";

const SECTION_LABELS: Record<InternalSection, string> = {
  pilot: "Pilot Operations",
  crm: "CRM",
  mail: "Atlas Mail",
  users: "Users & Access",
  superadmin: "Super Admin Organization Administration",
};

function hasSectionAccess(role: AtlasRole, section: InternalSection): boolean {
  switch (section) {
    case "pilot":
      return canAccessPilotAdmin(role);
    case "crm":
      return canAccessCRM(role);
    case "mail":
      return canAccessMail(role);
    case "users":
      return canAccessUserAdmin(role);
    case "superadmin":
      return canAccessSuperAdmin(role);
    default:
      return false;
  }
}

/**
 * Route guard for internal Atlas sections (Pilot, CRM, Mail, Users).
 *
 * Unlike RequireAuth (which gates on authentication + account status),
 * RequireInternalAuth additionally gates on the user's platform_role.
 * Customer-level users who manually navigate to /dashboard/pilot/crm will
 * see a clear "Insufficient Permissions" page instead of internal data.
 */
export function RequireInternalAuth({
  section,
  children,
}: {
  section: InternalSection;
  children: ReactNode;
}) {
  const { isLoading, isAuthenticated, user, role } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (!hasSectionAccess(role, section)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-6">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <ShieldAlert className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Insufficient Permissions
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              You do not have permission to access {SECTION_LABELS[section]}.
              This section requires an internal administrator role.
            </p>
          </div>
          <div className="flex flex-col gap-3 items-center">
            <Link
              to="/dashboard"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
