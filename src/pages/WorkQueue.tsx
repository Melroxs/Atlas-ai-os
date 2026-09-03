import { api } from "@/lib/api";
import { useQuery } from "@/hooks/use-supabase";
import { useAtlasWorkforce } from "@/hooks/use-atlas-workforce";
import { EmptyPanel, PageHeader, Panel, formatDate } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  CheckCircle2,
  Clock,
  Loader2,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { filterBySearch, paginate, totalPages } from "@/lib/workforce/selectors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { WorkItem } from "@/lib/work-queue/service";
import {
  listActionableGovernance,
  decideGovernanceDecision,
  type GovernanceDecisionRow,
} from "@/lib/governance/persistence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const PRIORITY_CLS: Record<string, string> = {
  critical: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  high: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  medium: "border-border/70 text-muted-foreground",
  low: "border-border/50 text-muted-foreground/70",
};

const DECISION_CLS: Record<string, string> = {
  ALLOW: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  REVIEW_REQUIRED: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  BLOCK: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  UNKNOWN: "border-border/70 bg-muted/20 text-muted-foreground",
};

const CATEGORY_ICONS: Record<string, typeof AlertTriangle> = {
  missing_evidence: AlertTriangle,
  supplement_opportunity: TrendingUp,
  financial_discrepancy: BadgeDollarSign,
  stale_claim: Clock,
  deadline_approaching: AlertTriangle,
  follow_up_needed: Clock,
  claim_review: Search,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WorkQueue() {
  const navigate = useNavigate();
  const { scanAllClaims, running, error } = useAtlasWorkforce();
  const [workItems, setWorkItems] = useState<WorkItem[] | null>(null);
  const [summary, setSummary] = useState<{
    totalItems: number;
    byPriority: Record<string, number>;
    totalFinancialImpact: number;
  } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  // Governance approvals — decisions Atlas evaluated that require a human.
  const [governanceItems, setGovernanceItems] = useState<GovernanceDecisionRow[] | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadGovernance = useCallback(async () => {
    setGovernanceItems(await listActionableGovernance());
  }, []);

  useEffect(() => {
    void loadGovernance();
  }, [loadGovernance]);

  const handleGovernanceDecision = async (
    row: GovernanceDecisionRow,
    decision: "approved" | "rejected" | "escalated",
  ) => {
    setDecidingId(row.id);
    await decideGovernanceDecision(
      row.id,
      decision,
      decision === "escalated" ? "Escalated by operator" : `Operator ${decision} from work queue`,
    );
    setDecidingId(null);
    await loadGovernance();
  };

  const handleScan = async () => {
    const result = await scanAllClaims();
    if (result) {
      setWorkItems(result.workItems);
      setSummary(result.summary);
    }
  };

  const filteredItems = useMemo(() => {
    if (!workItems) return [];
    let items = workItems;
    if (filter === "critical") items = items.filter((w) => w.priority === "critical");
    else if (filter === "human") items = items.filter((w) => w.actionable === "human_action_required");
    else if (filter === "financial") items = items.filter((w) => w.financialImpact && w.financialImpact > 0);
    else if (filter !== "all") items = items.filter((w) => w.category === filter);
    return filterBySearch(items, query, [
      (w) => w.title,
      (w) => w.claimNumber,
      (w) => w.customer,
      (w) => w.property,
      (w) => w.description,
    ]);
  }, [workItems, filter, query]);

  // Group by claim
  const grouped = useMemo(() => {
    const map = new Map<string, { claim: string; customer: string | null; property: string | null; items: WorkItem[] }>();
    for (const item of filteredItems) {
      const key = item.claimId;
      if (!map.has(key)) {
        map.set(key, { claim: item.claimNumber ?? "N/A", customer: item.customer, property: item.property, items: [] });
      }
      map.get(key)!.items.push(item);
    }
    return Array.from(map.values());
  }, [filteredItems]);

  // Paginate the grouped list so a large book never renders every group.
  const groupedPages = totalPages(grouped.length, 10);
  const visibleGroups = paginate(grouped, Math.min(page, groupedPages), 10);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Atlas Workforce"
        title="Work Queue"
        description="Prioritized action items across all claims — what needs human attention and why."
        actions={
          <Button className="gap-2" onClick={handleScan} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
            {running ? "Scanning…" : "Scan all claims"}
          </Button>
        }
      />

      {/* Governance approvals — decisions that must not execute without a human */}
      {governanceItems !== null && (
        <Panel>
          <div className="border-b border-border/60 px-5 py-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-teal-600 dark:text-teal-300" />
              <h3 className="text-sm font-semibold text-foreground">Atlas governance — pending decisions</h3>
              <Badge variant="outline" className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {governanceItems.length} pending
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Actions Atlas evaluated that require human review, escalation, or an authorized override before execution.
            </p>
          </div>
          <div className="divide-y divide-border/60">
            {governanceItems.length === 0 && (
              <p className="px-5 py-4 text-sm text-muted-foreground">
                No pending governance decisions. Atlas is not holding any action for review.
              </p>
            )}
            {governanceItems.map((row) => {
              const requiresOverride = row.decision === "BLOCK" || row.decision === "UNKNOWN";
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
                  <Badge variant="outline" className={`font-mono text-[9px] uppercase tracking-wide ${DECISION_CLS[row.decision] ?? ""}`}>
                    {row.decision.replace(/_/g, " ")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">
                      {row.action_type.replace(/_/g, " ")}
                      {row.claim_id ? ` — claim ${row.claim_id}` : ""}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{row.decision_rationale}</p>
                    {row.knowledge_gaps.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-rose-500">
                        Gaps: {(row.knowledge_gaps as Array<{ description: string }>).map((g) => g.description).join("; ")}
                      </p>
                    )}
                    {requiresOverride && (
                      <p className="mt-0.5 text-[10px] text-violet-600 dark:text-violet-300">
                        Requires super_admin / atlas_admin override to proceed.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!requiresOverride && (
                      <Button
                        size="sm"
                        variant="default"
                        disabled={decidingId === row.id}
                        onClick={() => handleGovernanceDecision(row, "approved")}
                      >
                        Approve
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={decidingId === row.id}
                      onClick={() => handleGovernanceDecision(row, "rejected")}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={decidingId === row.id}
                      onClick={() => handleGovernanceDecision(row, "escalated")}
                    >
                      Escalate
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Panel className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total work items</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{summary.totalItems}</p>
          </Panel>
          <Panel className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Critical</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-300">
              {summary.byPriority?.critical ?? 0}
            </p>
          </Panel>
          <Panel className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">High priority</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-300">
              {summary.byPriority?.high ?? 0}
            </p>
          </Panel>
          <Panel className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total financial impact</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">
              {money(summary.totalFinancialImpact)}
            </p>
          </Panel>
        </div>
      )}

      {/* Filters + search */}
      {workItems && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search claims, customers, items…"
              className="h-8 pl-8 text-xs"
              aria-label="Search work queue"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              { key: "all", label: "All" },
              { key: "critical", label: "Critical" },
              { key: "human", label: "Needs human" },
              { key: "financial", label: "Financial" },
              { key: "missing_evidence", label: "Missing evidence" },
              { key: "supplement_opportunity", label: "Supplements" },
              { key: "stale_claim", label: "Stale" },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setFilter(f.key);
                  setPage(1);
                }}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors ${
                  filter === f.key
                    ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                    : "border-border/70 text-muted-foreground hover:border-teal-400/30"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {filteredItems.length} item{filteredItems.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* Results */}
      {!workItems && !running && (
        <EmptyPanel
          icon={Radar}
          title="Scan your claims"
          description="Click 'Scan all claims' to have Atlas analyze every claim for missing evidence, supplement opportunities, financial discrepancies, and stale items."
          action={
            <Button onClick={handleScan}>
              <Radar className="mr-2 size-4" />
              Scan all claims
            </Button>
          }
        />
      )}

      {error && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {grouped.length > 0 && (
        <div className="space-y-6">
          {visibleGroups.map((group) => (
            <Panel key={group.claim + (group.customer ?? "")}>
              <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {group.customer ?? group.property ?? group.claim}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Claim #{group.claim} · {group.items.length} item{group.items.length === 1 ? "" : "s"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/dashboard/revenue-recovery/${group.items[0]?.claimId}`)}
                  className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-teal-600 dark:hover:text-teal-300"
                >
                  View claim <ArrowRight className="size-3" />
                </button>
              </div>
              <div className="divide-y divide-border/50">
                {group.items.map((item) => {
                  const Icon = CATEGORY_ICONS[item.category] ?? Sparkles;
                  return (
                    <div key={item.id} className="px-5 py-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
                          <Icon className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{item.title}</span>
                            <Badge variant="outline" className={`shrink-0 font-mono text-[9px] uppercase tracking-wide ${PRIORITY_CLS[item.priority] ?? ""}`}>
                              {item.priority}
                            </Badge>
                            <Badge variant="outline" className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                              {item.category.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                          {item.financialImpact && item.financialImpact > 0 && (
                            <p className="mt-1 text-xs font-semibold text-rose-600 dark:text-rose-300">
                              Potential impact: {money(item.financialImpact)}
                            </p>
                          )}
                          {item.atlasRecommends.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                                Atlas recommends
                              </p>
                              <ul className="mt-1 space-y-0.5">
                                {item.atlasRecommends.map((r, i) => (
                                  <li key={i} className="text-[11px] leading-4 text-muted-foreground">
                                    · {r}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {item.humanNeedsTo.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                You need to
                              </p>
                              <ul className="mt-1 space-y-0.5">
                                {item.humanNeedsTo.map((h, i) => (
                                  <li key={i} className="text-[11px] leading-4 text-muted-foreground">
                                    · {h}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ))}
        </div>
      )}

      {workItems && workItems.length === 0 && !running && (
        <Panel className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 className="size-8 text-emerald-500" />
          <p className="text-sm font-medium text-foreground">No work items found</p>
          <p className="text-xs text-muted-foreground">All claims are in good shape — nothing requires immediate attention.</p>
        </Panel>
      )}

      {groupedPages > 1 && grouped.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Page {Math.min(page, groupedPages)} of {groupedPages} · {grouped.length} claim group{grouped.length === 1 ? "" : "s"}
          </p>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={page >= groupedPages} onClick={() => setPage((p) => Math.min(groupedPages, p + 1))}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
