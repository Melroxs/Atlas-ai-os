// ---------------------------------------------------------------------------
// Revenue Recovery Coordinator — where is the company leaving recoverable
// revenue on the table? Real data only: insurance_claim_counts +
// insurance_recovery_analytics + work-queue service.
// ---------------------------------------------------------------------------

import { ArrowRight, Banknote, Clock, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useNavigate } from "react-router";

const WORKER = WORKERS_BY_SLUG["recovery"]!;

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function RevenueRecoveryCoordinator() {
  const navigate = useNavigate();
  const data = useWorkerData();

  if (data.loading) return <WorkerLoading />;

  const attention = data.forWorker(WORKER);
  const r = data.recovery;
  const topClaims = [...data.claimView]
    .filter(({ outstanding }) => typeof outstanding === "number" && outstanding > 0)
    .sort((a, b) => (b.outstanding ?? 0) - (a.outstanding ?? 0))
    .slice(0, 6);

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Potential recovery", value: money(r.potential), tone: r.potential > 0 ? "positive" : "default" },
        { label: "Outstanding", value: money(r.outstanding), tone: r.outstanding > 0 ? "danger" : "positive" },
        { label: "Recovered (paid)", value: money(r.paidAmount), tone: "positive" },
        { label: "Claims needing attention", value: r.attentionClaims, tone: r.attentionClaims > 0 ? "warning" : "positive" },
        { label: "Supplements drafted", value: r.supplementsDrafted, tone: "default" },
        { label: "Open findings", value: r.openFindings, tone: "default" },
      ]}
    >
      {/* Financial intelligence — real recovery pipeline */}
      <WorkerSection
        title="Recovery pipeline"
        icon={Banknote}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/revenue-recovery">
              Detailed recovery view
              <ArrowRight className="size-3" />
            </a>
          </Button>
        }
      >
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
          <div className="divide-y divide-border/50">
            {[
              ["Requested from carriers", r.requestedAmount],
              ["Approved by carriers", r.approvedAmount],
              ["Denied by carriers", r.deniedAmount],
              ["Paid / recovered", r.paidAmount],
              ["Outstanding balance", r.outstanding],
            ].map(([label, amount]) => (
              <div key={label as string} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                  {money(amount as number)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </WorkerSection>

      {/* Attention */}
      <WorkerSection title="Recovery needs attention" icon={Clock} count={attention.length}>
        <AttentionList
          items={attention}
          emptyTitle="No recovery items need attention"
          emptyDescription="No outstanding balances, stalled claims, or overdue follow-ups right now. Atlas will surface anything that starts leaving money on the table."
          pageSize={8}
        />
      </WorkerSection>

      {/* Highest outstanding claims */}
      <WorkerSection title="Largest open balances" icon={TrendingUp} count={topClaims.length}>
        {topClaims.length === 0 ? (
          <WorkerEmpty
            title="No open balances"
            description="Every claim on file is either settled or has no recorded outstanding balance."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {topClaims.map(({ claim, outstanding }) => (
                <button
                  key={String(claim._id ?? "")}
                  type="button"
                  onClick={() => navigate(`/dashboard/revenue-recovery/${claim._id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {claim.customer ?? claim.property ?? claim.claimNumber ?? "Claim"}
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {claim.claimNumber ?? String(claim._id ?? "").slice(0, 8)}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-sm font-semibold text-rose-600 dark:text-rose-300">
                    {money(outstanding)}
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* The book */}
      <WorkerSection title="Claims on file" count={data.claimView.length}>
        <ClaimsTable rows={data.claimView} pageSize={8} />
      </WorkerSection>
    </WorkerPage>
  );
}