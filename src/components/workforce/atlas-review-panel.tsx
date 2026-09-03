// ---------------------------------------------------------------------------
// Atlas Review Panel — Displays workforce orchestrator results on ClaimDetail
//
// Shows:
//   - Completed tasks (what Atlas did)
//   - Work items (what needs human action)
//   - Evidence generated
//   - Deadlines identified
//   - Communications drafted
//   - Recommendations
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/atlas-ui";
import type { OrchestrationResult, TaskResult, EvidenceRecord, CommunicationRecord, DeadlineRecord } from "@/lib/orchestrator/types";
import type { WorkItem } from "@/lib/work-queue/service";
import {
  listGovernanceDecisions,
  type GovernanceDecisionRow,
} from "@/lib/governance/persistence";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  MessageSquare,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AtlasReviewPanelProps {
  result: OrchestrationResult | null;
  workItems: WorkItem[];
  running: boolean;
  error: string | null;
  onRunReview: () => void;
  /** Claim id used to load the persistent governance history. */
  claimId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function PriorityBadge({ priority }: { priority: string }) {
  const cls =
    priority === "critical"
      ? "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300"
      : priority === "high"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300"
        : "border-border/70 text-muted-foreground";
  return (
    <Badge variant="outline" className={`font-mono text-[9px] uppercase tracking-wide ${cls}`}>
      {priority}
    </Badge>
  );
}

const DECISION_CLS: Record<string, string> = {
  ALLOW: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  REVIEW_REQUIRED: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  BLOCK: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  UNKNOWN: "border-border/70 bg-muted/20 text-muted-foreground",
};

const RISK_CLS: Record<string, string> = {
  critical: "text-rose-600 dark:text-rose-300",
  high: "text-rose-600 dark:text-rose-300",
  medium: "text-amber-600 dark:text-amber-300",
  low: "text-emerald-600 dark:text-emerald-300",
  none: "text-emerald-600 dark:text-emerald-300",
};

function decisionBadgeCls(decision: string): string {
  return DECISION_CLS[decision] ?? DECISION_CLS.UNKNOWN;
}

function formatDecisionTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function GovernanceSection({ governance }: { governance: NonNullable<OrchestrationResult["governance"]> }) {
  const rules = [...governance.applicableRules, ...governance.applicableStandards].slice(0, 4);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-3.5 text-teal-600 dark:text-teal-300" />
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Governance
        </p>
        <Badge variant="outline" className={`ml-auto font-mono text-[9px] uppercase tracking-wide ${decisionBadgeCls(governance.decision)}`}>
          {governance.decision.replace(/_/g, " ")}
        </Badge>
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{governance.reason}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span>
          Risk: <span className={`font-semibold ${RISK_CLS[governance.riskLevel] ?? RISK_CLS.none}`}>{governance.riskLevel}</span>
        </span>
        {governance.jurisdiction && <span>Jurisdiction: {governance.jurisdiction}</span>}
        <span>Rules: {governance.applicableRuleCount}</span>
        <span>Standards: {governance.applicableStandardsCount}</span>
        <span>Knowledge gaps: {governance.knowledgeGapCount}</span>
        <span className="font-mono">{governance.evaluationTimeMs}ms</span>
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground/70">
        {governance.persisted
          ? `Persisted ${governance.decisionId ? `(id ${governance.decisionId.slice(0, 8)}…)` : ""} — auditable`
          : "Not persisted (storage unavailable) — decision recorded in this result only"}
      </p>
      {governance.requiredApprovals.length > 0 && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-300">
          Approval required: {governance.requiredApprovals.join(", ")}
        </p>
      )}
      {rules.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">Applicable knowledge</p>
          {rules.map((r) => (
            <p key={r.id} className="flex items-baseline gap-1.5 text-[10px] leading-4 text-muted-foreground">
              <span className="truncate">• {r.title}</span>
              {r.authorityLevel === "general_ai_knowledge" ? (
                <Badge variant="outline" className="shrink-0 font-mono text-[8px] text-muted-foreground/60">
                  not authoritative
                </Badge>
              ) : (
                <span className="shrink-0 font-mono text-[8px] text-muted-foreground/60">{r.authorityLevel.replace(/_/g, " ")}</span>
              )}
            </p>
          ))}
        </div>
      )}
      {governance.knowledgeGaps.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-rose-500">Knowledge gaps</p>
          {governance.knowledgeGaps.map((g, i) => (
            <p key={`${g.description}-${i}`} className="text-[10px] leading-4 text-rose-600/80 dark:text-rose-300/80">
              • {g.description}{g.requiresHumanReview ? " (requires human review)" : ""}
            </p>
          ))}
        </div>
      )}
      {governance.citations.length > 0 && (
        <p className="mt-1 line-clamp-2 text-[10px] italic text-muted-foreground/70">
          {governance.citations.slice(0, 3).join(" · ")}
        </p>
      )}
    </div>
  );
}

