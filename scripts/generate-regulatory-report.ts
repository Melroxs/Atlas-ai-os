import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";
import { WAVE_1_JURISDICTIONS } from "../src/lib/regulatory/catalog";

interface Row {
  jurisdiction_code: string;
  kind?: string;
  status?: string;
  verification_state?: string;
  resolution_status?: string;
  coverage_score?: number;
}

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before generating the regulatory report.");
const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const [sourcesResult, propositionsResult, reviewsResult, contradictionsResult, coverageResult] = await Promise.all([
  client.from("atlas_regulatory_sources").select("jurisdiction_code,kind,status"),
  client.from("atlas_regulatory_propositions").select("jurisdiction_code,verification_state"),
  client.from("atlas_regulatory_review_queue").select("jurisdiction_code,status"),
  client.from("atlas_regulatory_contradictions").select("jurisdiction_code,resolution_status"),
  client.from("atlas_regulatory_coverage").select("jurisdiction_code,coverage_score,last_acquisition,last_verification"),
]);
for (const result of [sourcesResult, propositionsResult, reviewsResult, contradictionsResult, coverageResult]) if (result.error) throw new Error(result.error.message);
const sources = (sourcesResult.data ?? []) as Row[];
const propositions = (propositionsResult.data ?? []) as Row[];
const reviews = (reviewsResult.data ?? []) as Row[];
const contradictions = (contradictionsResult.data ?? []) as Row[];
const coverage = (coverageResult.data ?? []) as Row[];
const rows = WAVE_1_JURISDICTIONS.map((jurisdiction) => {
  const sourceRows = sources.filter((row) => row.jurisdiction_code === jurisdiction.code);
  const propositionRows = propositions.filter((row) => row.jurisdiction_code === jurisdiction.code);
  const reviewRows = reviews.filter((row) => row.jurisdiction_code === jurisdiction.code && row.status === "OPEN");
  const contradictionRows = contradictions.filter((row) => row.jurisdiction_code === jurisdiction.code && row.resolution_status !== "RESOLVED_PRIMARY_PREVAILS");
  const coverageRow = coverage.find((row) => row.jurisdiction_code === jurisdiction.code);
  return `| ${jurisdiction.code} | ${sourceRows.length} | ${sourceRows.filter((row) => row.kind !== "secondary").length} | ${propositionRows.length} | ${propositionRows.filter((row) => row.verification_state === "VERIFIED").length} | ${reviewRows.length} | ${contradictionRows.length} | ${coverageRow ? `${Math.round(Number(coverageRow.coverage_score ?? 0) * 100)}%` : "0%"} |`;
});
const content = `# Atlas Regulatory Intelligence — Wave 1 Acquisition Report

**Generated:** ${new Date().toISOString()}  
**Source of counts:** persisted Supabase regulatory tables; no estimates are used.

## Wave 1 counts

| Jurisdiction | Sources | Primary | Propositions | Verified | Review | Contradictions | Coverage |
| ------------ | ------: | ------: | -----------: | -------: | -----: | -------------: | -------: |
${rows.join("\n")}

## Interpretation

Counts are proposition- and evidence-aware. Downloading a page does not make a jurisdiction complete. Secondary sources remain discovery-only, unverified material is not silently promoted, unresolved contradictions remain visible, and historical proposition versions remain addressable through the version tables.

If no migration or acquisition has been run, zeros are the correct output. The generator intentionally fails when durable database credentials are missing rather than generating a fabricated report.

## Operational references

- Migration: \`supabase/migrations/20260906_atlas_regulatory_intelligence.sql\`
- Schema verification: \`supabase/verification/20260906_atlas_regulatory_verification.sql\`
- Acquisition worker: \`scripts/acquire-regulatory-wave1.ts\`
- Queue processor: \`scripts/process-regulatory-jobs.ts\`
`;
await writeFile("REGULATORY_WAVE1_ACQUISITION_REPORT.md", content, "utf8");
console.log("Wrote REGULATORY_WAVE1_ACQUISITION_REPORT.md from persisted regulatory counts.");
