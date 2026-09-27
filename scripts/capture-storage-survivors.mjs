// READ-ONLY: capture the storage paths that SURVIVING Test Company rows still
// reference, so the storage purge can be verified as having spared exactly
// these and nothing more.
import { writeFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) { console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

const HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const TC = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";

const rest = async (path) => {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`REST ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const docs = await rest(`documents?select=storageId&tenantId=eq.${TC}`);
const files = await rest(`archivefiles?select=storageId&tenantId=eq.${TC}`);

const out = {
  documents: [...new Set(docs.map((d) => d.storageId).filter(Boolean))].sort(),
  archives: [...new Set(files.map((f) => f.storageId).filter(Boolean))].sort(),
};
writeFileSync("scripts/sql/storage-survivors.json", JSON.stringify(out, null, 2));
console.log(`documents rows: ${docs.length}, distinct paths: ${out.documents.length}`);
console.log(`archivefiles rows: ${files.length}, distinct paths: ${out.archives.length}`);
