// ---------------------------------------------------------------------------
// LIVE PROBE: Free Pilot admin actions against the DEPLOYED
// admin-provision-user edge function, asserting the real database effects.
//
//   node scripts/probes/test-pilot-actions.mjs
//
// ############################################################################
// # THIS PROBE MUTATES PRODUCTION.                                        #
// # It creates a real organization, a real org-wide complimentary-access  #
// # grant and a real membership through the deployed function, then        #
// # removes them. It is NOT read-only. Only run it against a project you    #
// # own, and only when you accept creating and deleting real rows.         #
// ############################################################################
//
// Safety properties this file guarantees:
//   * Every production write happens inside a try { } whose finally { }
//     block performs the cleanup. Cleanup runs on assertion failure, on a
//     thrown API call, on a failed DB query, and on an unexpected error.
//   * The probe namespace is unique per run (probe-<stamp>-<rand>), and all
//     cleanup and residue checks are scoped to that exact namespace. It
//     never matches on broad patterns like '%test%', so legitimate data such
//     as an organization named "Test Company" can never be matched or
//     deleted.
//   * The access token is minted in-process and is never printed, logged or
//     written to disk. Only a token hash is displayed.
//   * Exit 0 requires every assertion to pass AND cleanup to verify.
//
// Required configuration (no account addresses are hardcoded):
//   PROBE_SUPERADMIN_EMAIL   account whose platform_role is super_admin
//   PROBE_NONADMIN_EMAIL     optional; a non-super-admin account used to
//                            prove the authorization guard returns 403
//
// Also read (env or .env.local):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

function parseEnvFile(file) {
  const out = {};
  try {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* missing */
  }
  return out;
}

const env = { ...parseEnvFile(".env.local"), ...process.env };
const URL_ = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = env.PROBE_SUPERADMIN_EMAIL;
const NONADMIN_EMAIL = env.PROBE_NONADMIN_EMAIL;

if (!URL_ || !ANON || !SERVICE) {
  console.error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing");
  process.exit(2);
}
if (!ADMIN_EMAIL) {
  console.error("PROBE_SUPERADMIN_EMAIL is required (no account address is hardcoded in this probe)");
  process.exit(2);
}

const FN = `${URL_}/functions/v1/admin-provision-user`;
const STAMP = Date.now();
const RID = randomBytes(3).toString("hex");
const PROBE_ID = `probe-${STAMP}-${RID}`;
const PROBE_SLUG = PROBE_ID;
const PROBE_NAME = `Probe ${PROBE_ID}`;
const PROBE_ADMIN_EMAIL = `${PROBE_ID}@example.invalid`;

// ------------------------------------------------------------------ results
const failures = [];
const skips = [];
let checks = 0;

function check(label, cond, detail = "") {
  checks++;
  const line = detail ? `${label} :: ${detail}` : label;
  if (cond) {
    console.log(`PASS  ${line}`);
  } else {
    failures.push(line);
    console.log(`FAIL  ${line}`);
  }
  return cond;
}
function skip(label, why) {
  skips.push(`${label} (${why})`);
  console.log(`SKIP  ${label} :: ${why}`);
}