function GovernanceHistory({ claimId, currentDecisionId }: { claimId: string; currentDecisionId?: string }) {
  const [rows, setRows] = useState<GovernanceDecisionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGovernanceDecisions({ claimId, limit: 20 }).then((items) => {
      if (!cancelled) setRows(items);
    });
    return () => {
      cancelled = true;
    };
  }, [claimId, currentDecisionId]);

  if (rows === null) {
    return (
      <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 px-4 py-3 text-[11px] text-muted-foreground">
        Loading governance history…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 px-4 py-3 text-[11px] text-muted-foreground">
        No persisted governance decisions for this claim yet. Run Atlas Review to record the first one.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-3.5 text-teal-600 dark:text-teal-300" />
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Governance history ({rows.length})
        </p>
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const isCurrent = currentDecisionId === r.id;
          return (
            <div key={r.id} className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[11px] font-medium text-foreground">{r.action_type.replace(/_/g, " ")}</span>
                <Badge variant="outline" className={`font-mono text-[9px] uppercase tracking-wide ${decisionBadgeCls(r.decision)}`}>
                  {r.decision.replace(/_/g, " ")}
                </Badge>
                <span className="font-mono text-[9px] text-muted-foreground">
                  {formatDecisionTime(r.evaluated_at)} · {r.evaluated_at.slice(11, 19)}Z
                </span>
                {isCurrent && (
                  <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-wide text-teal-600 dark:text-teal-300">
                    current
                  </Badge>
                )}
                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                  risk {r.risk_level} · {r.execution_status.replace(/_/g, " ")} · approval {r.approval_status.replace(/_/g, " ")}
                </span>
              </div>
              {r.jurisdiction && (
                <p className="mt-0.5 text-[10px] text-muted-foreground/70">Jurisdiction: {r.jurisdiction}</p>
              )}
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{r.decision_rationale}</p>
              {(r.override_decision || r.override_reason) && (
                <p className="mt-0.5 text-[10px] text-violet-600 dark:text-violet-300">
                  Overridden: {r.override_decision} — {r.override_reason}
                </p>
              )}
              {r.knowledge_gaps.length > 0 && (
                <p className="mt-0.5 text-[10px] text-rose-500">
                  Gaps: {(r.knowledge_gaps as Array<{ description: string }>).map((g) => g.description).join("; ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskSection({ title, items, icon: Icon, color }: {
  title: string;
  items: TaskResult[];
  icon: typeof CheckCircle2;
  color: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${color}`}>
        <Icon className="size-3" />
        {title} ({items.length})
      </p>
      <div className="mt-2 space-y-1.5">
        {items.map((t) => (
          <div key={t.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">{t.title}</span>
              <Badge variant="outline" className="ml-auto font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                {t.category.replace(/_/g, " ")}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{t.description}</p>
            {t.suggestedAction && (
              <p className="mt-1 text-[10px] italic leading-4 text-violet-600 dark:text-violet-300">
                → {t.suggestedAction}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AtlasReviewPanel({ result, workItems, running, error, onRunReview, claimId }: AtlasReviewPanelProps) {
  const highPriorityItems = workItems.filter((w) => w.priority === "critical" || w.priority === "high");

  return (
    <Panel title="Atlas Workforce Review">
      <div className="px-5 py-4">
        {/* Trigger button */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">
              {result
                ? `Review completed in ${(result.executionTimeMs / 1000).toFixed(1)}s`
                : "Run Atlas's full claim review workflow — evidence analysis, gap identification, supplement opportunities, financial reconciliation, and communication drafting."}
            </p>
          </div>
          <Button
            variant={result ? "outline" : "default"}
            className="gap-2"
            onClick={onRunReview}
            disabled={running}
          >
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : result ? (
              <Sparkles className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
            {running ? "Running…" : result ? "Re-run review" : "Run Atlas Review"}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="mt-4 space-y-4">
            {/* Summary */}
            <div className="rounded-lg border border-teal-400/25 bg-teal-400/5 px-4 py-3">
              <p className="text-sm font-medium text-foreground">{result.summary}</p>
            </div>

            {/* Governance gate */}
            {result.governance && (
              <GovernanceSection governance={result.governance} />
            )}

            {/* Governance history (persistent) */}
            {claimId && (
              <GovernanceHistory
                claimId={claimId}
                currentDecisionId={result?.governance?.decisionId}
              />
            )}

            {/* Stats row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="text-center">
                <p className="font-mono text-lg font-semibold text-emerald-600 dark:text-emerald-300">
                  {result.completedByAtlas.length}
                </p>
                <p className="text-[10px] text-muted-foreground">Completed by Atlas</p>
              </div>
              <div className="text-center">
                <p className="font-mono text-lg font-semibold text-amber-600 dark:text-amber-300">
                  {result.readyForHumanApproval.length}
                </p>
                <p className="text-[10px] text-muted-foreground">Awaiting approval</p>
              </div>
              <div className="text-center">
                <p className="font-mono text-lg font-semibold text-violet-600 dark:text-violet-300">
                  {result.evidenceGenerated.length}
                </p>
                <p className="text-[10px] text-muted-foreground">Evidence records</p>
              </div>
              <div className="text-center">
                <p className="font-mono text-lg font-semibold text-rose-600 dark:text-rose-300">
                  {result.deadlinesIdentified.length}
                </p>
                <p className="text-[10px] text-muted-foreground">Deadlines</p>
              </div>
            </div>

            {/* Completed tasks */}
            <TaskSection
              title="Completed by Atlas"
              items={result.completedByAtlas}
              icon={CheckCircle2}
              color="text-emerald-700 dark:text-emerald-300"
            />

            {/* Awaiting approval */}
            <TaskSection
              title="Requires human approval"
              items={result.readyForHumanApproval}
              icon={Clock}
              color="text-amber-700 dark:text-amber-300"
            />

            {/* Deadlines */}
            {result.deadlinesIdentified.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="size-3" />
                  Deadlines ({result.deadlinesIdentified.length})
                </p>
                <div className="mt-2 space-y-1.5">
                  {result.deadlinesIdentified.map((d: DeadlineRecord) => (
                    <div key={d.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <div>
                        <span className="text-xs font-medium text-foreground">{d.title}</span>
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          {d.daysUntilDue} days · {d.severity}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">{d.suggestedAction}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Communications */}
            {result.communicationsGenerated.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
                  <MessageSquare className="size-3" />
                  Communications drafted ({result.communicationsGenerated.length})
                </p>
                <div className="mt-2 space-y-1.5">
                  {result.communicationsGenerated.map((c: CommunicationRecord) => (
                    <div key={c.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-foreground">{c.subject}</span>
                        <Badge variant="outline" className="ml-auto font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                          {c.type} · {c.status}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{c.body.slice(0, 200)}…</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Evidence */}
            {result.evidenceGenerated.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                  <FileText className="size-3" />
                  Evidence generated ({result.evidenceGenerated.length})
                </p>
                <div className="mt-2 space-y-1">
                  {result.evidenceGenerated.slice(0, 5).map((e: EvidenceRecord) => (
                    <div key={e.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="shrink-0 font-mono text-[9px] text-violet-500">{e.type}</span>
                      <span className="truncate">{e.extractedFact}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px]">{Math.round(e.confidence * 100)}%</span>
                    </div>
                  ))}
                  {result.evidenceGenerated.length > 5 && (
                    <p className="text-[10px] text-muted-foreground/70">
                      +{result.evidenceGenerated.length - 5} more evidence records
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Work items */}
            {highPriorityItems.length > 0 && (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  <TrendingUp className="size-3" />
                  High-priority work items ({highPriorityItems.length})
                </p>
                <div className="mt-2 space-y-1.5">
                  {highPriorityItems.slice(0, 5).map((w) => (
                    <div key={w.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-foreground">{w.title}</span>
                          <PriorityBadge priority={w.priority} />
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{w.description}</p>
                        {w.financialImpact && w.financialImpact > 0 && (
                          <p className="mt-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-300">
                            Potential: {money(w.financialImpact)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No results state */}
        {!result && !running && !error && (
          <div className="mt-4 text-center text-sm text-muted-foreground">
            <p>Click "Run Atlas Review" to have Atlas analyze this claim end-to-end.</p>
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              Atlas will assess completeness, identify gaps, find supplement opportunities, reconcile finances, and draft communications.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
