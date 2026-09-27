// Fingerprint a DEPLOYED edge function by content, so "did production actually
// change?" is answered by content rather than by Supabase's `version` field.
//
// IMPORTANT SEMANTIC NOTE:
// Supabase's function `version` is a PROJECT-WIDE deploy counter, not a
// per-function revision — it increments for every function deployed in the
// project. It is therefore NOT evidence about any single function, and this
// tool never treats it as such.
//
// The hashes reported here are deliberately NOT conflated:
//   repo_source_md5  md5 of the repository source file on disk
//   bundle_md5       md5 of the whole deployed bundle returned by the API
//   marker_region_md5  md5 of the deployed bundle from an explicit marker to
//                       the end. ONLY computed when --marker is supplied and
//                       found; the tool exits non-zero if the marker is absent,
//                       so a missing marker can never yield a hash of a
//                       meaningless slice.
//
// Usage:
//   node scripts/fingerprint-function.mjs <slug> [--marker <string>]
//
// Reads SUPABASE_ACCESS_TOKEN from the environment (env or .env.local), which
// is the repository's standard mechanism. The project ref follows the existing
// convention used by scripts/list-functions.mjs and scripts/verify-production.mjs:
// an env override if one is set, otherwise the documented Atlas project ref.
// Read-only. Prints no secrets.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function parseEnvFile(file) {
  const out = {};
  try {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* missing */
  }
  return out;
}

const env = { ...parseEnvFile(".env.local"), ...process.env };
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const REF = env.SUPABASE_PROJECT_REF || "ibxvzxblyhzwokljkslt";
if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN not set (env or .env.local)");
  process.exit(2);
}

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
let marker = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--marker") marker = argv[++i] ?? null;
  else if (argv[i].startsWith("--")) {
    console.error(`unknown option ${argv[i]}`);
    process.exit(2);
  }
}
if (!slug) {
  console.error("usage: node scripts/fingerprint-function.mjs <slug> [--marker <string>]");
  process.exit(2);
}

const md5 = (s) => createHash("md5").update(s).digest("hex");
const hdr = { Authorization: `Bearer ${TOKEN}` };
const base = `https://api.supabase.com/v1/projects/${REF}/functions/${slug}`;

// A function that does not exist must fail loudly, not print an empty report.
const metaRes = await fetch(base, { headers: hdr });
if (!metaRes.ok) {
  console.error(`function "${slug}" not found in project ${REF}: HTTP ${metaRes.status}`);
  console.error((await metaRes.text()).slice(0, 300));
  process.exit(1);
}
const meta = await metaRes.json();

const bodyRes = await fetch(`${base}/body`, { headers: hdr });
if (!bodyRes.ok) {
  console.error(`could not read deployed body for "${slug}": HTTP ${bodyRes.status}`);
  process.exit(1);
}
const bundle = await bodyRes.text();

// Repository source, hashed honestly as repository source.
let repoSourceMd5 = "n/a (no local source file)";
let repoSourcePath = `supabase/functions/${slug}/index.ts`;
try {
  repoSourceMd5 = md5(readFileSync(repoSourcePath, "utf8"));
} catch {
  repoSourcePath = "(not present in this checkout)";
}

console.log(`slug                ${meta.slug}`);
console.log(`project_ref         ${REF}`);
console.log(`deploy_version      ${meta.version}   (PROJECT-WIDE counter - not per-function evidence)`);
console.log(`updated_at          ${new Date(Number(meta.updated_at)).toISOString()}`);
console.log(`status              ${meta.status}`);
console.log(`verify_jwt          ${meta.verify_jwt}`);
console.log(`entrypoint_path     ${meta.entrypoint_path ?? "(none)"}`);
console.log(`bundle_bytes        ${bundle.length}`);
console.log(`bundle_md5          ${md5(bundle)}`);
console.log(`repo_source         ${repoSourcePath}`);
console.log(`repo_source_md5     ${repoSourceMd5}`);

if (marker !== null) {
  const idx = bundle.indexOf(marker);
  if (idx < 0) {
    console.error(`\nMARKER NOT FOUND in the deployed bundle: ${JSON.stringify(marker)}`);
    console.error("Refusing to report a marker_region_md5 for a marker that does not exist.");
    process.exit(1);
  }
  const region = bundle.slice(idx);
  console.log(`marker              ${JSON.stringify(marker)} at offset ${idx}`);
  console.log(`marker_region_bytes ${region.length}`);
  console.log(`marker_region_md5   ${md5(region)}`);
}

const cases = [...new Set([...bundle.matchAll(/case\s+"([a-z_]+)"/g)].map((m) => m[1]))].sort();
console.log(`action_case_labels  (${cases.length}) ${cases.join(" ")}`);
