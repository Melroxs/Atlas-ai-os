// ---------------------------------------------------------------------------
// Governance — the control system behind every Atlas worker.
//
// Pending approvals (with approve/reject/escalate actions), decision history
// with full provenance, and knowledge gaps. Every row is persisted Supabase
// data; UNKNOWN is always presented as blocked, never safe.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Loader2, Search, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyPanel, PageHeader } from "@/components/atlas-ui";
import {
  listActionableGovernance,
  listGovernanceDecisions,
  decideGovernanceDecision,
  type GovernanceDecisionRow,
} from "@/lib/governance/persistence";
import { filterBySearch, paginate, totalPages } from "@/lib/workforce/selectors";
import { cn } from "@/lib/utils";

const DECISION_CLS: Record<string, string> = {
  ALLOW: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  REVIEW_REQUIRED: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  BLOCK: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  UNKNOWN: "border-border/70 bg-muted/20 text-muted-foreground",
};

const EXEC_CLS: Record<string, string> = {
  executed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  approved: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  awaiting_approval: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  blocked: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  superseded: "border-border/70 bg-muted/30 text-muted-foreground",
  rejected: "border-border/70 bg-muted/30 text-muted-foreground",
};

function fmt(ts?: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DecisionRow({
  row,
  onAction,
  busy,
}: {
  row: GovernanceDecisionRow;
  onAction: (row: GovernanceDecisionRow, decision: "approved" | "rejected" | "escalated") => void;
  busy: boolean;
}) {
  const requiresOverride = row.decision === "BLOCK" || row.decision === "UNKNOWN";
  const gaps = Array.isArray(row.knowledge_gaps) ? (row.knowledge_gaps as Array<{ description: string }>) : [];
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("shrink-0 font-mono text-[9px] uppercase tracking-wide", DECISION_CLS[row.decision] ?? "")}>
          {row.decision.replace(/_/g, " ")}
        </Badge>
        <span className="text-xs font-medium text-foreground">{row.action_type.replace(/_/g, " ")}</span>
        <span className="font-mono text-[10px] text-muted-foreground">claim {row.claim_id ?? "—"}</span>
        <Badge variant="outline" className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          {row.risk_level}
        </Badge>
        {row.jurisdiction && (
          <Badge variant="outline" className="shrink-0 font-mono text-[9px] text-muted-foreground">
            {row.jurisdiction}
          </Badge>
        )}
        <Badge variant="outline" className={cn("shrink-0 font-mono text-[9px] uppercase tracking-wide", EXEC_CLS[row.execution_status] ?? "")}>
          {row.execution_status.replace(/_/g, " ")}
        </Badge>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{fmt(row.evaluated_at)}</span>
      </div>

      {row.decision_rationale && (
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{row.decision_rationale}</p>
      )}

      {/* Structured provenance — never hidden */}
      {(gaps.length > 0 || (row.required_approvals?.length ?? 0) > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {gaps.length > 0 && (
            <p className="text-[10px] text-rose-500">
              Gaps: {gaps.map((g) => g.description).join("; ")}
            </p>
          )}
          {(row.required_approvals ?? []).length > 0 && (
            <p className="text-[10px] text-amber-600 dark:text-amber-300">
              Requires: {(row.required_approvals ?? []).join(", ")}
            </p>
          )}
          {requiresOverride && (
            <p className="text-[10px] text-violet-600 dark:text-violet-300">
              BLOCK/UNKNOWN — override requires super_admin / atlas_admin
            </p>
          )}
        </div>
      )}

      {/* Approval actions — only for actionable rows */}
      {(row.approval_status === "required" &&
        (row.execution_status === "awaiting_approval" || row.execution_status === "blocked")) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!requiresOverride && (
            <Button size="sm" variant="default" className="h-7 text-xs" disabled={busy} onClick={() => onAction(row, "approved")}>
              Approve
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onAction(row, "rejected")}>
            Reject
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onAction(row, "escalated")}>
            Escalate
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Governance() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<GovernanceDecisionRow[] | null>(null);
  const [history, setHistory] = useState<GovernanceDecisionRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setPending(await listActionableGovernance());
    setHistory(await listGovernanceDecisions({ limit: 200 }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAction = async (row: GovernanceDecisionRow, decision: "approved" | "rejected" | "escalated") => {
    setBusyId(row.id);
    try {
      await decideGovernanceDecision(
        row.id,
        decision,
        decision === "escalated" ? "Escalated by operator" : `Operator ${decision} from Governance`,
      );
    } catch {
      // decideGovernanceDecision throws on non-actionable / unauthorized rows.
    }
    setBusyId(null);
    await load();
  };

  const filteredHistory = useMemo(() => {
    let items = history ?? [];
    if (decisionFilter !== "all") {
      items = items.filter((r) => r.decision === decisionFilter);
    }
    return filterBySearch(items, query, [
      (r) => r.action_type,
      (r) => r.claim_id ?? "",
      (r) => r.decision_rationale,
      (r) => r.jurisdiction ?? "",
    ]);
  }, [history, query, decisionFilter]);

  const pages = totalPages(filteredHistory.length, 20);
  const pageRows = paginate(filteredHistory, Math.min(page, pages), 20);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Intelligence · Governance"
        title="Governance"
        description="Every material Atlas action passes through this gate. Decisions, knowledge provenance, approvals and overrides are persisted and auditable — UNKNOWN is always blocked until an authorized human acts."
        actions={
          <Button variant="outline" className="gap-2" onClick={() => void load()}>
            <Sparkles className="size-3.5" />
            Refresh
          </Button>
        }
      />

      {/* Pending approvals */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-amber-600 dark:text-amber-300" />
          <h2 className="text-sm font-semibold text-foreground">Pending decisions</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            {pending === null ? "…" : pending.length}
          </Badge>
        </div>
        {pending === null ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading governance decisions…
          </div>
        ) : pending.length === 0 ? (
          <EmptyPanel
            icon={ShieldCheck}
            title="No pending governance decisions"
            description="Atlas is not holding any action for human review right now."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
            <div className="divide-y divide-border/50">
              {pending.map((row) => (
                <DecisionRow key={row.id} row={row} busy={busyId === row.id} onAction={(r, d) => void handleAction(r, d)} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Decision history */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Decision history</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            {history === null ? "…" : history.length}
          </Badge>
          <div className="relative ml-auto min-w-52 flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search actions, claims, rationale…"
              className="h-8 pl-8 text-xs"
              aria-label="Search governance history"
            />
          </div>
          {["all", "ALLOW", "REVIEW_REQUIRED", "BLOCK", "UNKNOWN"].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDecisionFilter(d);
                setPage(1);
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
                decisionFilter === d
                  ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                  : "border-border/70 text-muted-foreground hover:border-teal-400/30",
              )}
            >
              {d.replace(/_/g, " ")}
            </button>
          ))}
        </div>

        {history === null ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading decision history…
          </div>
        ) : filteredHistory.length === 0 ? (
          <EmptyPanel
            icon={ShieldCheck}
            title="No decisions match"
            description="No persisted governance decisions match this search yet. Decisions appear here the moment an Atlas worker evaluates a material action."
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
              <div className="divide-y divide-border/50">
                {pageRows.map((row) => (
                  <DecisionRow key={row.id} row={row} busy={busyId === row.id} onAction={(r, d) => void handleAction(r, d)} />
                ))}
              </div>
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  Page {Math.min(page, pages)} of {pages}
                </p>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* In-context link */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Governance also appears inside the Atlas Review Panel on each claim:</span>
        <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
          <a href="/dashboard/work-queue">
            Work Queue
            <ArrowRight className="ml-1 size-3" />
          </a>
        </Button>
        <span>·</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => navigate(-1)}
        >
          back to where you were
        </Button>
      </div>
    </div>
  );
}