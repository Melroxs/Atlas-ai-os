// ---------------------------------------------------------------------------
// Daily Briefing Panel — Dashboard overview for the Atlas digital employee
//
// Shows:
//   - Work queue summary (critical/high items)
//   - Deadline alerts
//   - Quick-action buttons to drill into specific claims
// ---------------------------------------------------------------------------

import { useAtlasWorkforce, type AtlasDailyBriefingResult } from "@/hooks/use-atlas-workforce";
import { Panel } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Radar,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useState } from "react";

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function DailyBriefingPanel() {
  const navigate = useNavigate();
  const { generateBriefing, running, error } = useAtlasWorkforce();
  const [briefing, setBriefing] = useState<AtlasDailyBriefingResult | null>(null);

  const handleGenerate = async () => {
    const result = await generateBriefing();
    if (result) setBriefing(result);
  };

  return (
    <Panel>
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-teal-600 dark:text-teal-300" />
          Atlas Daily Briefing
        </h2>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleGenerate} disabled={running}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
          {running ? "Scanning…" : "Generate briefing"}
        </Button>
      </div>
      <div className="px-5 py-4">
        {error && (
          <div className="mb-3 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
            {error}
          </div>
        )}

        {!briefing && !running && (
          <p className="text-xs text-muted-foreground">
            Have Atlas scan all claims to generate a prioritized daily briefing — critical items, overdue deadlines, and recommended actions.
          </p>
        )}

        {briefing && (
          <div className="space-y-4">
            {/* Summary row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="flex items-start gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-400/10">
                  <AlertTriangle className="size-4 text-rose-600 dark:text-rose-300" />
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-300">
                    {briefing.workSummary.byPriority?.critical ?? 0}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Critical items</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10">
                  <Clock className="size-4 text-amber-600 dark:text-amber-300" />
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-300">
                    {briefing.workSummary.byPriority?.high ?? 0}
                  </p>
                  <p className="text-[10px] text-muted-foreground">High priority</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10">
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-300" />
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">
                    {briefing.workSummary.totalItems}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Total items</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10">
                  <BadgeDollarSign className="size-4 text-emerald-600 dark:text-emerald-300" />
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">
                    {money(briefing.workSummary.totalFinancialImpact)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Financial impact</p>
                </div>
              </div>
            </div>

            {/* Deadline alerts */}
            {briefing.deadlineSummary.totalDeadlines > 0 && (
              <div>
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
                  <CalendarDays className="size-3" />
                  Deadlines ({briefing.deadlineSummary.totalDeadlines})
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {briefing.deadlineSummary.totalDeadlines > 0 && (
                    <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 text-[10px] text-rose-600 dark:text-rose-300">
                      {briefing.deadlineSummary.totalDeadlines} upcoming
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Key stats from briefing sections */}
            {briefing.briefing && briefing.briefing.sections && briefing.briefing.sections.length > 0 && (
              <div className="space-y-2">
                {briefing.briefing.sections.slice(0, 3).map((section, i) => (
                  <div key={i} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                    <p className="text-xs font-medium text-foreground">{section.title}</p>
                    {section.items && section.items.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {section.items.slice(0, 3).map((item, j) => (
                          <li key={j} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            {item.priority === "critical" ? (
                              <AlertTriangle className="size-3 shrink-0 text-rose-500" />
                            ) : item.priority === "high" ? (
                              <TrendingUp className="size-3 shrink-0 text-amber-500" />
                            ) : (
                              <Sparkles className="size-3 shrink-0 text-teal-500" />
                            )}
                            {item.description}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Quick link */}
            <button
              type="button"
              onClick={() => navigate("/dashboard/work-queue")}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 py-2 text-xs text-muted-foreground transition-colors hover:border-teal-400/40 hover:bg-muted/40 hover:text-teal-700 dark:hover:text-teal-200"
            >
              View full work queue <ArrowRight className="size-3" />
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
