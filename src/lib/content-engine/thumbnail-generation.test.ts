// ---------------------------------------------------------------------------
// Content Engine — canonical thumbnail generation
//
// WHAT THESE TESTS CATCH
// ----------------------
// The thumbnail step existed but had never run, and it was wrong in three ways
// that only surface once a provider answers:
//
//  1. it had no timeout, so an accepted-but-silent render would leave the job
//     `processing` forever (the Phase 6 failure, one step further out);
//  2. it stored the provider's short-lived URL as the authoritative asset, so
//     the canonical thumbnail would stop resolving within the hour;
//  3. it built its prompt from the article title and ignored the package's
//     curated `imagePrompt` — the only approved visual direction Atlas stores.
//
// So the tests execute the module against a real socket and a fake transport,
// and assert the properties that must never regress: the provider contract, the
// prompt's source, the abort, the DURABLE storage path, the real MIME type, the
// single canonical asset, idempotency, controlled failure, and tenant safety.
//
// They also pin the worker's executable copy to the Studio-facing provider in
// src/lib/content-engine/media.ts, because a Supabase Edge Function cannot
// import application code from `src/` and the two therefore CANNOT share one
// implementation — only a test can stop them drifting.
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  IMAGE_DEFAULT_TIMEOUT_MS,
  resolveImageTimeoutMs,
} from "../../../supabase/functions/content-engine-worker/provider-deadline";
import {
  buildThumbnailPrompt,
  decodeBase64Image,
  generateThumbnail,
  hasUsableThumbnail,
  sniffImageFormat,
  thumbnailStoragePath,
  type ThumbnailDeps,
} from "../../../supabase/functions/content-engine-worker/thumbnail";
import { buildOpenAiImageRequest, encodeBase64Bytes } from "./media";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA = readFileSync(resolve(HERE, "media.ts"), "utf8");
const WORKER = readFileSync(
  resolve(HERE, "../../../supabase/functions/content-engine-worker/thumbnail.ts"),
  "utf8",
);

const KEY = "test-image-key-do-not-log";
const BASE_URL = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2.5-flare";
const TENANT = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";
const PACKAGE = "2d156c39-1b17-4c07-a670-6713ef84b19b";

// A real 8-byte PNG signature followed by filler, so sniffing has something
// genuine to identify rather than a hand-waved magic number.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

const IMAGE_PROMPT = "Editorial illustration of editorial standards, deep navy with restrained cyan signal light.";

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

interface Recorded {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  uploads: Array<{ bucket: string; path: string; contentType: string; bytes: Uint8Array }>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  calls: number;
  failUpload?: boolean;
}

function deps(over: Partial<ThumbnailDeps> = {}, rec: Recorded = blank()): {
  deps: ThumbnailDeps;
  rec: Recorded;
} {
  const record = rec;
  return {
    rec: record,
    deps: {
      env: {
        get: (k) =>
          ({
            IMAGE_PROVIDER_API_KEY: KEY,
            OPENAI_API_KEY: null,
            IMAGE_PROVIDER_BASE_URL: BASE_URL,
            IMAGE_PROVIDER_MODEL: MODEL,
          })[k] ?? null,
      },
      transport: async ({ url, headers, body }) => {
        record.calls += 1;
        record.url = url;
        record.headers = headers as Record<string, string>;
        record.body = JSON.parse(body) as Record<string, unknown>;
        return { ok: true, status: 200, text: JSON.stringify({ data: [{ b64_json: PNG_B64 }] }) };
      },
      upload: async ({ bucket, path, bytes, contentType }) => {
        if (record.failUpload) throw new Error("storage unavailable");
        record.uploads.push({ bucket, path, bytes, contentType });
      },
      publicUrl: (p) => `https://project.supabase.co/storage/v1/object/public/${p}`,
      rpc: async (name, args) => {
        record.rpcs.push({ name, args });
        return name === "content_asset_upsert" ? { _id: "asset-123" } : null;
      },
      timeoutMs: 5000,
      ...over,
    },
  };
}

function blank(): Recorded {
  return { uploads: [], rpcs: [], calls: 0 };
}

function input(over: Record<string, unknown> = {}) {
  return {
    packageId: PACKAGE,
    tenantId: TENANT,
    packageOrganizationId: TENANT,
    packageTitle: "Why We Publish Atlas Intelligence",
    packageSlug: "why-we-publish-atlas-intelligence",
    imagePrompt: IMAGE_PROMPT,
    articleTitle: "How Atlas Checks Its Intelligence",
    brandVoice: "plain and practical",
    existing: null,
    regenerate: false,
    ...over,
  } as Parameters<typeof generateThumbnail>[0];
}

