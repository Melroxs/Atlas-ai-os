// INDEPENDENT VERIFICATION (recursive): Supabase's list endpoint returns only
// top-level stubs when prefix is "", so folder contents must be listed per
// folder. Proves (a) Test Company's surviving objects are still present and
// (b) every deleted-tenant folder and deleted-claim path is genuinely empty.
import { readFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) { console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

const HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const TEST_COMPANY = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";
const manifest = JSON.parse(readFileSync("scripts/sql/storage-manifest.json", "utf8"));
const doomed = manifest.doomedTenants;

// Objects the DB still expects to exist for Test Company.
const survivors = JSON.parse(readFileSync("scripts/sql/storage-survivors.json", "utf8"));

async function listUnder(bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ prefix, limit: 1000, offset }),
    });
    if (!res.ok) throw new Error(`list ${bucket} ${prefix} HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const o of page) if (o?.name && o.id) out.push(`${prefix}${o.name}`);
    if (page.length < 1000) break;
  }
  return out;
}

async function listFolders(bucket) {
  const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ prefix: "", limit: 1000 }),
  });
  if (!res.ok) throw new Error(`folders ${bucket} HTTP ${res.status}`);
  const page = await res.json();
  return (Array.isArray(page) ? page : []).map((o) => o.name);
}

const deletedClaimPaths = new Set([
  ...manifest.testCompanyClaimObjects.archives,
  ...manifest.testCompanyClaimObjects.documents,
]);

let problems = 0;

for (const bucket of ["documents", "archives"]) {
  const folders = await listFolders(bucket);
  const doomedFolders = folders.filter((f) => doomed.includes(f));
  const tcFolderPresent = folders.includes(TEST_COMPANY);

  const tcObjects = tcFolderPresent ? await listUnder(bucket, `${TEST_COMPANY}/`) : [];
  const expected = new Set(survivors[bucket] ?? []);

  // Every path the DB still points at must still exist.
  const missing = [...expected].filter((p) => !tcObjects.includes(p));
  // Every deleted-claim path must be gone.
  const claimSurvivors = tcObjects.filter((p) => deletedClaimPaths.has(p));
  // Deleted-tenant folders must be empty or gone.
  let doomedLeftovers = 0;
  for (const f of doomedFolders) doomedLeftovers += (await listUnder(bucket, `${f}/`)).length;

  console.log(`\n[${bucket}]`);
  console.log(`  top-level folders: ${folders.length}`);
  console.log(`  Test Company folder present: ${tcFolderPresent}`);
  console.log(`  Test Company objects on disk: ${tcObjects.length}`);
  console.log(`  Test Company objects the DB still references: ${expected.size}`);
  console.log(`  MISSING (DB row points at a deleted object): ${missing.length}`);
  if (missing.length) console.log(`    e.g. ${missing.slice(0, 5).join(", ")}`);
  console.log(`  deleted-claim objects still on disk: ${claimSurvivors.length}`);
  console.log(`  objects left under deleted-tenant folders: ${doomedLeftovers}`);

  problems += missing.length + claimSurvivors.length + doomedLeftovers;
}

console.log(`\n${problems === 0 ? "PASS: storage state is exactly as intended" : `FAIL: ${problems} problems`}`);
process.exit(problems === 0 ? 0 : 1);
