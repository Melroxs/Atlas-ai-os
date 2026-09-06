import { createClient } from "@supabase/supabase-js";
import { RegulatoryAcquisitionWorker } from "../src/lib/regulatory/acquisition";
import { RegulatorySourceDiscovery } from "../src/lib/regulatory/discovery";
import { SupabaseRegulatoryStore } from "../src/lib/regulatory/store";
import { WAVE_1_JURISDICTIONS } from "../src/lib/regulatory/catalog";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before processing regulatory jobs.");
const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseRegulatoryStore(client);
const worker = new RegulatoryAcquisitionWorker(store, new RegulatorySourceDiscovery());
const workerId = process.env.REGULATORY_WORKER_ID ?? `regulatory-worker-${process.pid}`;

const { data: jobs, error } = await client.from("atlas_regulatory_acquisition_jobs").select("*").in("status", ["PENDING", "RETRYING"]).order("requested_at").limit(Number(process.env.REGULATORY_JOB_BATCH ?? 5));
if (error) throw new Error(`Failed to load acquisition jobs: ${error.message}`);
for (const job of jobs ?? []) {
  const claim = await client.from("atlas_regulatory_acquisition_jobs").update({ status: "PROCESSING", attempt_count: (job.attempt_count ?? 0) + 1, started_at: new Date().toISOString() }).eq("id", job.id).in("status", ["PENDING", "RETRYING"]).select("id").maybeSingle();
  if (claim.error || !claim.data) continue;
  try {
    const jurisdiction = WAVE_1_JURISDICTIONS.find((candidate) => candidate.code === job.jurisdiction_code);
    if (!jurisdiction) throw new Error(`Unknown Wave 1 jurisdiction: ${job.jurisdiction_code}`);
    const result = await worker.acquire(jurisdiction);
    const update = await client.from("atlas_regulatory_acquisition_jobs").update({ status: "COMPLETED", result: { workerId, coverage: result.coverage, sources: result.sources.length, propositions: result.propositions, verified: result.verified, review: result.reviewItems.length, contradictions: result.contradictions }, completed_at: new Date().toISOString() }).eq("id", job.id);
    if (update.error) throw new Error(update.error.message);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const nextStatus = (job.attempt_count ?? 0) + 1 >= (job.max_attempts ?? 3) ? "FAILED" : "RETRYING";
    const update = await client.from("atlas_regulatory_acquisition_jobs").update({ status: nextStatus, error: { workerId, message }, completed_at: nextStatus === "FAILED" ? new Date().toISOString() : null }).eq("id", job.id);
    if (update.error) console.error(`Failed to record job ${job.id} failure: ${update.error.message}`);
    console.error(`Regulatory job ${job.id} ${nextStatus}: ${message}`);
  }
}
