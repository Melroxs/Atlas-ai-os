// ---------------------------------------------------------------------------
// Atlas Content Engine — thumbnail INPUT contract, implemented
//
// WHAT THESE TESTS PIN
// --------------------
// The deterministic compositor may only ever compose from inputs a human
// approved, belonging to the package it is rendering for and the organization
// that owns it. Everything here executes the REAL resolution and validation
// module — no mocks of the rules themselves — with one injected capability (the
// storage read), so the whole decision surface runs offline.
//
//   * SCHEMA      the migration widens one CHECK and nothing else
//   * DRIFT       the limits and vocabulary are defined once, not twice
//   * BACKGROUND  approved PNG accepted; every other shape refused
//   * OVERLAY     approved, ordered copy accepted; no fallback, ever
//   * RENDERER    reference form resolved; resolved form accepted; unknown fails
//   * PROTECTION  an operator's existing thumbnail is never silently replaced
//   * PROVENANCE  a render records its inputs completely, and stale keys clear
//
// Article 01's real thumbnail is used as the safety fixture throughout. Nothing
// here touches production, storage, the database or any provider.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BACKGROUND_BYTES as COMPOSITOR_MAX_BACKGROUND_BYTES,
  MAX_LINE_CHARS as COMPOSITOR_MAX_LINE_CHARS,
  MAX_TEXT_LINES as COMPOSITOR_MAX_TEXT_LINES,
  COMPOSITOR_VERSION,
} from "../../../supabase/functions/content-thumbnail-compose/compositor";
import {
  MAX_BACKGROUND_BYTES,
  MAX_OVERLAY_LINE_CHARS,
  MAX_OVERLAY_LINES,
  THUMBNAIL_BACKGROUND_ASSET_TYPE,
  THUMBNAIL_BACKGROUND_CONTENT_TYPE,
  THUMBNAIL_OVERLAY_ASSET_TYPE,
  THUMBNAIL_OVERLAY_CONTENT_TYPE,
  resolveThumbnailInputs,
  type ThumbnailInputAsset,
} from "../../../supabase/functions/content-engine-worker/thumbnail-input";
import {
  THUMBNAIL_COMPOSITOR_PROVIDER,
  THUMBNAIL_COMPOSITOR_VERSION,
  generateThumbnail,
  readThumbnailRenderer,
  type ComposeThumbnailFn,
  type ThumbnailDeps,
} from "../../../supabase/functions/content-engine-worker/thumbnail";
import {
  MAX_OVERLAY_LINE_CHARS as APP_MAX_LINE_CHARS,
  MAX_OVERLAY_LINES as APP_MAX_LINES,
  THUMBNAIL_INPUT_CONTENT_TYPES,
} from "./types";
import { sniffMedia, validateManualMedia } from "./media-upload";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../../supabase/migrations/20260947_atlas_thumbnail_input_contract.sql"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Fixtures — Article 01's real identity, plus synthetic approved inputs
// ---------------------------------------------------------------------------

const PACKAGE = "2d156c39-1b17-4c07-a670-6713ef84b19b";
const ORG = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";
const OTHER_ORG = "0000ffff-1111-4222-8333-444444444444";
const OTHER_PACKAGE = "99999999-8888-4777-8666-555555555555";
const RUNABLE_ID = "e2665343-4bf7-48de-b218-fb89a152d5f9";
const BACKGROUND_ID = "00000000-1111-4222-8333-444444444444";
const OVERLAY_ID = "00000000-2222-4333-8444-555555555555";

/** A real 160x90 PNG: magic bytes and a readable IHDR. */
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAA8UlEQVR4nO3RQQnAMBAAwfv1VQMxECv1r6gqQmAZGAELO8+7CJvrBRxlcJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcX2ZUQ1Q=",
    "base64",
  ),
);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const HTML_BYTES = new TextEncoder().encode("<!doctype html><h1>nope</h1>");

