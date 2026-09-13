// ---------------------------------------------------------------------------
// CollectionBrowser — scalable Collection → Group → Item browsing.
//
// Solves the "endless vertical list" problem: records are grouped into
// collapsible collections with counts; groups render compact rows; search and
// status filters narrow everything; pagination bounds DOM size. Works equally
// well with 50 or 50,000 records.
// ---------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  filterBySearch,
  paginate,
  totalPages,
  type CollectionGroup,
} from "@/lib/workforce/selectors";

export interface CollectionFilter<T> {
  key: string;
  label: string;
  /** True when the item matches this filter. */
  test: (item: T) => boolean;
}

export interface CollectionBrowserProps<T> {
  /** Grouped records (use groupByKey from selectors). */
  groups: CollectionGroup<T>[];
  /** Searchable text fields. */
  searchFields: Array<(item: T) => string | null | undefined>;
  /** Optional status filters. */
  filters?: Array<CollectionFilter<T>>;
  /** Render one row per item. */
  renderRow: (item: T) => ReactNode;
  /** Collapse everything when groups exceed this many items. */
  autoCollapseAbove?: number;
  /** Rows to render per expanded group page. */
  pageSize?: number;
  /** Search placeholder. */
  searchPlaceholder?: string;
  /** Called for each item row with the group label (for context badges). */
  emptyDescription?: string;
  /** Optional header action node. */
  headerAction?: ReactNode;
}

export function CollectionBrowser<T>({
  groups,
  searchFields,
  filters = [],
  renderRow,
  autoCollapseAbove = 12,
  pageSize = 50,
  searchPlaceholder = "Search…",
  emptyDescription = "No records match this view.",
  headerAction,
}: CollectionBrowserProps<T>) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => {
        let items = g.items;
        if (activeFilter !== "all") {
          const f = filters.find((f) => f.key === activeFilter);
          if (f) items = items.filter(f.test);
        }
        if (q) items = filterBySearch(items, q, searchFields);
        return { ...g, items, count: items.length };
      })
      .filter((g) => g.count > 0);
  }, [groups, query, activeFilter, filters, searchFields]);

  const totalItems = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.count, 0),
    [filteredGroups],
  );

  const toggle = (key: string) => {
    setPage(1);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (expand: boolean) => {
    setPage(1);
    setOpen(expand ? new Set(filteredGroups.map((g) => g.key)) : new Set());
  };

  const hasOpen = (key: string) =>
    open.has(key) ||
    (filteredGroups.find((g) => g.key === key)?.count ?? 0) <= autoCollapseAbove;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder={searchPlaceholder}
            className="h-8 pl-8 text-xs"
            aria-label={searchPlaceholder}
          />
        </div>
        {filters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setActiveFilter("all");
                setPage(1);
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
                activeFilter === "all"
                  ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                  : "border-border/70 text-muted-foreground hover:border-teal-400/30",
              )}
            >
              All
            </button>
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  setActiveFilter(f.key);
                  setPage(1);
                }}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors",
                  activeFilter === f.key
                    ? "border-teal-400/40 bg-teal-400/10 text-teal-700 dark:text-teal-200"
                    : "border-border/70 text-muted-foreground hover:border-teal-400/30",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {headerAction}
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {filteredGroups.length} group{filteredGroups.length === 1 ? "" : "s"} · {totalItems.toLocaleString()} item{totalItems === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => toggleAll(true)}
            className="rounded-md border border-border/70 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:border-teal-400/30 hover:text-teal-600 dark:hover:text-teal-300"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            className="rounded-md border border-border/70 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:border-teal-400/30 hover:text-teal-600 dark:hover:text-teal-300"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* Groups */}
      {filteredGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-8 text-center text-sm text-muted-foreground">
          {emptyDescription}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredGroups.map((group) => {
            const expanded = hasOpen(group.key);
            const pages = totalPages(group.count, pageSize);
            const safePage = Math.min(page, pages);
            const visibleItems = paginate(group.items, safePage, pageSize);
            return (
              <div
                key={group.key}
                className="overflow-hidden rounded-xl border border-border/70 bg-card/50"
              >
                {/* Collection header — always visible */}
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <FolderOpen className="size-4 shrink-0 text-teal-600 dark:text-teal-300" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {group.label}
                  </span>
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {group.count.toLocaleString()} item{group.count === 1 ? "" : "s"}
                  </Badge>
                  {expanded ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </button>

                {/* Expanded rows */}
                {expanded && (
                  <div className="border-t border-border/50">
                    <div className="divide-y divide-border/40">
                      {visibleItems.map((item, i) => (
                        <div key={i} className="px-4 py-2">
                          {renderRow(item)}
                        </div>
                      ))}
                    </div>
                    {pages > 1 && (
                      <div className="flex items-center justify-between border-t border-border/40 px-4 py-2">
                        <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                          Page {safePage} of {pages}
                        </p>
                        <div className="flex gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={safePage <= 1}
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                          >
                            Previous
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={safePage >= pages}
                            onClick={() => setPage((p) => Math.min(pages, p + 1))}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}