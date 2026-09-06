// ---------------------------------------------------------------------------
// Regulatory Intelligence — the Atlas regulatory layer dashboard.
//
// Reads the source-grounded regulatory registry: 51 jurisdictions, the source
// registry (with authority tiers), regulatory propositions (with verification
// states), contradictions, freshness, and observable acquisition jobs.
//
// Honesty rules baked into this page:
//   * State-level coverage starts at zero verified propositions — shown as
//     RESEARCH_INCOMPLETE, never as "no law exists".
//   * The coverage score measures configured acquisition targets, not legal
//     completeness (a 100 is "targets met", not "Atlas knows all law").
//   * Secondary sources are labeled discovery-only; only primary sources can
//     be cited as controlling authority.
//   * Acquisition jobs are observable; a failed fetch is recorded as failed.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  FileSearch,
  Landmark,
  Loader2,
  Scale,
  Search,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyPanel, PageHeader } from "@/components/atlas-ui";
import { isInternalRole } from "@/lib/auth/access-gate";
import { useAuth } from "@/hooks/use-auth";
import { JURISDICTIONS, PRIORITY_STATES } from "@/lib/regulatory/jurisdictions";
import { SEED_ALL_SOURCES, SEED_PROPOSITIONS } from "@/lib/regulatory/seed";
import { computeJurisdictionCoverage } from "@/lib/regulatory/completeness";
import type { JurisdictionCoverage } from "@/lib/regulatory/types";
import { SUPPLEMENT_TOPICS } from "@/lib/regulatory/taxonomy";
import { VERIFICATION_STATUS_LABELS } from "@/lib/regulatory/verification";
import { detectRegulatoryContradictions } from "@/lib/regulatory/contradictions";
import {
  runFreshnessMonitor,
  InMemoryRegulatoryStore,
  runAcquisitionPipeline,
  DEFAULT_FETCH_POLICY as DEFAULT_POLICY,
} from "@/lib/regulatory/pipeline";
import { filterBySearch, paginate, totalPages } from "@/lib/workforce/selectors";
import { cn } from "@/lib/utils";

const STATUS_CLS: Record<JurisdictionCoverage["status"], string> = {
  READY: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  PARTIAL: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  NEEDS_REVIEW: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  RESEARCH_INCOMPLETE: "border-border/70 bg-muted/20 text-muted-foreground",
};

const FRESHNESS_CLS: Record<string, string> = {
  CURRENT: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
  RECENT: "border-teal-400/30 bg-teal-400/10 text-teal-600 dark:text-teal-300",
  AGING: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  STALE: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
  UNKNOWN: "border-border/70 bg-muted/20 text-muted-foreground",
};

const SUPPLEMENT_LABELS: Record<string, string> = {
  explicitly_regulated: "Explicitly regulated",
  indirectly_regulated: "Indirectly regulated",
  no_identified_specific_provision: "No identified provision",
  insufficient_evidence: "Insufficient evidence",
  research_incomplete: "Research incomplete",
};

const PAGE_SIZE = 15;

/** The app-wide in-memory regulatory store (seeded registry). */
export function createRegulatoryStore() {
  const store = new InMemoryRegulatoryStore();
  for (const s of SEED_ALL_SOURCES) store.upsertSource(s);
  for (const p of SEED_PROPOSITIONS) store.upsertProposition(p);
  return store;
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "default" | "positive" | "warning" | "danger" | "accent";
}) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    positive: "text-emerald-600 dark:text-emerald-300",
    warning: "text-amber-600 dark:text-amber-300",
    danger: "text-rose-600 dark:text-rose-300",
    accent: "text-teal-600 dark:text-teal-300",
  };
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 px-3 py-2.5">
      <p className={cn("font-mono text-xl font-semibold tabular-nums", tones[tone ?? "default"])}>{value}</p>
      <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{label}</p>
    </div>
  );
}