function asset(over: Partial<ThumbnailInputAsset> & { _id: string }): ThumbnailInputAsset {
  return {
    contentType: null,
    assetType: null,
    parentContentId: PACKAGE,
    organizationId: ORG,
    approvalStatus: "approved",
    approvedBy: "admin-uuid",
    approvedAt: 1_790_000_000_000,
    storagePath: null,
    mimeType: null,
    provider: "manual_upload",
    metadata: {},
    ...over,
  };
}

/** Article 01's operator-supplied canonical thumbnail, exactly as it exists. */
const RUNABLE = asset({
  _id: RUNABLE_ID,
  contentType: "youtube_thumbnail",
  assetType: "youtube_thumbnail",
  mimeType: "image/png",
  storagePath: `blog-media/${ORG}/${PACKAGE}/thumbnail/p2-thumbnail-b-p2-thumbnail-b.png`,
  metadata: {
    width: 2048,
    height: 1152,
    byteSize: 8706,
    source: "manual_upload",
    externalSource: "Runable (declared by operator)",
    originalFileName: "p2-thumbnail-b",
  },
});

const BACKGROUND = asset({
  _id: BACKGROUND_ID,
  contentType: THUMBNAIL_BACKGROUND_CONTENT_TYPE,
  assetType: THUMBNAIL_BACKGROUND_ASSET_TYPE,
  storagePath: `blog-media/${ORG}/${PACKAGE}/thumbnail/background.png`,
  metadata: { width: 160, height: 90, byteSize: PNG_BYTES.byteLength, source: "manual_upload" },
});

