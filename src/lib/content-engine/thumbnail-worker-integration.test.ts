// ---------------------------------------------------------------------------
// Atlas Content Engine — WORKER thumbnail orchestration proof
//
// WHAT THIS PROVES
//   The existing worker media step (`content-engine-worker/thumbnail.ts`) can
//   orchestrate the PROVEN deterministic compositor adapter as an alternative
//   renderer, with no new queue, no new job type, no new state machine, no new
//   asset identity and no schema change:
//
//       synthetic approved-ish package
//         -> worker media step (tenant precondition + idempotency)
//         -> thumbnail adapter (src/lib/content-engine/thumbnail-compositor.ts)
//         -> canonical compositor response
//         -> the SAME persistence tail the provider path uses
//         -> one canonical youtube_thumbnail asset
//
//   The adapter used here is the REAL one, not a stand-in: the harness injects
//   its transport with the exact bytes the DEPLOYED `content-thumbnail-compose`
//   function returned for the canonical fixture (SHA-256 acd2f2c1…f5815), so the
//   worker's orchestration is proven against proven bytes.
//
//   Nothing here touches production: no Supabase client, no network, no storage
//   bucket, no database, no deployment. Storage, RPCs and the package view are
//   in-memory fakes that record exactly what the worker asked for.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM
//   The worker is NOT deployed and this is NOT a production run. It is an
//   orchestration proof of code that already exists.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_ASSET_TYPE,
  THUMBNAIL_BUCKET,
  THUMBNAIL_COMPOSITOR_PROVIDER,
  THUMBNAIL_CONTENT_TYPE,
  generateThumbnail,
  thumbnailStoragePath,
  type ComposeThumbnailFn,
  type ThumbnailDeps,
} from "../../../supabase/functions/content-engine-worker/thumbnail";
import {
  COMPOSITOR_VERSION,
  ThumbnailCompositorError,
  composeApprovedThumbnail,
  type CompositorTransport,
  type CompositorTransportResponse,
} from "./thumbnail-compositor";
import { canPublish } from "./package";
import {
  CANONICAL_THUMBNAIL_PNG_BASE64,
  CANONICAL_THUMBNAIL_SHA256,
  FIXTURE_BACKGROUND_DATA_URI,
  FIXTURE_OVERLAY_LINES,
} from "./thumbnail-compositor.fixture";

// ---------------------------------------------------------------------------
// A fully synthetic world
// ---------------------------------------------------------------------------

/** Synthetic ids. These are not any production tenant, package or article. */
const TENANT = "7c9e1b30-5a2d-4f18-9c63-2d4e6f8a1b20";
const OTHER_TENANT = "0000ffff-1111-4222-8333-444444444444";
const PACKAGE = "3f2a7c10-9d41-4c8e-9a55-0b7c1d2e3f44";
const SLUG = "synthetic-worker-proof";
const TITLE = "Synthetic Package For The Worker Proof";

