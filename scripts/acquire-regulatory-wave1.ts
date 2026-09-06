import { createClient } from "@supabase/supabase-js";
import { RegulatoryAcquisitionWorker } from "../src/lib/regulatory/acquisition";
import { RegulatorySourceDiscovery } from "../src/lib/regulatory/discovery";
import { SupabaseRegulatoryStore } from "../src/lib/regulatory/store";
import { WAVE_1_JURISDICTIONS } from "../src/lib/regulatory/catalog";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY before running regulatory acquisition.");
}

const allowWave1B = process.argv.includes("--allow-wave1b");
const requestedCodes = process.argv.slice(2).filter((value) => /^[A-Z]{2}$/.test(value));
const codes = requestedCodes.length ? requestedCodes : WAVE_1_JURISDICTIONS.map((jurisdiction) => jurisdiction.code);
const wave1A = ["FL", "TX", "CA", "NY", "CO"];
if (!allowWave1B && codes.some((code) => !wave1A.includes(code)) && !wave1A.every((code) => codes.includes(code))) {
  throw new Error("Wave 1B acquisition is gated: complete and verify Wave 1A first, then rerun with --allow-wave1b.");
}

const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseRegulatoryStore(client);
const discovery = new RegulatorySourceDiscovery();
const worker = new RegulatoryAcquisitionWorker(store, discovery);

const results = [];
for (const code of codes) {
  const jurisdiction = WAVE_1_JURISDICTIONS.find((candidate) => candidate.code === code);
  if (!jurisdiction) throw new Error(`Unknown Wave 1 jurisdiction: ${code}`);
  console.log(`Acquiring ${code} — ${jurisdiction.name}`);
  const result = await worker.acquire(jurisdiction);
  results.push(result);
  console.log(JSON.stringify({ code, sources: result.sources.length, propositions: result.propositions, verified: result.verified, review: result.reviewItems.length, contradictions: result.contradictions, coverage: result.coverage.coverageScore }, null, 2));
}

console.log("WAVE1_ACQUISITION_RESULT");
console.log(JSON.stringify(results.map((result) => ({ jurisdiction: result.jurisdiction.code, ...result.coverage })), null, 2));