// --------------------------------------------------------------- auth (in-process, never printed)
const svc = { apikey: SERVICE, "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` };

async function mintSession(email) {
  const gl = await fetch(`${URL_}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svc,
    body: JSON.stringify({ email, type: "magiclink" }),
  });
  const gb = await gl.json().catch(() => ({}));
  if (!gl.ok || !gb.action_link) {
    throw new Error(`generate_link failed for the configured account: HTTP ${gl.status}`);
  }
  // Exchange the link for a session WITHOUT following redirects; the token
  // rides in the Location fragment. The token stays in this scope and is
  // never printed or persisted.
  const res = await fetch(gb.action_link, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const m = location.match(/access_token=([^&]+)/);
  if (!m) throw new Error(`session exchange failed: HTTP ${res.status}`);
  return decodeURIComponent(m[1]);
}

// ------------------------------------------------------------- db (read + scoped deletes)
// The probe talks to the management API (the same channel the other Atlas
// audit tooling uses) so it can read production state and perform scoped
// deletes that are scoped to this run's unique probe id.
const MGMT_TOKEN = env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = env.SUPABASE_PROJECT_REF || "ibxvzxblyhzwokljkslt";
if (!MGMT_TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN is required for the probe's scoped cleanup verification");
  process.exit(2);
}

async function db(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  return parsed[0]?.report ?? null;
}

async function call(tok, action, payload) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = "<unparseable>";
  }
  return { status: res.status, body };
}

// --------------------------------------------------------------------- probe
console.log("=".repeat(78));
console.log("FREE PILOT ADMIN ACTIONS — LIVE PROBE (MUTATES PRODUCTION)");
console.log("=".repeat(78));
console.log(`project      ${PROJECT_REF}`);
console.log(`function     ${FN}`);
console.log(`probe id     ${PROBE_ID}`);
console.log("This probe creates and then removes a real organization, grant and");
console.log("membership. Do not interrupt it partway.\n");

let adminToken = null;
let tenantId = null;
const soon = Date.now() + 7 * 24 * 3600 * 1000;
const later = Date.now() + 90 * 24 * 3600 * 1000;

try {
  adminToken = await mintSession(ADMIN_EMAIL);
  console.log(`session      minted in-process (token md5 ${createHash("md5").update(adminToken).digest("hex").slice(0, 12)}…, never printed)\n`);

  // 0. authorization guard -----------------------------------------------------
  if (NONADMIN_EMAIL) {
    const nonAdminToken = await mintSession(NONADMIN_EMAIL);
    const guard = await call(nonAdminToken, "create_pilot_org", {
      name: `${PROBE_NAME} SHOULD-NOT-EXIST`,
      adminEmail: PROBE_ADMIN_EMAIL,
    });
    check("non-super_admin refused create_pilot_org", guard.status === 403, `HTTP ${guard.status}`);
  } else {
    skip("non-super_admin refused create_pilot_org", "PROBE_NONADMIN_EMAIL not set");
  }

  // 1. create_pilot_org --------------------------------------------------------
  const created = await call(adminToken, "create_pilot_org", {
    name: PROBE_NAME,
    adminEmail: PROBE_ADMIN_EMAIL,
    adminName: "Probe Admin",
    slug: PROBE_SLUG,
    expiresAt: soon,
    notes: "automated probe verification",
  });
  if (!check("create_pilot_org ok", created.status === 200 && created.body?.ok === true, JSON.stringify(created.body))) {
    throw new Error("create_pilot_org failed; cannot continue the sequence");
  }
  tenantId = created.body?.tenant_id;
  if (!tenantId) throw new Error("create_pilot_org returned no tenant_id");

  // count(*) must be part of the output: it is what proves "exactly one".
  const grant = await db(
    `select format('grants=%s: %s', count(*), coalesce(string_agg(format('status=%s,user_id=%s,expires=%s', status, coalesce(user_id::text,'org-wide'), coalesce(expires_at::text,'never')), ' | '), 'NONE')) as report from public.complimentary_access where organization_id='${tenantId}';`,
  );
  check(
    "exactly one org-wide complimentary grant created",
    typeof grant === "string" && grant.startsWith("grants=1:") && grant.includes("user_id=org-wide") && grant.includes("status=active"),
    String(grant),
  );

  const pilotStatus = await db(`select public.atlas_pilot_status('${tenantId}') as report;`);
  check("atlas_pilot_status = active", pilotStatus === "active", String(pilotStatus));

  // 2. extend_pilot ------------------------------------------------------------
  const ext = await call(adminToken, "extend_pilot", { tenantId, expiresAt: later, reason: "probe extend" });
  check("extend_pilot ok", ext.status === 200 && ext.body?.ok === true, JSON.stringify(ext.body));
  const afterExt = await db(
    `select format('expires_at=%s', expires_at) as report from public.complimentary_access where organization_id='${tenantId}' and status='active' and user_id is null;`,
  );
  const extVal = Number(String(afterExt ?? "").split("=")[1]);
  check("grant expiration moved out ~90d", Number.isFinite(extVal) && extVal > later - 60000, String(afterExt));

  // 3. set_pilot_status --------------------------------------------------------
  const susp = await call(adminToken, "set_pilot_status", { tenantId, status: "suspended", reason: "probe suspend" });
  check("set_pilot_status(suspended) ok", susp.status === 200 && susp.body?.ok === true, JSON.stringify(susp.body));
  check("pilot status now suspended", (await db(`select public.atlas_pilot_status('${tenantId}') as report;`)) === "suspended");

  const react = await call(adminToken, "set_pilot_status", { tenantId, status: "active", reason: "probe reactivate" });
  check("set_pilot_status(active) ok", react.status === 200 && react.body?.ok === true, JSON.stringify(react.body));
  check("pilot status back to active", (await db(`select public.atlas_pilot_status('${tenantId}') as report;`)) === "active");

  // 4. convert_pilot -----------------------------------------------------------
  const conv = await call(adminToken, "convert_pilot", { tenantId, reason: "probe convert" });
  check("convert_pilot ok", conv.status === 200 && conv.body?.ok === true, JSON.stringify(conv.body));
  const afterConv = await db(
    `select format('account_type=%s | converted=%s', account_type, coalesce(pilot_converted_at::text,'null')) as report from public.tenants where _id='${tenantId}';`,
  );
  check(
    "tenant converted to standard",
    typeof afterConv === "string" && afterConv.includes("account_type=standard") && !afterConv.includes("converted=null"),
    String(afterConv),
  );
  const activeOrgWide = await db(
    `select format('active_org_wide=%s', count(*)) as report from public.complimentary_access where organization_id='${tenantId}' and status='active' and user_id is null;`,
  );
  check("converted grant revoked", String(activeOrgWide).includes("active_org_wide=0"), String(activeOrgWide));

  // Stripe objects: the FK columns are snake_case (tenant_id), NOT "tenantId".
  const stripe = await db(
    `select format('customers=%s subs=%s', (select count(*) from public.stripe_customers where tenant_id='${tenantId}'), (select count(*) from public.subscriptions where tenant_id='${tenantId}')) as report;`,
  );
  check("no Stripe objects created by conversion", stripe === "customers=0 subs=0", String(stripe));
} catch (err) {
  failures.push(`probe aborted: ${err && err.message ? err.message : String(err)}`);
  console.log(`FAIL  probe aborted: ${err && err.message ? err.message : String(err)}`);
} finally {
  // ------------------------------------------------------------------ cleanup
  console.log(`\ncleanup (always runs, even after failure)`);
  if (!tenantId) {
    console.log("  no tenant was created; nothing to clean up");
  } else {
    const steps = [
      ["audit rows", `delete from public.atlas_audit_log where target_id='${tenantId}';`],
      ["grants", `delete from public.complimentary_access where organization_id='${tenantId}';`],
      ["memberships", `delete from public.memberships where "tenantId"='${tenantId}';`],
      ["tenant", `delete from public.tenants where _id='${tenantId}';`],
    ];
    for (const [what, stmt] of steps) {
      try {
        await db(stmt);
        console.log(`  removed ${what}`);
      } catch (e) {
        failures.push(`cleanup failed for ${what}: ${e.message}`);
        console.log(`  FAIL  cleanup failed for ${what}: ${e.message}`);
      }
    }

    // Residue check scoped to THIS probe's exact namespace only. Never a broad
    // pattern — legitimate organizations may legitimately contain "test".
    const residue = await db(
      `select format('probe_tenants=%s probe_grants=%s probe_members=%s probe_billing=%s',
        (select count(*) from public.tenants where slug='${PROBE_SLUG}'),
        (select count(*) from public.complimentary_access where organization_id='${tenantId}'),
        (select count(*) from public.memberships where "tenantId"='${tenantId}'),
        (select count(*) from public.stripe_customers where tenant_id='${tenantId}')
          + (select count(*) from public.subscriptions where tenant_id='${tenantId}')
          + (select count(*) from public.organization_subscriptions where organization_id='${tenantId}')
          + (select count(*) from public.billing_audit_events where organization_id='${tenantId}')) as report;`,
    );
    checks++;
    const clean = residue === "probe_tenants=0 probe_grants=0 probe_members=0 probe_billing=0";
    if (clean) console.log(`PASS  probe data removed :: ${residue}`);
    else {
      failures.push(`probe residue remains: ${residue}`);
      console.log(`FAIL  probe residue remains :: ${residue}`);
    }
  }
}

// ------------------------------------------------------------------ verdict
console.log("\n" + "=".repeat(78));
console.log(`checks run: ${checks}   passed: ${checks - failures.length}   failed: ${failures.length}   skipped: ${skips.length}`);
if (skips.length) for (const s of skips) console.log(`  SKIPPED: ${s}`);
if (failures.length) {
  console.log("\nFAILED CHECKS:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("\nRESULT: FAILED");
  process.exit(1);
}
console.log("\nRESULT: PASSED — all assertions held and probe data was removed.");
