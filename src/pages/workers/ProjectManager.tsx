// ---------------------------------------------------------------------------
// Project Manager — operational execution: milestones, deadlines, overdue
// items, blockers, next actions. Uses the real deadline tracker +
// work-queue service + claim data.
// ---------------------------------------------------------------------------

import { AlertTriangle, CalendarClock, CheckCircle2 } from "lucide-react";
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

const WORKER = WORKERS_BY_SLUG["projects"]!;

function dueLabel(dueDate: number): string {
  const days = Math.round((dueDate - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  return `${days}d left`;
}

export default function ProjectManager() {
  const navigate = useNavigate();
  const data = useWorkerData();

  if (data.loading) return <WorkerLoading />;

  const attention = data.forWorker(WORKER);
  const { critical, warning, upcoming, overdue } = data.deadlineView;
  const atRisk = data.claimView.filter((r) => r.attention === "at_risk").length;

  return (
    <WorkerPage
      worker={WORKER}
      metrics={[
        { label: "Projects on file", value: data.claims.length, tone: "default" },
        { label: "At risk", value: atRisk, tone: atRisk > 0 ? "danger" : "positive" },
        { label: "Critical deadlines", value: critical.length, tone: critical.length > 0 ? "danger" : "positive" },
        { label: "Overdue items", value: overdue, tone: overdue > 0 ? "warning" : "positive" },
        { label: "Needs attention", value: attention.length, tone: attention.length > 0 ? "warning" : "positive" },
      ]}
    >
      {/* Deadlines */}
      <WorkerSection title="Deadlines & at-risk items" icon={CalendarClock} count={critical.length + warning.length}>
        {critical.length + warning.length === 0 ? (
          <WorkerEmpty
            title="No critical deadlines"
            description="Atlas tracks statute-of-limitations, policy-period, and follow-up deadlines per claim. Nothing is urgent right now."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {[...critical, ...warning].slice(0, 8).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => d.claimId ? navigate(`/dashboard/revenue-recovery/${d.claimId}`) : undefined}
                  disabled={!d.claimId}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 disabled:opacity-60"
                >
                  <Badge
                    variant="outline"
                    className={
                      d.severity === "critical"
                        ? "shrink-0 border-rose-400/30 bg-rose-400/10 font-mono text-[9px] uppercase tracking-wide text-rose-600 dark:text-rose-300"
                        : "shrink-0 border-amber-400/30 bg-amber-400/10 font-mono text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-300"
                    }
                  >
                    {d.severity}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{d.title}</p>
                    {d.suggestedAction && (
                      <p className="truncate text-[11px] text-muted-foreground">{d.suggestedAction}</p>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] font-medium text-rose-600 dark:text-rose-300">
                    {dueLabel(d.dueDate)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* Attention */}
      <WorkerSection title="Needs attention" icon={AlertTriangle} count={attention.length}>
        <AttentionList
          items={attention}
          emptyTitle="Nothing needs attention"
          emptyDescription="No blockers, overdue items, or stalled work across the project book."
          pageSize={8}
        />
      </WorkerSection>

      {/* Projects */}
      <WorkerSection title="Projects on file" count={data.claimView.length}>
        <ClaimsTable rows={data.claimView} pageSize={8} />
      </WorkerSection>

      {/* Healthy indicator */}
      {attention.length === 0 && critical.length === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-3 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-4" />
          The project book is clear — nothing is blocking a claim from moving forward.
        </div>
      )}
    </WorkerPage>
  );
}