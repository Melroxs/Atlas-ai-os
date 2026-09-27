// List deployed Supabase edge functions and their versions (read-only).
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF || "ibxvzxblyhzwokljkslt";

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, {
  headers: { Authorization: `Bearer ${token}` },
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const fns = await res.json();
for (const f of fns.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))) {
  console.log(`${f.slug}\tv${f.version}\t${f.updated_at}`);
}
