// ---------------------------------------------------------------------------
// Estimator / Estimating Specialist — scope review and line-item intelligence.
// Runs the REAL estimator engine (generateEstimateLineItems) over claims with
// estimate data. Output is review-ready for a human estimator — Atlas does
// NOT modify Xactimate (no integration exists) and this is stated in the UI.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { AlertTriangle, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { generateEstimateLineItems } from "@/lib/orchestrator/estimator";
import {
  WorkerEmpty,
  WorkerLoading,
  WorkerPage,
  WorkerSection,
} from "@/components/workforce/worker-page";
import { WORKERS_BY_SLUG } from "@/lib/workforce/worker-defs";
import { useWorkerData } from "@/lib/workforce/use-worker-data";
import { useNavigate } from "react-router";

const WORKER = WORKERS_BY_SLUG["estimator"]!;

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const STATUS_CLS: Record<string, string> = {
  supported: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  identified: "border-sky-400/30 bg-sky-400/10 text-sky-600 dark:text-sky-300",
  partially_supported: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  unsupported: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  disputed: "border-violet-400/30 bg-violet-400/10 text-violet-600 dark:text-violet-300",
};

export default function EstimatorWorker() {
  const navigate = useNavigate();
  const data = useWorkerData();
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);

  if (data.loading) return <WorkerLoading />;

  const rows = data.estimateReview;
  const totalReviewItems = rows.reduce((sum, r) => sum + r.needsReview, 0);
  const selected = rows.find((r) => r.claimId === selectedClaimId) ?? null;
  const selectedClaim = selected
    ? data.claims.find((c) => String(c._id) === selected.claimId) ?? null
    : null;
  const selectedLineItems = selectedClaim ? generateEstimateLineItems(selectedClaim) : [];

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Estimates under review", value: rows.length, tone: "default" },
        { label: "Line items needing review", value: totalReviewItems, tone: totalReviewItems > 0 ? "warning" : "positive" },
        { label: "Claims on file", value: data.claims.length, tone: "default" },
      ]}
    >
      {/* Honesty banner */}
      <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-card/40 px-4 py-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <p>
          Atlas prepares <span className="font-medium text-foreground">review-ready estimate data</span> — line items,
          quantities and support. Atlas does <span className="font-medium text-foreground">not</span> modify Xactimate;
          a human estimator reviews and enters the work.
        </p>
      </div>

      {/* Review queue */}
      <WorkerSection title="Estimate review queue" icon={Scale} count={rows.length}>
        {rows.length === 0 ? (
          <WorkerEmpty
            title="No estimates to review"
            description="When a claim carries estimate data, Atlas reconstructs scope, identifies omissions, and prepares line items for review here."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {rows.slice(0, 10).map((row) => (
                <button
                  key={row.claimId}
                  type="button"
                  onClick={() => setSelectedClaimId(row.claimId)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {row.customer ?? row.property ?? row.claimNumber ?? "Claim"}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {row.claimNumber ?? row.claimId} · {row.lineItemCount} line items
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-sm font-semibold text-foreground">{money(row.estimateAmount)}</p>
                    <p className="mt-0.5 flex items-center justify-end gap-1.5">
                      {row.needsReview > 0 && (
                        <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[9px] text-amber-600 dark:text-amber-300">
                          {row.needsReview} need review
                        </Badge>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground">Inspect →</span>
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* All claims */}
      <WorkerSection title="Claims with scope data" count={data.claimView.length}>
        {data.claimView.length === 0 ? (
          <WorkerEmpty
            title="No claims yet"
            description="Ingest claim and estimate documents and Atlas will reconstruct the scope from evidence."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {data.claimView.slice(0, 8).map(({ claim }) => (
                <button
                  key={String(claim._id ?? "")}
                  type="button"
                  onClick={() => navigate(`/dashboard/revenue-recovery/${claim._id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {claim.customer ?? claim.property ?? claim.claimNumber ?? "Claim"}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {money(claim.estimateAmount)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* Line-item inspector */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelectedClaimId(null)}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Scale className="size-4 text-amber-600 dark:text-amber-300" />
                  {selected.customer ?? selected.property ?? selected.claimNumber} — estimate review
                </DialogTitle>
                <DialogDescription>
                  Atlas recommendation for {selected.claimNumber ?? selected.claimId} ·{" "}
                  {selected.lineItemCount} line items ·{" "}
                  <span className="font-medium text-foreground">
                    human estimator review required before any entry into Xactimate
                  </span>
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {selectedLineItems.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No line items could be derived from this claim's data.
                  </p>
                )}
                {selectedLineItems.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{item.description}</span>
                      <Badge variant="outline" className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${STATUS_CLS[item.status] ?? ""}`}>
                        {item.status.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{item.quantity} {item.unit} × {money(item.unitPrice)}</span>
                      <span className="font-mono font-semibold text-foreground">{money(item.totalPrice)}</span>
                      <span>confidence {Math.round(item.confidence * 100)}%</span>
                    </div>
                    {item.rationale && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.rationale}</p>}
                    {item.requiredHumanAction && (
                      <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-300">
                        Human review required: {item.humanNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </WorkerPage>
  );
}