import { PageHeader } from "@/components/atlas-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getSupabaseClient } from "@/lib/supabase";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface CoverageRow {
  jurisdiction_code: string;
  sources_discovered: number;
  primary_sources: number;
  secondary_sources: number;
  sources_fetched: number;
  propositions_extracted: number;
  propositions_verified: number;
  propositions_requiring_review: number;
  contradictions: number;
  stale_sources: number;
  topics_covered: string[];
  topics_incomplete: string[];
  source_freshness?: string;
  coverage_score: number;
  last_acquisition?: string;
  last_verification?: string;
}

interface JobRow {
  id: string;
  jurisdiction_code: string;
  status: string;
  attempt_count: number;
  requested_at: string;
  error?: { message?: string };
}

export default function RegulatoryDashboard() {
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const client = getSupabaseClient();

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    const [coverageResult, jobsResult] = await Promise.all([
      client.from("atlas_regulatory_coverage").select("*").order("jurisdiction_code"),
      client.from("atlas_regulatory_acquisition_jobs").select("*").order("requested_at", { ascending: false }).limit(50),
    ]);
    if (coverageResult.error) toast.error(coverageResult.error.message);
    if (jobsResult.error) toast.error(jobsResult.error.message);
    setCoverage((coverageResult.data ?? []) as CoverageRow[]);
    setJobs((jobsResult.data ?? []) as JobRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const enqueue = async (code: string) => {
    if (!client) return;
    setBusy(code);
    const { error } = await client.rpc("atlas_regulatory_enqueue", { p_jurisdiction_code: code });
    if (error) toast.error(error.message);
    else toast.success(`${code} acquisition queued`);
    setBusy(null);
    await load();
  };

  const formatDate = (value?: string) => value ? new Date(value).toLocaleString() : "—";
  const statusClass = (status: string) => status === "COMPLETED" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" : status === "FAILED" ? "border-red-500/30 bg-red-500/10 text-red-700" : "border-amber-500/30 bg-amber-500/10 text-amber-700";

  return (
    <div className="space-y-6">
      <PageHeader title="Regulatory Intelligence" description="Wave 1 acquisition, evidence provenance, verification, and coverage. Unverified material is never silently promoted." />
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
        <strong className="text-foreground">Safety invariant:</strong> secondary sources remain discovery-only. A proposition becomes verified only after an accessible, jurisdiction-matched primary authority, resolved citation, supporting evidence, date analysis, and contradiction review.
      </div>
      <section className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 className="font-semibold">Jurisdiction coverage</h2>
            <p className="text-sm text-muted-foreground">Actual persisted counts; an empty state is not treated as complete.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="p-3">Jurisdiction</th><th className="p-3">Sources</th><th className="p-3">Primary</th><th className="p-3">Fetched</th><th className="p-3">Propositions</th><th className="p-3">Verified</th><th className="p-3">Review</th><th className="p-3">Contradictions</th><th className="p-3">Coverage</th><th className="p-3" /></tr></thead>
            <tbody>{coverage.map((row) => <tr key={row.jurisdiction_code} className="border-b last:border-0"><td className="p-3 font-medium">{row.jurisdiction_code}</td><td className="p-3">{row.sources_discovered}</td><td className="p-3">{row.primary_sources}</td><td className="p-3">{row.sources_fetched}</td><td className="p-3">{row.propositions_extracted}</td><td className="p-3">{row.propositions_verified}</td><td className="p-3">{row.propositions_requiring_review}</td><td className="p-3">{row.contradictions}</td><td className="p-3">{Math.round(row.coverage_score * 100)}%</td><td className="p-3"><Button size="sm" variant="outline" disabled={busy === row.jurisdiction_code} onClick={() => void enqueue(row.jurisdiction_code)}>{busy === row.jurisdiction_code ? "Queueing…" : "Acquire"}</Button></td></tr>)}{!loading && coverage.length === 0 && <tr><td className="p-6 text-center text-muted-foreground" colSpan={10}>No coverage has been persisted yet. Seed the migration, then queue Florida first.</td></tr>}</tbody>
          </table>
        </div>
      </section>
      <section className="rounded-lg border bg-card">
        <div className="border-b p-4"><h2 className="font-semibold">Acquisition jobs</h2><p className="text-sm text-muted-foreground">Queue state is separate from source content and does not mutate raw evidence.</p></div>
        <div className="divide-y">{jobs.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="font-medium">{job.jurisdiction_code} acquisition</div><div className="text-xs text-muted-foreground">Requested {formatDate(job.requested_at)} · attempt {job.attempt_count}</div>{job.error?.message && <div className="text-xs text-red-600">{job.error.message}</div>}</div><Badge variant="outline" className={statusClass(job.status)}>{job.status}</Badge></div>)}{jobs.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No acquisition jobs yet.</div>}</div>
      </section>
      <p className="text-xs text-muted-foreground">Last refreshed from persisted regulatory tables. Source details, citations, evidence locations, versions, and human-review records remain available through the database adapter and review queue.</p>
    </div>
  );
}
