// Apply ONE Supabase migration file via the Management API migrations endpoint
// (per SUPABASE_REGULATORY_MIGRATION_NOTES.md). This both executes the SQL and
// records the migration in supabase_migrations.schema_migrations (the ledger).
// Prints only HTTP status + short error bodies — never file contents.
// Usage: node scripts/sb-apply-migration.mjs <path-to-sql> <version> <name>
import { readFileSync } from "node:fs";

const REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const [file, version, name] = process.argv.slice(2);

if (!TOKEN) { console.error("SUPABASE_ACCESS_TOKEN missing"); process.exit(2); }
if (!file || !version || !name) {
  console.error("usage: node scripts/sb-apply-migration.mjs <sql-file> <version> <name>");
  process.exit(2);
}

const query = readFileSync(file, "utf8");
const res = await fetch(
  `https://api.supabase.com/v1/projects/${REF}/database/migrations`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, name, version }),
  },
);

const text = await res.text();
console.log(`HTTP ${res.status}`);
if (!res.ok) {
  // Error bodies can echo SQL fragments; print a bounded excerpt only.
  console.error(text.slice(0, 1000));
  process.exit(1);
}
if (text.trim() && text.trim() !== "null") {
  console.log(text.slice(0, 2000));
}
console.log("MIGRATION_APPLIED");