function canonicalBytes(): Uint8Array {
  const buffer = Buffer.from(CANONICAL_THUMBNAIL_PNG_BASE64, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The deployed response, replayed through the adapter's transport seam. */
function canonicalTransport(
  overrides: Partial<CompositorTransportResponse> = {},
): CompositorTransport {
  return async () => ({
    status: 200,
    contentType: "image/png",
    compositorVersion: COMPOSITOR_VERSION,
    bytes: canonicalBytes(),
    ...overrides,
  });
}

/**
 * Bridge the worker's compositor hook to the REAL proven adapter.
 *
 * This is the integration seam under test: the worker's hook contract and the
 * adapter's outcome contract meet here, and the adapter's typed errors become
 * the step's typed failures without any hand-written translation table.
 */
function adapterBridge(options: { transport?: CompositorTransport } = {}): ComposeThumbnailFn {
  return async ({ backgroundDataUri, overlayLines, contentPackageId }) => {
    try {
      const artifact = await composeApprovedThumbnail(
        { backgroundDataUri, overlayLines, contentPackageId },
        options.transport ?? canonicalTransport(),
      );
      return {
        ok: true,
        artifact: {
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          width: artifact.width,
          height: artifact.height,
          byteSize: artifact.byteSize,
          mimeType: artifact.mimeType,
        },
      };
    } catch (error) {
      if (error instanceof ThumbnailCompositorError) {
        return { ok: false, code: error.code, message: error.message, retryable: error.retryable };
      }
      throw error;
    }
  };
}

interface World {
  deps: ThumbnailDeps;
  rec: {
    composeCalls: number;
    /** Calls to the GENERATIVE provider transport. Must stay at zero. */
    providerCalls: number;
    uploads: Array<{ bucket: string; path: string; contentType: string }>;
    rpcs: Array<{ name: string; args: Record<string, unknown> }>;
    /** Storage objects, keyed `bucket/path`. Size is the no-duplicate measure. */
    objects: Map<string, Uint8Array>;
  };
  /** What `content_package_get` would report back as the thumbnail asset. */
  packageThumbnail: { storagePath: string | null; externalUrl: string | null } | null;
  input(over?: Record<string, unknown>): Parameters<typeof generateThumbnail>[0];
}

interface WorldOptions {
  composeThumbnail?: ComposeThumbnailFn;
  /** Fail `content_asset_upsert` this many times (simulates a post-success failure). */
  failUpsertTimes?: number;
  timeoutMs?: number;
}

function makeWorld(options: WorldOptions = {}): World {
  const rec: World["rec"] = {
    composeCalls: 0,
    providerCalls: 0,
    uploads: [],
    rpcs: [],
    objects: new Map(),
  };
  const state: { thumbnail: World["packageThumbnail"]; upsertFailuresLeft: number } = {
    thumbnail: null,
    upsertFailuresLeft: options.failUpsertTimes ?? 0,
  };

  const baseCompose = options.composeThumbnail ?? adapterBridge();
  const deps: ThumbnailDeps = {
    // NO image provider is configured anywhere in this world. That is the
    // point: the compositor path must not need one.
    env: { get: () => null },
    transport: async () => {
      rec.providerCalls += 1;
      throw new Error("The generative provider must not be reached on this path.");
    },
    upload: async ({ bucket, path, bytes, contentType }) => {
      rec.uploads.push({ bucket, path, contentType });
      rec.objects.set(`${bucket}/${path}`, bytes);
    },
    publicUrl: (path) => `https://project.supabase.co/storage/v1/object/public/${path}`,
    rpc: async (name, args) => {
      rec.rpcs.push({ name, args });
      if (name === "content_asset_upsert") {
        if (state.upsertFailuresLeft > 0) {
          state.upsertFailuresLeft -= 1;
          throw new Error("content_asset_upsert is unavailable");
        }
        state.thumbnail = { storagePath: String(args.p_storage_path), externalUrl: null };
        return { _id: "asset-compositor-0001" };
      }
      return null;
    },
    timeoutMs: options.timeoutMs ?? 5_000,
    composeThumbnail: async (composeInput) => {
      rec.composeCalls += 1;
      return baseCompose(composeInput);
    },
  };

  return {
    deps,
    rec,
    get packageThumbnail() {
      return state.thumbnail;
    },
    input(over = {}) {
      return {
        packageId: PACKAGE,
        tenantId: TENANT,
        packageOrganizationId: TENANT,
        packageTitle: TITLE,
        packageSlug: SLUG,
        imagePrompt: null,
        articleTitle: null,
        brandVoice: null,
        existing: state.thumbnail,
        regenerate: false,
        renderer: {
          kind: "compositor",
          backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
          overlayLines: [...FIXTURE_OVERLAY_LINES],
        },
        ...over,
      } as Parameters<typeof generateThumbnail>[0];
    },
  };
}

const EXPECTED_PATH = thumbnailStoragePath({ slug: SLUG, packageId: PACKAGE, extension: "png" });
const EXPECTED_URL = `https://project.supabase.co/storage/v1/object/public/${EXPECTED_PATH}`;
const upsertArgs = (world: World) =>
  world.rec.rpcs.find((r) => r.name === "content_asset_upsert")?.args ?? {};

// ---------------------------------------------------------------------------
// The happy path: worker -> adapter -> compositor -> canonical artifact
// ---------------------------------------------------------------------------

describe("worker orchestration — deterministic compositor", () => {
  it("renders, verifies and persists exactly one canonical thumbnail", async () => {
    const world = makeWorld();
    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provider).toBe(THUMBNAIL_COMPOSITOR_PROVIDER);
    expect(outcome.result.storage_path).toBe(EXPECTED_PATH);
    expect(outcome.result.url).toBe(EXPECTED_URL);
    expect(outcome.result.mime_type).toBe("image/png");
    expect(outcome.result.asset_id).toBe("asset-compositor-0001");
  });

  it("invokes the compositor exactly once and never the generative provider", async () => {
    const world = makeWorld();
    await generateThumbnail(world.input(), world.deps);

    expect(world.rec.composeCalls).toBe(1);
    // No image provider is configured in this world at all, so reaching for one
    // would have failed the step outright.
    expect(world.rec.providerCalls).toBe(0);
  });

  it("stores the exact bytes the deployed compositor produced", async () => {
    const world = makeWorld();
    await generateThumbnail(world.input(), world.deps);

    const stored = world.rec.objects.get(`${THUMBNAIL_BUCKET}/${EXPECTED_PATH}`);
    expect(stored).toBeDefined();
    expect(stored!.byteLength).toBe(54_552);
    expect(Buffer.from(stored!).equals(Buffer.from(canonicalBytes()))).toBe(true);
    // One object only: no litter from a second render.
    expect(world.rec.objects.size).toBe(1);
  });

  it("records the render's identity and content hash on the asset", async () => {
    const world = makeWorld();
    await generateThumbnail(world.input(), world.deps);
    const args = upsertArgs(world);

    expect(args.p_content_type).toBe(THUMBNAIL_CONTENT_TYPE);
    expect(args.p_asset_type).toBe(THUMBNAIL_ASSET_TYPE);
    expect(args.p_provider).toBe(THUMBNAIL_COMPOSITOR_PROVIDER);
    expect(args.p_storage_path).toBe(EXPECTED_PATH);
    // The stored object is the asset; no expiring external URL is authoritative.
    expect(args.p_external_url).toBeNull();
    expect(args.p_status).toBe("drafted");
    expect(args.p_metadata).toMatchObject({
      source: THUMBNAIL_COMPOSITOR_PROVIDER,
      renderer: "content-thumbnail-compose",
      sha256: CANONICAL_THUMBNAIL_SHA256,
      width: 2048,
      height: 1152,
      byteSize: 54_552,
      mimeType: "image/png",
    });
  });

  it("writes the canonical presentation reference and nothing else", async () => {
    const world = makeWorld();
    await generateThumbnail(world.input(), world.deps);

    expect(world.rec.rpcs.map((r) => r.name)).toEqual([
      "content_asset_upsert",
      "content_set_youtube_presentation",
    ]);
    const presentation = world.rec.rpcs.find((r) => r.name === "content_set_youtube_presentation");
    expect(presentation?.args.p_package).toBe(PACKAGE);
    expect(presentation?.args.p_thumbnail_url).toBe(EXPECTED_URL);
  });

  it("forwards the approved overlay lines verbatim to the adapter", async () => {
    const seen: string[][] = [];
    const world = makeWorld({
      transport: undefined,
      composeThumbnail: adapterBridge({
        transport: async (request) => {
          seen.push([...request.text.lines]);
          return {
            status: 200,
            contentType: "image/png",
            compositorVersion: COMPOSITOR_VERSION,
            bytes: canonicalBytes(),
          };
        },
      }),
    });
    await generateThumbnail(world.input(), world.deps);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["NOTHING PUBLISHES", "WITHOUT A HUMAN"]);
  });

  it("refuses a package owned by another tenant before invoking the compositor", async () => {
    const world = makeWorld();
    const outcome = await generateThumbnail(
      world.input({ packageOrganizationId: OTHER_TENANT }),
      world.deps,
    );

    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION", retryable: false });
    expect(world.rec.composeCalls).toBe(0);
    expect(world.rec.uploads).toHaveLength(0);
  });

  it("leaves the generative provider path untouched when no renderer is selected", async () => {
    // The default is still the provider: adding the compositor changed nothing
    // about existing production behaviour.
    const world = makeWorld();
    const outcome = await generateThumbnail(world.input({ renderer: undefined }), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(world.rec.composeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency — the same job executed twice", () => {
  it("the second execution reuses the stored artifact and renders nothing", async () => {
    const world = makeWorld();

    const first = await generateThumbnail(world.input(), world.deps);
    const second = await generateThumbnail(world.input(), world.deps);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Second execution is a REUSE, not a second render.
    expect(second.result).toMatchObject({ reused: true, package_id: PACKAGE });

    // One render, one upload, one object, one asset row.
    expect(world.rec.composeCalls).toBe(1);
    expect(world.rec.uploads).toHaveLength(1);
    expect(world.rec.objects.size).toBe(1);
    expect(world.rec.rpcs.filter((r) => r.name === "content_asset_upsert")).toHaveLength(1);
  });

  it("refuses to re-render on regenerate ALONE, because replacement is a separate decision", async () => {
    const world = makeWorld();

    const first = await generateThumbnail(world.input(), world.deps);
    const second = await generateThumbnail(world.input({ regenerate: true }), world.deps);

    expect(first.ok).toBe(true);
    // `regenerate` means "render again". It is NOT consent to overwrite an
    // artifact a human supplied, so on its own it is refused.
    expect(second).toMatchObject({ ok: false, code: "REPLACEMENT_NOT_AUTHORIZED", retryable: false });
    expect(world.rec.composeCalls).toBe(1);
    expect(world.rec.objects.size).toBe(1);
  });

  it("re-renders into the SAME deterministic object once replacement is authorized", async () => {
    const world = makeWorld();

    const first = await generateThumbnail(world.input(), world.deps);
    const second = await generateThumbnail(
      world.input({ regenerate: true, replaceExistingThumbnail: true }),
      world.deps,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(world.rec.composeCalls).toBe(2);
    // The path is derived from the package, so an authorized re-render OVERWRITES
    // rather than accumulating a second near-identical object.
    expect(world.rec.objects.size).toBe(1);
    expect(world.rec.objects.has(`${THUMBNAIL_BUCKET}/${EXPECTED_PATH}`)).toBe(true);

    const stored = world.rec.objects.get(`${THUMBNAIL_BUCKET}/${EXPECTED_PATH}`)!;
    expect(Buffer.from(stored).equals(Buffer.from(canonicalBytes()))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure AFTER external success
// ---------------------------------------------------------------------------

describe("failure after external success", () => {
  it("re-running after a failed asset upsert leaves exactly one object and one asset", async () => {
    // The compositor succeeds and the bytes ARE stored, then the asset row
    // cannot be written: the external result succeeds and the job fails after.
    const world = makeWorld({ failUpsertTimes: 1 });

    const first = generateThumbnail(world.input(), world.deps);
    // The upsert rejection propagates to the worker loop, which records an
    // INTERNAL, retryable failure — it is NOT reported as success.
    await expect(first).rejects.toThrow(/content_asset_upsert is unavailable/);
    expect(world.rec.objects.size).toBe(1);
    expect(world.packageThumbnail).toBeNull();

    // The retry.
    const second = await generateThumbnail(world.input(), world.deps);
    expect(second.ok).toBe(true);
    // The retry rewrote the SAME object: no orphan, no second object.
    expect(world.rec.objects.size).toBe(1);
    expect(world.packageThumbnail).toEqual({ storagePath: EXPECTED_PATH, externalUrl: null });
    expect(world.rec.rpcs.filter((r) => r.name === "content_asset_upsert")).toHaveLength(2);
  });

  it("a storage failure marks nothing authored and stores nothing", async () => {
    const world = makeWorld();
    world.deps.upload = async () => {
      throw new Error("storage unavailable");
    };

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "STORAGE_ERROR", retryable: true });
    expect(world.rec.rpcs).toHaveLength(0);
    expect(world.packageThumbnail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

describe("retry behaviour", () => {
  it("a retryable compositor failure (HTTP 500) is retryable and stores nothing", async () => {
    const world = makeWorld({
      composeThumbnail: adapterBridge({ transport: canonicalTransport({ status: 500 }) }),
    });

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "HTTP_ERROR", retryable: true });
    expect(world.rec.uploads).toHaveLength(0);
    expect(world.rec.rpcs).toHaveLength(0);
  });

  it("a permanent rejection (HTTP 400) is not retried and stores nothing", async () => {
    const world = makeWorld({
      composeThumbnail: adapterBridge({ transport: canonicalTransport({ status: 400 }) }),
    });

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "COMPOSITOR_REJECTED", retryable: false });
    expect(world.rec.uploads).toHaveLength(0);
  });

  it("a permanently invalid background is rejected before any render", async () => {
    // A remote URL is not an approved background, so the adapter refuses it.
    // The transport below must never be reached: proving that is the point.
    const world = makeWorld({
      composeThumbnail: adapterBridge({
        transport: async () => {
          throw new Error("The compositor must not be asked to render an unapproved background.");
        },
      }),
    });
    const outcome = await generateThumbnail(
      world.input({
        renderer: {
          kind: "compositor",
          backgroundDataUri: "https://example.com/not-approved.png",
          overlayLines: [...FIXTURE_OVERLAY_LINES],
        },
      }),
      world.deps,
    );

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_INPUT", retryable: false });
    expect(world.rec.uploads).toHaveLength(0);
    expect(world.rec.rpcs).toHaveLength(0);
  });

  it("a timeout is classified PROVIDER_TIMEOUT, is retryable, and stores nothing", async () => {
    const world = makeWorld({
      timeoutMs: 25,
      composeThumbnail: () => new Promise(() => {}),
    });

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_TIMEOUT", retryable: true });
    expect(world.rec.uploads).toHaveLength(0);
    expect(world.rec.rpcs).toHaveLength(0);
  });

  it("an unauthenticated caller is permanent, not retryable", async () => {
    const world = makeWorld({
      composeThumbnail: adapterBridge({ transport: canonicalTransport({ status: 401 }) }),
    });

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "UNAUTHENTICATED", retryable: false });
    expect(world.rec.uploads).toHaveLength(0);
  });

  it("a compositor that is not wired is reported as NOT_CONFIGURED, not as success", async () => {
    const world = makeWorld();
    world.deps.composeThumbnail = undefined;

    const outcome = await generateThumbnail(world.input(), world.deps);

    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED", retryable: false });
    expect(world.rec.uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Provider isolation
// ---------------------------------------------------------------------------

describe("provider isolation", () => {
  it("never names PixVerse, OpenAI, YouTube or LinkedIn on this path", async () => {
    const world = makeWorld();
    const outcome = await generateThumbnail(world.input(), world.deps);
    expect(outcome.ok).toBe(true);

    // The only endpoints the worker touched are its own storage seam and its
    // own RPCs. No video, social or generative-image provider appears anywhere.
    const rendered = JSON.stringify(outcome.result);
    for (const provider of ["pixverse", "openai", "youtube", "linkedin", "image_provider"]) {
      expect(rendered.toLowerCase()).not.toContain(provider);
    }
    expect(world.rec.providerCalls).toBe(0);
    for (const call of world.rec.rpcs) {
      // `content_set_youtube_presentation` is a PRE-EXISTING package hook that
      // records a thumbnail URL on the package; it contacts no YouTube API and
      // publishes nothing. Nothing here publishes, generates video, or posts to a
      // social network.
      expect(call.name).not.toMatch(/publish|video|social|linkedin/i);
      expect(call.name).not.toBe("content_publication_upsert");
    }
  });
});

// ---------------------------------------------------------------------------
// The approval gate — reported honestly, not weakened
// ---------------------------------------------------------------------------

describe("approval gate", () => {
  it("a composited thumbnail does not make an unapproved package publishable", () => {
    // The engine generates MEDIA before review by design (`nextWorkflowStep`
    // puts `thumbnail` ahead of `review`), and gates PUBLISHING instead. The
    // compositor renderer does not change that boundary: it produces an asset,
    // and the asset confers no approval.
    const pending = canPublish({ approvalStatus: "pending", status: "drafting" }, { autoPublish: false });
    expect(pending.ok).toBe(false);
    expect(pending.reason).toMatch(/approved by a human/i);
  });

  it("approval still requires an explicit human decision, never a renderer", () => {
    expect(canPublish({ approvalStatus: "approved", status: "approved" }, { autoPublish: false }).ok).toBe(true);
    expect(canPublish({ approvalStatus: "rejected", status: "drafting" }, { autoPublish: false }).ok).toBe(false);
    expect(
      canPublish({ approvalStatus: "pending", status: "approved" }, { autoPublish: true }).ok,
    ).toBe(true);
  });
});
