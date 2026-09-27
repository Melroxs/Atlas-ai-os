// Capture the CURRENT deployed definition of one or more public Postgres
// functions into a timestamped audit file.
//
// SAFETY CONTRACT (this tool writes audit evidence — it must never destroy it):
//   * The output path is NEVER hardcoded. Without --out a unique timestamped
//     path is generated, so two runs can never collide.
//   * An existing file is NEVER overwritten by default. The run aborts with a
//     non-zero exit and prints the exact command needed to proceed.
//   * --force must be passed explicitly to replace a file.
//   * The captured content is labelled from the HASHES, never from the
//     filename. A capture is only called "pre-change" when every
//     --expect-md5 hash actually matches what production returned.
//
// Usage:
//   node scripts/backup-function-defs.mjs <fn> [<fn> ...] [options]
//
//   --out <path>          write here instead of a generated timestamped path
//   --label <text>        human label recorded in the file header
//   --expect-md5 <f=md5>   assert this function's prosrc hash (repeatable);
//                         a mismatch marks the capture UNVERIFIED and exits 1
//   --force               allow replacing an existing --out file
//   --dry-run             print the resolved output path and exit without writing
//
// Reads SUPABASE_ACCESS_TOKEN from the environment (env or .env.local), the
// repository's standard mechanism. The project ref follows the convention in
// scripts/list-functions.mjs: env override, else the documented Atlas ref.
// Prints no secrets.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const fns = [];
let outPath = null;
let label = null;
let force = false;
let dryRun = false;
const expectMd5 = new Map();

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") outPath = argv[++i];
  else if (a === "--label") label = argv[++i];
  else if (a === "--force") force = true;
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--expect-md5") {
    const spec = argv[++i] ?? "";
    const eq = spec.indexOf("=");
    if (eq < 1) {
      console.error(`--expect-md5 expects <function>=<md5>, got "${spec}"`);
      process.exit(2);
    }
    expectMd5.set(spec.slice(0, eq).trim(), spec.slice(eq + 1).trim());
  } else if (a.startsWith("--")) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else fns.push(a);
}

if (fns.length === 0) {
  console.error("usage: node scripts/backup-function-defs.mjs <fn> [<fn> ...] [--out <path>] [--label <text>] [--expect-md5 <f=md5>] [--force] [--dry-run]");
  process.exit(2);
}

// ------------------------------------------------------- resolve output path
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const safeLabel = (label ?? "function-defs").replace(/[^A-Za-z0-9._-]+/g, "-");
const target = resolve(outPath ?? `scripts/sql/backups/${safeLabel}-${stamp}.sql`);

if (existsSync(target) && !force) {
  console.error(`REFUSING TO OVERWRITE an existing file:\n  ${target}`);
  console.error(
    "\nThat file may be committed audit evidence. Choose a different --out path,",
  );
  console.error("omit --out for a fresh timestamped file, or pass --force to replace it deliberately.");
  process.exit(1);
}

if (dryRun) {
  console.log(`dry-run: would write ${target}`);
  console.log(`functions: ${fns.join(", ")}`);
  process.exit(0);
}

// ------------------------------------------------------------------ capture
const api = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const q = async (query) => {
  const res = await fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

const list = fns.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
const rows = await q(`
  select p.proname as name,
         pg_get_function_identity_arguments(p.oid) as args,
         md5(p.prosrc) as md5,
         p.prosecdef as security_definer,
         p.provolatile as volatile,
         p.proisstrict as strict,
         coalesce(array_to_string(p.proconfig, ','), 'none') as config,
         p.prosrc as src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (${list})
  order by p.proname;`);

if (!rows.length) {
  console.error(`no such function(s) in public schema: ${fns.join(", ")}`);
  process.exit(1);
}

const found = new Set(rows.map((r) => r.name));
const missing = fns.filter((f) => !found.has(f));
if (missing.length) {
  console.error(`not found in public schema: ${missing.join(", ")}`);
  process.exit(1);
}

// A capture may only be called "pre-change" if every asserted hash matches.
let verified = expectMd5.size > 0;
const mismatches = [];
for (const [fn, want] of expectMd5) {
  const row = rows.find((r) => r.name === fn);
  if (!row) {
    mismatches.push(`${fn}: not found`);
    continue;
  }
  if (row.md5 !== want) mismatches.push(`${fn}: expected ${want}, got ${row.md5}`);
}
if (mismatches.length) verified = false;

const stampIso = new Date().toISOString();
const header = [
  `-- Atlas function-definition audit capture`,
  `-- captured_at_utc : ${stampIso}`,
  `-- project_ref     : ${REF}`,
  `-- label           : ${label ?? "(none)"}`,
  `-- functions       : ${fns.join(", ")}`,
  `-- overall_md5     : ${createHash("md5").update(rows.map((r) => r.src).join("\n")).digest("hex")}`,
  verified
    ? `-- pre_change      : VERIFIED — every --expect-md5 hash matched production`
    : expectMd5.size
      ? `-- pre_change      : UNVERIFIED — hash mismatch, see below. Do NOT treat as pre-change evidence.`
      : `-- pre_change      : UNCLAIMED — no --expect-md5 supplied, so this is only a capture of current state`,
  ...(mismatches.length ? mismatches.map((m) => `-- MISMATCH          ${m}`) : []),
  `--`,
  `-- This file records the state of production at the timestamp above. It is`,
  `-- NOT automatically a "before" snapshot; only the --expect-md5 checks above`,
  `-- can establish that.`,
  ``,
].join("\n");

const body = rows
  .map(
    (r) =>
      `### ${r.name}(${r.args})\n` +
      `prosrc_md5=${r.md5}\n` +
      `security_definer=${r.security_definer} volatile=${r.volatile} strict=${r.strict} config=${r.config}\n\n${r.src}`,
  )
  .join("\n\n");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${header}${body}\n`);

console.log(`wrote ${target}`);
console.log(`functions: ${rows.map((r) => `${r.name}=${r.md5}`).join("  ")}`);
console.log(`pre_change: ${verified ? "VERIFIED" : expectMd5.size ? "UNVERIFIED" : "UNCLAIMED"}`);

if (!verified) {
  if (mismatches.length) console.error(`\nFAILED hash validation:\n  ${mismatches.join("\n  ")}`);
  else console.error("\nno --expect-md5 supplied: capture is unlabelled current state, not pre-change evidence.");
  process.exit(1);
}
