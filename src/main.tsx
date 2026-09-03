import '@vly-ai/integrations';
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireInternalAuth } from "@/components/RequireInternalAuth";
import { AppShell } from "@/components/app-shell";
import { VoiceSessionProvider } from "@/components/voice-session";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const Pilot = lazy(() => import("./pages/Pilot.tsx"));
const Pricing = lazy(() => import("./pages/Pricing.tsx"));
const Checkout = lazy(() => import("./pages/Checkout.tsx"));
const PricingSuccess = lazy(() => import("./pages/PricingSuccess.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Setup = lazy(() => import("./pages/Setup.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Ask = lazy(() => import("./pages/Ask.tsx"));
const Knowledge = lazy(() => import("./pages/Knowledge.tsx"));
const KnowledgeDetail = lazy(() => import("./pages/KnowledgeDetail.tsx"));
const ArchiveDetail = lazy(() => import("./pages/ArchiveDetail.tsx"));
const Intelligence = lazy(() => import("./pages/Intelligence.tsx"));
const BusinessBrain = lazy(() => import("./pages/BusinessBrain.tsx"));
const Recommendations = lazy(() => import("./pages/Recommendations.tsx"));
const Connections = lazy(() => import("./pages/Connections.tsx"));
const Actions = lazy(() => import("./pages/Actions.tsx"));
const Events = lazy(() => import("./pages/Events.tsx"));
const WorkQueue = lazy(() => import("./pages/WorkQueue.tsx"));
const Workflows = lazy(() => import("./pages/Workflows.tsx"));
const WorkflowDetail = lazy(() => import("./pages/WorkflowDetail.tsx"));
const RevenueRecovery = lazy(() => import("./pages/RevenueRecovery.tsx"));
const ClaimDetail = lazy(() => import("./pages/ClaimDetail.tsx"));
const Team = lazy(() => import("./pages/Team.tsx"));
const Audit = lazy(() => import("./pages/Audit.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const PilotIntelligence = lazy(() => import("./pages/PilotIntelligence.tsx"));
const PilotCompanies = lazy(() => import("./pages/PilotCompanies.tsx"));
const PilotSessions = lazy(() => import("./pages/PilotSessions.tsx"));
const PilotInsights = lazy(() => import("./pages/PilotInsights.tsx"));
const PilotOutcomes = lazy(() => import("./pages/PilotOutcomes.tsx"));
const MailInbox = lazy(() => import("./pages/mail/MailInbox.tsx"));
const MailSettings = lazy(() => import("./pages/mail/MailSettings.tsx"));
const PilotApply = lazy(() => import("./pages/PilotApply.tsx"));
const AccessDenied = lazy(() => import("./pages/AccessDenied.tsx"));
const ResetPassword = lazy(() => import("./pages/ResetPassword.tsx"));
const PilotHub = lazy(() => import("./pages/pilot/PilotHub.tsx"));
const PilotApplications = lazy(() => import("./pages/pilot/PilotApplications.tsx"));
const PilotCRM = lazy(() => import("./pages/pilot/PilotCRM.tsx"));
const PilotOutreach = lazy(() => import("./pages/pilot/PilotOutreach.tsx"));
const UsersAccess = lazy(() => import("./pages/UsersAccess.tsx"));
const WorkersHub = lazy(() => import("./pages/workers/WorkersHub.tsx"));
const ClaimsManager = lazy(() => import("./pages/workers/ClaimsManager.tsx"));
const SupplementSpecialist = lazy(() => import("./pages/workers/SupplementSpecialist.tsx"));
const RevenueRecoveryCoordinator = lazy(() => import("./pages/workers/RevenueRecoveryCoordinator.tsx"));
const ProjectManager = lazy(() => import("./pages/workers/ProjectManager.tsx"));
const EstimatorWorker = lazy(() => import("./pages/workers/Estimator.tsx"));
const CustomerSuccess = lazy(() => import("./pages/workers/CustomerSuccess.tsx"));
const Governance = lazy(() => import("./pages/Governance.tsx"));

/** Protected section: auth gate + workspace shell.
 * VoiceSessionProvider is mounted OUTSIDE the router (see render tree) so the
 * voice session survives route navigation — the entire reason ambient listening
 * previously died after the first wake-word cycle.
 */
function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="atlas-theme">
        <VoiceSessionProvider>
        <BrowserRouter>
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/pilot" element={<Pilot />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/pricing-success" element={<PricingSuccess />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/dashboard" />}
              />
              <Route
                path="/setup"
                element={
                  <RequireAuth>
                    <Setup />
                  </RequireAuth>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ProtectedLayout>
                    <Dashboard />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers"
                element={
                  <ProtectedLayout>
                    <WorkersHub />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/claims"
                element={
                  <ProtectedLayout>
                    <ClaimsManager />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/supplements"
                element={
                  <ProtectedLayout>
                    <SupplementSpecialist />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/recovery"
                element={
                  <ProtectedLayout>
                    <RevenueRecoveryCoordinator />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/projects"
                element={
                  <ProtectedLayout>
                    <ProjectManager />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/estimator"
                element={
                  <ProtectedLayout>
                    <EstimatorWorker />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workers/customers"
                element={
                  <ProtectedLayout>
                    <CustomerSuccess />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/governance"
                element={
                  <ProtectedLayout>
                    <Governance />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/ask"
                element={
                  <ProtectedLayout>
                    <Ask />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/knowledge"
                element={
                  <ProtectedLayout>
                    <Knowledge />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/knowledge/archives/:id"
                element={
                  <ProtectedLayout>
                    <ArchiveDetail />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/knowledge/:id"
                element={
                  <ProtectedLayout>
                    <KnowledgeDetail />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/intelligence"
                element={
                  <ProtectedLayout>
                    <Intelligence />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/brain"
                element={
                  <ProtectedLayout>
                    <BusinessBrain />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/recommendations"
                element={
                  <ProtectedLayout>
                    <Recommendations />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/connections"
                element={
                  <ProtectedLayout>
                    <Connections />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/actions"
                element={
                  <ProtectedLayout>
                    <Actions />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/events"
                element={
                  <ProtectedLayout>
                    <Events />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workflows"
                element={
                  <ProtectedLayout>
                    <Workflows />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/workflows/:id"
                element={
                  <ProtectedLayout>
                    <WorkflowDetail />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/work-queue"
                element={
                  <ProtectedLayout>
                    <WorkQueue />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/revenue-recovery"
                element={
                  <ProtectedLayout>
                    <RevenueRecovery />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/revenue-recovery/:id"
                element={
                  <ProtectedLayout>
                    <ClaimDetail />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/team"
                element={
                  <ProtectedLayout>
                    <Team />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/audit"
                element={
                  <ProtectedLayout>
                    <Audit />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/settings"
                element={
                  <ProtectedLayout>
                    <Settings />
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot-intelligence"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotIntelligence />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot-intelligence/companies"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotCompanies />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot-intelligence/sessions"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotSessions />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot-intelligence/insights"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotInsights />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot-intelligence/outcomes"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotOutcomes />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotHub />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot/applications"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotApplications />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot/crm"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="crm">
                      <PilotCRM />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/pilot/outreach"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="pilot">
                      <PilotOutreach />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/mail"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="mail">
                      <MailInbox />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/mail/settings"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="mail">
                      <MailSettings />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/dashboard/users"
                element={
                  <ProtectedLayout>
                    <RequireInternalAuth section="users">
                      <UsersAccess />
                    </RequireInternalAuth>
                  </ProtectedLayout>
                }
              />
              <Route
                path="/pilot-apply"
                element={<PilotApply />}
              />
              <Route
                path="/access-denied"
                element={<AccessDenied />}
              />
              <Route
                path="/reset-password"
                element={<ResetPassword />}
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
        </VoiceSessionProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
