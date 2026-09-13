// ---------------------------------------------------------------------------
// ClaimsTable — compact, scalable claim rows for worker surfaces.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ClaimSnapshot } from "@/lib/insurance/logic";
import {
  filterBySearch,
  paginate,
  totalPages,
  type ClaimAttentionTag,
} from "@/lib/workforce/selectors";

const ATTENTION_META: Record<ClaimAttentionTag, { label: string; cls: string }> = {
  at_risk: { label: "At risk", cls: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300" },
  incomplete: { label: "Incomplete", cls: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300" },
  stalled: { label: "Stalled", cls: "border-border/70 bg-muted/30 text-muted-foreground" },
  new: { label: "New", cls: "border-sky-400/30 bg-sky-400/10 text-sky-600 dark:text-sky-300" },
  ready: { label: "Ready", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300" },
};

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function ClaimsTable({
  rows,
  pageSize = 10,
}: {
  rows: Array<{ claim: ClaimSnapshot; attention: ClaimAttentionTag | null; outstanding: number | null }>;
  pageSize?: number;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let items = rows;
    if (status === "attention") items = items.filter((r) => r.attention !== null);
    if (status === "open") items = items.filter((r) => !["closed", "rejected"].includes(String(r.claim.status ?? "").toLowerCase()));
    return filterBySearch(items, query, [
      (r) => r.claim.claimNumber,
      (r) => r.claim.customer,
      (r) => r.claim.property,
      (r) => r.claim.carrier,
      (r) => String(r.claim.status ?? ""),
    ]);
  }, [rows, query, status]);

  const pages = totalPages(filtered.length, pageSize);
  const pageRows = paginate(filtered, Math.min(page, pages), pageSize);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search claim #, customer, property, carrier…"
            className="h-8 pl-8 text-xs"
            aria-label="Search claims"
          />
        </div>
        {[
          { key: "all", label: "All" },
          { key: "attention", label: "Needs attention" },
          { key: "open", label: "Open" },
        ].map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setStatus(f.key);
              setPage(1);
            }}
            className={cn(
              "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
              status === f.key
                ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                : "border-border/70 text-muted-foreground hover:border-teal-400/30",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {filtered.length} claim{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {pageRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-8 text-center text-sm text-muted-foreground">
          No claims match this view.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/50">
          <div className="divide-y divide-border/50">
            {pageRows.map(({ claim, attention, outstanding }) => (
              <button
                key={String(claim._id ?? "")}
                type="button"
                onClick={() => navigate(`/dashboard/revenue-recovery/${claim._id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium text-foreground">
                      {claim.claimNumber ?? String(claim._id ?? "").slice(0, 8)}
                    </span>
                    <span className="truncate text-sm font-medium text-foreground">
                      {claim.customer ?? claim.property ?? "Unknown customer"}
                    </span>
                    {attention && (
                      <Badge variant="outline" className={cn("shrink-0 font-mono text-[9px] uppercase tracking-wide", ATTENTION_META[attention].cls)}>
                        {ATTENTION_META[attention].label}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {[claim.property, claim.carrier, claim.status ? `status: ${claim.status}` : null]
                      .filter(Boolean)
                      .join(" · ") || "No details yet"}
                  </p>
                </div>
                {outstanding !== null && (
                  <span className="shrink-0 font-mono text-xs font-semibold text-rose-600 dark:text-rose-300">
                    {money(outstanding)}
                  </span>
                )}
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}

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
    </div>
  );
}