export default function RegulatoryIntelligence() {
  const { role } = useAuth();
  const isAdmin = isInternalRole(role);

  // Registry state (in-memory store seeded from code — same model as the
  // knowledge corpus; the pending migration adds durable persistence).
  const [store, setStore] = useState(() => createRegulatoryStore());
  const [scanning, setScanning] = useState(false);
  const [scanLog, setScanLog] = useState<string[]>([]);

  const [jurSearch, setJurSearch] = useState("");
  const [jurStatus, setJurStatus] = useState<string>("all");
  const [jurPage, setJurPage] = useState(1);

  const [srcSearch, setSrcSearch] = useState("");
  const [srcTier, setSrcTier] = useState<string>("all");
  const [srcPage, setSrcPage] = useState(1);

  const sources = useMemo(() => store.getSources(), [store]);
  const propositions = useMemo(() => store.getPropositions(), [store]);
  const jobs = useMemo(() => store.getJobs(), [store]);

  const contradictions = useMemo(
    () => detectRegulatoryContradictions({ propositions, sources }),
    [propositions, sources],
  );
  const openContradictions = contradictions.filter((c) => c.status === "OPEN");

  const freshnessMonitor = useMemo(
    () => runFreshnessMonitor(sources),
    [sources],
  );

  const coverage = useMemo(
    () =>
      JURISDICTIONS.map((j) =>
        computeJurisdictionCoverage({
          jurisdiction: j,
          sources: sources.filter((s) => s.jurisdictionId === j.jurisdictionId),
          propositions,
          contradictionCount: openContradictions.filter((c) => c.jurisdictionId === j.jurisdictionId).length,
          configuredTargetTopics: SUPPLEMENT_TOPICS,
        }),
      ),
    [sources, propositions, openContradictions],
  );

  const verifiedProps = propositions.filter((p) => p.verificationStatus === "VERIFIED");
  const registeredSources = sources.filter((s) => s.status === "REGISTERED");
  const verifiedSources = sources.filter((s) => s.status === "VERIFIED");

  // -------------------------------------------------------------------------
  // Admin action: run an observable acquisition scan over the registry.
  // Fetch is disabled in the browser (SSRF guard off / CORS); the pipeline
  // records honest partial/failed states — nothing is fabricated.
  // -------------------------------------------------------------------------
  const runAcquisitionScan = async () => {
    setScanning(true);
    const log: string[] = [];
    const nextStore = createRegulatoryStore();
    for (const code of PRIORITY_STATES) {
      const j = JURISDICTIONS.find((x) => x.stateCode === code);
      if (!j) continue;
      const targets = sources.filter(
        (s) => s.jurisdictionId === j.jurisdictionId && s.status === "REGISTERED",
      );
      for (const src of targets.slice(0, 2)) {
        const result = await runAcquisitionPipeline(
          {
            source: src,
            jurisdictionId: j.jurisdictionId,
            topic: "claims_practices",
            fetchPolicy: { ...DEFAULT_POLICY, enabled: false },
            initiatedBy: role ?? "admin",
          },
          nextStore,
        );
        const lastJob = result.jobs[result.jobs.length - 1];
        log.push(
          `${code} · ${src.sourceType} · ${lastJob?.status ?? "?"} · ${lastJob?.error ?? "recorded"}`,
        );
      }
    }
    setStore(nextStore);
    setScanLog(log);
    setScanning(false);
  };

  const jurFiltered = coverage.filter((c) => {
    if (jurStatus !== "all" && c.status !== jurStatus) return false;
    const j = JURISDICTIONS.find((x) => x.jurisdictionId === c.jurisdictionId);
    return filterBySearch([c], jurSearch, [
      () => c.jurisdictionId,
      () => j?.name,
      () => j?.stateCode,
    ]).length > 0;
  });

  const srcFiltered = sources.filter((s) => {
    if (srcTier !== "all" && s.authorityTier !== Number(srcTier)) return false;
    return filterBySearch([s], srcSearch, [
      () => s.title,
      () => s.publisher,
      () => s.sourceType,
      () => s.sourceId,
    ]).length > 0;
  });

  const jurRows = paginate(jurFiltered, jurPage, PAGE_SIZE);
  const srcRows = paginate(srcFiltered, srcPage, PAGE_SIZE);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Atlas intelligence layer"
        title="Regulatory Intelligence"
        description="Source-grounded U.S. insurance restoration regulatory knowledge: 50 states + D.C., authority-tiered sources, verified propositions, temporal versioning, contradictions, and freshness. State-level coverage is research-incomplete until the acquisition pipeline verifies official sources."
        actions={
          isAdmin ? (
            <Button size="sm" variant="outline" disabled={scanning} onClick={() => void runAcquisitionScan()}>
              {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <FileSearch className="size-3.5" />}
              {scanning ? "Scanning registry…" : "Run acquisition scan"}
            </Button>
          ) : undefined
        }
      />

      {/* Honesty banner */}
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Coverage is not legal completeness.</span>{" "}
          The <span className="font-mono">regulatory_intelligence_coverage_score</span> measures configured
          acquisition/verification targets. No state law is represented as verified yet — every state starts at
          zero verified propositions, and &quot;not found&quot; is represented as insufficient evidence, never as
          &quot;does not exist&quot;.
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Jurisdictions" value={JURISDICTIONS.length} tone="accent" />
        <MetricCard label="Registered sources" value={registeredSources.length} />
        <MetricCard label="Verified sources" value={verifiedSources.length} tone="positive" />
        <MetricCard label="Verified propositions" value={verifiedProps.length} tone="positive" />
        <MetricCard label="Open contradictions" value={openContradictions.length} tone={openContradictions.length > 0 ? "danger" : "default"} />
        <MetricCard label="Stale sources" value={freshnessMonitor.staleSources.length} tone={freshnessMonitor.staleSources.length > 0 ? "warning" : "default"} />
      </div>

      {/* Jurisdiction coverage */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Jurisdiction coverage</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            {jurFiltered.length} / {JURISDICTIONS.length}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={jurSearch}
                onChange={(e) => {
                  setJurSearch(e.target.value);
                  setJurPage(1);
                }}
                placeholder="Search state or code…"
                className="h-8 w-48 pl-8 text-xs"
                aria-label="Search jurisdictions"
              />
            </div>
            <select
              value={jurStatus}
              onChange={(e) => {
                setJurStatus(e.target.value);
                setJurPage(1);
              }}
              className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs text-muted-foreground"
              aria-label="Filter by coverage status"
            >
              <option value="all">All statuses</option>
              <option value="READY">READY</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
              <option value="RESEARCH_INCOMPLETE">RESEARCH_INCOMPLETE</option>
            </select>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border/70 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Jurisdiction</th>
                  <th className="px-3 py-2 font-medium">Coverage</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Sources</th>
                  <th className="px-3 py-2 font-medium">Verified</th>
                  <th className="px-3 py-2 font-medium">Supplement</th>
                  <th className="px-3 py-2 font-medium">Freshness</th>
                  <th className="px-3 py-2 font-medium">Gaps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {jurRows.map((c) => {
                  const j = JURISDICTIONS.find((x) => x.jurisdictionId === c.jurisdictionId);
                  return (
                    <tr key={c.jurisdictionId} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <span className="font-mono text-[10px] font-semibold text-muted-foreground">{j?.stateCode}</span>
                        <span className="ml-1.5 font-medium text-foreground">{j?.name}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={cn("font-mono text-[9px] uppercase tracking-wide", STATUS_CLS[c.status])}>
                          {c.status.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{c.regulatoryIntelligenceCoverageScore}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{c.sourceCount}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{c.verifiedPropositionCount}</td>
                      <td className="px-3 py-2 text-muted-foreground">{SUPPLEMENT_LABELS[c.supplementState ?? "research_incomplete"]}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={cn("font-mono text-[9px]", FRESHNESS_CLS[c.freshness])}>
                          {c.freshness}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{c.gaps.length}</td>
                    </tr>
                  );
                })}
                {jurRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      No jurisdictions match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              page {jurPage} / {totalPages(jurFiltered.length, PAGE_SIZE)}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={jurPage <= 1} onClick={() => setJurPage((p) => p - 1)}>
                Prev
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={jurPage >= totalPages(jurFiltered.length, PAGE_SIZE)} onClick={() => setJurPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Federal verified propositions */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <BookOpenCheck className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Verified federal propositions</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{verifiedProps.length}</Badge>
        </div>
        {verifiedProps.length === 0 ? (
          <EmptyPanel
            icon={Scale}
            title="No verified propositions yet"
            description="The acquisition pipeline has not verified any proposition against a fetched official source."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70">
            {verifiedProps.map((p) => {
              const src = sources.find((s) => s.sourceId === p.sourceId);
              return (
                <div key={p.propositionId} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                      {VERIFICATION_STATUS_LABELS[p.verificationStatus]}
                    </Badge>
                    <span className="text-xs font-medium text-foreground">{p.topic.replace(/_/g, " ")}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{p.citation}</span>
                    <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">
                      tier {p.authorityTier}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{p.ruleText}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                    {src?.title} · {src?.publisher}
                    {src?.canonicalUrl ? ` · ${src.canonicalUrl}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Source registry */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Source registry</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{srcFiltered.length}</Badge>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={srcSearch}
                onChange={(e) => {
                  setSrcSearch(e.target.value);
                  setSrcPage(1);
                }}
                placeholder="Search sources…"
                className="h-8 w-44 pl-8 text-xs"
                aria-label="Search sources"
              />
            </div>
            <select
              value={srcTier}
              onChange={(e) => {
                setSrcTier(e.target.value);
                setSrcPage(1);
              }}
              className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs text-muted-foreground"
              aria-label="Filter by authority tier"
            >
              <option value="all">All tiers</option>
              <option value="1">Tier 1 · Primary</option>
              <option value="2">Tier 2 · Interpretive</option>
              <option value="3">Tier 3 · Industry</option>
              <option value="4">Tier 4 · Secondary</option>
            </select>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border/70 bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Publisher</th>
                  <th className="px-3 py-2 font-medium">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {srcRows.map((s) => (
                  <tr key={s.sourceId} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium text-foreground">{s.title}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{s.sourceType.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{s.authorityTier}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "font-mono text-[9px]",
                          s.status === "VERIFIED"
                            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300"
                            : s.status === "FAILED"
                              ? "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300"
                              : "text-muted-foreground",
                        )}
                      >
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{s.publisher}</td>
                    <td className="max-w-[240px] truncate px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
                      {s.canonicalUrl ?? "—"}
                    </td>
                  </tr>
                ))}
                {srcRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                      No sources match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border/70 px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              page {srcPage} / {totalPages(srcFiltered.length, PAGE_SIZE)}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={srcPage <= 1} onClick={() => setSrcPage((p) => p - 1)}>
                Prev
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={srcPage >= totalPages(srcFiltered.length, PAGE_SIZE)} onClick={() => setSrcPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Contradictions */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Regulatory contradictions</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{openContradictions.length}</Badge>
        </div>
        {openContradictions.length === 0 ? (
          <EmptyPanel
            icon={ShieldAlert}
            title="No open contradictions"
            description="Contradictions are explicit records, never silently resolved. When two sources conflict, both are preserved and surfaced here."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70">
            {openContradictions.map((c) => (
              <div key={c.contradictionId} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[9px] uppercase tracking-wide",
                      c.severity === "HIGH"
                        ? "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300"
                        : "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
                    )}
                  >
                    {c.severity}
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">{c.kind.replace(/_/g, " ")}</span>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">{c.jurisdictionId}</span>
                  <Badge variant="outline" className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {c.status}
                  </Badge>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{c.detail}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Acquisition jobs */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Acquisition jobs</h2>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">{jobs.length}</Badge>
        </div>
        {jobs.length === 0 && scanLog.length === 0 ? (
          <EmptyPanel
            icon={FileSearch}
            title="No acquisition jobs recorded"
            description="The pipeline (DISCOVERY → FETCH → PARSE → CLASSIFY → EXTRACT → NORMALIZE → RESOLVE CITATION → VERIFY → VERSION → INDEX → EMBED → QUALITY CHECK → PUBLISH) is ready. Every stage is observable; nothing is auto-verified."
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border border-border/70">
            {scanLog.map((line, i) => (
              <div key={i} className="px-4 py-2 font-mono text-[10px] text-muted-foreground">
                {line}
              </div>
            ))}
            {jobs.map((j) => (
              <div key={j.jobId} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[9px]",
                    j.status === "completed"
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300"
                      : j.status === "failed"
                        ? "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300"
                        : j.status === "partial"
                          ? "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300"
                          : "text-muted-foreground",
                  )}
                >
                  {j.status}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">{j.stage}</span>
                <span className="font-mono text-[10px] text-muted-foreground/70">{j.sourceId}</span>
                {j.error && <span className="text-[10px] text-rose-500">{j.error}</span>}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{new Date(j.createdAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Admin note */}
      {isAdmin && (
        <p className="text-[11px] leading-5 text-muted-foreground">
          Admin actions: the acquisition scan runs the observable pipeline over the priority-state registry.
          In the browser, fetching official state sites is blocked (SSRF guard / CORS) and recorded honestly —
          run acquisition where network access exists (CLI/CI) to fetch and verify sources. Secondary sources
          can never become verified primary authority.
        </p>
      )}
    </div>
  );
}