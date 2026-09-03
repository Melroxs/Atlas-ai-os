import { AtlasAssistant } from "@/components/atlas-assistant";
import { useVoiceSession } from "@/components/voice-session";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { canAccessPilotAdmin, canAccessCRM, canAccessMail, canAccessUserAdmin, isInternalRole } from "@/lib/auth/access-gate";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/atlas-ui";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useAction, useMutation, useQuery } from "@/hooks/use-supabase";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Brain,
  Briefcase,
  Building2,
  Cable,
  Calendar,
  ClipboardCheck,
  Database,
  FileSearch,
  Handshake,
  Landmark,
  LayoutGrid,
  Layers,
  Lightbulb,
  LogOut,
  Mail,
  MessageSquareText,
  Radar,
  Scale,
  ScrollText,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Workflow,
  Zap,
  FileText,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Navigate, useLocation, useNavigate } from "react-router";

/**
 * Global ambient voice indicator — a small pill in the bottom-left corner
 * that shows the current voice session state. Visible even when the
 * floating assistant panel is closed.
 */
function GlobalVoiceIndicator() {
  const session = useVoiceSession();
  const isActive =
    session.ambientEnabled &&
    session.status !== "idle" &&
    session.status !== "unavailable" &&
    session.status !== "permission_required";

  if (!isActive) return null;

  const dotColor = (() => {
    switch (session.status) {
      case "listening_for_wake_word":
        return "bg-emerald-400";
      case "wake_detected":
        return "bg-amber-400 animate-pulse";
      case "listening_for_command":
        return "bg-rose-400 animate-pulse";
      case "thinking":
        return "bg-amber-400 animate-pulse";
      case "speaking":
        return "bg-teal-400 animate-pulse";
      case "interrupted":
        return "bg-slate-400";
      case "paused":
        return "bg-slate-400";
      case "error":
        return "bg-rose-500";
      default:
        return "bg-emerald-400";
    }
  })();

  const label = (() => {
    switch (session.status) {
      case "listening_for_wake_word":
        return "Listening";
      case "wake_detected":
        return "Yes?";
      case "listening_for_command":
        return "Listening…";
      case "thinking":
        return "Thinking…";
      case "speaking":
        return "Speaking…";
      case "interrupted":
        return "Stopped";
      case "paused":
        return "Paused";
      case "error":
        return "Error";
      default:
        return "Active";
    }
  })();

  return (
    <div className="fixed bottom-5 left-5 z-40">
      <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1.5 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm">
        <span className={`size-1.5 rounded-full ${dotColor}`} />
        <span className="text-foreground">Atlas</span>
        <span className="text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

const NAV_SECTIONS: Array<{
  label: string;
  items: Array<{
    to: string;
    label: string;
    icon: LucideIcon;
    badge?: "open";
  }>;
}> = [
  {
    label: "Command",
    items: [{ to: "/dashboard", label: "Command Center", icon: LayoutGrid }],
  },
  {
    label: "Workforce",
    items: [
      { to: "/dashboard/workers", label: "Workers", icon: Sparkles },
      { to: "/dashboard/workers/claims", label: "Claims Manager", icon: Radar },
      { to: "/dashboard/workers/supplements", label: "Supplement Specialist", icon: FileSearch },
      { to: "/dashboard/workers/recovery", label: "Revenue Recovery", icon: TrendingUp },
      { to: "/dashboard/workers/projects", label: "Project Manager", icon: ClipboardCheck },
      { to: "/dashboard/workers/estimator", label: "Estimator", icon: Scale },
      { to: "/dashboard/workers/customers", label: "Customer Success", icon: Handshake },
    ],
  },
  {
    label: "Work",
    items: [
      { to: "/dashboard/work-queue", label: "Work Queue", icon: Briefcase },
      { to: "/dashboard/governance", label: "Governance", icon: ShieldCheck },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { to: "/dashboard/ask", label: "Ask Atlas", icon: MessageSquareText },
      { to: "/dashboard/knowledge", label: "Knowledge & Ingestion", icon: Database },
      { to: "/dashboard/intelligence", label: "Intelligence Packs", icon: Layers },
      { to: "/dashboard/brain", label: "Business Brain", icon: Brain },
      {
        to: "/dashboard/recommendations",
        label: "Recommendations",
        icon: Target,
        badge: "open",
      },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/dashboard/workflows", label: "Workflows", icon: Workflow },
      { to: "/dashboard/events", label: "Events", icon: Activity },
      { to: "/dashboard/actions", label: "Actions & Tools", icon: Zap },
      { to: "/dashboard/audit", label: "Activity / Audit", icon: ScrollText },
      { to: "/dashboard/connections", label: "Connections", icon: Cable },
      { to: "/dashboard/team", label: "Team", icon: Users },
      { to: "/dashboard/settings", label: "Settings", icon: Settings2 },
    ],
  },
  {
    label: "Admin",
    items: [{ to: "/dashboard/users", label: "Users & Access", icon: Users }],
  },
  {
    label: "Mail",
    items: [{ to: "/dashboard/mail", label: "Atlas Mail", icon: Mail }],
  },
  {
    label: "Pilot",
    items: [
      { to: "/dashboard/pilot", label: "Pilot Home", icon: Radar },
      { to: "/dashboard/pilot/applications", label: "Applications", icon: FileText },
      { to: "/dashboard/pilot/crm", label: "CRM", icon: Users },
      { to: "/dashboard/pilot/outreach", label: "Outreach", icon: Send },
    ],
  },
  {
    label: "Pilot Intelligence",
    items: [
      { to: "/dashboard/pilot-intelligence", label: "Intelligence", icon: Radar },
      { to: "/dashboard/pilot-intelligence/companies", label: "Companies", icon: Building2 },
      { to: "/dashboard/pilot-intelligence/sessions", label: "Sessions", icon: Calendar },
      { to: "/dashboard/pilot-intelligence/insights", label: "Insights", icon: Lightbulb },
      { to: "/dashboard/pilot-intelligence/outcomes", label: "Outcomes", icon: Target },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Command Center",
  "/dashboard/workers": "Workers",
  "/dashboard/workers/claims": "Claims Manager",
  "/dashboard/workers/supplements": "Supplement Specialist",
  "/dashboard/workers/recovery": "Revenue Recovery Coordinator",
  "/dashboard/workers/projects": "Project Manager",
  "/dashboard/workers/estimator": "Estimator",
  "/dashboard/workers/customers": "Customer Success Manager",
  "/dashboard/governance": "Governance",
  "/dashboard/ask": "Ask Atlas",
  "/dashboard/knowledge": "Knowledge & Ingestion",
  "/dashboard/intelligence": "Intelligence Packs",
  "/dashboard/brain": "Business Brain",
  "/dashboard/recommendations": "Recommendation Center",
  "/dashboard/connections": "Connections",
  "/dashboard/actions": "Actions & Tools",
  "/dashboard/events": "Events",
  "/dashboard/work-queue": "Work Queue",
  "/dashboard/workflows": "Workflows",
  "/dashboard/revenue-recovery": "Revenue Recovery",
  "/dashboard/revenue-recovery/:id": "Claim Package",
  "/dashboard/team": "Team",
  "/dashboard/audit": "Activity / Audit",
  "/dashboard/settings": "Workspace Settings",
  "/dashboard/pilot-intelligence": "Pilot Intelligence",
  "/dashboard/pilot-intelligence/companies": "Pilot Companies",
  "/dashboard/pilot-intelligence/sessions": "Pilot Sessions",
  "/dashboard/pilot-intelligence/insights": "Pilot Insights",
  "/dashboard/pilot-intelligence/outcomes": "Pilot Outcomes",
  "/dashboard/mail": "Atlas Mail",
  "/dashboard/mail/settings": "Mail Settings",
  "/dashboard/pilot": "Pilot Home",
  "/dashboard/pilot/applications": "Pilot Applications",
  "/dashboard/pilot/crm": "CRM",
  "/dashboard/pilot/outreach": "Outreach Center",
  "/dashboard/users": "Users & Access",
};

function initials(name?: string | null, email?: string | null): string {
  const src = name ?? email ?? "?";
  return (
    src
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const workspace = useQuery(api.tenants.getMyWorkspace);
  // recommendationCounts calls requireTenant server-side, which throws for
  // signed-in users who don't have a workspace yet (fresh sign-in before
  // /setup completes). Subscribe only once a workspace actually exists; the
  // loading/null early returns below would otherwise still run this query.
  const recCounts = useQuery(
    api.recommendations.recommendationCounts,
    workspace ? undefined : "skip",
  );
  const seedIntelligence = useMutation(api.intelligence.seedIntelligence);
  const claimInvites = useMutation(api.tenants.claimInvites);
  const runDueSyncs = useAction(api.connectionsSync.runDueSyncs);

  // Track whether we just claimed invites so invited users aren't redirected
  // to /setup before their workspace data loads.
  const [justClaimedInvites, setJustClaimedInvites] = useState(false);
  const hasClaimed = useRef(false);

  // Idempotent: ensure the pack catalog exists, claim any invites, and let
  // background syncs pick up connected sources that are due for a refresh.
  // Connections sync is optional infrastructure — a failure (edge function
  // not deployed, CORS, timeout) is logged once for diagnostics and NEVER
  // blocks the app.
  useEffect(() => {
    void seedIntelligence();
    void claimInvites().then((result) => {
      const claimed = (result as { claimed?: number })?.claimed ?? 0;
      if (claimed > 0 && !hasClaimed.current) {
        hasClaimed.current = true;
        setJustClaimedInvites(true);
        // Clear the flag after a short delay to allow workspace data to reload
        setTimeout(() => setJustClaimedInvites(false), 3000);
      }
    });
    void runDueSyncs().catch((e) => {
      console.warn(
        "[atlas] background connections sync unavailable (non-blocking):",
        e instanceof Error ? e.message : String(e),
      );
    });
  }, [seedIntelligence, claimInvites, runDueSyncs]);

  if (workspace === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Radar className="size-5 animate-pulse text-teal-600 dark:text-teal-300" />
          <span className="text-sm">Loading workspace…</span>
        </div>
      </main>
    );
  }

  // For invited users who just claimed their invite, allow a brief grace
  // period before enforcing the onboarding check (workspace data may not
  // have reloaded yet).
  if (!justClaimedInvites) {
    if (
      workspace === null ||
      workspace.profile === null ||
      workspace.profile.onboardingComplete !== true
    ) {
      return <Navigate to="/setup" replace />;
    }
  }

  const openRecs = recCounts?.open ?? 0;
  const companyName =
    (workspace?.profile?.companyName) || workspace?.tenant?.name || "Workspace";
  const memberRole = workspace?.membership?.role;

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" className="border-sidebar-border">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                asChild
                className="group/data-[slot=sidebar-menu-button]:h-12"
              >
                <NavLink to="/dashboard">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-400/15 text-teal-600 ring-1 ring-teal-400/30 dark:text-teal-300">
                    <Radar className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-semibold">{companyName}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {memberRole ? `${memberRole} · Atlas workspace` : "Atlas workspace"}
                    </span>
                  </div>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {NAV_SECTIONS.filter((section) => {
            // Filter nav sections by role
            if (section.label === "Admin") return canAccessUserAdmin(role);
            if (section.label === "Mail") return canAccessMail(role);
            if (section.label === "Pilot") return canAccessPilotAdmin(role);
            if (section.label === "Pilot Intelligence") return canAccessPilotAdmin(role);
            if (section.label === "CRM") return canAccessCRM(role);
            // Operations, Intelligence, Atlas, Workspace are visible to all authenticated users
            return true;
          }).map((section) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={
                          item.to === "/dashboard" || item.to === "/dashboard/workers"
                            ? location.pathname === item.to
                            : location.pathname.startsWith(item.to)
                        }
                        tooltip={item.label}
                      >
                        <NavLink to={item.to}>
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {item.badge === "open" && openRecs > 0 && (
                        <SidebarMenuBadge className="font-mono text-[11px]">
                          {openRecs}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter>
          <SidebarSeparator className="mx-2" />
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <Avatar className="size-8 rounded-lg">
                      {user?.image && <AvatarImage src={user.image} alt="" />}
                      <AvatarFallback className="rounded-lg bg-teal-400/15 text-xs text-teal-600 dark:text-teal-300">
                        {initials(user?.name, user?.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-medium">
                        {user?.name ?? "Atlas user"}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {user?.email ?? ""}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  sideOffset={8}
                  className="w-56 rounded-xl"
                >
                  <DropdownMenuLabel className="font-normal">
                    <p className="text-sm font-medium">{user?.name ?? "Atlas user"}</p>
                    <p className="text-xs text-muted-foreground">{user?.email ?? ""}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/")} className="cursor-pointer">
                    <Landmark className="mr-2 size-4" />
                    Landing page
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleSignOut}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {PAGE_TITLES[location.pathname] ?? "Atlas"}
            </span>
            {openRecs > 0 && (
              <Badge
                variant="outline"
                className="hidden gap-1 border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-600 dark:text-amber-300 sm:inline-flex"
              >
                <Sparkles className="size-3" />
                {openRecs} open signal{openRecs === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Button
              size="sm"
              className="hidden gap-2 md:inline-flex"
              onClick={() => navigate("/dashboard/ask")}
            >
              <MessageSquareText className="size-3.5" />
              Ask Atlas
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 md:inline-flex"
              onClick={() => navigate("/dashboard/knowledge")}
            >
              <Database className="size-3.5 text-teal-600 dark:text-teal-300" />
              Upload
            </Button>
          </div>
        </header>
        <main className="atlas-scroll flex-1 overflow-y-auto">
          <div className={cn("mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8")}>
            {children}
          </div>
        </main>
      </SidebarInset>

      {/* Global ambient voice indicator — visible when ambient listening is
          active, even when the floating panel is closed. */}
      <GlobalVoiceIndicator />

      {/* Phase 10 — persistent Atlas assistant, available across the app. */}
      <AtlasAssistant pageContext={location.pathname} />
    </SidebarProvider>
  );
}
