// ---------------------------------------------------------------------------
// Supplement Specialist — detected opportunities → investigation → evidence
// gaps → prepared supplements → governance review → human action.
// Output is always PREPARED (never "submitted") — no insurer integration
// exists, and the governance gate is shown for every prepared action.
// ---------------------------------------------------------------------------

import { AlertTriangle, FileSearch, ShieldCheck, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

const WORKER = WORKERS_BY_SLUG["supplements"]!;

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function SupplementSpecialist() {
  const navigate = useNavigate();
  const data = useWorkerData();

  if (data.loading) return <WorkerLoading />;

  const attention = data.forWorker(WORKER);
  const govPending = data.pendingGovernanceFor(WORKER);
  const totalPotential = attention.reduce((sum, i) => sum + (i.financialImpact ?? 0), 0);

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Opportunities detected", value: attention.length, tone: attention.length > 0 ? "accent" : "positive" },
        { label: "Potential recovery", value: money(totalPotential), tone: totalPotential > 0 ? "positive" : "default" },
        { label: "Prepared & awaiting review", value: govPending.length, tone: govPending.length > 0 ? "warning" : "positive" },
        { label: "Open findings", value: data.recovery.openFindings, tone: "default" },
      ]}
    >
      {/* Pipeline strip — business language, real stages */}
      <div className="flex flex-wrap items-center gap-1.5">
        {[
          ["Ingested claim data", "done"],
          ["Claim analysis", "done"],
          ["Discrepancy detection", "done"],
          ["Evidence & gap analysis", "done"],
          ["Supplement preparation", "done"],
          ["Governance review", govPending.length > 0 ? "active" : "done"],
          ["Human review / next action", govPending.length > 0 ? "active" : "pending"],
        ].map(([label, state]) => (
          <span
            key={label as string}
            className={
              state === "done"
                ? "rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-300"
                : state === "active"
                  ? "rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-300"
                  : "rounded-full border border-border/70 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
            }
          >
            {label}
          </span>
        ))}
      </div>

      {/* Supplement opportunities */}
      <WorkerSection title="Supplement opportunities" icon={TrendingUp} count={attention.length}>
        <AttentionList
          items={attention}
          emptyTitle="No supplement opportunities right now"
          emptyDescription="Atlas analyzes every claim against its evidence. When it finds scope the carrier estimate omitted, an opportunity will appear here."
          pageSize={8}
        />
      </WorkerSection>

      {/* Prepared supplements in governance review */}
      <WorkerSection title="Prepared supplements — governance review" icon={ShieldCheck} count={govPending.length}>
        {govPending.length === 0 ? (
          <WorkerEmpty
            title="Nothing in governance review"
            description="Prepared supplements pass through the governance gate before any human action. None are waiting right now."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {govPending.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => navigate("/dashboard/governance")}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
                >
                  <Badge variant="outline" className="shrink-0 font-mono text-[9px] uppercase tracking-wide border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300">
                    {row.decision.replace(/_/g, " ")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {row.action_type.replace(/_/g, " ")} — claim {row.claim_id ?? "—"}
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{row.decision_rationale}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">Review in Governance →</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* Claims under supplement analysis */}
      <WorkerSection title="Claims under analysis" icon={FileSearch} count={data.claims.length}>
        {data.claims.length === 0 ? (
          <WorkerEmpty
            title="No claims yet"
            description="Ingest claim documents and Atlas will reconstruct claims and run discrepancy analysis automatically."
          />
        ) : (
          <ClaimsTable rows={data.claimView} pageSize={8} />
        )}
      </WorkerSection>

      {/* Honesty banner */}
      <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-card/40 px-4 py-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <p>
          Atlas prepares supplements for human review. There is no insurer-submission
          integration — nothing is sent externally, and prepared output stays in
          <span className="font-medium text-foreground"> PREPARED / AWAITING EXTERNAL EXECUTION</span> until a human acts.
        </p>
      </div>
    </WorkerPage>
  );
}