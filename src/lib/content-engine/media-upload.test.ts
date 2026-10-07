// ---------------------------------------------------------------------------
// Atlas Content Studio — external media upload: contract + integration tests.
//
// WHAT IS ACTUALLY TESTED HERE
// ----------------------------
// The upload is the one path where bytes a stranger produced become durable
// Atlas storage and a canonical content asset. These tests pin the properties
// that make that safe, and they do it against the SAME modules that run in
// production:
//
//   * `media-upload.ts`            — the canonical contract (types, limits,
//                                    magic bytes, path derivation, validation)
//   * `content-media-upload/`      — the Edge Function that enforces the
//                                    authorization order and the write sequence
//   * the migration                — the bucket, its policies, and the grants
//   * `studio-api.ts`              — the single browser-facing surface
//   * `ContentPackageDetail.tsx`   — where the two tabs render the panel
//
// The Edge Function cannot be executed here (it calls Deno.serve and the
// Supabase REST API), so it is asserted STATICALLY — the same approach the
// repository's existing edge-function ratchets use. The logic that can run
// without a network or a database DOES run: the contract module, and a scripted
// version of the function's authorize-then-write ordering.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as contract from "./media-upload";
import * as edgeContract from "../../../supabase/functions/content-media-upload/media-contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/**
 * Strip SQL comments before scanning for statements.
 *
 * This migration deliberately QUOTES the statement it refuses to run, in order
 * to explain why. A scanner that reads prose as executable SQL would flag the
 * explanation as the thing it forbids, so the comment text has to go first —
 * the same reason `function-grant-hygiene.test.ts` strips comments.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const UPLOAD_FN = read("supabase/functions/content-media-upload/index.ts");
const MIGRATION = read("supabase/migrations/20260946_atlas_content_media_upload.sql");
const CONFIG = read("supabase/config.toml");
const STUDIO_API = read("src/lib/content-engine/studio-api.ts");
const DETAIL = read("src/pages/content/ContentPackageDetail.tsx");
const PANEL = read("src/components/content/MediaUploadPanel.tsx");
const CLIENT = read("src/lib/content-engine/media-upload-client.ts");

const ORG = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";
const OTHER_ORG = "11111111-2222-3333-4444-555555555555";
const PKG = "2d156c39-1b17-4c07-a670-6713ef84b19b";

// ---------------------------------------------------------------------------
// Fixtures — real bytes with real magic numbers
// ---------------------------------------------------------------------------

function pngBytes(width = 2048, height = 1152): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length + type, then big-endian width/height.
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes;
}

function mp4Bytes(brand = "isom"): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 24);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  for (let i = 0; i < 4; i += 1) bytes[8 + i] = brand.charCodeAt(i);
  return bytes;
}

function webmBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  const head = "webm";
  for (let i = 0; i < head.length; i += 1) bytes[8 + i] = head.charCodeAt(i);
  return bytes;
}

function sizedBytes(base: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  out.set(base.subarray(0, Math.min(base.length, total)));
  return out;
}

// ===========================================================================
// 1-2. Authorization: the function authenticates and scopes correctly
// ===========================================================================

