import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { DailyBriefingPanel } from "@/components/workforce/daily-briefing-panel";
import {
  ConfidenceBar,
  EmptyPanel,
  KnowledgeBadge,
  PageHeader,
  Panel,
  PriorityBadge,
  RecStatusBadge,
  StatCard,
  formatDate,
  titleCase,
} from "@/components/atlas-ui";
import { Button } from "@/components/ui/button";
import { useAction, useMutation, useQuery } from "@/hooks/use-supabase";
import {
  Activity,
  ArrowRight,
  BadgeDollarSign,
  ClipboardList,
  Compass,
  Database,
  FileSearch,
  FileUp,
  FlaskConical,
  MessageSquareText,
  Network,
  Radar,
  Search,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const NODE_COLORS: Record<string, string> = {
  claim: "oklch(0.7 0.16 20)",
  carrier: "oklch(0.78 0.115 230)",
  adjuster: "oklch(0.72 0.13 300)",
  policyholder: "oklch(0.802 0.14 80)",
  property: "oklch(0.7 0.13 155)",
  financial: "oklch(0.75 0.132 178)",
  organization: "oklch(0.8 0.1 250)",
  person: "oklch(0.8 0.14 80)",
  system: "oklch(0.72 0.12 210)",
  project: "oklch(0.75 0.13 178)",
  product: "oklch(0.75 0.13 178)",
  location: "oklch(0.75 0.13 178)",
  document: "oklch(0.75 0.13 178)",
  inspection: "oklch(0.72 0.13 300)",
  estimate: "oklch(0.802 0.14 80)",
  supplement: "oklch(0.78 0.115 230)",
  unknown: "oklch(0.6 0 0)",
};

function money(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function MiniGraph({ nodes, edges }: { nodes: Array<{ id: string; type: string }>; edges: Array<{ source: string; target: string }> }) {
  const W = 300;
  const H = 200;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(cx, cy) - 34;
  const visible = nodes.slice(0, 12);
  const pos = new Map(
    visible.map((n, i) => {
      const a = (i / Math.max(visible.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return [n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
    }),
  );
  if (visible.length === 0) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {edges.map((e, i) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="oklch(1 0 0 / 0.12)"
            strokeWidth="1"
          />
        );
      })}
      {visible.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const color = NODE_COLORS[n.type] ?? NODE_COLORS.unknown;
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r="7" fill={color} opacity="0.25" />
            <circle cx={p.x} cy={p.y} r="4" fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [quickAsk, setQuickAsk] = useState("");

  const workspace = useQuery(api.tenants.getMyWorkspace);
  const docStats = useQuery(api.documents.documentStats);
  const entityStats = useQuery(api.knowledge.entityStats);
  const recCounts = useQuery(api.recommendations.recommendationCounts);
  const recs = useQuery(api.recommendations.listRecommendations);
  const activity = useQuery(api.history.recentActivity);
  const graph = useQuery(api.knowledge.graphSnapshot);
  const claimCounts = useQuery(api.insurance.claims.claimCounts);
  const claims = useQuery(api.insurance.claims.listClaims, {});
  const seedDemo = useMutation(api.seed.seedDemoData);
  const runDetectors = useAction(api.recommendations.runDetectors);

  const [seeding, setSeeding] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const companyName = workspace?.profile?.companyName ?? "your workspace";

  const openRecs = (recs ?? []).filter((r) => r.status === "open");
  const pendingRecs = (recs ?? []).filter((r) => r.status !== "open" && r.status !== "dismissed");

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const res = await seedDemo();
      if (res.seeded) {
        toast.success("Demo knowledge loaded", {
          description: `${res.documents} documents · ${res.entities} entities · ${res.assertions} assertions`,
        });
      } else {
        toast.info("Demo data already loaded");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to seed demo data");
    } finally {
      setSeeding(false);
    }
  };

  const handleRunDetectors = async () => {
    setDetecting(true);
    try {
      const res = await runDetectors();
      toast.success("Comparison engine finished", {
        description: `${res.created} new signal${res.created === 1 ? "" : "s"}, ${res.closed} resolved`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Detectors failed");
    } finally {
      setDetecting(false);
    }
  };

  const submitAsk = () => {
    const q = quickAsk.trim();
    navigate(q ? `/dashboard/ask?q=${encodeURIComponent(q)}` : "/dashboard/ask");
  };

  const empty =
    (docStats?.total ?? 0) === 0 && (entityStats?.entities ?? 0) === 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Atlas Home"
        title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${user?.name?.split(" ")[0] ?? "there"}`}
        description={`This is the live state of ${companyName} as Atlas understands it — knowledge, signals and activity.`}
        actions={
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleRunDetectors}
            disabled={detecting}
          >
            <Radar className={`size-4 text-teal-600 dark:text-teal-300 ${detecting ? "animate-spin" : ""}`} />
            {detecting ? "Comparing…" : "Run comparison"}
          </Button>
        }
      />

      {/* Quick ask */}
      <div className="group relative">
        <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={quickAsk}
          onChange={(e) => setQuickAsk(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitAsk()}
          placeholder={`Ask Atlas about ${companyName}… e.g. "What's outstanding on claim 1042?"`}
          className="h-12 w-full rounded-xl border border-border/70 bg-card/70 pl-11 pr-28 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-teal-400/50 focus:ring-2 focus:ring-teal-400/20"
        />
        <button
          type="button"
          onClick={submitAsk}
          className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-lg bg-teal-400 px-3 py-1.5 text-xs font-semibold text-teal-950 transition-colors hover:bg-teal-300"
        >
          <MessageSquareText className="size-3.5" />
          Ask
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Database} label="Documents" value={docStats?.total ?? "—"} hint={`${docStats?.ready ?? 0} ready · ${docStats?.chunks ?? 0} chunks`} accent="text-cyan-600 dark:text-cyan-300" />
        <StatCard icon={Network} label="Entities" value={entityStats?.entities ?? "—"} hint={`${entityStats?.relationships ?? 0} relationships`} accent="text-teal-600 dark:text-teal-300" />
        <StatCard icon={Sparkles} label="Assertions" value={entityStats?.assertions ?? "—"} hint="labeled knowledge statements" accent="text-violet-600 dark:text-violet-300" />
        <StatCard icon={Target} label="Open signals" value={recCounts?.open ?? "—"} hint={`${recCounts?.executed ?? 0} executed · ${recCounts?.approved ?? 0} approved`} accent="text-amber-600 dark:text-amber-300" />
      </div>

      {/* Phase 11 — Revenue recovery (first vertical) */}
      <Panel>
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="size-4 text-emerald-600 dark:text-emerald-300" />
            Revenue recovery
          </h2>
          <button
            type="button"
            onClick={() => navigate("/dashboard/revenue-recovery")}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-emerald-700 dark:hover:text-emerald-200"
          >
            Open Revenue Recovery <ArrowRight className="size-3" />
          </button>
        </div>
        <div className="px-5 py-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300">
                <ClipboardList className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">Open claims</p>
                <p className="font-mono text-lg font-semibold text-foreground">
                  {claimCounts?.openClaims ?? "…"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {claimCounts?.attentionClaims ?? 0} need attention
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10 text-amber-600 dark:text-amber-300">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">Potential opportunities</p>
                <p className="font-mono text-lg font-semibold text-foreground">
                  {claimCounts?.openFindings ?? "…"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {claimCounts?.drafts ?? 0} draft · {claimCounts?.readyForSubmission ?? 0} ready supplements
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300">
                <BadgeDollarSign className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">Potential recovery</p>
                <p className="font-mono text-lg font-semibold text-foreground">
                  {money(claimCounts?.potential)}
                </p>
                <p className="text-[11px] text-muted-foreground">potential — never guaranteed</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-400/10 text-rose-600 dark:text-rose-300">
                <Activity className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">Potentially outstanding</p>
                <p className="font-mono text-lg font-semibold text-rose-600 dark:text-rose-300">
                  {money(claimCounts?.outstanding)}
                </p>
                <p className="text-[11px] text-muted-foreground">approved vs paid</p>
              </div>
            </div>
          </div>

          {(claims ?? []).length > 0 && (
            <div className="mt-4 border-t border-border/50 pt-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Claims needing attention
              </p>
              <div className="space-y-1.5">
                {(claims ?? [])
                  .filter(
                    (c) =>
                      c.openFindings > 0 ||
                      (c.outstanding ?? 0) > 0 ||
                      c.completeness < c.completenessTotal ||
                      c.hasDiscrepancy,
                  )
                  .slice(0, 3)
                  .map((c) => (
                    <button
                      key={c._id}
                      type="button"
                      onClick={() => navigate(`/dashboard/revenue-recovery/${c._id}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-left transition-colors hover:border-emerald-400/40 hover:bg-muted/40"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {c.customer ?? c.property ?? c.claimNumber ?? "Unnamed claim"}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {(c.status ?? "opened").replace(/_/g, " ")}
                          {c.openFindings > 0 && ` · ${c.openFindings} open finding${c.openFindings === 1 ? "" : "s"}`}
                          {c.completeness < c.completenessTotal && ` · ${c.completeness}/${c.completenessTotal} complete`}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs font-semibold text-rose-600 dark:text-rose-300">
                        {money(c.outstanding)}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Atlas Daily Briefing — digital employee overview */}
      <DailyBriefingPanel />

      {/* Phase 12 — quick commands (restoration MVP) */}
      <Panel
        title="Quick commands"
        description="The restoration demo journey — each command runs against your real claim records."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <button
            type="button"
            onClick={() => navigate(`/dashboard/ask?q=${encodeURIComponent("What money are we leaving on the table?")}`)}
            className="group flex items-start gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-left transition-all hover:border-emerald-400/50 hover:bg-emerald-400/10"
          >
            <BadgeDollarSign className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">Find missing revenue</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                “What are we leaving on the table?”
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/dashboard/revenue-recovery")}
            className="group flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 text-left transition-all hover:border-teal-400/40 hover:bg-muted/40"
          >
            <ClipboardList className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">Review claims</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Claims, packages & supplements
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/dashboard/ask?q=${encodeURIComponent("Build the claim package")}`)}
            className="group flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 text-left transition-all hover:border-sky-400/40 hover:bg-muted/40"
          >
            <Compass className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-300" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">Build claim package</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Verified, derived & missing labels
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/dashboard/ask?q=${encodeURIComponent("Find potential supplements")}`)}
            className="group flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 text-left transition-all hover:border-amber-400/50 hover:bg-amber-400/10"
          >
            <FileSearch className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">Find supplements</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Scan claims for opportunities
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/dashboard/ask")}
            className="group flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 text-left transition-all hover:border-teal-400/40 hover:bg-muted/40"
          >
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-teal-600 dark:text-teal-300" />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">Ask Atlas</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Talk or type anything
              </span>
            </span>
          </button>
        </div>
      </Panel>

      {/* Knowledge graph + recommendations */}
      <div className="grid gap-6 lg:grid-cols-5">
        <Panel className="lg:col-span-3">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Network className="size-4 text-teal-600 dark:text-teal-300" />
              Knowledge graph
            </h2>
            <button
              type="button"
              onClick={() => navigate("/dashboard/knowledge")}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-teal-700 dark:hover:text-teal-200"
            >
              Open knowledge base <ArrowRight className="size-3" />
            </button>
          </div>
          <div className="px-5 py-4">
            {graph && graph.nodes.length > 0 ? (
              <>
                <MiniGraph nodes={graph.nodes} edges={graph.edges} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(entityStats?.typeCounts ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([type, count]) => (
                      <span
                        key={type}
                        className="flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        <span
                          className="size-1.5 rounded-full"
                          style={{ background: NODE_COLORS[type] ?? NODE_COLORS.unknown }}
                        />
                        {titleCase(type)} · {count}
                      </span>
                    ))}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Network className="size-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">
                  No knowledge yet. Upload documents to grow your graph.
                </p>
                <div className="mt-4 flex gap-2">
                  <Button size="sm" onClick={() => navigate("/dashboard/knowledge")}>
                    <FileUp className="mr-2 size-3.5" />
                    Upload documents
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleSeed} disabled={seeding}>
                    <FlaskConical className="mr-2 size-3.5" />
                    {seeding ? "Loading…" : "Load demo"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Target className="size-4 text-amber-600 dark:text-amber-300" />
              Priority signals
            </h2>
            <button
              type="button"
              onClick={() => navigate("/dashboard/recommendations")}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-teal-700 dark:hover:text-teal-200"
            >
              All signals <ArrowRight className="size-3" />
            </button>
          </div>
          <div className="divide-y divide-border/50">
            {openRecs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
                <Sparkles className="size-6 text-emerald-700/70 dark:text-emerald-600 dark:text-emerald-300/70" />
                <p className="text-sm text-muted-foreground">
                  No open signals. Run the comparison engine to scan for gaps and risks.
                </p>
              </div>
            ) : (
              openRecs.slice(0, 3).map((r) => (
                <button
                  key={r._id}
                  type="button"
                  onClick={() => navigate("/dashboard/recommendations")}
                  className="block w-full px-5 py-3.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-center gap-2">
                    <PriorityBadge priority={r.priority} />
                    <span className="text-xs font-medium text-muted-foreground">
                      {formatDate(r.decidedAt ?? r._creationTime)}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-5">{r.title}</p>
                  <div className="mt-1.5">
                    <ConfidenceBar value={r.confidence} />
                  </div>
                </button>
              ))
            )}
            {pendingRecs.length > 0 && (
              <div className="flex items-center justify-between px-5 py-2.5 text-xs text-muted-foreground">
                <span>{pendingRecs.length} decided signal{pendingRecs.length === 1 ? "" : "s"} this period</span>
                <RecStatusBadge status={pendingRecs[0].status} />
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* Activity */}
      <Panel>
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-cyan-600 dark:text-cyan-300" />
            Recent activity
          </h2>
          <button
            type="button"
            onClick={() => navigate("/dashboard/audit")}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-teal-700 dark:hover:text-teal-200"
          >
            Audit log <ArrowRight className="size-3" />
          </button>
        </div>
        <div className="divide-y divide-border/50">
          {(activity ?? []).length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            (activity ?? []).slice(0, 8).map((log) => (
              <div key={log._id} className="flex items-start gap-3 px-5 py-3">
                <div className="mt-1 size-2 shrink-0 rounded-full bg-teal-400/70" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium capitalize">
                      {log.actionType.replace(/_/g, " ")}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {log.targetType ? `· ${titleCase(log.targetType)}` : ""}
                    </span>
                  </p>
                  {log.metadata && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
                      {JSON.stringify(log.metadata).slice(0, 120)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">{log.actorName ?? "system"}</p>
                  <p className="font-mono text-[10px] text-muted-foreground/60">
                    {formatDate(log._creationTime)}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>

      {/* Knowledge status strip */}
      {!empty && docStats && docStats.total > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono uppercase tracking-wider">Pipeline</span>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-emerald-600 dark:text-emerald-300">
            {docStats.ready} ready
          </span>
          {docStats.processing > 0 && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-amber-600 dark:text-amber-300">
              {docStats.processing} processing
            </span>
          )}
          {docStats.failed > 0 && (
            <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-rose-600 dark:text-rose-300">
              {docStats.failed} failed
            </span>
          )}
          <KnowledgeBadge classification="FACT" />
          <KnowledgeBadge classification="RULE" />
          <KnowledgeBadge classification="OBSERVATION" />
          <KnowledgeBadge classification="INFERENCE" />
          <KnowledgeBadge classification="RECOMMENDATION" />
        </div>
      )}

      {empty && (
        <EmptyPanel
          icon={Database}
          title="Your knowledge base is empty"
          description="Upload your first documents (SOPs, invoices, spreadsheets) or load the demo workspace to see Atlas in action."
          action={
            <div className="flex gap-2">
              <Button onClick={() => navigate("/dashboard/knowledge")}>
                <FileUp className="mr-2 size-4" />
                Upload documents
              </Button>
              <Button variant="outline" onClick={handleSeed} disabled={seeding}>
                <FlaskConical className="mr-2 size-4" />
                {seeding ? "Loading demo…" : "Load demo knowledge"}
              </Button>
            </div>
          }
        />
      )}
    </div>
  );
}
