// For every storage path that a SURVIVING row still references, check both
// buckets. archivefiles.storageId and documents.storageId share path strings,
// so a path can legitimately resolve in the documents bucket only.
import { readFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

const survivors = JSON.parse(readFileSync("scripts/sql/storage-survivors.json", "utf8"));

async function exists(bucket, path) {
  const res = await fetch(
    `${URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  return res.ok;
}

const allPaths = [...new Set([...(survivors.documents ?? []), ...(survivors.archives ?? [])])];

let ok = 0;
const gone = [];
for (const p of allPaths) {
  const inDocs = await exists("documents", p);
  const inArchives = await exists("archives", p);
  if (inDocs || inArchives) ok += 1;
  else gone.push(p);
  if (!inDocs && !inArchives) continue;
}

console.log(`distinct surviving paths: ${allPaths.length}`);
console.log(`resolvable in at least one bucket: ${ok}`);
console.log(`unresolvable everywhere: ${gone.length}`);
if (gone.length) for (const p of gone) console.log(`  GONE ${p}`);
console.log(gone.length === 0 ? "\nPASS: every surviving row's bytes are still on disk" : "\nFAIL: some surviving rows lost their bytes");
process.exit(gone.length === 0 ? 0 : 1);
