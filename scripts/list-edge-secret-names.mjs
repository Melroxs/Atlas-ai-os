// List only the NAMES of the project's Edge Function secrets — values are
// never printed. Read-only audit helper for the Paystack activation review.
// Usage: bun scripts/list-edge-secret-names.mjs
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN missing");
  process.exit(2);
}

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`,
  {
    headers: { Authorization: `Bearer ${TOKEN}` },
  },
);

const text = await res.text();
console.log(`HTTP ${res.status}`);
if (!res.ok) {
  console.error(text.slice(0, 500));
  process.exit(1);
}

try {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed.secrets ?? []);
  const names = rows
    .map((row) => (typeof row === "string" ? row : String(row.name ?? "")))
    .filter(Boolean)
    .sort();
  console.log(JSON.stringify({ secret_names: names }, null, 0));
} catch {
  // Never fall back to printing the raw body — it could contain values.
  console.error("response was not JSON; names not extracted (body not printed)");
  process.exit(1);
}
