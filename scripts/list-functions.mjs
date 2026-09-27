// List deployed Supabase edge functions, or show one function in detail.
//
//   node scripts/list-functions.mjs                     # list every function
//   node scripts/list-functions.mjs admin-provision-user  # detail for one
//
// With no argument the output is unchanged: one tab-separated line per
// function (slug, version, updated_at).
//
// With a slug it reports the full deployment record, including verify_jwt,
// entrypoint_path, import_map_path and status, and exits non-zero if no such
// function is deployed — a missing function must never look like a success.
//
// NOTE: `version` is a PROJECT-WIDE deploy counter, not a per-function
// revision. It increments for every function deployed in the project, so it is
// not evidence about any single function. Use scripts/fingerprint-function.mjs
// when you need content-level evidence.
//
// scripts/verify-production.mjs also prints slug/status/verify_jwt for every
// function as part of its broader diagnostics. This script is the dedicated
// inspection tool; the two intentionally overlap only at the summary level.
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
const token = env.SUPABASE_ACCESS_TOKEN;
const ref = env.SUPABASE_PROJECT_REF || "ibxvzxblyhzwokljkslt";
if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN not set (env or .env.local)");
  process.exit(2);
}

const slug = process.argv[2];

if (!slug) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("HTTP", res.status);
    process.exit(1);
  }
  const fns = await res.json();
  for (const f of fns.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))) {
    console.log(`${f.slug}\tv${f.version}\t${f.updated_at}`);
  }
} else {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions/${slug}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`function "${slug}" is not deployed in ${ref}: HTTP ${res.status}`);
    process.exit(1);
  }
  const f = await res.json();
  console.log(
    JSON.stringify(
      {
        slug: f.slug,
        // project-wide deploy counter, not a per-function revision
        version: f.version,
        verify_jwt: f.verify_jwt,
        entrypoint_path: f.entrypoint_path,
        import_map_path: f.import_map_path,
        status: f.status,
        updated_at: new Date(Number(f.updated_at)).toISOString(),
      },
      null,
      2,
    ),
  );
}
