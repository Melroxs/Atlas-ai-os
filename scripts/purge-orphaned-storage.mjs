// Purge every Supabase Storage object orphaned by the approved deletion,
// using the manifest captured BEFORE any rows were removed.
//
// Robustness:
//  - removes objects individually (the batch endpoint is all-or-nothing)
//  - retries on 429/5xx with exponential backoff
//  - checkpoints progress to disk so a rate-limited run can be resumed
import { readFileSync, writeFileSync } from "node:fs";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) { console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

// Bodyless DELETE: must NOT advertise application/json, or the API rejects
// the empty body with "Body cannot be empty when content-type is set".
const DELETE_HEADERS = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const CHECKPOINT = "scripts/sql/storage-purge-progress.json";

const manifest = JSON.parse(readFileSync("scripts/sql/storage-manifest.json", "utf8"));

const targets = new Map();
const add = (bucket, paths) => {
  if (!paths || !paths.length) return;
  if (!targets.has(bucket)) targets.set(bucket, new Set());
  const set = targets.get(bucket);
  for (const p of paths) if (p) set.add(p);
};
add("documents", manifest.doomedObjects.documents);
add("archives", manifest.doomedObjects.archives);
add("archives", manifest.testCompanyClaimObjects.archives);
add("documents", manifest.testCompanyClaimObjects.documents);

let done;
try {
  done = new Set(JSON.parse(readFileSync(CHECKPOINT, "utf8")).done ?? []);
} catch {
  done = new Set();
}
const save = () => writeFileSync(CHECKPOINT, JSON.stringify({ done: [...done] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeOne(bucket, path) {
  const url = `${URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { method: "DELETE", headers: DELETE_HEADERS });
    if (res.ok) return "removed";
    // Storage reports a missing key as HTTP 400 with code "NoSuchKey",
    // not as 404. Either shape means the object is already gone.
    if (res.status === 404) return "absent";
    const text = await res.text().catch(() => "");
    if (/NoSuchKey|not_found/i.test(text)) return "absent";
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(500 * 2 ** attempt, 15000));
      continue;
    }
    return { error: res.status, body: text.slice(0, 200) };
  }
  return { error: "retries exhausted", body: url };
}

const failures = [];
let removed = 0;
let alreadyAbsent = 0;
let resumed = 0;

for (const [bucket, set] of targets) {
  const pending = [...set].filter((p) => !done.has(`${bucket}:${p}`));
  resumed += [...set].length - pending.length;
  console.log(`${bucket}: ${pending.length} pending (${resumed} already checkpointed)`);

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const r = await removeOne(bucket, p);
    if (r === "removed") removed += 1;
    else if (r === "absent") alreadyAbsent += 1;
    else failures.push({ bucket, path: p, ...r });
    done.add(`${bucket}:${p}`);
    if ((i + 1) % 50 === 0) save();
    await sleep(20); // stay well under the rate limiter
  }
  save();
  console.log(`  ${bucket} done`);
}

console.log(`\nremoved this run: ${removed}`);
console.log(`already absent: ${alreadyAbsent}`);
console.log(`total checkpointed: ${done.size}`);
if (failures.length) {
  console.error(`FAILURES: ${failures.length}`);
  for (const f of failures.slice(0, 20)) console.error(`  ${f.bucket} ${f.path} -> ${f.error} ${f.body}`);
  process.exit(1);
}
console.log("storage purge complete");
