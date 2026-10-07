// ---------------------------------------------------------------------------
// Article-regeneration payload contract — regression tests
//
// THE DEFECT THIS EXISTS TO CATCH
// ------------------------------
// A real production job (released through the normal path: pg_cron
// `atlas-platform-tick` → `content-engine-worker`) died 158 ms after dequeue:
//
//     { "code": "VALIDATION", "message": "package_id and topic are required." }
//
// The Content Studio's only article-regeneration action sends
// `{ package_id, content_id, regenerate: true }` — no topic — while the worker's
// `stepGeneratePackage()` requires both `package_id` and `topic`. The single
// producer, `content_engine_enqueue`, forwarded that payload verbatim, so the
// article could never be regenerated and no provider was ever reached.
//
// The fix belongs in the producer: it is the only place that already reads the
// package row (for the owning organization), and the topic is already persisted
// on that row at creation time (`content_create` stores the Studio's topic in
// the package's `seo` document).
//
// These tests are textual because the property IS textual: it lives in the SQL
// that will run, in the worker's guard, and in the caller's payload shape.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

const CONTRACT_FILE = "20260945_atlas_content_enqueue_topic_contract.sql";
const CONTENT_ENGINE_FILE = "20260935_atlas_content_engine.sql";
const HARDENING_FILE = "20260918_atlas_security_hardening.sql";

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** Drop comments so prose explaining the defect is not read as the fix. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const SQL = stripComments(read(`supabase/migrations/${CONTRACT_FILE}`));
const WORKER = read("supabase/functions/content-engine-worker/index.ts");
const STUDIO_API = read("src/lib/content-engine/studio-api.ts");
const CLIENT = read("src/lib/content-engine/client.ts");

/** The `stepGeneratePackage` function body, for the worker-side assertions. */
function stepGeneratePackage(): string {
  const start = WORKER.indexOf("async function stepGeneratePackage");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = WORKER.indexOf("\nasync function ", start + 1);
  return WORKER.slice(start, next === -1 ? undefined : next);
}

/** The `contentStudio.regenerate` implementation, for the caller-side assertions. */
function regenerateBlock(): string {
  const start = STUDIO_API.indexOf("regenerate: async (");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = STUDIO_API.indexOf("};", start);
  return STUDIO_API.slice(start, end === -1 ? undefined : end);
}

