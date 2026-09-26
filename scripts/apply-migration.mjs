// Apply a migration file to the live Supabase project via the Management API.
// Usage: bun scripts/apply-migration.mjs <path-to-sql-file>
// Mirrors run-db-sql.mjs but reports each statement so a failure is locatable.
import { readFileSync } from "node:fs";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const file = process.argv[2];

if (!TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN missing");
  process.exit(2);
}
if (!file) {
  console.error("usage: bun scripts/apply-migration.mjs <sql-file>");
  process.exit(2);
}

const sql = readFileSync(file, "utf8");
const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);

const text = await res.text();
console.log(`HTTP ${res.status}`);
if (!res.ok) {
  console.error(text.slice(0, 1500));
  process.exit(1);
}
console.log("OK");
