// Inspect what actually sits in the Test Company folder and identify the
// unexplained top-level folders.
import { readFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const TC = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";

async function listUnder(bucket, prefix) {
  const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify({ prefix, limit: 1000 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = await res.json();
  return Array.isArray(page) ? page : [];
}

for (const bucket of ["archives", "documents"]) {
  console.log(`\n===== ${bucket} : contents of ${TC}/ =====`);
  const tc = await listUnder(bucket, `${TC}/`);
  for (const o of tc) console.log(`  id=${o.id ? "OBJ " : "DIR "} ${o.name}`);
  console.log(`  (${tc.length} entries)`);
}

console.log("\n===== sample unknown top-level folders in documents =====");
const folders = await listUnder("documents", "");
const unknown = folders.map((f) => f.name).filter((n) => n !== TC).slice(0, 5);
for (const f of unknown) {
  const inner = await listUnder("documents", `${f}/`);
  console.log(`  ${f} -> ${inner.length} entries; sample: ${inner.slice(0, 2).map((o) => `${o.id ? "OBJ" : "DIR"} ${o.name}`).join(" | ")}`);
}
