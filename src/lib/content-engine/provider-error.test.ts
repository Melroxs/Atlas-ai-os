// ---------------------------------------------------------------------------
// Content Engine — provider error diagnostics
//
// THE FAILURE THIS EXISTS TO CATCH
// -------------------------------
// The Phase 9 production run returned a bare "HTTP 400" and nothing else. The
// provider had already told us WHY in the response body — the worker read it and
// then threw it away — so a diagnosable rejection arrived as an undiagnosable one.
//
// The tests therefore assert two things that pull in opposite directions, and
// both must hold:
//
//   1. the reason is CAPTURED (message, code, type, param) and is legible;
//   2. the capture can never become a secret leak, an unbounded blob, or a
//      reason for the worker itself to fail.
//
// Because the sanitiser exists in two copies (the deployed worker and the
// Studio-facing provider cannot share a module across the Edge bundle boundary),
// the suite also executes BOTH over the same fixtures and demands identical
// output. A security control that is duplicated but unpinned is a control that
// quietly stops applying.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  MAX_PROVIDER_FIELD_CHARS,
  describeProviderError as describeStudio,
  formatProviderError as formatStudio,
} from "./provider-error";
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARS as WORKER_MAX_CHARS,
  MAX_PROVIDER_FIELD_CHARS as WORKER_MAX_FIELD,
  describeProviderError as describeWorker,
  formatProviderError as formatWorker,
} from "../../../supabase/functions/content-engine-worker/provider-error";
import { generateThumbnail, type ThumbnailDeps } from "../../../supabase/functions/content-engine-worker/thumbnail";

const OPENAI_400 = JSON.stringify({
  error: {
    message: "Example provider rejection",
    type: "invalid_request_error",
    param: "prompt",
    code: "content_policy_violation",
  },
});

const CREDENTIALS = [
  "sk-abc123def456",
  "sk-proj-xyz789012345",
  "nvapi-ZZZ9999yyyy8888",
  "AIzaSyTopSecretValue123",
  "AKIAIOSFODNN7EXAMPLE",
  "topsecrettokengoeshere",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh",
];

// Test 1 — the standard OpenAI rejection shape.
describe("provider error diagnostics — a standard rejection becomes legible", () => {
  it("1. captures status, message, type, param and code", () => {
    const d = describeStudio({ provider: "openai", status: 400, body: OPENAI_400 });
    expect(d.provider).toBe("openai");
    expect(d.provider_status).toBe(400);
    expect(d.provider_type).toBe("invalid_request_error");
    expect(d.provider_param).toBe("prompt");
    expect(d.provider_code).toBe("content_policy_violation");
    expect(d.detail).toContain("Example provider rejection");
  });

  it("1b. formats one readable line that carries the reason and the status", () => {
    const line = formatStudio(describeStudio({ provider: "openai", status: 400, body: OPENAI_400 }));
    expect(line).toContain("HTTP 400");
    expect(line).toContain("Example provider rejection");
    expect(line).toContain("code=content_policy_violation");
    expect(line).toContain("type=invalid_request_error");
    expect(line).toContain("param=prompt");
  });

  it("1c. still says something useful when the body is empty", () => {
    const line = formatStudio(describeStudio({ provider: "openai", status: 503, body: "" }));
    expect(line).toContain("HTTP 503");
    expect(line.length).toBeGreaterThan(0);
  });
});

// Test 2 — the capture must never become a secret leak.
describe("provider error diagnostics — credentials never survive", () => {
  const leaky = JSON.stringify({
    error: {
      message:
        "Bad key: Bearer sk-abc123def456 OPENAI_API_KEY=sk-proj-xyz789012345 " +
        "Authorization: Bearer topsecrettokengoeshere nvapi-ZZZ9999yyyy8888 " +
        "AIzaSyTopSecretValue123 AKIAIOSFODNN7EXAMPLE",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  });

  it("2. redacts every credential shape from a structured error", () => {
    const d = describeStudio({ provider: "openai", status: 401, body: leaky });
    const serialised = JSON.stringify(d);
    for (const secret of CREDENTIALS) {
      expect(serialised, `${secret} must never be stored`).not.toContain(secret);
    }
    expect(serialised).toContain("[redacted]");
  });

  it("2b. redacts credentials from a NON-JSON body too", () => {
    const html =
      "<html><body>Upstream said: Bearer sk-abc123def456 and OPENAI_API_KEY=sk-proj-xyz789012345</body></html>";
    const serialised = JSON.stringify(describeStudio({ provider: "openai", status: 502, body: html }));
    for (const secret of CREDENTIALS) expect(serialised).not.toContain(secret);
  });

  it("2c. redacts credentials that appear in the structured code/type/param fields", () => {
    const d = describeStudio({
      provider: "openai",
      status: 400,
      body: JSON.stringify({ error: { message: "x", code: "sk-abc123def456", param: "Bearer topsecrettokengoeshere" } }),
    });
    const serialised = JSON.stringify(d);
    expect(serialised).not.toContain("sk-abc123def456");
    expect(serialised).not.toContain("topsecrettokengoeshere");
  });
});

// Test 3 — an unexpected body must never throw.
describe("provider error diagnostics — hostile bodies are survivable", () => {
  const bodies: Array<[string, string]> = [
    ["not json at all", "totally not json"],
    ["truncated json", '{"error":{"message":"trunc'],
    ["html error page", "<html><body>502 Bad Gateway</body></html>"],
    ["json array", "[1,2,3]"],
    ["json null", "null"],
    ["json primitive", '"just a string"'],
    ["error node not an object", '{"error":"nope"}'],
    ["error message not a string", '{"error":{"message":42}}'],
    ["empty object", "{}"],
  ];

  for (const [name, body] of bodies) {
    it(`3. never throws on ${name}`, () => {
      const d = describeStudio({ provider: "openai", status: 400, body });
      expect(d.provider_status).toBe(400);
      expect(typeof d.detail).toBe("string");
      expect(formatStudio(d)).toContain("HTTP 400");
    });
  }

  it("3b. tolerates a body that is not a string at all", () => {
    const d = describeStudio({ provider: "openai", status: 400, body: undefined as unknown as string });
    expect(d.detail).toBe("");
  });
});

// Test 4 — bounded output.
describe("provider error diagnostics — output is bounded", () => {
  it("4. caps the detail at 1,000 characters", () => {
    const d = describeStudio({ provider: "openai", status: 400, body: "x".repeat(5_000) });
    expect(d.detail.length).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_CHARS);
    expect(MAX_PROVIDER_DIAGNOSTIC_CHARS).toBe(1_000);
  });

  it("4b. caps each structured field independently", () => {
    const d = describeStudio({
      provider: "openai",
      status: 400,
      body: JSON.stringify({ error: { message: "m".repeat(4_000), code: "c".repeat(4_000) } }),
    });
    expect(d.detail!.length).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_CHARS);
    expect(d.provider_code!.length).toBeLessThanOrEqual(MAX_PROVIDER_FIELD_CHARS);
  });

  it("4c. the whole formatted line stays bounded", () => {
    const line = formatStudio(
      describeStudio({
        provider: "openai",
        status: 400,
        body: JSON.stringify({ error: { message: "y".repeat(9_000), code: "z".repeat(9_000), type: "t".repeat(9_000), param: "p".repeat(9_000) } }),
      }),
    );
    expect(line.length).toBeLessThan(MAX_PROVIDER_DIAGNOSTIC_CHARS + 400);
  });
});

