// ---------------------------------------------------------------------------
// Claims Manager — the claim book: intake, reconstruction, completeness,
// attention. Reuses insurance claim RPCs + work-queue + candidates services.
// ---------------------------------------------------------------------------

import { AlertTriangle, Radar, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttentionList } from "@/components/workforce/attention-list";
import { ClaimsTable } from "@/components/workforce/claims-table";
import {
  WorkerEmpty,
  WorkerLoading,
  WorkerPage,
  WorkerSection,
  ViewAllLink,
} from "@/components/workforce/worker-page";
import { WORKERS_BY_SLUG } from "@/lib/workforce/worker-defs";
import { useWorkerData } from "@/lib/workforce/use-worker-data";
import { useNavigate } from "react-router";

const WORKER = WORKERS_BY_SLUG["claims"]!;

export default function ClaimsManager() {
  const navigate = useNavigate();
  const data = useWorkerData();

  if (data.loading) return <WorkerLoading />;

  const attention = data.forWorker(WORKER);
  const pendingCandidates = data.candidates.filter((c) => String(c.status ?? "pending") === "pending");
  const govPending = data.pendingGovernanceFor(WORKER);

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Claims on file", value: data.claims.length, tone: "default" },
        { label: "Needs attention", value: attention.length, tone: attention.length > 0 ? "warning" : "positive" },
        { label: "New candidates", value: pendingCandidates.length, tone: pendingCandidates.length > 0 ? "accent" : "default" },
        { label: "Governance pending", value: govPending.length, tone: govPending.length > 0 ? "danger" : "positive" },
      ]}
    >
      {/* New claims awaiting approval */}
      <WorkerSection
        title="New claims from ingested evidence"
        icon={Sparkles}
        count={pendingCandidates.length}
        action={<ViewAllLink to="/dashboard/revenue-recovery" label="Full claim book" />}
      >
        {pendingCandidates.length === 0 ? (
          <WorkerEmpty
            title="No pending claim candidates"
            description="Atlas reconstructs claims from ingested documents. When it finds high-confidence evidence it will propose a new claim here for your approval."
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {pendingCandidates.slice(0, 6).map((c) => (
              <div key={String(c._id ?? "")} className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300">
                  <Sparkles className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {String(c.customer ?? c.property ?? `Claim ${c.claimNumber ?? ""}`)}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{String(c.basis ?? "")}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[9px] text-amber-600 dark:text-amber-300">
                      {Math.round(Number(c.confidence ?? 0) * 100)}% confidence
                    </Badge>
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                    >
                      <a href="/dashboard/revenue-recovery">Review</a>
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </WorkerSection>

      {/* Attention */}
      <WorkerSection title="Needs attention" icon={AlertTriangle} count={attention.length}>
        <AttentionList
          items={attention}
          emptyTitle="No claims need attention"
          emptyDescription="No missing evidence, stalled claims, or review items in the claims book right now."
          pageSize={8}
        />
      </WorkerSection>

      {/* The claim book */}
      <WorkerSection
        title="Claims on file"
        icon={Radar}
        count={data.claimView.length}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/revenue-recovery">Open Revenue Recovery</a>
          </Button>
        }
      >
        <ClaimsTable rows={data.claimView} />
      </WorkerSection>

      {/* Governance in context */}
      {govPending.length > 0 && (
        <WorkerSection title="Governance decisions for this worker" count={govPending.length}>
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {govPending.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => navigate("/dashboard/governance")}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                >
                  <Badge variant="outline" className="shrink-0 font-mono text-[9px] uppercase tracking-wide border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300">
                    {row.decision.replace(/_/g, " ")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {row.action_type.replace(/_/g, " ")} — {row.claim_id ?? "no claim"}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">Review →</span>
                </button>
              ))}
            </div>
          </div>
        </WorkerSection>
      )}
    </WorkerPage>
  );
}