// Apply a migration SQL file to the linked Supabase project, atomically.
//
// Why not `supabase db push`: the repository migration history diverges from the
// live ledger (several migrations were applied out-of-band), so a push would
// attempt to re-apply migrations whose objects already exist. This tool applies
// exactly ONE chosen migration, wrapped in an explicit transaction so a failure
// leaves the database untouched.
//
// Usage: bun scripts/apply-migration.mjs supabase/migrations/<file>.sql
// Requires the injected SUPABASE_ACCESS_TOKEN. Never prints secrets.
import { readFileSync } from "node:fs";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const file = process.argv[2];

if (!TOKEN) { console.error("SUPABASE_ACCESS_TOKEN missing"); process.exit(2); }
if (!file) { console.error("usage: bun scripts/apply-migration.mjs <sql-file>"); process.exit(2); }

const body = readFileSync(file, "utf8");

// No CREATE INDEX CONCURRENTLY / VACUUM here, so a plain transaction is safe.
const sql = "begin;\n" + body + "\ncommit;\n";

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
  // First 2,000 chars of the error: messages only, never secrets.
  console.error(text.slice(0, 2000));
  process.exit(1);
}
if (text.trim() && text.trim() !== "null") {
  console.log(text.slice(0, 2000));
}
console.log("APPLIED");