// ---------------------------------------------------------------------------

describe("provider contract", () => {
  it("requests the configured OpenAI image endpoint", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    expect(rec.url).toBe("https://api.openai.com/v1/images/generations");
  });

  it("sends the authorized model and the authorized 16:9 landscape size", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    expect(rec.body?.model).toBe("gpt-image-2.5-flare");
    expect(rec.body?.size).toBe("2048x1152");
    expect(rec.body?.n).toBe(1);
  });

  it("sends NO output-format parameter, which OpenAI rejects on the current contract", async () => {
    // OpenAI documented `response_format` for dall-e-2/dall-e-3 only, does not
    // support it for the GPT image models, and answered the live request with
    // HTTP 400 `invalid_request_error / unknown_parameter / response_format`.
    // It is removed, not replaced with a guessed parameter.
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(true);
    expect(rec.body).not.toHaveProperty("response_format");
    expect(rec.body).not.toHaveProperty("output_format");
    // Only contract-verified parameters travel.
    expect(Object.keys(rec.body ?? {}).sort()).toEqual(["model", "n", "prompt", "size"]);
  });

  it("never sends width/height, which the OpenAI images endpoint does not accept", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    expect(rec.body).not.toHaveProperty("width");
    expect(rec.body).not.toHaveProperty("height");
  });

  it("authenticates with a bearer token and never returns the key", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input(), d);
    expect(rec.headers?.authorization).toBe(`Bearer ${KEY}`);
    expect(rec.headers?.["content-type"]).toBe("application/json");
    // The key must not leak into the job result that is persisted and surfaced.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("accepts the vendor-specific credential name when the generic one is absent", async () => {
    const { deps: d, rec } = deps({
      env: {
        get: (k) =>
          ({
            OPENAI_API_KEY: KEY,
            IMAGE_PROVIDER_BASE_URL: BASE_URL,
            IMAGE_PROVIDER_MODEL: MODEL,
          })[k] ?? null,
      },
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(true);
    expect(rec.headers?.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("prompt — the curated package direction is used", () => {
  it("leads with the package's existing imagePrompt", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    expect(String(rec.body?.prompt)).toMatch(new RegExp(`^${IMAGE_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("appends only deterministic technical constraints and subject context", () => {
    const prompt = buildThumbnailPrompt({
      imagePrompt: IMAGE_PROMPT,
      articleTitle: "How Atlas Checks Its Intelligence",
      brandVoice: "plain and practical",
    });
    expect(prompt).toContain(IMAGE_PROMPT);
    expect(prompt).toContain("Subject: How Atlas Checks Its Intelligence");
    expect(prompt).toContain("2048x1152");
    expect(prompt).toContain("No fabricated statistics");
    expect(prompt).toContain("No misleading claims");
  });

  it("refuses to invent direction when the package has no curated imagePrompt", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input({ imagePrompt: null }), d);
    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION", retryable: false });
    expect(rec.calls).toBe(0);
  });
});

describe("timeout — the render is actually cancellable", () => {
  it("aborts a real outstanding request and returns a controlled failure", async () => {
    const server = createServer(() => {
      /* accept, then never answer */
    });
    open.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/images/generations`;

    let captured: AbortSignal | undefined;
    const { deps: d, rec } = deps({
      env: {
        get: (k) =>
          ({ IMAGE_PROVIDER_API_KEY: KEY, IMAGE_PROVIDER_BASE_URL: url, IMAGE_PROVIDER_MODEL: MODEL })[
            k
          ] ?? null,
      },
      timeoutMs: 150,
      transport: async (t) => {
        captured = t.signal;
        const res = await fetch(t.url, {
          method: t.method,
          headers: t.headers,
          body: t.body,
          signal: t.signal,
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
      },
    });

    const started = Date.now();
    const outcome = await generateThumbnail(input(), d);
    const elapsed = Date.now() - started;

    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_TIMEOUT" });
    expect(captured?.aborted).toBe(true);
    expect(elapsed).toBeLessThan(5000);
    // The caller is released promptly, and NOTHING is persisted on a timeout.
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("sizes the image deadline below the edge wall clock and inside the lease", () => {
    expect(IMAGE_DEFAULT_TIMEOUT_MS).toBe(75_000);
    expect(IMAGE_DEFAULT_TIMEOUT_MS).toBeLessThan(150_000);
    expect(150_000 - IMAGE_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(300_000 - IMAGE_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("resolves a missing or invalid image deadline to the derived default", () => {
    expect(resolveImageTimeoutMs(null)).toBe(IMAGE_DEFAULT_TIMEOUT_MS);
    expect(resolveImageTimeoutMs("")).toBe(IMAGE_DEFAULT_TIMEOUT_MS);
    expect(resolveImageTimeoutMs("0")).toBe(IMAGE_DEFAULT_TIMEOUT_MS);
    expect(resolveImageTimeoutMs("nope")).toBe(IMAGE_DEFAULT_TIMEOUT_MS);
    expect(resolveImageTimeoutMs("30000")).toBe(30_000);
  });
});

describe("durable persistence", () => {
  it("stores the real bytes in Atlas's existing blog-media bucket", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(true);
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].bucket).toBe("blog-media");
    expect(Array.from(rec.uploads[0].bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it("persists the durable storage path and NEVER a provider URL", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    const upsert = rec.rpcs.find((r) => r.name === "content_asset_upsert");
    expect(upsert).toBeDefined();
    expect(upsert?.args.p_storage_path).toBe(
      "blog-media/why-we-publish-atlas-intelligence/thumbnail.png",
    );
    expect(upsert?.args.p_external_url).toBeNull();
  });

  it("persists the ACTUAL sniffed MIME type rather than a hardcoded one", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    const upsert = rec.rpcs.find((r) => r.name === "content_asset_upsert");
    expect(upsert?.args.p_mime_type).toBe("image/png");
    // A JPEG is reported as a JPEG, and never as the PNG it was not.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(sniffImageFormat(jpeg)?.mimeType).toBe("image/jpeg");
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it("records provider, canonical asset identity and the curated prompt", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    const upsert = rec.rpcs.find((r) => r.name === "content_asset_upsert");
    expect(upsert?.args.p_provider).toBe("openai");
    expect(upsert?.args.p_content_type).toBe("youtube_thumbnail");
    expect(upsert?.args.p_asset_type).toBe("youtube_thumbnail");
    expect((upsert?.args.p_metadata as Record<string, unknown>).imagePrompt).toBe(IMAGE_PROMPT);
  });

  it("creates exactly ONE canonical asset and no per-destination copies", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    expect(rec.rpcs.filter((r) => r.name === "content_asset_upsert")).toHaveLength(1);
    const types = rec.rpcs
      .filter((r) => r.name === "content_asset_upsert")
      .map((r) => String(r.args.p_content_type));
    expect(new Set(types)).toEqual(new Set(["youtube_thumbnail"]));
  });

  it("points the existing canonical presentation at the durable storage URL", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    const presentation = rec.rpcs.find((r) => r.name === "content_set_youtube_presentation");
    expect(presentation?.args.p_thumbnail_url).toBe(
      "https://project.supabase.co/storage/v1/object/public/blog-media/why-we-publish-atlas-intelligence/thumbnail.png",
    );
  });

  it("derives a deterministic storage path so retries overwrite instead of duplicating", () => {
    const a = thumbnailStoragePath({ slug: "atlas-intel", packageId: PACKAGE, extension: "png" });
    const b = thumbnailStoragePath({ slug: "atlas-intel", packageId: PACKAGE, extension: "png" });
    expect(a).toBe(b);
    // A hostile or empty slug cannot escape the bucket prefix.
    expect(thumbnailStoragePath({ slug: "../../etc", packageId: PACKAGE, extension: "png" })).toBe(
      `blog-media/${PACKAGE}/thumbnail.png`,
    );
  });

  it("decodes provider base64 into the original bytes", () => {    expect(Array.from(decodeBase64Image(PNG_B64))).toEqual(Array.from(PNG_BYTES));
  });
});

describe("both verified OpenAI response shapes become the same durable bytes", () => {
  // OpenAI's images contract returns inline base64 for the GPT image models and
  // a short-lived URL for the dall-e models. With no output-format parameter
  // sent, Atlas cannot know in advance which one arrives, so BOTH must end in
  // the same stored object — and neither may leave a URL behind as the asset.
  const IMAGE_URL = "https://oaidalleapiprodscus.blob.core.windows.net/private/tmp-image.png";

  it("base64 -> bytes -> sniffed MIME -> durable storage, no URL anywhere", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(true);
    expect(rec.uploads).toHaveLength(1);
    expect(Array.from(rec.uploads[0]!.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(rec.uploads[0]!.contentType).toBe("image/png");
    // The presented URL is Atlas's OWN stored object, never a provider URL.
    expect(JSON.stringify(outcome)).not.toContain("blob.core.windows.net");
    expect((outcome as { result: Record<string, unknown> }).result.storage_path).toBe(
      "blog-media/why-we-publish-atlas-intelligence/thumbnail.png",
    );
  });

  it("url -> download -> bytes -> sniffed MIME -> durable storage", async () => {
    const seen: Array<{ url: string; method: string; wantBytes?: boolean }> = [];
    const { deps: d, rec } = deps({
      transport: async ({ url, method, wantBytes }) => {
        seen.push({ url, method, wantBytes });
        if (method === "POST") {
          return { ok: true, status: 200, text: JSON.stringify({ data: [{ url: IMAGE_URL }] }) };
        }
        return { ok: true, status: 200, text: "", bytes: PNG_BYTES };
      },
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(true);

    // The URL was followed, as a byte read, inside the same deadline.
    expect(seen[1]).toEqual({ url: IMAGE_URL, method: "GET", wantBytes: true });

    // The BYTES are what got stored — not the URL.
    expect(rec.uploads).toHaveLength(1);
    expect(Array.from(rec.uploads[0]!.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(rec.uploads[0]!.contentType).toBe("image/png");
    expect(rec.uploads[0]!.path).toBe(
      "blog-media/why-we-publish-atlas-intelligence/thumbnail.png",
    );

    // Nothing persisted or presented may reference the temporary provider URL.
    const assetUpsert = rec.rpcs.find((r) => r.name === "content_asset_upsert");
    expect(JSON.stringify(assetUpsert?.args)).not.toContain("blob.core.windows.net");
    expect(assetUpsert?.args.p_external_url).toBeNull();
    expect(assetUpsert?.args.p_storage_path).toBe(
      "blog-media/why-we-publish-atlas-intelligence/thumbnail.png",
    );

    const presentation = rec.rpcs.find((r) => r.name === "content_set_youtube_presentation");
    expect(String(presentation?.args.p_thumbnail_url)).toContain("/blog-media/");
    expect(String(presentation?.args.p_thumbnail_url)).not.toContain("blob.core.windows.net");
  });

  it("rejects a URL download whose payload is not an image, before anything is stored", async () => {
    const { deps: d, rec } = deps({
      transport: async ({ method }) =>
        method === "POST"
          ? { ok: true, status: 200, text: JSON.stringify({ data: [{ url: IMAGE_URL }] }) }
          : { ok: true, status: 200, text: "", bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(String((outcome as { message: string }).message)).toMatch(/not a recognisable image/);
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("rejects a response that carries neither bytes nor a URL", async () => {
    const { deps: d, rec } = deps({
      transport: async () => ({ ok: true, status: 200, text: JSON.stringify({ data: [{}] }) }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(rec.uploads).toHaveLength(0);
  });

  it("rejects a body that is not JSON, without crashing", async () => {
    const { deps: d, rec } = deps({
      transport: async () => ({ ok: true, status: 200, text: "<html>gateway</html>" }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(String((outcome as { message: string }).message)).toMatch(/not valid JSON/);
    expect(rec.uploads).toHaveLength(0);
  });
});

describe("diagnostic secret safety", () => {
  it("redacts a credential echoed back inside a provider rejection body", async () => {
    // The Phase 10 sanitizer runs on the rejection body. A provider (or a
    // misconfigured proxy) that echoes the key must not be able to write it
    // into job state.
    const leaky = JSON.stringify({
      error: {
        message: `invalid api key: sk-proj-${KEY} rejected for Authorization: Bearer ${KEY}`,
        type: "invalid_request_error",
        code: "invalid_api_key",
        param: null,
      },
    });
    const { deps: d, rec } = deps({
      transport: async () => ({ ok: false, status: 401, text: leaky }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome.ok).toBe(false);
    const message = String((outcome as { message: string }).message);
    expect(message).toContain("401");
    expect(message).toContain("invalid_api_key");
    expect(message).not.toContain(KEY);
    expect(message).not.toMatch(/sk-proj-/);
    expect(message).not.toMatch(/Bearer\s+\S/);
    // The raw body is never stored anywhere in the outcome.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(rec.uploads).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("reuses an existing durable thumbnail and never calls the provider", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(
      input({ existing: { storagePath: "blog-media/atlas/thumbnail.png", externalUrl: null } }),
      d,
    );
    expect(outcome).toMatchObject({ ok: true, result: { reused: true } });
    expect(rec.calls).toBe(0);
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("treats a legacy externalUrl asset as usable so it is not regenerated needlessly", () => {
    expect(hasUsableThumbnail({ storagePath: null, externalUrl: "https://x/y.png" }, false)).toBe(true);
    expect(hasUsableThumbnail({ storagePath: "blog-media/a/t.png", externalUrl: null }, false)).toBe(true);
    expect(hasUsableThumbnail(null, false)).toBe(false);
  });

  it("lets an explicit regeneration supersede the existing asset", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(
      input({
        regenerate: true,
        existing: { storagePath: "blog-media/atlas/thumbnail.png", externalUrl: null },
      }),
      d,
    );
    expect(rec.calls).toBe(1);
    expect(rec.uploads).toHaveLength(1);
  });
});

describe("controlled failure", () => {
  it("reports an HTTP rejection as a retryable failure and stores nothing", async () => {
    const { deps: d, rec } = deps({
      transport: async () => ({ ok: false, status: 429, text: "" }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR", retryable: true });
    expect(String((outcome as { message: string }).message)).toContain("429");
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("refuses an image URL that is not https", async () => {
    const { deps: d, rec } = deps({
      transport: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({ data: [{ url: "http://internal.example/tmp.png" }] }),
      }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(String((outcome as { message: string }).message)).toContain("https");
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("fails cleanly when a returned image URL's bytes cannot be downloaded", async () => {
    const { deps: d, rec } = deps({
      transport: async ({ method }) =>
        method === "POST"
          ? {
              ok: true,
              status: 200,
              text: JSON.stringify({ data: [{ url: "https://cdn.example/tmp.png" }] }),
            }
          : { ok: false, status: 404, text: "" },
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(rec.uploads).toHaveLength(0);
    expect(rec.rpcs).toHaveLength(0);
  });

  it("refuses bytes that are not a recognisable image", async () => {
    const { deps: d, rec } = deps({
      transport: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
      }),
    });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(rec.uploads).toHaveLength(0);
  });

  it("writes no asset row when storage fails, so nothing is falsely completed", async () => {
    const rec = blank();
    rec.failUpload = true;
    const { deps: d } = deps({}, rec);
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "STORAGE_ERROR", retryable: true });
    expect(rec.rpcs).toHaveLength(0);
  });

  it("fails closed, without contacting anyone, when no provider is configured", async () => {
    const { deps: d, rec } = deps({ env: { get: () => null } });
    const outcome = await generateThumbnail(input(), d);
    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED", retryable: false });
    expect(rec.calls).toBe(0);
  });
});

describe("tenant safety", () => {
  it("refuses a package that does not belong to the job's tenant", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(
      input({ packageOrganizationId: "99999999-9999-4999-8999-999999999999" }),
      d,
    );
    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION", retryable: false });
    expect(rec.calls).toBe(0);
    expect(rec.uploads).toHaveLength(0);
  });

  it("refuses a package with no ownership at all", async () => {
    const { deps: d, rec } = deps();
    const outcome = await generateThumbnail(input({ packageOrganizationId: null }), d);
    expect(outcome.ok).toBe(false);
    expect(rec.calls).toBe(0);
  });

  it("writes the asset against the job's package, never a caller-supplied one", async () => {
    const { deps: d, rec } = deps();
    await generateThumbnail(input(), d);
    for (const call of rec.rpcs) {
      expect(call.args.p_package).toBe(PACKAGE);
    }
  });
});

describe("no drift between the worker's copy and the Studio-facing provider", () => {
  it("agrees on the endpoint, model, size and env var names", () => {
    // A Supabase Edge Function is bundled from its own directory and cannot
    // import src/, so these two descriptions of the same contract cannot share
    // an implementation. This test is the only thing stopping them diverging.
    expect(MEDIA).toContain('"https://api.openai.com/v1/images/generations"');
    expect(MEDIA).toContain('"gpt-image-2.5-flare"');
    expect(MEDIA).toContain('"2048x1152"');
    for (const name of [
      "IMAGE_PROVIDER_API_KEY",
      "IMAGE_PROVIDER_BASE_URL",
      "IMAGE_PROVIDER_MODEL",
      "OPENAI_API_KEY",
    ]) {
      expect(MEDIA).toContain(name);
    }
  });

  it("builds the SAME request body on both sides, with no output-format parameter", () => {
    // The drift guard that matters most: the rejected parameter must not
    // reappear on either side, and both bodies must stay byte-identical.
    const body = buildOpenAiImageRequest({ prompt: "p", overlayText: null, aspectRatio: "16:9", width: 2048, height: 1152, outputPrefix: "x" }, MODEL);
    expect(body).not.toHaveProperty("response_format");
    expect(body).toEqual({ model: MODEL, prompt: "p", n: 1, size: "2048x1152" });
    // The executable worker copy builds the same body inline.
    expect(WORKER).toContain("n: 1,");
    expect(WORKER).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*response_format/s);
  });
});
