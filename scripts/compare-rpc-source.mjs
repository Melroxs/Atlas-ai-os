// Extract function bodies from a migration file and md5 them, to compare with
// the md5 of prosrc reported by production pg_proc.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const targets = [
  ["supabase/migrations/20260927_atlas_pilot_organizations.sql", "admin_create_tenant"],
  ["supabase/migrations/20260927_atlas_pilot_organizations.sql", "admin_create_pilot_organization"],
  ["supabase/migrations/202608251_atlas_fix_user_management_rpc.sql", "admin_list_users"],
  ["supabase/migrations/20260932_atlas_admin_quoted_creation_time_fix.sql", "admin_create_tenant"],
  ["supabase/migrations/20260932_atlas_admin_quoted_creation_time_fix.sql", "admin_create_pilot_organization"],
  ["supabase/migrations/20260932_atlas_admin_quoted_creation_time_fix.sql", "admin_list_users"],
  ["supabase/migrations/20260909_atlas_complimentary_access.sql", "admin_grant_complimentary_access"],
  ["supabase/migrations/20260932_atlas_admin_quoted_creation_time_fix.sql", "admin_grant_complimentary_access"],
];

for (const [file, fn] of targets) {
  const sql = readFileSync(file, "utf8");
  const start = sql.search(new RegExp(`function public\\.${fn}\\(`, "i"));
  if (start < 0) {
    console.log(`${fn}\tNOT FOUND in ${file}`);
    continue;
  }
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  if (open < 0 || close < 0) {
    console.log(`${fn}\tNO DOLLAR QUOTES`);
    continue;
  }
  const body = sql.slice(open + 2, close);
  const md5 = createHash("md5").update(body, "utf8").digest("hex");
  console.log(`${fn}\t${md5}\tlen=${body.length}`);
}
