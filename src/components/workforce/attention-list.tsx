// ---------------------------------------------------------------------------
// AttentionList — shared "what needs attention" surface.
//
// Renders WorkItem[] (work-queue service) with the Atlas pattern:
//   WHAT needs attention → WHY → WHAT ATLAS DID → WHAT ATLAS RECOMMENDS
//   → WHAT THE HUMAN NEEDS TO DO
// Scalable: search + priority/category filter + pagination. Empty state is
// honest ("nothing needs attention") and loading is distinct.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  CheckCircle2,
  Clock,
  FileText,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WorkItem } from "@/lib/work-queue/service";
import { filterBySearch, paginate, totalPages } from "@/lib/workforce/selectors";

const PRIORITY_CLS: Record<string, string> = {
  critical: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  high: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  medium: "border-border/70 text-muted-foreground",
  low: "border-border/50 text-muted-foreground/70",
};

const CATEGORY_ICONS: Record<string, typeof AlertTriangle> = {
  missing_evidence: AlertTriangle,
  supplement_opportunity: TrendingUp,
  financial_discrepancy: BadgeDollarSign,
  stale_claim: Clock,
  deadline_approaching: AlertTriangle,
  follow_up_needed: Clock,
  claim_review: Search,
  pending_approval: ShieldAlert,
  document_request: FileText,
  carrier_response_overdue: Clock,
};

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "high", label: "High" },
  { key: "financial", label: "Financial" },
] as const;

export function AttentionList({
  items,
  emptyTitle = "Nothing needs attention",
  emptyDescription = "Atlas has no open items in this worker's queue right now.",
  pageSize = 10,
  compact = false,
}: {
  items: WorkItem[];
  emptyTitle?: string;
  emptyDescription?: string;
  pageSize?: number;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const searched = filterBySearch(items, query, [
      (i) => i.title,
      (i) => i.claimNumber,
      (i) => i.customer,
      (i) => i.property,
      (i) => i.description,
    ]);
    if (filter === "all") return searched;
    if (filter === "critical") return searched.filter((i) => i.priority === "critical");
    if (filter === "high") return searched.filter((i) => i.priority === "high");
    if (filter === "financial") return searched.filter((i) => (i.financialImpact ?? 0) > 0);
    return searched;
  }, [items, query, filter]);

  const pages = totalPages(filtered.length, pageSize);
  const pageItems = paginate(filtered, Math.min(page, pages), pageSize);

  return (
    <div className="flex flex-col gap-3">
      {/* Search + filters */}
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
            aria-label="Search attention items"
          />
        </div>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
            className={cn(
              "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
              filter === f.key
                ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                : "border-border/70 text-muted-foreground hover:border-teal-400/30",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {filtered.length} item{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-8 text-center">
          <CheckCircle2 className="size-6 text-emerald-500/70" />
          <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">{emptyDescription}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
          <div className="divide-y divide-border/50">
            {pageItems.map((item) => {
              const Icon = CATEGORY_ICONS[item.category] ?? Sparkles;
              return (
                <div key={item.id} className={cn("px-4", compact ? "py-2.5" : "py-3.5")}>
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30",
                        compact ? "size-7" : "size-8",
                      )}
                    >
                      <Icon className={compact ? "size-3.5" : "size-4"} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{item.title}</span>
                        <Badge variant="outline" className={cn("shrink-0 font-mono text-[9px] uppercase tracking-wide", PRIORITY_CLS[item.priority] ?? "")}>
                          {item.priority}
                        </Badge>
                        <Badge variant="outline" className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                          {item.category.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p>
                      {(item.financialImpact ?? 0) > 0 && (
                        <p className="mt-1 text-xs font-semibold text-rose-600 dark:text-rose-300">
                          Potential impact: {money(item.financialImpact)}
                        </p>
                      )}
                      {!compact && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {item.atlasRecommends.length > 0 && (
                            <div>
                              <p className="text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                                Atlas recommends
                              </p>
                              <ul className="mt-0.5 space-y-0.5">
                                {item.atlasRecommends.slice(0, 3).map((r, i) => (
                                  <li key={i} className="text-[11px] leading-4 text-muted-foreground">
                                    · {r}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {item.humanNeedsTo.length > 0 && (
                            <div>
                              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                You need to
                              </p>
                              <ul className="mt-0.5 space-y-0.5">
                                {item.humanNeedsTo.slice(0, 3).map((h, i) => (
                                  <li key={i} className="text-[11px] leading-4 text-muted-foreground">
                                    · {h}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {item.claimId && (
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1 self-start px-2 text-xs text-muted-foreground"
                      >
                        <a href={`/dashboard/revenue-recovery/${item.claimId}`}>
                          Claim
                          <ArrowRight className="size-3" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Page {Math.min(page, pages)} of {pages}
          </p>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}