// Test 5 — the successful path is untouched.
describe("provider error diagnostics — the success path is unchanged", () => {
  it("5. a successful render still completes with no diagnostic anywhere", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString("base64");
    const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps: ThumbnailDeps = {
      env: {
        get: (k) =>
          ({
            IMAGE_PROVIDER_API_KEY: "k",
            IMAGE_PROVIDER_BASE_URL: "https://api.openai.com/v1/images/generations",
            IMAGE_PROVIDER_MODEL: "gpt-image-2.5-flare",
          })[k] ?? null,
      },
      transport: async () => ({ ok: true, status: 200, text: JSON.stringify({ data: [{ b64_json: png }] }) }),
      upload: async () => undefined,
      publicUrl: (p) => `https://x/${p}`,
      rpc: async (name, args) => {
        rpcs.push({ name, args });
        return { _id: "a1" };
      },
      timeoutMs: 5_000,
    };
    const outcome = await generateThumbnail(
      {
        packageId: "p",
        tenantId: "t",
        packageOrganizationId: "t",
        packageTitle: "T",
        packageSlug: "s",
        imagePrompt: "brief",
        articleTitle: null,
        brandVoice: null,
        existing: null,
        regenerate: false,
      },
      deps,
    );
    expect(outcome.ok).toBe(true);
    // No diagnostic text leaks into a successful job result.
    expect(JSON.stringify(outcome)).not.toContain("[redacted]");
    expect(rpcs.map((r) => r.name)).toEqual(["content_asset_upsert", "content_set_youtube_presentation"]);
  });

  it("5b. a rejection message still reaches the job as `PROVIDER_ERROR`", async () => {
    const deps: ThumbnailDeps = {
      env: {
        get: (k) =>
          ({
            IMAGE_PROVIDER_API_KEY: "k",
            IMAGE_PROVIDER_BASE_URL: "https://api.openai.com/v1/images/generations",
            IMAGE_PROVIDER_MODEL: "gpt-image-2.5-flare",
          })[k] ?? null,
      },
      transport: async () => ({ ok: false, status: 400, text: OPENAI_400 }),
      upload: async () => {
        throw new Error("must not upload on a rejection");
      },
      publicUrl: (p) => p,
      rpc: async () => {
        throw new Error("must not write an asset on a rejection");
      },
      timeoutMs: 5_000,
    };
    const outcome = await generateThumbnail(
      {
        packageId: "p",
        tenantId: "t",
        packageOrganizationId: "t",
        packageTitle: "T",
        packageSlug: "s",
        imagePrompt: "brief",
        articleTitle: null,
        brandVoice: null,
        existing: null,
        regenerate: false,
      },
      deps,
    );
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR", retryable: true });
    expect((outcome as { message: string }).message).toContain("Example provider rejection");
  });
});

// The two copies must behave identically, or one of them is unprotected.
describe("provider error diagnostics — the deployed and Studio copies cannot diverge", () => {
  const fixtures: Array<{ status: number; body: string }> = [
    { status: 400, body: OPENAI_400 },
    { status: 401, body: JSON.stringify({ error: { message: "Bearer sk-abc123def456", code: "invalid_api_key" } }) },
    { status: 500, body: "not json, and quite long ".repeat(200) },
    { status: 429, body: "" },
    { status: 502, body: "<html>502</html>" },
    { status: 400, body: JSON.stringify({ error: { message: "m".repeat(4_000), param: "p".repeat(4_000) } }) },
  ];

  it("produces byte-identical diagnostics from both implementations", () => {
    expect(WORKER_MAX_CHARS).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS);
    expect(WORKER_MAX_FIELD).toBe(MAX_PROVIDER_FIELD_CHARS);
    for (const f of fixtures) {
      const worker = describeWorker({ provider: "openai", status: f.status, body: f.body });
      const studio = describeStudio({ provider: "openai", status: f.status, body: f.body });
      expect(worker, `diagnostic diverged for status ${f.status}`).toEqual(studio);
      expect(formatWorker(worker)).toBe(formatStudio(studio));
    }
  });
});
