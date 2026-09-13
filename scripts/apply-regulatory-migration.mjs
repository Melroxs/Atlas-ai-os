import { readFile } from "node:fs/promises";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const migrationPath = process.env.REGULATORY_MIGRATION_PATH ?? "supabase/migrations/20260906_atlas_regulatory_intelligence.sql";
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
if (!ref) throw new Error("SUPABASE_PROJECT_REF is required.");
const query = await readFile(migrationPath, "utf8");
const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/migrations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "atlas-regulatory-20260906",
  },
  body: JSON.stringify({ query, name: "atlas_regulatory_intelligence", rollback: "" }),
});
const body = await response.text();
if (!response.ok) throw new Error(`Supabase migration failed (${response.status}): ${body.slice(0, 2000)}`);
console.log(body || `Supabase accepted migration for project ${ref}.`);
