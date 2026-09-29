// Create exactly one Supabase Vault secret, `atlas_service_token`, holding the
// authoritative worker credential, so the database-side scheduler can invoke the
// protected worker.
//
// The ONLY input is the environment variable `ATLAS_WORKER_SERVICE_ROLE_KEY`.
// There is deliberately no fallback to any other variable. If it is absent the
// script refuses to run rather than guessing at a credential.
//
// SAFETY: the value is read from the environment and passed straight through to
// the Management API. It is never printed, never written to a file, and never
// logged. Any error text is scrubbed of the value before printing. Only HTTP
// status, validation verdicts, and success/failure leave this script.
//
// GUARDS (run before any write, so a bad value can never destroy the row):
//   1. presence          - refuses when the variable is unset or empty
//   2. shape             - must be a 3-segment JWT with role=service_role, or `sb_secret_*`
//   3. gateway           - the project's own PostgREST gateway must accept the key
// Only then is `atlas_service_token` deleted and recreated. No other Vault
// secret is referenced anywhere in this file.
const REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SECRET_NAME = "atlas_service_token";
const ENV_VAR = "ATLAS_WORKER_SERVICE_ROLE_KEY";

if (!TOKEN) {
  console.error("management token missing");
  process.exit(2);
}

const value = process.env[ENV_VAR];
if (typeof value !== "string" || value.length === 0) {
  console.error(`${ENV_VAR} missing or empty; refusing to run and not falling back`);
  process.exit(2);
}

/** Never let the value escape, even inside an error body. */
function scrub(s) {
  return value ? String(s).split(value).join("[REDACTED]") : String(s);
}

/** Quote a value as a SQL string literal. */
function sqlLiteral(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Guard 2: shape. Returns { ok, kind } without echoing the value. */
function checkShape(v) {
  const isJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
  if (isJwt) {
    try {
      const claims = JSON.parse(
        Buffer.from(v.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      );
      return { ok: claims.role === "service_role", kind: "jwt", role: claims.role ?? null };
    } catch {
      return { ok: false, kind: "jwt_unparseable" };
    }
  }
  if (/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(v)) return { ok: true, kind: "sb_secret" };
  return { ok: false, kind: "unrecognised" };
}

/** Guard 3: the project's own gateway must accept the key. Read-only. */
async function checkGateway(v) {
  const url =
    `https://${REF}.supabase.co/rest/v1/atlas_audit_log?select=id&limit=1`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { apikey: v, Authorization: `Bearer ${v}` },
    });
    // 404 PGRST205 still means the gateway accepted the key and only the
    // relation lookup failed, so treat "not 401/403" as accepted.
    return { ok: res.status !== 401 && res.status !== 403, status: res.status };
  } catch (e) {
    return { ok: false, status: null, error: String(e && e.message).slice(0, 120) };
  }
}

const shape = checkShape(value);
console.log(`shape: ${shape.kind}${shape.role ? ` role=${shape.role}` : ""} valid=${shape.ok}`);
if (!shape.ok) {
  console.error("refusing to write: credential is not a recognised Supabase service credential");
  process.exit(3);
}

const gw = await checkGateway(value);
console.log(`gateway: status=${gw.status} accepted=${gw.ok}`);
if (!gw.ok) {
  console.error("refusing to write: project gateway rejected the credential; Vault left untouched");
  process.exit(3);
}

const query = async (q) => {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
};

// Are we touching only the intended name, and can we see the pre-existing set?
const before = await query(
  "select count(*) as total, count(*) filter (where name = '" + SECRET_NAME + "') as target " +
    "from vault.secrets;",
);
console.log(`before: HTTP ${before.status} ${scrub(before.text).slice(0, 200)}`);

// Delete any previous copy so this is idempotent, then create exactly one.
const sql = `
do $$
begin
  delete from vault.secrets where name = '${SECRET_NAME}';
end $$;
select vault.create_secret(${sqlLiteral(value)}, ${sqlLiteral(SECRET_NAME)});
`;

const res = await query(sql);
console.log(`write: HTTP ${res.status}`);
if (!res.ok) {
  console.error(scrub(res.text).slice(0, 400));
  process.exit(1);
}

// Verify by boolean comparison inside the database: no plaintext is returned,
// only whether the stored value equals the intended one.
const verify = await query(
  "select (select count(*) from vault.secrets where name = '" + SECRET_NAME + "') as target_count, " +
    "(select count(*) from vault.secrets) as total_count, " +
    "(select decrypted_secret = " +
    sqlLiteral(value) +
    " from vault.decrypted_secrets where name = '" +
    SECRET_NAME +
    "') as value_matches;",
);
console.log(`verify: HTTP ${verify.status} ${scrub(verify.text).slice(0, 300)}`);

console.log("VAULT_SECRET_CREATED");
