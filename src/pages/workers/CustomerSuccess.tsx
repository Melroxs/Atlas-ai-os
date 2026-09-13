// ---------------------------------------------------------------------------
// Customer Success Manager — the customer experience across every claim:
// who needs an update, what's overdue, drafted communications awaiting human
// approval. Drafting goes through the orchestrator's governance gate; no
// send path exists — every communication is a DRAFT for human review.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Handshake, MessageSquareText, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AttentionList } from "@/components/workforce/attention-list";
import { ClaimsTable } from "@/components/workforce/claims-table";
import {
  WorkerEmpty,
  WorkerLoading,
  WorkerPage,
  WorkerSection,
} from "@/components/workforce/worker-page";
import { WORKERS_BY_SLUG } from "@/lib/workforce/worker-defs";
import { useWorkerData } from "@/lib/workforce/use-worker-data";
import { useAtlasWorkforce } from "@/hooks/use-atlas-workforce";
import { useNavigate } from "react-router";

const WORKER = WORKERS_BY_SLUG["customers"]!;

export default function CustomerSuccess() {
  const navigate = useNavigate();
  const data = useWorkerData();
  const { draftCommunication, running } = useAtlasWorkforce();
  const [draftingClaim, setDraftingClaim] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<{ claimId: string; subject: string; body: string; governance: string } | null>(null);

  if (data.loading) return <WorkerLoading />;

  const attention = data.forWorker(WORKER);
  const govPending = data.pendingGovernanceFor(WORKER);
  const customers = Array.from(
    new Map(
      data.claims.map((c) => [String(c.customer ?? c.property ?? c.claimNumber ?? c._id), c]),
    ).values(),
  );

  const handleDraft = async (claimId: string) => {
    setDraftingClaim(claimId);
    const result = await draftCommunication(claimId, "customer_status_update");
    setDraftingClaim(null);
    if (!result) return;
    const comm = result.communicationsGenerated?.[0];
    if (!comm) return;
    setDraftResult({
      claimId,
      subject: comm.subject,
      body: comm.body,
      governance: `${result.governance?.decision ?? "REVIEW_REQUIRED"} · ${result.governance?.reason ?? "Awaiting human review"}`,
    });
  };

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Customers on file", value: customers.length, tone: "default" },
        { label: "Updates needed", value: attention.length, tone: attention.length > 0 ? "warning" : "positive" },
        { label: "Drafts awaiting approval", value: govPending.length, tone: govPending.length > 0 ? "warning" : "positive" },
      ]}
    >
      {/* Attention — customers needing communication */}
      <WorkerSection title="Customers needing attention" icon={Handshake} count={attention.length}>
        <AttentionList
          items={attention}
          emptyTitle="No customers need an update"
          emptyDescription="No overdue follow-ups or customer-impacting milestones right now."
          pageSize={8}
        />
      </WorkerSection>

      {/* Draft a status update */}
      <WorkerSection title="Draft customer status updates" icon={MessageSquareText} count={customers.length}>
        {customers.length === 0 ? (
          <WorkerEmpty
            title="No customers yet"
            description="When claims exist, Atlas can draft a customer status update for human review before anything is sent."
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {customers.slice(0, 8).map((c) => {
              const claimId = String(c._id ?? "");
              return (
                <div key={claimId} className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {c.customer ?? c.property ?? c.claimNumber ?? "Customer"}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {c.claimNumber ?? claimId.slice(0, 8)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    disabled={running || draftingClaim === claimId}
                    onClick={() => void handleDraft(claimId)}
                  >
                    <Send className="size-3" />
                    {draftingClaim === claimId ? "Drafting…" : "Draft update"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </WorkerSection>

      {/* Governance pending for communications */}
      <WorkerSection title="Communications in governance review" icon={ShieldCheck} count={govPending.length}>
        {govPending.length === 0 ? (
          <WorkerEmpty
            title="No drafts in review"
            description="Drafted communications pass through the governance gate. None are waiting for approval right now."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {govPending.slice(0, 6).map((row) => (
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
                    {row.action_type.replace(/_/g, " ")} — claim {row.claim_id ?? "—"}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">Review →</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* Claims */}
      <WorkerSection title="Customer claims" count={data.claimView.length}>
        <ClaimsTable rows={data.claimView} pageSize={8} />
      </WorkerSection>

      {/* Draft result dialog */}
      <Dialog open={!!draftResult} onOpenChange={(o) => !o && setDraftResult(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {draftResult && (
            <>
              <DialogHeader>
                <DialogTitle>Drafted — awaiting human approval</DialogTitle>
                <DialogDescription className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-amber-600 dark:text-amber-300" />
                  Governance: {draftResult.governance}
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subject</p>
                <p className="mt-1 text-sm font-medium text-foreground">{draftResult.subject}</p>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Draft body</p>
                <pre className="atlas-scroll mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-5 text-foreground">
                  {draftResult.body}
                </pre>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                Atlas does not send communications. This draft requires human approval before anything leaves the company.
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </WorkerPage>
  );
}