describe("article regeneration — the producer owns the payload contract", () => {
  it("resolves the topic from the same package row it reads for the tenant", () => {
    // ONE read, both values: the organization that authorizes the enqueue and
    // the topic the worker needs. A second lookup would be a second source.
    expect(SQL).toMatch(
      /select "organizationId",\s*\n?\s*nullif\(btrim\(coalesce\("seo" ->> 'topic', ''\)\), ''\)\s*\n?\s*into v_org, v_topic\s*\n?\s*from public\."atlasContentItems" where "_id" = p_package/,
    );
    // Exactly one read of the package row in the whole function.
    expect(SQL.match(/from public\."atlasContentItems"/g) ?? []).toHaveLength(1);
  });

  it("uses the stored seo.topic — not the title, not the tags", () => {
    // §6 of the phase brief: title and topic are different things, and the
    // package's `seo.topic` is the value `content_create` persisted.
    expect(SQL).toMatch(/"seo" ->> 'topic'/);
    expect(SQL).not.toMatch(/"title"/);
    expect(SQL).not.toMatch(/"tags"/);
    // No literal topic is ever injected.
    expect(SQL).not.toMatch(/v_topic\s*:=\s*'/);
  });

  it("adds the topic to the payload for content_generate_package", () => {
    expect(SQL).toMatch(/if p_job_type = 'content_generate_package'/);
    expect(SQL).toMatch(/jsonb_set\(v_payload, '\{topic\}', to_jsonb\(v_topic\), true\)/);
    // The job receives the RESOLVED payload, never the raw caller payload.
    expect(SQL).toMatch(/p_payload\s*=>\s*v_payload/);
    expect(SQL).not.toMatch(/p_payload\s*=>\s*coalesce\(p_payload/);
  });

  it("never overwrites a topic the caller did supply", () => {
    expect(SQL).toMatch(/coalesce\(btrim\(v_payload ->> 'topic'\), ''\) = ''/);
    // `jsonb_set(..., true)` only ever runs behind that emptiness test.
    const guard = SQL.indexOf("coalesce(btrim(v_payload ->> 'topic'), '') = ''");
    const set = SQL.indexOf("jsonb_set(v_payload, '{topic}'");
    expect(guard).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(guard);
  });

  it("never fabricates a topic, and fails closed when none is stored", () => {
    // The fill is conditional on a real stored value…
    expect(SQL).toMatch(/and v_topic is not null/);
    // …so a package with no topic keeps its old behaviour: the worker rejects it.
    expect(SQL).not.toMatch(/coalesce\(v_topic,/);
    expect(SQL).not.toMatch(/v_topic\s*:=\s*p_package/);
  });

  it("keeps the authorization guard it had before", () => {
    expect(SQL).toMatch(
      /public\.atlas_is_trusted_server\(\)\s*\n?\s*or public\.is_atlas_admin\(\)\s*\n?\s*or \(v_org is not null and v_org = public\.my_tenant_id\(\)\)/,
    );
    expect(SQL).toMatch(
      /raise exception 'Access denied: not a member of this organization'\s*\n?\s*using errcode = '42501'/,
    );
    // The guard still runs BEFORE the payload is touched.
    expect(SQL.indexOf("Access denied")).toBeLessThan(
      SQL.indexOf("jsonb_set(v_payload"),
    );
  });
});

describe("article regeneration — the caller shape that was proven broken", () => {
  it("still sends no topic, which is why the producer must supply it", () => {
    const block = regenerateBlock();
    expect(block).toMatch(
      /p_payload:\s*\{\s*package_id:\s*packageId,\s*content_id:\s*packageId,\s*regenerate:\s*true\s*\}/,
    );
    // This is the exact payload that produced the production VALIDATION failure.
    expect(block).not.toMatch(/topic/);
  });

  it("the topic the producer reads is the topic createContentPackage persists", () => {
    // One writer, one reader, one field.
    expect(CLIENT).toMatch(/seo:\s*\{\s*tags:\s*input\.tags,\s*topic:\s*input\.topic\s*\}/);
    expect(CLIENT).toMatch(/content_create/);
  });

  it("startPackage keeps supplying its own topic, so nothing there changes", () => {
    expect(STUDIO_API).toMatch(
      /p_payload:\s*\{\s*package_id:\s*created\.content_id,\s*topic,\s*source:\s*"studio"\s*\}/,
    );
  });
});

describe("article regeneration — the worker contract is NOT weakened", () => {
  it("still requires BOTH package_id and topic", () => {
    const body = stepGeneratePackage();
    expect(body).toMatch(/const packageId = str\(job\.payload\.package_id\)/);
    expect(body).toMatch(/const topic = str\(job\.payload\.topic\)/);
    expect(body).toMatch(/if \(!packageId \|\| !topic\)/);
    expect(body).toMatch(/code: "VALIDATION"/);
    expect(body).toMatch(/message: "package_id and topic are required\."/);
    // Non-retryable: a malformed payload is never retried into a provider call.
    expect(body).toMatch(/retryable: false/);
  });

  it("does not fill the topic itself — resolution stays in the producer", () => {
    const body = stepGeneratePackage();
    // No fallback and no database read inside the worker step.
    expect(body).not.toMatch(/job\.payload\.topic\s*(\?\?|\|\|)/);
    expect(body).not.toMatch(/seo/);
    expect(body).not.toMatch(/atlasContentItems/);
  });
});

describe("article regeneration — the fix is additive", () => {
  it("replaces one function body and touches no schema", () => {
    expect(SQL).toMatch(/create or replace function public\.content_engine_enqueue\(/);
    expect(SQL).not.toMatch(/create table/i);
    expect(SQL).not.toMatch(/create (unique )?index/i);
    expect(SQL).not.toMatch(/alter table/i);
    expect(SQL).not.toMatch(/\bdrop\b/i);
    expect(SQL).not.toMatch(/create policy|enable row level security/i);
    expect(SQL).not.toMatch(/update public\.|delete from public\.|insert into public\./i);
  });

  it("stays SECURITY DEFINER with a pinned search_path", () => {
    expect(SQL).toMatch(/security definer/i);
    expect(SQL).toMatch(/set search_path = public/);
  });

  it("re-states the grants without restoring the PUBLIC grant", () => {
    expect(SQL).toMatch(
      /revoke execute on function public\.content_engine_enqueue\(uuid, text, jsonb, text\)\s*\n?\s*from public, anon;/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.content_engine_enqueue\(uuid, text, jsonb, text\)\s*\n?\s*to authenticated, service_role;/,
    );
    expect(SQL).not.toMatch(/grant execute on all functions/i);
  });

  it("keeps the queue's tenant requirement and idempotency untouched", () => {
    // The payload gained a field; idempotency is keyed on (tenant_id, key) and
    // must not have been redesigned.
    expect(SQL).toMatch(
      /p_idempotency_key => coalesce\(p_idempotency_key,\s*\n?\s*'content:' \|\| p_job_type \|\| ':' \|\| p_package::text\)/,
    );
    expect(SQL).toMatch(/p_tenant_id\s*=>\s*v_org/);
    const hardening = stripComments(read(`supabase/migrations/${HARDENING_FILE}`));
    expect(hardening).toMatch(
      /if p_tenant_id is null then\s+raise exception 'Tenant is required\.' using errcode = '22004'/,
    );
    // Idempotency is still keyed on the key alone — the payload is not hashed.
    expect(hardening).toMatch(
      /where tenant_id = p_tenant_id\s*\n\s*and idempotency_key = p_idempotency_key\s*\n\s*and status not in \('completed', 'cancelled'\)/,
    );
  });

  it("sorts after the migration that created the package model it reads", () => {
    expect(CONTRACT_FILE > CONTENT_ENGINE_FILE).toBe(true);
  });
});
