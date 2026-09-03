// ---------------------------------------------------------------------------
// Command Center — the operational home of the Atlas workforce.
//
// Answers: What is happening? What matters? What needs attention? What is
// Atlas doing? What should happen next?
//
// Every number comes from real backend data (claims, work queue, governance,
// recovery counts, activity). Empty states are honest — no fabricated
// metrics.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CalendarClock,
  CheckCircle2,
  Clock,
  Loader2,
  Radar,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DailyBriefingPanel } from "@/components/workforce/daily-briefing-panel";
import { AttentionList } from "@/components/workforce/attention-list";
import { WorkerLoading, WorkerSection } from "@/components/workforce/worker-page";
import { WORKERS } from "@/lib/workforce/worker-defs";
import { useWorkerData } from "@/lib/workforce/use-worker-data";
import { useAtlasWorkforce } from "@/hooks/use-atlas-workforce";
import { cn } from "@/lib/utils";

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function dueLabel(dueDate: number): string {
  const days = Math.round((dueDate - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  return `${days}d left`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const data = useWorkerData();
  const { scanAllClaims, running } = useAtlasWorkforce();
  const [scanResult, setScanResult] = useState<{ generatedAt: number; count: number } | null>(null);

  const allAttention = useMemo(
    () =>
      [...data.workItems].sort((a, b) => {
        const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
      }),
    [data.workItems],
  );

  const workerCounts = useMemo(
    () =>
      WORKERS.map((w) => ({
        worker: w,
        attention: data.forWorker(w).length,
        governance: data.pendingGovernanceFor(w).length,
      })),
    [data, data.forWorker, data.pendingGovernanceFor],
  );

  const handleScan = async () => {
    const result = await scanAllClaims();
    if (result) {
      setScanResult({ generatedAt: Date.now(), count: result.workItems.length });
    }
  };

  if (data.loading) return <WorkerLoading label="Loading the command center…" />;

  const r = data.recovery;
  const { critical, warning, overdue } = data.deadlineView;
  const totalAttention = allAttention.length;
  const governancePending = data.governance.length;

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Atlas · Command Center
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            The workforce is working.
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Six Atlas workers run across your claims book — this is what they found,
            what they're doing, and what needs you right now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="gap-2" onClick={() => void handleScan()} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
            {running ? "Scanning…" : "Scan all claims"}
          </Button>
          <Button className="gap-2" onClick={() => navigate("/dashboard/workers")}>
            <Sparkles className="size-4" />
            Workers
          </Button>
        </div>
      </div>

      {scanResult && (
        <div className="flex items-center gap-2 rounded-xl border border-teal-400/25 bg-teal-400/5 px-4 py-2.5 text-xs text-teal-700 dark:text-teal-300">
          <CheckCircle2 className="size-4" />
          Scan complete — {scanResult.count} work item{scanResult.count === 1 ? "" : "s"} identified across the claims book.
        </div>
      )}

      {/* Workforce status */}
      <WorkerSection
        title="Workforce status"
        icon={Radar}
        count={workerCounts.reduce((s, w) => s + w.attention + w.governance, 0)}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/workers">
              Open workforce
              <ArrowRight className="size-3" />
            </a>
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {workerCounts.map(({ worker, attention, governance }) => {
            const Icon = worker.icon;
            const needs = attention + governance;
            return (
              <a
                key={worker.slug}
                href={worker.route}
                className={cn(
                  "flex items-center gap-3 rounded-xl border bg-card/50 px-4 py-3 transition-colors",
                  needs > 0 ? "border-amber-400/30 hover:border-amber-400/50" : "border-border/70 hover:border-teal-400/30",
                )}
              >
                <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg ring-1", worker.accent)}>
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{worker.name}</p>
                  <p className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    {worker.role}
                  </p>
                </div>
                {needs > 0 ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    {attention > 0 && (
                      <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-600 dark:text-amber-300">
                        {attention}
                      </Badge>
                    )}
                    {governance > 0 && (
                      <Badge variant="outline" className="border-rose-400/30 bg-rose-400/10 font-mono text-[10px] text-rose-600 dark:text-rose-300">
                        {governance}
                      </Badge>
                    )}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                    clear
                  </span>
                )}
              </a>
            );
          })}
        </div>
      </WorkerSection>

      {/* Attention queue */}
      <WorkerSection
        title="Attention queue"
        icon={AlertTriangle}
        count={totalAttention + governancePending}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/work-queue">
              Work queue
              <ArrowRight className="size-3" />
            </a>
          </Button>
        }
      >
        {totalAttention === 0 && governancePending === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-8 text-center">
            <CheckCircle2 className="size-6 text-emerald-500/70" />
            <p className="text-sm font-medium text-foreground">Nothing needs attention</p>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              Atlas scanned the claims book and found no missing evidence, discrepancies,
              stalled claims, or pending governance decisions.
            </p>
          </div>
        ) : (
          <AttentionList items={allAttention.slice(0, 30)} pageSize={8} compact />
        )}
        {governancePending > 0 && (
          <button
            type="button"
            onClick={() => navigate("/dashboard/governance")}
            className="flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-400/5 px-4 py-2.5 text-left text-xs text-rose-700 transition-colors hover:bg-rose-400/10 dark:text-rose-300"
          >
            <ShieldCheck className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {governancePending} governance decision{governancePending === 1 ? "" : "s"} await{governancePending === 1 ? "s" : ""} human review — Atlas will not execute without you.
            </span>
            <ArrowRight className="size-3.5 shrink-0" />
          </button>
        )}
      </WorkerSection>

      {/* Financial intelligence */}
      <WorkerSection
        title="Financial intelligence"
        icon={Banknote}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/workers/recovery">
              Revenue Recovery
              <ArrowRight className="size-3" />
            </a>
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Potential recovery", value: money(r.potential), tone: r.potential > 0 ? "text-emerald-600 dark:text-emerald-300" : "text-foreground" },
            { label: "Outstanding balance", value: money(r.outstanding), tone: r.outstanding > 0 ? "text-rose-600 dark:text-rose-300" : "text-foreground" },
            { label: "Paid / recovered", value: money(r.paidAmount), tone: "text-emerald-600 dark:text-emerald-300" },
            { label: "Requested from carriers", value: money(r.requestedAmount), tone: "text-foreground" },
          ].map((m) => (
            <div key={m.label} className="rounded-xl border border-border/70 bg-card/50 px-4 py-3">
              <p className="font-mono text-lg font-semibold tabular-nums sm:text-xl">{m.value}</p>
              <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{m.label}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Claims needing attention", value: r.attentionClaims, tone: r.attentionClaims > 0 ? "text-amber-600 dark:text-amber-300" : "text-foreground" },
            { label: "Open findings", value: r.openFindings, tone: "text-foreground" },
            { label: "Supplements drafted", value: r.supplementsDrafted, tone: "text-foreground" },
            { label: "Supplements ready", value: r.supplementsReady, tone: "text-foreground" },
          ].map((m) => (
            <div key={m.label} className="rounded-xl border border-border/70 bg-card/40 px-4 py-2.5">
              <p className={cn("font-mono text-lg font-semibold tabular-nums", m.tone)}>{m.value}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{m.label}</p>
            </div>
          ))}
        </div>
      </WorkerSection>

      {/* Deadlines */}
      <WorkerSection
        title="Deadlines & at-risk"
        icon={CalendarClock}
        count={critical.length + warning.length}
        action={
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground">
            <a href="/dashboard/workers/projects">
              Project Manager
              <ArrowRight className="size-3" />
            </a>
          </Button>
        }
      >
        {critical.length + warning.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/30 px-4 py-3 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            No critical deadlines tracked right now.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {[...critical, ...warning].slice(0, 6).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={!d.claimId}
                  onClick={() => d.claimId && navigate(`/dashboard/revenue-recovery/${d.claimId}`)}
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
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{d.title}</span>
                  <span className="shrink-0 font-mono text-[11px] font-medium text-rose-600 dark:text-rose-300">
                    {dueLabel(d.dueDate)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </WorkerSection>

      {/* Atlas working — recent activity + briefing */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WorkerSection title="What Atlas is working on" icon={TrendingUp} count={overdue}>
          <div className="rounded-xl border border-border/70 bg-card/50">
            <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
              <Radar className="size-7 text-teal-600 dark:text-teal-300" />
              <p className="text-sm font-medium text-foreground">Work is generated on demand</p>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                Run a scan to have Atlas analyze every claim, or open a claim and run the
                Atlas Review to see the full orchestrated analysis with governance.
              </p>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void handleScan()} disabled={running}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
                Scan all claims
              </Button>
            </div>
          </div>
        </WorkerSection>
        <DailyBriefingPanel />
      </div>
    </div>
  );
}