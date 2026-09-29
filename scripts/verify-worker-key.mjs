// Verify whether ATLAS_WORKER_SERVICE_ROLE_KEY is a valid elevated API key for the
// Supabase project. Read-only: performs a single GET against PostgREST, changes nothing.
//
// The key is read from the environment and never printed, logged, or written to disk,
// so it never appears in shell history. Negative controls prove the probe is meaningful.
//
// Usage:  node scripts/verify-worker-key.mjs
// Exit:   0 = valid   3 = invalid/rejected   2 = cannot run
import { randomBytes } from "node:crypto";

const REF = process.env.SUPABASE_PROJECT_REF ?? "ibxvzxblyhzwokljkslt";
const ROOT = `https://${REF}.supabase.co`;
// A table that exists and requires an authenticated key to read.
const TARGET = `${ROOT}/rest/v1/atlas_organizations?select=id&limit=1`;

function classifyShape(v) {
  return {
    length: v.length,
    segmentCount: v.split(".").length,
    whitespaceCount: (v.match(/\s/g) || []).length,
    charsOutsideAlphabet: (v.match(/[^A-Za-z0-9_.-]/g) || []).length,
    kind: v.startsWith("sb_secret_")
      ? "new_style_secret_key"
      : v.startsWith("eyJ")
        ? "legacy_jwt"
        : "unknown",
  };
}

async function probe(label, apikey) {
  const headers = apikey ? { apikey, Authorization: `Bearer ${apikey}` } : {};
  try {
    const res = await fetch(TARGET, { method: "GET", headers });
    const text = await res.text().catch(() => "");
    const m = text.match(/"(?:message|error|code)"\s*:\s*"([^"]{0,90})"/);
    let rowCount = null;
    try {
      const parsed = JSON.parse(text);
      rowCount = Array.isArray(parsed) ? parsed.length : null;
    } catch {}
    return { label, status: res.status, rowCount, message: m ? m[1] : null };
  } catch (e) {
    return { label, error: String(e?.message ?? e).slice(0, 100) };
  }
}

const key = process.env.ATLAS_WORKER_SERVICE_ROLE_KEY;
if (!key) {
  console.log(JSON.stringify({ result: "CANNOT_RUN", reason: "ATLAS_WORKER_SERVICE_ROLE_KEY is not set" }, null, 2));
  process.exit(2);
}

const shape = classifyShape(key);
const [candidate, randomControl, noKey] = await Promise.all([
  probe("candidate", key),
  probe("random_control", "sb_secret_" + randomBytes(24).toString("base64url")),
  probe("no_key", null),
]);

// The probe only means something if a bogus key and a missing key are both rejected.
const controlValid = randomControl.status === 401 && noKey.status === 401;
const valid = controlValid && candidate.status === 200;

console.log(
  JSON.stringify(
    {
      projectRef: REF,
      shape,
      controlValid,
      candidateStatus: candidate.status,
      candidateMessage: candidate.message,
      noKeyStatus: noKey.status,
      randomControlStatus: randomControl.status,
      result: controlValid
        ? valid
          ? "VALID — safe to write to Vault"
          : `INVALID — the gateway rejected this key (${candidate.message ?? candidate.status})`
        : "CANNOT_RUN — controls did not behave as expected; probe is not trustworthy",
    },
    null,
    2,
  ),
);

process.exit(valid ? 0 : controlValid ? 3 : 2);