describe("upload authorization", () => {
  it("1. the Edge Function verifies the caller's JWT and resolves their own organization", () => {
    // requireAtlasCaller reads the caller's own membership; a client-supplied
    // organization id is never consulted.
    expect(UPLOAD_FN).toMatch(/requireAtlasCaller\(request\)/);
    expect(UPLOAD_FN).toMatch(/caller\.tenantId/);
    // There is no code path that reads an organization id off the request body.
    expect(UPLOAD_FN).not.toMatch(/body\["organizationId"\]/);
    expect(UPLOAD_FN).not.toMatch(/body\["orgId"\]/);
    expect(UPLOAD_FN).not.toMatch(/body\["tenantId"\]/);
  });

  it("2. authorization runs before any storage write or asset write", () => {
    const authAt = UPLOAD_FN.indexOf("requireAtlasCaller(request)");
    const loadAt = UPLOAD_FN.indexOf("loadPackage(packageId, kind)");
    const uploadAt = UPLOAD_FN.indexOf("await uploadObject({");
    const upsertAt = UPLOAD_FN.indexOf('rpc("content_asset_upsert"');

    expect(authAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(authAt);
    expect(uploadAt).toBeGreaterThan(loadAt);
    expect(upsertAt).toBeGreaterThan(uploadAt);
  });

  it("3. a caller with no workspace membership is refused", () => {
    expect(UPLOAD_FN).toMatch(/if \(!caller\.tenantId\)/);
  });
});

// ===========================================================================
// 3. Wrong organization cannot upload to another organization's package
// ===========================================================================

describe("organization isolation", () => {
  it("rejects a package owned by a different organization than the caller's", () => {
    // The comparison is between the PACKAGE's organization and the CALLER's
    // membership-derived organization. Both sides are server-side values.
    expect(UPLOAD_FN).toMatch(/pkg\.organizationId !== caller\.tenantId/);
    expect(UPLOAD_FN).toMatch(
      /belongs to another organization/,
    );
  });

  it("refuses an org-less (legacy platform) package outright", () => {
    // An org-less package belongs to no customer organization, so no customer
    // member may attach media to it — not even by guessing its id.
    expect(UPLOAD_FN).toMatch(/if \(pkg\.organizationId === null\)/);
  });

  it("the storage path cannot escape the verified organization prefix", () => {
    const path = contract.manualMediaStoragePath({
      kind: "video",
      organizationId: ORG,
      packageId: PKG,
      uploadId: "u1",
      fileName: "clip.mp4",
      extension: "mp4",
    });
    expect(path.startsWith(`${contract.VIDEO_BUCKET}/${ORG}/${PKG}/`)).toBe(true);
  });

  it("rejects a non-UUID organization or package before building any path", () => {
    expect(() =>
      contract.manualMediaStoragePath({
        kind: "video",
        organizationId: "../../etc",
        packageId: PKG,
        uploadId: "u1",
        fileName: "a.mp4",
        extension: "mp4",
      }),
    ).toThrow(/organization id/i);
    expect(() =>
      contract.manualMediaStoragePath({
        kind: "video",
        organizationId: ORG,
        packageId: "..",
        uploadId: "u1",
        fileName: "a.mp4",
        extension: "mp4",
      }),
    ).toThrow(/package id/i);
  });

  it("strips the bucket prefix when deriving the storage API object key", () => {
    // Atlas stores the path WITH the bucket so the public URL is
    // /object/public/<bucket>/<key>, but the Storage API is addressed as
    // /object/<bucket>/<key> and 404s if the key repeats the bucket. Both the
    // Edge Function and the browser must therefore strip it, through ONE helper.
    const stored = contract.manualMediaStoragePath({
      kind: "video",
      organizationId: ORG,
      packageId: PKG,
      uploadId: "u1",
      fileName: "a.mp4",
      extension: "mp4",
    });
    expect(stored.startsWith("content-media/")).toBe(true);
    const key = contract.mediaObjectKey(stored, "video");
    expect(key.startsWith("content-media/")).toBe(false);
    expect(key).toBe(`${ORG}/${PKG}/video/u1-a.mp4`);

    // A stored value that does not carry the prefix is returned unchanged, so
    // the two conventions cannot disagree silently.
    expect(contract.mediaObjectKey(key, "video")).toBe(key);
  });

  it("never doubles the extension when the name already carries one", () => {
    // The bytes decide the format, so a user-supplied ".mp4" is stripped before
    // the sniffed extension is appended exactly once.
    for (const name of ["clip.mp4", "clip.MP4", "clip.png", "clip", "  clip  "]) {
      const stored = contract.manualMediaStoragePath({
        kind: "video",
        organizationId: ORG,
        packageId: PKG,
        uploadId: "u1",
        fileName: name,
        extension: "mp4",
      });
      expect(stored.split("/").pop()).toBe("u1-clip.mp4");
    }
    // Only the FINAL extension is dropped, so a multi-dot name keeps its stem.
    expect(
      contract.manualMediaStoragePath({
        kind: "video",
        organizationId: ORG,
        packageId: PKG,
        uploadId: "u1",
        fileName: "clip.tar.gz",
        extension: "mp4",
      }).split("/").pop(),
    ).toBe("u1-clip.tar.mp4");
    expect(
      contract.manualMediaStoragePath({
        kind: "thumbnail",
        organizationId: ORG,
        packageId: PKG,
        uploadId: "u1",
        fileName: "hero.png",
        extension: "png",
      }).split("/").pop(),
    ).toBe("u1-hero.png");
  });

  it("never builds a storage URL that repeats the bucket", () => {
    // The upload and delete helpers take the STORED path and derive the key, so
    // the addressable URL is /object/<bucket>/<org>/<pkg>/… exactly once.
    expect(UPLOAD_FN).toMatch(/mediaObjectKey\(input\.storedPath, input\.kind\)/);
    expect(UPLOAD_FN).toMatch(/mediaObjectKey\(storedPath, kind\)/);
    expect(DETAIL).toMatch(/mediaObjectKey\(videoStoragePath, "video"\)/);
  });

  it("keeps the stored path interchangeable with a generated asset's", () => {
    // The generated thumbnail also stores `blog-media/<slug>/thumbnail.<ext>`,
    // so an uploaded thumbnail resolves through the same public URL builder.
    const worker = read("supabase/functions/content-engine-worker/thumbnail.ts");
    expect(worker).toMatch(/return `\$\{THUMBNAIL_BUCKET\}\/\$\{safeSlug\}\/thumbnail\.\$\{input\.extension\}`/);
    const stored = contract.manualMediaStoragePath({
      kind: "thumbnail",
      organizationId: ORG,
      packageId: PKG,
      uploadId: "u1",
      fileName: "t.png",
      extension: "png",
    });
    expect(stored.split("/")[0]).toBe("blog-media");
    expect(contract.mediaObjectKey(stored, "thumbnail").startsWith(`${ORG}/`)).toBe(true);
  });

  it("a traversal attempt in the filename cannot produce a path separator", () => {
    const path = contract.manualMediaStoragePath({
      kind: "thumbnail",
      organizationId: ORG,
      packageId: PKG,
      uploadId: "u1",
      fileName: "../../../etc/passwd.png",
      extension: "png",
    });
    // The sanitized name is a single final segment; no ".." survives.
    expect(path).not.toContain("..");
    expect(path.split("/")).toHaveLength(5);
  });
});

// ===========================================================================
// 4-5. Unsupported types are rejected
// ===========================================================================

describe("type validation", () => {
  it("4. rejects an image upload that is not a real image", () => {
    // An HTML error page saved as .png is the canonical case.
    const html = new Uint8Array(64);
    html.set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e], 0); // "<html>"
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: html,
      fileName: "thumbnail.png",
      declaredMimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported_type");
      expect(result.message).toMatch(/PNG, JPEG, WebP/);
    }
  });

  it("5. rejects a video upload that is not a real video", () => {
    const result = contract.validateManualMedia({
      kind: "video",
      bytes: pngBytes(),
      fileName: "video.mp4",
      declaredMimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_type");
  });

  it("accepts exactly the declared image types from their magic bytes", () => {
    for (const [bytes, mime] of [
      [pngBytes(), "image/png"],
      [jpegBytes(), "image/jpeg"],
      [webpBytes(), "image/webp"],
    ] as const) {
      const result = contract.validateManualMedia({
        kind: "thumbnail",
        bytes,
        fileName: "x",
        width: 2048,
        height: 1152,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.type.mimeType).toBe(mime);
    }
  });

  it("accepts the declared video containers and rejects QuickTime-as-MP4 confusion", () => {
    for (const [bytes, mime] of [
      [mp4Bytes("isom"), "video/mp4"],
      [mp4Bytes("mp42"), "video/mp4"],
      [mp4Bytes("qt"), "video/quicktime"],
      [webmBytes(), "video/webm"],
    ] as const) {
      const result = contract.validateManualMedia({ kind: "video", bytes, fileName: "v" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.type.mimeType).toBe(mime);
    }
  });

  it("rejects an SVG even though the public bucket would allow one", () => {
    // SVG is active content served from a public bucket. The upload surface
    // does not introduce it.
    expect(contract.ACCEPTED_IMAGE_TYPES.map((t) => t.mimeType)).not.toContain("image/svg+xml");
    const svg = new Uint8Array(64);
    svg.set([0x3c, 0x73, 0x76, 0x67], 0);
    const result = contract.validateManualMedia({ kind: "thumbnail", bytes: svg, fileName: "a.svg" });
    expect(result.ok).toBe(false);
  });

  it("never lets a declared MIME type grant acceptance", () => {
    // Bytes are not an image, but the client claims PNG. Still rejected.
    const notAnImage = new Uint8Array(64);
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: notAnImage,
      fileName: "a.png",
      declaredMimeType: "image/png",
    });
    expect(result.ok).toBe(false);
  });

  it("warns, but does not reject, when a declared type disagrees with the bytes", () => {
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: pngBytes(),
      fileName: "a.jpg",
      declaredMimeType: "image/jpeg",
      width: 2048,
      height: 1152,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type.mimeType).toBe("image/png");
      expect(result.warning).toMatch(/stored it as image\/png/);
    }
  });
});

