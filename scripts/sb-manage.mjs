// Read-only Management API inventory helper (functions + secret names only).
// Mirrors scripts/run-db-sql.mjs: uses the injected Supabase access token,
// never prints secret values.
// Usage: node scripts/sb-manage.mjs functions|secrets
const REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const [mode] = process.argv.slice(2);
if (!TOKEN) { console.error("SUPABASE_ACCESS_TOKEN missing"); process.exit(2); }

const base = `https://api.supabase.com/v1/projects/${REF}`;
const H = { Authorization: `Bearer ${TOKEN}` };

if (mode === "functions") {
  const r = await fetch(`${base}/functions`, { headers: H });
  const j = await r.json();
  if (!r.ok) { console.error(`HTTP ${r.status}`, JSON.stringify(j).slice(0, 500)); process.exit(1); }
  for (const f of j) {
    console.log(`${f.slug}\tstatus=${f.status}\tverify_jwt=${f.verify_jwt}\tupdated=${f.updated_at ?? ""}`);
  }
  process.exit(0);
}

if (mode === "secrets") {
  const r = await fetch(`${base}/secrets`, { headers: H });
  const j = await r.json();
  if (!r.ok) { console.error(`HTTP ${r.status}`, JSON.stringify(j).slice(0, 500)); process.exit(1); }
  console.log(j.map((s) => s.name).sort().join("\n"));
  process.exit(0);
}

console.error("modes: functions | secrets");
process.exit(2);
