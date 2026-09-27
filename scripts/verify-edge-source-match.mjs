// Check that a DEPLOYED edge function corresponds to the repository's expected
// implementation, by asserting the things that can actually be proven.
//
// WHAT THIS TOOL DOES NOT DO
// It does NOT prove byte-level source equivalence, and must not be read as
// doing so. The Supabase bundler transpiles TypeScript to JavaScript, strips
// type annotations and reformats, so the repository source can never appear
// verbatim in the deployed bundle. A verbatim/whitespace-insensitive
// containment test is therefore NOT a valid assertion: it fails even when the
// deployment is perfectly correct. Such a check is reported below as
// DIAGNOSTIC ONLY and never affects the exit status.
//
// WHAT THIS TOOL ASSERTS (and fails loudly on)
//   * the function is deployed, with metadata readable
//   * every --require marker appears in the deployed bundle
//   * every --action case label appears in the deployed bundle's action switch
// Any missing marker/action is a hard failure (exit 1).
//
// Usage:
//   node scripts/verify-edge-source-match.mjs <slug> \
//        --require <marker> [--require <marker> ...] \
//        --action <case_label> [--action <case_label> ...]
//
// Reads SUPABASE_ACCESS_TOKEN from the environment (env or .env.local), the
// repository's standard mechanism. The project ref follows the convention in
// scripts/list-functions.mjs: env override, else the documented Atlas ref.
// Read-only. Prints no secrets.

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
const required = [];
const actions = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--require") required.push(argv[++i] ?? "");
  else if (argv[i] === "--action") actions.push(argv[++i] ?? "");
  else if (argv[i].startsWith("--")) {
    console.error(`unknown option ${argv[i]}`);
    process.exit(2);
  }
}
if (!slug || required.length === 0) {
  console.error(
    "usage: node scripts/verify-edge-source-match.mjs <slug> --require <marker> [--action <case>]",
  );
  process.exit(2);
}
if (required.some((m) => !m) || actions.some((a) => !a)) {
  console.error("--require / --action need a non-empty value");
  process.exit(2);
}

const hdr = { Authorization: `Bearer ${TOKEN}` };
const base = `https://api.supabase.com/v1/projects/${REF}/functions/${slug}`;

const metaRes = await fetch(base, { headers: hdr });
if (!metaRes.ok) {
  console.error(`FAIL  function "${slug}" is not deployed in ${REF} (HTTP ${metaRes.status})`);
  process.exit(1);
}
const meta = await metaRes.json();

const bodyRes = await fetch(`${base}/body`, { headers: hdr });
if (!bodyRes.ok) {
  console.error(`FAIL  deployed body for "${slug}" unreadable (HTTP ${bodyRes.status})`);
  process.exit(1);
}
const bundle = await bodyRes.text();

console.log(`slug        ${meta.slug}`);
console.log(`status      ${meta.status}`);
console.log(`verify_jwt  ${meta.verify_jwt}`);
console.log(`updated_at  ${new Date(Number(meta.updated_at)).toISOString()}`);
console.log(`bundle      ${bundle.length} bytes`);
console.log("");

let failures = 0;

console.log("ASSERTIONS (a failure here is a real mismatch):");
console.log(`  ok  deployment exists: ${meta.slug}`);

for (const m of required) {
  const present = bundle.includes(m);
  if (!present) failures++;
  console.log(`  ${present ? "ok  " : "FAIL"}  required marker present: ${JSON.stringify(m)}`);
}

const cases = new Set([...bundle.matchAll(/case\s+"([a-z_]+)"/g)].map((x) => x[1]));
for (const a of actions) {
  const present = cases.has(a);
  if (!present) failures++;
  console.log(`  ${present ? "ok  " : "FAIL"}  action case label present: ${JSON.stringify(a)}`);
}

console.log("");
console.log("DIAGNOSTIC ONLY (NOT asserted, and deliberately excluded from the exit status):");
let src = "";
try {
  src = readFileSync(`supabase/functions/${slug}/index.ts`, "utf8");
  const squeeze = (s) => s.replace(/\s+/g, "");
  const contained = squeeze(bundle).includes(squeeze(src));
  console.log(
    `  source text verbatim inside bundle: ${contained}` +
      (contained
        ? ""
        : "  <- expected; the bundler transpiles TypeScript, so this is normal and is NOT a defect"),
  );
} catch {
  console.log("  (no local source file in this checkout; containment check skipped)");
}
console.log("  NOTE: source equivalence is NOT proven by this tool. Markers and action");
console.log("        labels are evidence of correspondence, not proof of identical source.");

console.log("");
if (failures > 0) {
  console.error(`RESULT: FAILED — ${failures} assertion(s) did not hold.`);
  process.exit(1);
}
console.log(`RESULT: VERIFIED — deployment present and all ${required.length + actions.length} marker/action assertion(s) hold.`);
console.log("        (source equivalence remains unproven by design; see DIAGNOSTIC ONLY above)");