const OVERLAY = asset({
  _id: OVERLAY_ID,
  contentType: THUMBNAIL_OVERLAY_CONTENT_TYPE,
  assetType: THUMBNAIL_OVERLAY_ASSET_TYPE,
  metadata: { overlayLines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"] },
});

function resolveInputs(over: { assets?: ThumbnailInputAsset[]; bytes?: Uint8Array; download?: () => Promise<Uint8Array> } = {}) {
  const download = vi.fn(
    over.download ?? (async () => over.bytes ?? PNG_BYTES),
  );
  const promise = resolveThumbnailInputs(
    {
      packageId: PACKAGE,
      packageOrganizationId: ORG,
      assets: over.assets ?? [BACKGROUND, OVERLAY],
      backgroundAssetId: BACKGROUND_ID,
      overlayAssetId: OVERLAY_ID,
    },
    { download },
  );
  return { promise, download };
}

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------

describe("the migration widens exactly one constraint", () => {
  it("allows the two new content types", () => {
    expect(MIGRATION).toContain("'thumbnail_background'");
    expect(MIGRATION).toContain("'thumbnail_overlay'");
  });

  it("preserves every previously allowed content type", () => {
    for (const type of ["blog", "linkedin_post", "video_script", "youtube_video", "youtube_thumbnail"]) {
      expect(MIGRATION).toContain(`'${type}'`);
    }
  });

  it("creates no table, column, index, policy or bucket", () => {
    expect(MIGRATION).not.toMatch(/create\s+table/i);
    expect(MIGRATION).not.toMatch(/add\s+column/i);
    expect(MIGRATION).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(MIGRATION).not.toMatch(/create\s+policy/i);
    expect(MIGRATION).not.toMatch(/insert\s+into/i);
    expect(MIGRATION).not.toMatch(/update\s+public\./i);
    expect(MIGRATION).not.toMatch(/storage\.buckets/i);
  });

  it("does not duplicate the existing uniqueness index", () => {
    expect(MIGRATION).toMatch(/contentitems_unique_asset_type_per_parent_idx/);
    expect(MIGRATION).not.toMatch(/create\s+unique\s+index/i);
  });
});

// ---------------------------------------------------------------------------
// DRIFT — one definition per rule
// ---------------------------------------------------------------------------

describe("limits and vocabulary are defined once, not twice", () => {
  it("agrees with the compositor on the background ceiling", () => {
    expect(MAX_BACKGROUND_BYTES).toBe(COMPOSITOR_MAX_BACKGROUND_BYTES);
  });

  it("agrees with the compositor on the overlay ceilings", () => {
    expect(MAX_OVERLAY_LINES).toBe(COMPOSITOR_MAX_TEXT_LINES);
    expect(MAX_OVERLAY_LINE_CHARS).toBe(COMPOSITOR_MAX_LINE_CHARS);
  });

  it("agrees between the app and the worker on the overlay ceilings", () => {
    expect(MAX_OVERLAY_LINES).toBe(APP_MAX_LINES);
    expect(MAX_OVERLAY_LINE_CHARS).toBe(APP_MAX_LINE_CHARS);
  });

  it("agrees on the content type names", () => {
    expect(THUMBNAIL_BACKGROUND_CONTENT_TYPE).toBe(THUMBNAIL_INPUT_CONTENT_TYPES.background);
    expect(THUMBNAIL_OVERLAY_CONTENT_TYPE).toBe(THUMBNAIL_INPUT_CONTENT_TYPES.overlay);
    expect(THUMBNAIL_BACKGROUND_ASSET_TYPE).toBe(THUMBNAIL_INPUT_CONTENT_TYPES.background);
    expect(THUMBNAIL_OVERLAY_ASSET_TYPE).toBe(THUMBNAIL_INPUT_CONTENT_TYPES.overlay);
  });

  it("agrees with the compositor on the renderer version", () => {
    expect(THUMBNAIL_COMPOSITOR_VERSION).toBe(COMPOSITOR_VERSION);
  });
});

// ---------------------------------------------------------------------------
// BACKGROUND
// ---------------------------------------------------------------------------

describe("background input", () => {
  it("accepts an approved PNG belonging to this package and organization", async () => {
    const { promise, download } = resolveInputs();
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backgroundDataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.overlayLines).toEqual(["NOTHING PUBLISHES", "WITHOUT A HUMAN"]);
    expect(result.provenance.backgroundAssetId).toBe(BACKGROUND_ID);
    expect(result.provenance.backgroundApprovedBy).toBe("admin-uuid");
    expect(download).toHaveBeenCalledWith(BACKGROUND.storagePath);
  });

  it("records the background's own content hash", async () => {
    const { promise } = resolveInputs();
    const result = await promise;
    expect(result.ok && result.provenance.backgroundSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a background that is not yet approved", async () => {
    const { promise } = resolveInputs({
      assets: [asset({ ...BACKGROUND, approvalStatus: "pending" }), OVERLAY],
    });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_NOT_APPROVED" });
  });

  it.each([
    ["JPEG", JPEG_BYTES],
    ["WebP", WEBP_BYTES],
    ["SVG", SVG_BYTES],
    ["HTML", HTML_BYTES],
  ])("rejects a %s background decided from its bytes", async (_name, bytes) => {
    const { promise } = resolveInputs({ bytes });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_NOT_PNG" });
  });

  it("rejects a background over 2 MB", async () => {
    const oversized = new Uint8Array(MAX_BACKGROUND_BYTES + 1);
    oversized.set(PNG_BYTES.subarray(0, 8), 0);
    const { promise } = resolveInputs({ bytes: oversized });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_TOO_LARGE" });
  });

  it("rejects a background from another organization", async () => {
    const { promise } = resolveInputs({
      assets: [asset({ ...BACKGROUND, organizationId: OTHER_ORG }), OVERLAY],
    });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_CROSS_ORG" });
  });

  it("rejects a background belonging to another package", async () => {
    const { promise } = resolveInputs({
      assets: [asset({ ...BACKGROUND, parentContentId: OTHER_PACKAGE }), OVERLAY],
    });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_WRONG_PACKAGE" });
  });

  it("rejects a background with no stored image", async () => {
    const { promise } = resolveInputs({
      assets: [asset({ ...BACKGROUND, storagePath: null }), OVERLAY],
    });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_NO_STORAGE" });
  });

  it("rejects a background that cannot be read from storage", async () => {
    const { promise } = resolveInputs({
      download: async () => {
        throw new Error("404");
      },
    });
    expect(await promise).toMatchObject({ ok: false, code: "BACKGROUND_UNREADABLE" });
  });

  it("rejects a reference to an asset that is not a background", async () => {
    const { promise } = resolveInputs({ assets: [RUNABLE, OVERLAY] });
    expect(await promise).toMatchObject({ ok: false, code: "UNKNOWN_BACKGROUND" });
  });

  it("rejects a missing background reference", async () => {
    const result = await resolveThumbnailInputs(
      {
        packageId: PACKAGE,
        packageOrganizationId: ORG,
        assets: [BACKGROUND, OVERLAY],
        backgroundAssetId: "",
        overlayAssetId: OVERLAY_ID,
      },
      { download: async () => PNG_BYTES },
    );
    expect(result).toMatchObject({ ok: false, code: "MISSING_BACKGROUND_REF" });
  });

  it("reads NO bytes when the background is not authorized", async () => {
    const { promise, download } = resolveInputs({
      assets: [asset({ ...BACKGROUND, organizationId: OTHER_ORG }), OVERLAY],
    });
    await promise;
    expect(download).not.toHaveBeenCalled();
  });

  it("accepts only PNG through the shared upload contract", () => {
    expect(validateManualMedia({ kind: "background", bytes: PNG_BYTES, fileName: "bg.png" }).ok).toBe(true);
    expect(validateManualMedia({ kind: "background", bytes: JPEG_BYTES, fileName: "bg.jpg" })).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    expect(sniffMedia("background", JPEG_BYTES)).toBeNull();
    expect(sniffMedia("background", PNG_BYTES)?.mimeType).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// OVERLAY
// ---------------------------------------------------------------------------

describe("overlay input", () => {
  const withOverlay = (overlay: Partial<ThumbnailInputAsset>) =>
    resolveInputs({ assets: [BACKGROUND, asset({ ...OVERLAY, ...overlay })] });

  it("accepts approved copy and preserves its exact order", async () => {
    const ordered = asset({
      ...OVERLAY,
      metadata: { overlayLines: ["LINE ONE", "LINE TWO", "LINE THREE"] },
    });
    const { promise } = resolveInputs({ assets: [BACKGROUND, ordered] });
    const result = await promise;
    expect(result.ok && result.overlayLines).toEqual(["LINE ONE", "LINE TWO", "LINE THREE"]);
  });

  it("rejects overlay copy that is not approved", async () => {
    const { promise } = withOverlay({ approvalStatus: "pending" });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_NOT_APPROVED" });
  });

  it("rejects overlay copy from another organization", async () => {
    const { promise } = withOverlay({ organizationId: OTHER_ORG });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_CROSS_ORG" });
  });

  it("rejects overlay copy belonging to another package", async () => {
    const { promise } = withOverlay({ parentContentId: OTHER_PACKAGE });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_WRONG_PACKAGE" });
  });

  it("refuses to invent copy when overlayLines are absent", async () => {
    const { promise } = withOverlay({ metadata: {} });
    const result = await promise;
    expect(result).toMatchObject({ ok: false, code: "OVERLAY_LINES_MISSING" });
    // The refusal must not smuggle in any fallback text.
    expect(JSON.stringify(result)).not.toContain("Atlas Intelligence");
  });

  it("rejects an empty overlay array", async () => {
    const { promise } = withOverlay({ metadata: { overlayLines: [] } });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_LINES_EMPTY" });
  });

  it("rejects overlayLines that are not an array", async () => {
    const { promise } = withOverlay({ metadata: { overlayLines: "LINE ONE" } });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_LINES_MISSING" });
  });

  it("rejects more than six lines", async () => {
    const { promise } = withOverlay({
      metadata: { overlayLines: Array.from({ length: 7 }, (_, i) => `LINE ${i + 1}`) },
    });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_TOO_MANY_LINES" });
  });

  it("rejects a line over 120 characters", async () => {
    const { promise } = withOverlay({ metadata: { overlayLines: ["x".repeat(121)] } });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_LINE_TOO_LONG" });
  });

  it("rejects a blank line", async () => {
    const { promise } = withOverlay({ metadata: { overlayLines: ["OK", "   "] } });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_LINE_BLANK" });
  });

  it("rejects control characters in a line", async () => {
    const { promise } = withOverlay({ metadata: { overlayLines: ["OKBAD"] } });
    expect(await promise).toMatchObject({ ok: false, code: "OVERLAY_INVALID_CHARACTERS" });
  });

  it("rejects a missing overlay reference", async () => {
    const result = await resolveThumbnailInputs(
      {
        packageId: PACKAGE,
        packageOrganizationId: ORG,
        assets: [BACKGROUND, OVERLAY],
        backgroundAssetId: BACKGROUND_ID,
        overlayAssetId: "",
      },
      { download: async () => PNG_BYTES },
    );
    expect(result).toMatchObject({ ok: false, code: "MISSING_OVERLAY_REF" });
  });
});

// ---------------------------------------------------------------------------
// RENDERER
// ---------------------------------------------------------------------------

describe("renderer selection", () => {
  it("reads the reference form a durable job payload carries", () => {
    const read = readThumbnailRenderer({
      renderer: { kind: "compositor", backgroundAssetId: BACKGROUND_ID, overlayAssetId: OVERLAY_ID },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.renderer).toEqual({
      kind: "compositor",
      backgroundAssetId: BACKGROUND_ID,
      overlayAssetId: OVERLAY_ID,
    });
  });

  it("still reads the resolved internal form", () => {
    const read = readThumbnailRenderer({
      renderer: { kind: "compositor", backgroundDataUri: FIXTURE_DATA_URI, overlayLines: ["A"] },
    });
    expect(read.ok).toBe(true);
  });

  it("rejects a half-specified reference", () => {
    expect(
      readThumbnailRenderer({ renderer: { kind: "compositor", backgroundAssetId: BACKGROUND_ID } }),
    ).toMatchObject({ ok: false });
  });

  it("keeps no renderer as the image provider", () => {
    expect(readThumbnailRenderer({ package_id: PACKAGE })).toEqual({ ok: true });
  });

  it("fails closed on an unknown renderer", () => {
    expect(readThumbnailRenderer({ renderer: { kind: "openai" } })).toMatchObject({
      ok: false,
      code: "VALIDATION",
    });
  });
});

const FIXTURE_DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

// ---------------------------------------------------------------------------
// PROTECTION + PROVENANCE, through the step itself
// ---------------------------------------------------------------------------

interface StepWorld {
  deps: ThumbnailDeps;
  uploads: Array<{ path: string; contentType: string }>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  composed: number;
}

function stepWorld(over: { compose?: ComposeThumbnailFn | undefined } = {}): StepWorld {
  const world: StepWorld = { deps: null as unknown as ThumbnailDeps, uploads: [], rpcs: [], composed: 0 };
  const compose: ComposeThumbnailFn =
    over.compose ??
    (async () => {
      world.composed += 1;
      return {
        ok: true,
        artifact: {
          bytes: PNG_BYTES,
          sha256: "a".repeat(64),
          width: 2048,
          height: 1152,
          byteSize: PNG_BYTES.byteLength,
          mimeType: "image/png",
        },
      };
    });
  world.deps = {
    env: { get: () => null },
    transport: async () => {
      throw new Error("the generative provider must not be reached");
    },
    upload: async ({ path, contentType }) => {
      world.uploads.push({ path, contentType });
    },
    publicUrl: (p) => `https://project.supabase.co/storage/v1/object/public/${p}`,
    rpc: async (name, args) => {
      world.rpcs.push({ name, args });
      return name === "content_asset_upsert" ? { _id: "asset-new" } : null;
    },
    timeoutMs: 1_000,
    now: () => 1_800_000_000_000,
    composeThumbnail: compose,
  };
  return world;
}

const RESOLVED_RENDERER = {
  kind: "compositor" as const,
  backgroundDataUri: FIXTURE_DATA_URI,
  overlayLines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"],
  provenance: {
    backgroundAssetId: BACKGROUND_ID,
    backgroundSha256: "b".repeat(64),
    backgroundStoragePath: BACKGROUND.storagePath,
    backgroundApprovedBy: "admin-uuid",
    backgroundApprovedAt: 1_790_000_000_000,
    overlayAssetId: OVERLAY_ID,
    overlayLines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"],
    overlayApprovedBy: "admin-uuid",
    overlayApprovedAt: 1_790_000_000_000,
  },
};

function stepInput(over: Record<string, unknown> = {}) {
  return {
    packageId: PACKAGE,
    tenantId: ORG,
    packageOrganizationId: ORG,
    packageTitle: "Why We Publish Atlas Intelligence, and How We Check It",
    packageSlug: "atlas-intelligence-publication",
    imagePrompt: "Editorial illustration representing editorial standards and provenance.",
    articleTitle: "How Atlas Streamlines Restoration and Roofing Project Management",
    brandVoice: "plain and practical",
    existing: { storagePath: RUNABLE.storagePath, externalUrl: null },
    regenerate: false,
    ...over,
  } as Parameters<typeof generateThumbnail>[0];
}

const upsert = (world: StepWorld) =>
  world.rpcs.find((r) => r.name === "content_asset_upsert")?.args.p_metadata as Record<string, unknown>;

describe("Article 01's existing thumbnail is protected", () => {
  it("reuses it and renders nothing when regeneration is not requested", async () => {
    const world = stepWorld();
    const outcome = await generateThumbnail(stepInput(), world.deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result).toMatchObject({ reused: true });
    expect(world.composed).toBe(0);
    expect(world.uploads).toHaveLength(0);
  });

  it("refuses to replace it when regeneration alone is requested", async () => {
    const world = stepWorld();
    const outcome = await generateThumbnail(
      stepInput({ regenerate: true, renderer: RESOLVED_RENDERER }),
      world.deps,
    );

    expect(outcome).toMatchObject({ ok: false, code: "REPLACEMENT_NOT_AUTHORIZED", retryable: false });
    // The decisive assertions: nothing composed, nothing stored, nothing written.
    expect(world.composed).toBe(0);
    expect(world.uploads).toHaveLength(0);
    expect(world.rpcs).toHaveLength(0);
  });

  it("does not reach the generative provider as a fallback", async () => {
    const world = stepWorld();
    await generateThumbnail(stepInput({ regenerate: true, renderer: RESOLVED_RENDERER }), world.deps);
    // `transport` throws if called; reaching here proves it was not.
    expect(world.composed).toBe(0);
  });

  it("renders only when replacement is explicitly authorized", async () => {
    const world = stepWorld();
    const outcome = await generateThumbnail(
      stepInput({
        regenerate: true,
        replaceExistingThumbnail: true,
        renderer: RESOLVED_RENDERER,
        supersedes: { assetId: RUNABLE_ID, provider: "manual_upload", source: "Runable (declared by operator)" },
      }),
      world.deps,
    );

    expect(outcome.ok).toBe(true);
    expect(world.composed).toBe(1);
    expect(world.uploads).toHaveLength(1);
  });

  it("is not satisfied by a background asset sitting on the same package", async () => {
    // The background occupies a different content type, so `hasUsableThumbnail`
    // can never see it as the package's thumbnail.
    const world = stepWorld();
    const outcome = await generateThumbnail(
      stepInput({ existing: null, renderer: { ...RESOLVED_RENDERER } }),
      world.deps,
    );
    expect(outcome.ok).toBe(true);
    // Without authorization and without an existing thumbnail, a first render
    // is allowed — and it writes the canonical thumbnail, never the background.
    expect(world.uploads[0]?.path).toMatch(/thumbnail\.png$/);
  });
});

describe("provenance", () => {
  async function renderAuthorized() {
    const world = stepWorld();
    await generateThumbnail(
      stepInput({
        regenerate: true,
        replaceExistingThumbnail: true,
        renderer: RESOLVED_RENDERER,
        supersedes: { assetId: RUNABLE_ID, provider: "manual_upload", source: "Runable (declared by operator)" },
      }),
      world.deps,
    );
    return upsert(world);
  }

  it("records the renderer and its version", async () => {
    const metadata = await renderAuthorized();
    expect(metadata).toMatchObject({
      source: THUMBNAIL_COMPOSITOR_PROVIDER,
      renderer: "content-thumbnail-compose",
      compositorVersion: COMPOSITOR_VERSION,
    });
  });

  it("records the background's identity, hash and approval", async () => {
    const metadata = await renderAuthorized();
    expect(metadata).toMatchObject({
      backgroundAssetId: BACKGROUND_ID,
      backgroundSha256: "b".repeat(64),
      backgroundApprovedBy: "admin-uuid",
      backgroundApprovedAt: 1_790_000_000_000,
    });
  });

  it("records the exact overlay copy and its approval", async () => {
    const metadata = await renderAuthorized();
    expect(metadata).toMatchObject({
      overlayAssetId: OVERLAY_ID,
      overlayLines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"],
      overlayApprovedBy: "admin-uuid",
    });
  });

  it("records the output's own geometry, size, type and hash", async () => {
    const metadata = await renderAuthorized();
    expect(metadata).toMatchObject({
      width: 2048,
      height: 1152,
      byteSize: PNG_BYTES.byteLength,
      mimeType: "image/png",
      sha256: "a".repeat(64),
      generatedAt: 1_800_000_000_000,
    });
  });

  it("records what the render superseded", async () => {
    const metadata = await renderAuthorized();
    expect(metadata).toMatchObject({
      supersedes: {
        assetId: RUNABLE_ID,
        provider: "manual_upload",
        source: "Runable (declared by operator)",
      },
    });
  });

  it("writes the COMPLETE key set, so no stale value can survive a merge", async () => {
    const metadata = await renderAuthorized();
    // `content_asset_upsert` merges metadata, so an OMITTED key survives into the
    // next render. Every key must therefore be present on every render.
    expect(Object.keys(metadata).sort()).toEqual(
      [
        "backgroundApprovedAt",
        "backgroundApprovedBy",
        "backgroundAssetId",
        "backgroundSha256",
        "backgroundStoragePath",
        "byteSize",
        "compositorVersion",
        "generatedAt",
        "height",
        "mimeType",
        "overlayApprovedAt",
        "overlayApprovedBy",
        "overlayAssetId",
        "overlayLines",
        "renderer",
        "sha256",
        "source",
        "supersedes",
        "width",
      ].sort(),
    );
  });

  it("clears the compositor keys explicitly on the provider path", async () => {
    const world = stepWorld();
    const configured = {
      ...world.deps,
      env: {
        get: (k: string) =>
          ({
            IMAGE_PROVIDER_API_KEY: "k",
            IMAGE_PROVIDER_BASE_URL: "https://example.invalid/v1",
            IMAGE_PROVIDER_MODEL: "m",
          })[k] ?? null,
      },
      transport: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
        }),
      }),
    } as ThumbnailDeps;

    await generateThumbnail(
      stepInput({ existing: null, regenerate: true, imagePrompt: "brief" }),
      configured,
    );

    const metadata = upsert(world) ?? {};
    // A provider render after a compositor render must not keep claiming the
    // compositor's inputs.
    expect(metadata.renderer).toBeNull();
    expect(metadata.compositorVersion).toBeNull();
    expect(metadata.backgroundAssetId).toBeNull();
    expect(metadata.overlayLines).toBeNull();
    expect(metadata.sha256).toBeNull();
    expect(metadata.supersedes).toBeNull();
  });
});
