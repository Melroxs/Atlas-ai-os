import { createClient } from "@supabase/supabase-js";
import { WAVE_1_JURISDICTIONS, JURISDICTIONS } from "../src/lib/regulatory/catalog";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before verifying the regulatory schema.");
const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const tables = [
  "atlas_regulatory_jurisdictions",
  "atlas_regulatory_sources",
  "atlas_regulatory_source_versions",
  "atlas_regulatory_propositions",
  "atlas_regulatory_proposition_versions",
  "atlas_regulatory_contradictions",
  "atlas_regulatory_review_queue",
  "atlas_regulatory_coverage",
  "atlas_regulatory_acquisition_jobs",
];
const counts: Record<string, number> = {};
for (const table of tables) {
  const result = await client.from(table).select("*", { count: "exact", head: true });
  if (result.error) throw new Error(`${table}: ${result.error.message}`);
  counts[table] = result.count ?? 0;
}
if (counts.atlas_regulatory_jurisdictions !== JURISDICTIONS.length) throw new Error(`Expected ${JURISDICTIONS.length} jurisdictions, found ${counts.atlas_regulatory_jurisdictions}.`);
const waveResult = await client.from("atlas_regulatory_jurisdictions").select("code").eq("wave", 1);
if (waveResult.error) throw new Error(`Wave 1 seed query failed: ${waveResult.error.message}`);
if ((waveResult.data ?? []).length !== WAVE_1_JURISDICTIONS.length) throw new Error(`Expected ${WAVE_1_JURISDICTIONS.length} Wave 1 records, found ${(waveResult.data ?? []).length}.`);
console.log(JSON.stringify({ passed: true, counts, jurisdictions: counts.atlas_regulatory_jurisdictions, wave1: (waveResult.data ?? []).length }, null, 2));
