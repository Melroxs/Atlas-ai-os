// Execute a .sql file against the live Supabase project (Management API query
// endpoint). Uses the injected SUPABASE_ACCESS_TOKEN — never prints secrets.
// Usage: bun scripts/run-db-sql.mjs <path-to-sql-file>
import { readFileSync } from "node:fs";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const file = process.argv[2];

if (!TOKEN) { console.error("SUPABASE_ACCESS_TOKEN missing"); process.exit(2); }
if (!file) { console.error("usage: bun scripts/run-db-sql.mjs <sql-file>"); process.exit(2); }

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
  // Print the first 1,000 chars of the error body (messages, never secrets).
  console.error(text.slice(0, 1000));
  process.exit(1);
}
if (text.trim() && text.trim() !== "null") {
  console.log(text.slice(0, 3000));
}
console.log("OK");