// Extract function bodies from a migration file and md5 them, to compare with
// the md5 of prosrc reported by production pg_proc.
//
//   node scripts/compare-rpc-source.mjs
//
// A target is [migrationFile, functionName] or
// [migrationFile, functionName, requiredQuotedRefs].
//
// The optional third element is a NARROW, EXPLICIT list of column references
// that must appear in double-quoted form, each given as [quotedForm,
// bareForm]. PostgreSQL folds an unquoted identifier to lower case, so a
// mixed-case column referenced bare silently resolves to a column that does not
// exist and the function fails at runtime. This checks only the identifiers
// named here for that target - it is deliberately NOT a repository-wide
// heuristic identifier linter.
//
// Exits non-zero if a target cannot be located or a required quoted reference
// is missing, so this is usable as a verification step and not just a report.
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

  // connections_list_catalog: both the corrected source migration and the
  // additive repair migration must carry the same, fully quoted body.
  [
    "supabase/migrations/20260922_atlas_integration_foundation.sql",
    "connections_list_catalog",
    [['c."lastError"', "c.lastError"], ['c."_creationTime"', "c._creationTime"]],
  ],
  [
    "supabase/migrations/20260933_atlas_connections_list_catalog_quoted_identifiers.sql",
    "connections_list_catalog",
    [['c."lastError"', "c.lastError"], ['c."_creationTime"', "c._creationTime"]],
  ],
];

let problems = 0;

for (const [file, fn, requiredRefs = []] of targets) {
  const sql = readFileSync(file, "utf8");
  const start = sql.search(new RegExp(`function public\\.${fn}\\(`, "i"));
  if (start < 0) {
    console.log(`${fn}\tNOT FOUND in ${file}`);
    problems++;
    continue;
  }
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  if (open < 0 || close < 0) {
    console.log(`${fn}\tNO DOLLAR QUOTES`);
    problems++;
    continue;
  }
  const body = sql.slice(open + 2, close);
  const md5 = createHash("md5").update(body, "utf8").digest("hex");
  console.log(`${fn}\t${md5}\tlen=${body.length}\t${file.split("/").pop()}`);

  // Narrow check: each listed reference must be quoted, and its bare form
  // must not appear as a column reference.
  for (const [quoted, bare] of requiredRefs) {
    const hasQuoted = body.includes(quoted);
    // The bare form is only a problem when it is not part of the quoted form.
    const hasBare = body.includes(bare) && !body.includes(quoted);
    if (hasQuoted && !hasBare) {
      console.log(`  ok   quoted reference present: ${quoted}`);
    } else {
      problems++;
      console.log(
        `  FAIL required quoted reference: ${quoted}` +
          (hasBare ? `  (bare form ${bare} still present)` : "  (not found)"),
      );
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} problem(s) found.`);
  process.exit(1);
}
console.log(`\nall ${targets.length} target(s) resolved with no problems.`);