// ===========================================================================
// 6. Oversized files are rejected
// ===========================================================================

describe("size limits", () => {
  it("6a. rejects a thumbnail above the blog-media bucket limit", () => {
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: sizedBytes(pngBytes(), contract.MAX_THUMBNAIL_BYTES + 1),
      fileName: "big.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too_large");
      expect(result.message).toMatch(/limit is 2(\.0)? MB/);
    }
  });

  it("6b. accepts a thumbnail exactly at the limit", () => {
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: sizedBytes(pngBytes(), contract.MAX_THUMBNAIL_BYTES),
      fileName: "ok.png",
      width: 2048,
      height: 1152,
    });
    expect(result.ok).toBe(true);
  });

  it("6c. rejects a video above the video ceiling", () => {
    const result = contract.validateManualMedia({
      kind: "video",
      bytes: sizedBytes(mp4Bytes(), contract.MAX_VIDEO_BYTES + 1),
      fileName: "big.mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("6d. rejects an empty file before sniffing", () => {
    const result = contract.validateManualMedia({
      kind: "thumbnail",
      bytes: new Uint8Array(0),
      fileName: "empty.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  it("the application limit matches the bucket limits declared in the migration", () => {
    // A limit the bucket would still reject is a limit that produces a
    // confusing failure at upload time, so the two are pinned together.
    expect(MIGRATION).toMatch(/104857600/); // content-media file_size_limit
    expect(contract.MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
    // blog-media keeps its pre-existing 2 MB limit; the thumbnail contract
    // adopts it rather than inventing a second number.
    expect(contract.MAX_THUMBNAIL_BYTES).toBe(2 * 1024 * 1024);
  });

  it("rejects an oversized request body before parsing it", () => {
    expect(UPLOAD_FN).toMatch(/MAX_UPLOAD_REQUEST_BYTES/);
    expect(UPLOAD_FN).toMatch(/declaredLength > MAX_UPLOAD_REQUEST_BYTES/);
  });
});

// ===========================================================================
// 7-8. Replacement updates the existing logical asset, never duplicates
// ===========================================================================

describe("replacement does not duplicate the logical asset", () => {
  it("7. the thumbnail upload maps onto the existing youtube_thumbnail asset", () => {
    expect(contract.MANUAL_MEDIA_ASSET_TYPE.thumbnail).toBe("youtube_thumbnail");
    expect(UPLOAD_FN).toMatch(/MANUAL_MEDIA_ASSET_TYPE\[kind\]/);
  });

  it("8. the video upload maps onto the existing youtube_video asset", () => {
    expect(contract.MANUAL_MEDIA_ASSET_TYPE.video).toBe("youtube_video");
  });

  it("invents no new asset type for an uploaded file", () => {
    for (const forbidden of ["external_thumbnail", "external_video", "manual_upload_asset"]) {
      expect(UPLOAD_FN).not.toContain(forbidden);
    }
    expect(MIGRATION).not.toMatch(/external_thumbnail|external_video/);
  });

  it("reuses content_asset_upsert, whose conflict target is the per-type unique index", () => {
    // The upsert is ON CONFLICT (parentContentId, contentType, assetType), so a
    // second upload UPDATEs the row rather than inserting a second one. No new
    // upsert function was written.
    expect(UPLOAD_FN).toMatch(/rpc\("content_asset_upsert"/);
    const engine = read("supabase/migrations/20260935_atlas_content_engine.sql");
    expect(engine).toMatch(
      /on conflict \("parentContentId", "contentType", "assetType"\)/,
    );
  });

  it("records the source honestly as manual_upload", () => {
    expect(contract.MANUAL_MEDIA_PROVIDER).toBe("manual_upload");
    expect(UPLOAD_FN).toMatch(/p_provider: MANUAL_MEDIA_PROVIDER/);
    expect(UPLOAD_FN).toMatch(/source: MANUAL_MEDIA_PROVIDER/);
  });

  it("never stores a provider URL as the authoritative media reference", () => {
    expect(UPLOAD_FN).toMatch(/p_external_url: null/);
  });

  it("records the external provenance only when the user supplied it", () => {
    expect(UPLOAD_FN).toMatch(/externalSource \? \{ externalSource \}/);
    // No unconditional claim that any particular tool made the file.
    expect(UPLOAD_FN).not.toMatch(/provider: "runable"/i);
  });
});

// ===========================================================================
// 9. A failed replacement preserves the previous asset
// ===========================================================================

describe("replacement safety", () => {
  it("writes the new object before repointing the asset row", () => {
    const uploadAt = UPLOAD_FN.indexOf("await uploadObject({");
    const upsertAt = UPLOAD_FN.indexOf('rpc("content_asset_upsert"');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(upsertAt).toBeGreaterThan(uploadAt);
  });

  it("removes the previous object only AFTER the asset points at the new one", () => {
    const upsertAt = UPLOAD_FN.indexOf('rpc("content_asset_upsert"');
    const removeAt = UPLOAD_FN.lastIndexOf("await removeObject(");
    expect(removeAt).toBeGreaterThan(upsertAt);
  });

  it("never deletes an object the database still points at", () => {
    // The retirement call is guarded on the path actually differing.
    expect(UPLOAD_FN).toMatch(/if \(priorPath && priorPath !== storagePath\)/);
  });

  it("gives each upload its own object, so a write never truncates the live one", () => {
    expect(UPLOAD_FN).toMatch(/"x-upsert": "false"/);
    const a = contract.manualMediaStoragePath({
      kind: "video", organizationId: ORG, packageId: PKG, uploadId: "up-1",
      fileName: "a.mp4", extension: "mp4",
    });
    const b = contract.manualMediaStoragePath({
      kind: "video", organizationId: ORG, packageId: PKG, uploadId: "up-2",
      fileName: "a.mp4", extension: "mp4",
    });
    expect(a).not.toBe(b);
  });

  it("cleans up the orphaned object if the asset row could not be written", () => {
    // The bytes existed but nothing references them, so they are removed. The
    // PREVIOUS asset was never touched, so the package still resolves.
    expect(UPLOAD_FN).toMatch(/await removeObject\(kind, storagePath\)/);
  });

  it("a rejected file never reaches storage at all", () => {
    const uploadAt = UPLOAD_FN.indexOf("await uploadObject({");
    const validateAt = UPLOAD_FN.indexOf("validateManualMedia({");
    expect(validateAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(validateAt);
  });
});

// ===========================================================================
// 10-13. The uploads surface in the UI and feed the existing pipeline
// ===========================================================================

describe("Content Package Detail integration", () => {
  it("10. the Thumbnail tab renders the thumbnail upload panel", () => {
    expect(DETAIL).toMatch(/kind="thumbnail"/);
    expect(PANEL).toMatch(/"Upload Thumbnail"/);
  });

  it("11. the Video tab renders the video upload panel", () => {
    expect(DETAIL).toMatch(/kind="video"/);
    expect(PANEL).toMatch(/"Upload Video"/);
  });

  it("shows a Replace action once an asset exists", () => {
    expect(PANEL).toMatch(/Replace Thumbnail/);
    expect(PANEL).toMatch(/Replace Video/);
    expect(PANEL).toMatch(/asset\s*\?\s*BUTTON_LABEL\[kind\]\.replace/);
  });

  it("12. an uploaded thumbnail becomes the blog hero and Open Graph image", () => {
    // The SAME existing presentation RPC the generated thumbnail uses, and the
    // same durable object — no second copy of the image.
    expect(UPLOAD_FN).toMatch(/rpc\("content_set_youtube_presentation"/);
    expect(UPLOAD_FN).toMatch(/p_thumbnail_url: thumbnailUrl/);
    expect(UPLOAD_FN).toMatch(/storage\/v1\/object\/public\//);
  });

  it("12b. the preview reads the package's existing thumbnail reference", () => {
    expect(DETAIL).toMatch(/thumbnail\?\.externalUrl \?\? view\.youtubeThumbnailUrl/);
  });

  it("13. an uploaded video is available to the YouTube publication flow", () => {
    // The video asset carries a durable storagePath, and the publishing step
    // already resolves the YouTube asset by content type.
    expect(UPLOAD_FN).toMatch(/p_storage_path: storagePath/);
    const worker = read("supabase/functions/content-engine-worker/index.ts");
    expect(worker).toMatch(/assetOf\(view, "youtube_video"\)/);
  });

  it("a private video is previewed with a signed URL, not a public one", () => {
    expect(DETAIL).toMatch(/createSignedUrl\(videoObjectKey/);
    expect(DETAIL).toMatch(/from\(CONTENT_MEDIA_BUCKET\)/);
  });

  it("does not add the private video to the public presentation", () => {
    // Only a thumbnail updates the presentation. The video has no public URL.
    const presentationAt = UPLOAD_FN.indexOf('rpc("content_set_youtube_presentation"');
    const guarded = UPLOAD_FN.slice(presentationAt - 200, presentationAt);
    expect(guarded).toMatch(/if \(kind === "thumbnail"\)/);
  });

  it("keeps the existing regenerate controls alongside the upload controls", () => {
    expect(DETAIL).toMatch(/regenerate\("thumbnail"\)/);
    expect(DETAIL).toMatch(/regenerate\("video"\)/);
    expect(DETAIL).toMatch(/Regenerate thumbnail/);
  });
});

// ===========================================================================
// 14-15. An upload never publishes, and approval is still required
// ===========================================================================

describe("approval and publishing safety", () => {
  it("14. the upload function never enqueues a publication", () => {
    for (const forbidden of [
      "content_engine_enqueue",
      "content_publish_youtube",
      "content_publish_blog",
      "content_publish_linkedin",
      "content_publication_upsert",
      "content_publication_claim",
    ]) {
      expect(UPLOAD_FN).not.toContain(forbidden);
    }
  });

  it("the response states explicitly that nothing was published", () => {
    expect(UPLOAD_FN).toMatch(/published: false/);
  });

  it("15. the success message tells the user approval is still required", () => {
    expect(PANEL).toMatch(/still needs review and approval before anything is published/);
  });

  it("the existing approval control and its RPC are untouched", () => {
    expect(DETAIL).toMatch(/contentStudio\.review\(view\.packageId, decision\)/);
    expect(STUDIO_API).toMatch(/reviewPackage/);
  });

  it("an uploaded asset is written as `drafted`, never as published", () => {
    expect(UPLOAD_FN).toMatch(/p_status: "drafted"/);
  });

  it("does not change the package's approval status", () => {
    // Only the presentation RPC is called, and it never touches approvalStatus.
    const presentation = read("supabase/migrations/20260935_atlas_content_engine.sql");
    const fn = presentation.slice(
      presentation.indexOf("create or replace function public.content_set_youtube_presentation"),
    ).slice(0, 2000);
    expect(fn).not.toMatch(/"approvalStatus"\s*=/);
  });
});

// ===========================================================================
// 16. Existing generated-media behaviour is not broken
// ===========================================================================

describe("existing behaviour preserved", () => {
  it("the generated-thumbnail pipeline is untouched", () => {
    const worker = read("supabase/functions/content-engine-worker/thumbnail.ts");
    expect(worker).toMatch(/THUMBNAIL_PROVIDER = "openai"/);
    expect(worker).toMatch(/THUMBNAIL_SOURCE_SIZE = "2048x1152"/);
    expect(worker).toMatch(/THUMBNAIL_BUCKET = "blog-media"/);
  });

  it("the generated thumbnail still uses the same bucket the upload reuses", () => {
    const worker = read("supabase/functions/content-engine-worker/thumbnail.ts");
    expect(contract.THUMBNAIL_BUCKET).toBe("blog-media");
    expect(worker).toMatch(/export const THUMBNAIL_BUCKET = "blog-media"/);
  });

  it("the generated magic-byte validator still exists unchanged", () => {
    const worker = read("supabase/functions/content-engine-worker/thumbnail.ts");
    expect(worker).toMatch(/export function sniffImageFormat/);
  });

  it("creates no new table and no new content type", () => {
    expect(MIGRATION).not.toMatch(/create table/i);
    expect(MIGRATION).not.toMatch(/alter table/i);
    expect(MIGRATION).not.toMatch(/contentType_check/);
  });

  it("introduces no new asset vocabulary in the browser layer", () => {
    expect(STUDIO_API).not.toMatch(/external_thumbnail|external_video/);
  });
});

// ===========================================================================
// 10. Storage + grant safety
// ===========================================================================

describe("storage and grant safety", () => {
  it("creates exactly one new bucket, and it is private", () => {
    expect(MIGRATION).toMatch(/'content-media',\s*\n\s*'content-media',\s*\n\s*false/);
  });

  it("does not create a new public bucket or a new public-read policy", () => {
    expect(MIGRATION).not.toMatch(/create policy[\s\S]{0,120}for select to anon/);
  });

  it("grants no client write access to either media bucket", () => {
    // Expressed as the ABSENCE of a write POLICY, which is what RLS enforces and
    // what is scoped to the two buckets this feature owns.
    const sql = stripSqlComments(MIGRATION);
    expect(sql).not.toMatch(
      /revoke insert, update, delete on storage\.objects from anon, authenticated/,
    );
    expect(sql).toMatch(/for select to authenticated/);
    expect(sql).toMatch(/drop policy if exists content_media_write on storage\.objects/);
    // The only policy this migration creates grants SELECT and nothing else.
    const policies = [...sql.matchAll(/create policy\s+(\w+)\s+on\s+storage\.objects\s+for\s+(\w+)/g)];
    expect(policies.map((p) => `${p[1]}:${p[2]}`)).toEqual(["content_media_tenant_read:select"]);
  });

  it("does not revoke storage table privileges the OTHER features rely on", () => {
    // `authenticated` holds insert/update/delete on storage.objects and the live
    // documents_/email_attachments_ policies depend on it for archive, document
    // and email-attachment uploads. A blanket revoke would break those unrelated
    // features with a permission error even though their policies still allow
    // the rows, so this migration must not touch table privileges at all.
    expect(stripSqlComments(MIGRATION)).not.toMatch(
      /revoke\s+\w+(\s*,\s*\w+)*\s+on\s+storage\./i,
    );
  });

  it("still revokes the read-path function from anon and PUBLIC", () => {
    // The one revoke that MUST be present: without the PUBLIC grant removal the
    // function stays callable by anon through the default privilege.
    expect(stripSqlComments(MIGRATION)).toMatch(
      /revoke all on function public\.content_media_read_path\(uuid, text\) from public, anon;/,
    );
  });

  it("scopes the video read policy to the caller's own tenant folder", () => {
    expect(MIGRATION).toMatch(
      /bucket_id = 'content-media'[\s\S]{0,200}storage\.foldername\(name\)\)\[1\] = public\.my_tenant_id\(\)::text/,
    );
  });

  it("the read-path RPC revokes PUBLIC in the same statement as the client roles", () => {
    // Without the PUBLIC revoke the function stays callable by anon through the
    // default privilege — the exact hole 20260936 repaired.
    const sql = stripSqlComments(MIGRATION);
    expect(sql).toMatch(
      /revoke all on function public\.content_media_read_path\(uuid, text\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant execute on function public\.content_media_read_path\(uuid, text\) to authenticated, service_role;/,
    );
  });

  it("the read-path RPC derives the organization from the package, not the caller", () => {
    expect(MIGRATION).not.toMatch(/p_organization/);
    expect(MIGRATION).toMatch(/select c\."organizationId" into v_org/);
    expect(MIGRATION).toMatch(/v_org = public\.my_tenant_id\(\)/);
  });

  it("the read-path RPC refuses an org-less package to an ordinary member", () => {
    // The guard must be an ALLOW-LIST. The negated form
    // (`if v_org is not null and not (...)`) short-circuits to false for an
    // org-less package and therefore lets ANY signed-in user read its media
    // path. content_package_get uses the allow-list form; this must match it.
    const sql = stripSqlComments(MIGRATION);
    expect(sql).not.toMatch(
      /if v_org is not null\s*\n?\s*and not \(public\.atlas_is_trusted_server\(\)/,
    );
    expect(sql).toMatch(
      /if not \(\s*\n?\s*public\.atlas_is_trusted_server\(\)\s*\n?\s*or public\.is_atlas_admin\(\)\s*\n?\s*or \(v_org is not null and v_org = public\.my_tenant_id\(\)\)/,
    );
  });

  it("keeps JWT verification enabled for the new function", () => {
    expect(CONFIG).toMatch(
      /\[functions\.content-media-upload\][\s\S]{0,200}?verify_jwt\s*=\s*true/,
    );
  });

  it("exposes no service credential to the browser", () => {
    // The browser client sends bytes and a filename. It never names a bucket,
    // builds a path, or carries a key.
    expect(CLIENT).not.toMatch(/SERVICE_ROLE/);
    expect(CLIENT).not.toMatch(/storage\.from\(/);
    expect(CLIENT).not.toMatch(/content_asset_upsert/);
    expect(CLIENT).toMatch(/functions\.invoke\(MEDIA_UPLOAD_FUNCTION/);
  });

  it("exposes no service credential through the Edge Function's responses", () => {
    // Storage and RPC failures surface a status code, never the provider body,
    // which can echo a request header.
    expect(UPLOAD_FN).toMatch(/Atlas could not complete the upload \(HTTP \$\{response\.status\}\)/);
    expect(UPLOAD_FN).toMatch(/Atlas storage rejected the file \(HTTP \$\{response\.status\}\)/);
  });
});

// ===========================================================================
// 11. The deployed contract cannot drift from the tested one
// ===========================================================================

describe("src/edge contract parity", () => {
  const cases: Array<{ name: string; args: Parameters<typeof contract.validateManualMedia>[0] }> = [
    { name: "png at the recommended size", args: { kind: "thumbnail", bytes: pngBytes(), fileName: "t.png", declaredMimeType: "image/png", width: 2048, height: 1152 } },
    { name: "png with a non-recommended size", args: { kind: "thumbnail", bytes: pngBytes(512, 512), fileName: "t.png", width: 512, height: 512 } },
    { name: "jpeg", args: { kind: "thumbnail", bytes: jpegBytes(), fileName: "t.jpg" } },
    { name: "webp", args: { kind: "thumbnail", bytes: webpBytes(), fileName: "t.webp" } },
    { name: "not an image", args: { kind: "thumbnail", bytes: new Uint8Array(8), fileName: "t.png" } },
    { name: "oversized image", args: { kind: "thumbnail", bytes: sizedBytes(pngBytes(), contract.MAX_THUMBNAIL_BYTES + 1), fileName: "t.png" } },
    { name: "empty", args: { kind: "thumbnail", bytes: new Uint8Array(0), fileName: "t.png" } },
    { name: "mp4", args: { kind: "video", bytes: mp4Bytes(), fileName: "v.mp4" } },
    { name: "quicktime", args: { kind: "video", bytes: mp4Bytes("qt"), fileName: "v.mov" } },
    { name: "webm", args: { kind: "video", bytes: webmBytes(), fileName: "v.webm" } },
    { name: "a png offered as a video", args: { kind: "video", bytes: pngBytes(), fileName: "v.mp4" } },
  ];

  it.each(cases)("validates identically: $name", ({ args }) => {
    expect(edgeContract.validateManualMedia(args)).toEqual(contract.validateManualMedia(args));
  });

  it("derives identical storage paths", () => {
    const input = {
      kind: "video" as const,
      organizationId: ORG,
      packageId: PKG,
      uploadId: "up-1",
      fileName: "../../escape name.mp4",
      extension: "mp4",
    };
    expect(edgeContract.manualMediaStoragePath(input)).toBe(
      contract.manualMediaStoragePath(input),
    );
  });

  it("agrees on every limit and every accepted type", () => {
    expect(edgeContract.MAX_THUMBNAIL_BYTES).toBe(contract.MAX_THUMBNAIL_BYTES);
    expect(edgeContract.MAX_VIDEO_BYTES).toBe(contract.MAX_VIDEO_BYTES);
    expect(edgeContract.ACCEPTED_IMAGE_TYPES).toEqual(contract.ACCEPTED_IMAGE_TYPES);
    expect(edgeContract.ACCEPTED_VIDEO_TYPES).toEqual(contract.ACCEPTED_VIDEO_TYPES);
    expect(edgeContract.MEDIA_BUCKET).toEqual(contract.MEDIA_BUCKET);
  });

  it("agrees on the dimension reader", () => {
    const bytes = pngBytes(2048, 1152);
    expect(edgeContract.readImageDimensions(bytes)).toEqual(
      contract.readImageDimensions(bytes),
    );
  });
});

// ===========================================================================
// Filename handling
// ===========================================================================

describe("filename sanitization", () => {
  it("strips separators, traversal and control characters", () => {
    expect(contract.safeFileToken("../../etc/passwd", "fallback")).not.toContain("/");
    expect(contract.safeFileToken("..\\..\\windows\\system32", "fallback")).not.toContain("\\");
    expect(contract.safeFileToken("....//....//x", "fallback")).not.toContain("..");
    expect(contract.safeFileToken("a bc", "fallback")).toBe("a-b-c");
  });

  it("falls back rather than producing an empty segment", () => {
    expect(contract.safeFileToken("", "thumbnail.png")).toBe("thumbnail.png");
    expect(contract.safeFileToken(null, "video.mp4")).toBe("video.mp4");
    expect(contract.safeFileToken("...", "video.mp4")).toBe("video.mp4");
  });

  it("bounds the length", () => {
    expect(contract.safeFileToken("x".repeat(500), "f").length).toBeLessThanOrEqual(60);
  });
});
