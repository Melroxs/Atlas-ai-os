// Deploy a single Edge Function to the live Supabase project via the Management
// API (POST /v1/projects/{ref}/functions/deploy?slug=..., multipart/form-data).
// Usage: bun scripts/deploy-blog-sitemap.mjs [function-name]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const name = process.argv[2] ?? "blog-sitemap";

if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN missing");
  process.exit(2);
}

const dir = join("supabase", "functions", name);
const files = [];
function walk(d, prefix = "") {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(d, entry.name), rel);
    else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      files.push(rel);
    }
  }
}
walk(dir);
if (files.length === 0) {
  console.error(`No deployable files found in ${dir}`);
  process.exit(2);
}

const form = new FormData();
for (const rel of files) {
  const content = readFileSync(join(dir, rel), "utf8");
  form.append("file", new Blob([content], { type: "text/plain" }), rel);
}

// The function is a public crawl surface: crawlers cannot present a Supabase
// JWT, and its read is bounded by anon RLS (asserted in
// src/lib/security/edge-functions-integrity.test.ts).
form.append(
  "metadata",
  JSON.stringify({
    entrypoint_path: "index.ts",
    import_map_path: "import_map.json",
    verify_jwt: false,
  }),
);

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${name}`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  },
);

const text = await res.text();
console.log(`HTTP ${res.status}`);
if (!res.ok) {
  console.error(text.slice(0, 1500));
  process.exit(1);
}
try {
  const parsed = JSON.parse(text);
  console.log(
    `Deployed ${parsed.slug} v${parsed.version} status=${parsed.status} verify_jwt=${parsed.verify_jwt}`,
  );
} catch {
  console.log(text.slice(0, 400));
}
