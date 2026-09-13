import { api } from "@/lib/api";
import { EmptyPanel, PageHeader, formatDate, titleCase } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@/hooks/use-supabase";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  FileText,
  ListChecks,
  Loader2,
  Radio,
} from "lucide-react";
import { useMemo, useState } from "react";

type Row = Record<string, any>;

const STATUS_TONE: Record<string, string> = {
  queued: "border-sky-400/30 bg-sky-400/10 text-sky-600 dark:text-sky-300",
  pending: "border-sky-400/30 bg-sky-400/10 text-sky-600 dark:text-sky-300",
  processing: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  retrying: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  current: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  unchanged: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  changed: "border-violet-400/30 bg-violet-400/10 text-violet-600 dark:text-violet-300",
  needs_review: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  stale: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  failed: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  unavailable: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  published: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  approved: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  opportunity: "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300",
};

function tone(status?: string | null): string {
  if (!status) return "border-border/70 bg-muted/40 text-muted-foreground";
  return STATUS_TONE[status] ?? "border-border/70 bg-muted/40 text-muted-foreground";
}

function StatusPill({ value }: { value?: string | null }) {
  if (!value) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        tone(value),
      )}
    >
      {titleCase(value)}
    </span>
  );
}

/** Bounded, collapsible list so large result sets never overwhelm the page. */
function BoundedList({
  rows,
  initial = 8,
  render,
  empty,
}: {
  rows: Row[];
  initial?: number;
  render: (row: Row, index: number) => React.ReactNode;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    );
  }
  const visible = open ? rows : rows.slice(0, initial);
  const hidden = rows.length - visible.length;
  return (
    <div className="space-y-2">
      {visible.map(render)}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Show {hidden} more
        </button>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  icon: Icon,
  toneClass,
}: {
  label: string;
  value: number | string;
  icon: typeof Database;
  toneClass?: string;
}) {
  return (
    <Card className="border-border/70 bg-card/60 p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", toneClass ?? "text-teal-600 dark:text-teal-300")} />
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    </Card>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
  defaultOpen = false,
  note,
}: {
  title: string;
  icon: typeof Database;
  children: React.ReactNode;
  defaultOpen?: boolean;
  note?: string;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border border-border/70 bg-card/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <Icon className="size-4 text-teal-600 dark:text-teal-300" />
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-4 pb-4">
        {note && <p className="text-xs leading-5 text-muted-foreground">{note}</p>}
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function PlatformOps() {
  const [tab, setTab] = useState("jobs");

  const jobStats = useQuery(api.jobs.stats);
  const failedJobs = useQuery(api.platform.failedJobs, { status: "failed", limit: 50 });
  const dueSources = useQuery(api.platform.listDueSources, { limit: 100 });
  const schedules = useQuery(api.platform.listSchedules);
  const content = useQuery(api.platform.listContent, { limit: 100 });

  const stats = jobStats ?? {};
  const byStatus: Row = useMemo(
    () => (stats.by_status && typeof stats.by_status === "object" ? stats.by_status : {}),
    [stats],
  );

  const dueSourceRows: Row[] = useMemo(() => (Array.isArray(dueSources) ? dueSources : []), [dueSources]);
  const scheduleRows: Row[] = useMemo(() => (Array.isArray(schedules) ? schedules : []), [schedules]);
  const contentRows: Row[] = useMemo(() => (Array.isArray(content) ? content : []), [content]);
  const failedRows: Row[] = useMemo(() => (Array.isArray(failedJobs) ? failedJobs : []), [failedJobs]);

  const staleish = dueSourceRows.filter((s) =>
    ["stale", "failed", "changed", "needs_review"].includes(String(s.freshness ?? "")),
  );
  const published = contentRows.filter((c) => c.status === "published");
  const pendingReview = contentRows.filter((c) => c.status === "in_review" || c.approvalStatus === "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform Operations"
        description="Background jobs, knowledge source freshness, schedules and the content pipeline. Infrastructure visibility only — nothing here publishes automatically."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Queue depth" value={Number(stats.queue_depth ?? 0)} icon={ListChecks} />
        <SummaryTile
          label="Processing"
          value={Number(stats.processing_count ?? 0)}
          icon={Loader2}
          toneClass="text-amber-600 dark:text-amber-300"
        />
        <SummaryTile
          label="Failed (24h)"
          value={Number(stats.failed_24h ?? 0)}
          icon={CircleAlert}
          toneClass="text-rose-600 dark:text-rose-300"
        />
        <SummaryTile
          label="Sources due"
          value={dueSourceRows.length}
          icon={Radio}
          toneClass="text-violet-600 dark:text-violet-300"
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="space-y-3">
          <Panel
            title="Job status"
            icon={ListChecks}
            defaultOpen
            note="Durable job state from the canonical atlas_jobs queue. Failed jobs stay failed and visible; nothing is silently marked complete."
          >
            <div className="flex flex-wrap gap-2">
              {Object.keys(byStatus).length === 0 ? (
                <span className="text-xs text-muted-foreground">No jobs recorded yet.</span>
              ) : (
                Object.entries(byStatus).map(([status, count]) => (
                  <span key={status} className="flex items-center gap-2">
                    <StatusPill value={status} />
                    <span className="text-xs tabular-nums text-foreground/80">{String(count)}</span>
                  </span>
                ))
              )}
            </div>
          </Panel>

          <Panel
            title={`Failed jobs (${failedRows.length})`}
            icon={CircleAlert}
            note="Bounded sample. Retrying a failed job is an explicit operator action, not automatic."
          >
            <BoundedList
              rows={failedRows}
              empty="No failed jobs."
              render={(row) => (
                <div
                  key={String(row.id ?? row._id)}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                >
                  <StatusPill value={row.status} />
                  <span className="text-xs font-medium text-foreground">
                    {String(row.job_type ?? "unknown")}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    attempts {String(row.attempt_count ?? 0)}/{String(row.max_attempts ?? 0)}
                  </span>
                  {row.updated_at && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatDate(row.updated_at)}
                    </span>
                  )}
                </div>
              )}
            />
          </Panel>
        </TabsContent>

        <TabsContent value="knowledge" className="space-y-3">
          <Panel
            title={`Sources due for a check (${dueSourceRows.length})`}
            icon={Radio}
            defaultOpen
            note="A source that has not been checked recently is never presented as freshly verified. Checks that find no change are recorded and stop — they never trigger reprocessing."
          >
            <BoundedList
              rows={dueSourceRows}
              empty="Every enabled source is within its freshness window."
              render={(row) => (
                <div
                  key={String(row.sourceId)}
                  className="rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill value={row.freshness} />
                    <span className="text-xs font-medium text-foreground">{String(row.name ?? row.sourceId)}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {String(row.authorityTier ?? "")}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>last checked {row.lastCheckedAt ? formatDate(row.lastCheckedAt) : "never"}</span>
                    {row.nextCheckAt ? <span>next {formatDate(row.nextCheckAt)}</span> : null}
                    {row.consecutiveFailures ? <span>failures {String(row.consecutiveFailures)}</span> : null}
                    {row.lastFetchError ? <span className="text-rose-500">{String(row.lastFetchError)}</span> : null}
                  </div>
                </div>
              )}
            />
          </Panel>

          <Panel
            title={`Stale or failing (${staleish.length})`}
            icon={CircleAlert}
            note="Knowledge that drifted out of its freshness window and must be re-checked or reviewed."
          >
            <BoundedList
              rows={staleish}
              empty="No stale sources."
              render={(row) => (
                <div
                  key={`stale-${String(row.sourceId)}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                >
                  <StatusPill value={row.freshness} />
                  <span className="text-xs font-medium text-foreground">{String(row.name ?? row.sourceId)}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {row.lastChangedAt ? `changed ${formatDate(row.lastChangedAt)}` : "no recorded change"}
                  </span>
                </div>
              )}
            />
          </Panel>
        </TabsContent>

        <TabsContent value="schedules" className="space-y-3">
          <Panel
            title={`Recurring schedules (${scheduleRows.length})`}
            icon={Clock}
            defaultOpen
            note="Each schedule enqueues into the same durable job queue — it never runs work directly. A failing schedule backs off and stays visible instead of disappearing."
          >
            <BoundedList
              rows={scheduleRows}
              empty="No schedules registered."
              render={(row) => {
                const failures = Number(row.consecutive_failures ?? 0);
                const health = !row.enabled ? "paused" : failures === 0 ? "current" : failures < 3 ? "stale" : "failed";
                return (
                  <div
                    key={String(row.name)}
                    className="rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill value={health} />
                      <span className="text-xs font-medium text-foreground">{String(row.name)}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {String(row.job_type)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                      <span>every {Math.round(Number(row.interval_seconds ?? 0) / 60)}m</span>
                      {row.last_run_at ? <span>last {formatDate(row.last_run_at)}</span> : <span>never run</span>}
                      {row.next_run_at ? <span>next {formatDate(row.next_run_at)}</span> : null}
                      <span>{row.tenant_id ? "tenant" : "platform"} scope</span>
                      {failures > 0 ? <span className="text-rose-500">failures {failures}</span> : null}
                    </div>
                  </div>
                );
              }}
            />
          </Panel>
        </TabsContent>

        <TabsContent value="content" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile label="Items" value={contentRows.length} icon={FileText} />
            <SummaryTile label="Awaiting review" value={pendingReview.length} icon={Clock} toneClass="text-amber-600 dark:text-amber-300" />
            <SummaryTile label="Published" value={published.length} icon={CircleCheck} />
          </div>

          <Panel
            title={`Content pipeline (${contentRows.length})`}
            icon={FileText}
            defaultOpen
            note="Foundation only: publishing is not implemented. Every item must be explicitly approved by a human before publication, and each retains its knowledge/source provenance."
          >
            <BoundedList
              rows={contentRows}
              empty="No content items yet."
              render={(row) => (
                <div
                  key={String(row._id)}
                  className="rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill value={row.status} />
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {String(row.contentType ?? "")}
                    </Badge>
                    <span className="text-xs font-medium text-foreground">{String(row.title ?? "")}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>{Array.isArray(row.sourceIds) ? row.sourceIds.length : 0} source(s)</span>
                    <span>{Array.isArray(row.knowledgeIds) ? row.knowledgeIds.length : 0} knowledge item(s)</span>
                    {row.parentContentId ? <span>derived from parent</span> : null}
                    {row.publishedAt ? <span>published {formatDate(row.publishedAt)}</span> : null}
                  </div>
                </div>
              )}
            />
          </Panel>
        </TabsContent>
      </Tabs>

      {dueSourceRows.length === 0 && contentRows.length === 0 && scheduleRows.length === 0 && failedRows.length === 0 && (
        <EmptyPanel
          icon={Database}
          title="No platform activity yet"
          description="Schedules, source checks and content only appear once the platform migration is applied and the worker runs. Atlas shows an honest empty state instead of placeholder data."
        />
      )}
    </div>
  );
}
