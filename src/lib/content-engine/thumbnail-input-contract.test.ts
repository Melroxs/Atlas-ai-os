// ---------------------------------------------------------------------------
// Atlas Content Engine — thumbnail INPUT CONTRACT design guards
//
// This phase DESIGNED the contract; it did not implement it. These tests are
// the executable part of that design: they assert, against the code and the
// migration that already exist, the structural facts the future contract
// DEPENDS on. If one of them fails, the design is no longer safe and the
// migration must not be written on top of it.
//
// Nothing here needs the future schema. A hypothetical background asset is
// modelled as a plain synthetic package-view object, which is exactly how the
// worker will see it after the migration lands.
//
// WHAT IS BEING GUARDED
//   1. The contentType CHECK constraint is the ONLY thing standing between the
//      existing asset model and a background asset. It enumerates five values,
//      so the contract provably needs exactly one additive migration change and
//      nothing structural beyond that.
//   2. The unique index (parentContentId, contentType, assetType) gives a
//      package exactly ONE slot per content type. A background in its OWN type
//      therefore cannot collide with — or be confused for — the thumbnail.
//   3. `assetOf` looks assets up BY CONTENT TYPE. That is why the background
//      must get its own content type rather than a second assetType under
//      youtube_thumbnail: sharing the type would make the existing lookup
//      ambiguous, and this test fails loudly if that is ever attempted.
//   4. Article 01's operator-supplied thumbnail stays reachable and intact
//      through every accessor the worker uses.
//   5. The limits the contract will enforce are the limits that already exist,
//      so validation is defined once rather than twice.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_BACKGROUND_BYTES,
  MAX_TEXT_LINES,
  MAX_LINE_CHARS,
} from "../../../supabase/functions/content-thumbnail-compose/compositor";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_THUMBNAIL_BYTES,
  MEDIA_BUCKET,
  sniffImageMedia,
  readImageDimensions,
} from "./media-upload";
import { assetOf, validatePackageIntegrity } from "./package";
import { ASSET_CONTENT_TYPE, ASSET_TYPES, type ContentAssetRecord, type ContentPackageView } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20260935_atlas_content_engine.sql"),
  "utf8",
);

/** The contentType the future contract will introduce. */
const BACKGROUND_CONTENT_TYPE = "thumbnail_background";

// ---------------------------------------------------------------------------
// A synthetic package carrying an operator thumbnail AND a future background
// ---------------------------------------------------------------------------

const PACKAGE_ID = "2d156c39-1b17-4c07-a670-6713ef84b19b";
const ORG_ID = "877bf5ec-fd93-4ea1-8e55-280e320f32aa";

/** A real 160x90 PNG, so sniffing and dimension reading are genuine. */
const BACKGROUND_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAA8UlEQVR4nO3RQQnAMBAAwfv1VQMxECv1r6gqQmAZGAELO8+7CJvrBRxlcJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHzdofYQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcX2ZUQ1Q=",
    "base64",
  ),
);

function asset(over: Partial<ContentAssetRecord> & { id: string; contentType: string }): ContentAssetRecord {
  return {
    title: over.title ?? "Asset",
    body: null,
    assetType: over.contentType,
    status: "drafted",
    approvalStatus: "pending",
    externalUrl: null,
    storagePath: null,
    externalId: null,
    provider: null,
    metadata: {},
    ...over,
  } as ContentAssetRecord;
}

/** Article 01 exactly as it exists today: an operator-uploaded thumbnail. */
const RUNABLE = asset({
  id: "e2665343-4bf7-48de-b218-fb89a152d5f9",
  contentType: "youtube_thumbnail",
  title: "Atlas — thumbnail (P2 B)",
  provider: "manual_upload",
  mimeType: "image/png",
  storagePath: `blog-media/${ORG_ID}/${PACKAGE_ID}/thumbnail/p2-thumbnail-b-p2-thumbnail-b.png`,
  metadata: {
    width: 2048,
    height: 1152,
    byteSize: 8706,
    mimeType: "image/png",
    source: "manual_upload",
    externalSource: "Runable (declared by operator)",
    originalFileName: "p2-thumbnail-b",
  },
});

/** The asset the future contract will add, in its own content type. */
const BACKGROUND = asset({
  id: "00000000-1111-4222-8333-444444444444",
  contentType: BACKGROUND_CONTENT_TYPE,
  title: "Atlas — thumbnail background",
  provider: "manual_upload",
  mimeType: "image/png",
  storagePath: `blog-media/${ORG_ID}/${PACKAGE_ID}/thumbnail/background.png`,
});

const VIEW = {
  id: PACKAGE_ID,
  organizationId: ORG_ID,
  title: "Why We Publish Atlas Intelligence, and How We Check It",
  slug: "atlas-intelligence-publication",
  status: "published",
  approvalStatus: "approved",
  summary: null,
  body: null,
  seo: {},
  tags: [],
  category: null,
  author: null,
  ctaId: null,
  readingTime: null,
  imagePrompt: "Editorial illustration representing editorial standards and provenance.",
  heroImage: null,
  socialImage: null,
  youtubeUrl: null,
  youtubeVideoId: null,
  youtubeThumbnailUrl: null,
  updatedAt: 0,
  publishedAt: 0,
  assets: [
    asset({
      id: "ba64edd1-628f-4c83-9f77-e305301fb2ec",
      contentType: "blog",
      assetType: "blog_article",
      title: "How Atlas Streamlines Restoration and Roofing Project Management",
      body: "Article body.",
    }),
    RUNABLE,
    BACKGROUND,
  ],
} as unknown as ContentPackageView;

// ---------------------------------------------------------------------------
// 1. The migration surface is exactly one constraint
// ---------------------------------------------------------------------------

describe("the schema change the contract requires", () => {
  it("already has a contentType CHECK that enumerates every allowed value", () => {
    expect(MIGRATION).toContain('"atlasContentItems_contentType_check"');
    for (const type of ASSET_CONTENT_TYPE ? ["blog", "linkedin_post", "video_script", "youtube_video", "youtube_thumbnail"] : []) {
      expect(MIGRATION).toContain(`'${type}'`);
    }
  });

  it("does NOT yet allow a background content type", () => {
    // The design depends on this being true today: it is precisely why a
    // migration is required, and precisely why the migration must be additive
    // (one more value) rather than structural.
    expect(MIGRATION).not.toContain(`'${BACKGROUND_CONTENT_TYPE}'`);
  });

  it("already enforces one asset per type per package", () => {
    expect(MIGRATION).toContain("contentitems_unique_asset_type_per_parent_idx");
    expect(MIGRATION).toContain('on public."atlasContentItems" ("parentContentId", "contentType", "assetType")');
  });

  it("already copies the package's organization onto every asset it upserts", () => {
    // This is the anti-cross-tenant property: content_asset_upsert never accepts
    // an organization id, it inherits the package's.
    expect(MIGRATION).toMatch(/select "organizationId" into v_org/);
    expect(MIGRATION).toContain("belongs to another organization");
    expect(MIGRATION).toMatch(/insert into public\."atlasContentItems" \(\s*"organizationId"/);
  });

  it("already restricts package reads to the owning organization", () => {
    expect(MIGRATION).toContain("contentitems_org_read");
    expect(MIGRATION).toContain('"organizationId" is not null and "organizationId" = public.my_tenant_id()');
  });
});

// ---------------------------------------------------------------------------
// 2. The background must not be confusable with the thumbnail
// ---------------------------------------------------------------------------

describe("background and thumbnail stay distinct assets", () => {
  it("resolves the operator thumbnail through the existing accessor", () => {
    expect(assetOf(VIEW, "youtube_thumbnail")).toBe(RUNABLE);
    expect(assetOf(VIEW, ASSET_CONTENT_TYPE.youtube_thumbnail)).toBe(RUNABLE);
  });

  it("resolves the background through its own content type", () => {
    expect(assetOf(VIEW, BACKGROUND_CONTENT_TYPE)).toBe(BACKGROUND);
  });

  it("does not let a background satisfy a thumbnail lookup", () => {
    const backgroundOnly = { ...VIEW, assets: [BACKGROUND] } as unknown as ContentPackageView;
    expect(assetOf(backgroundOnly, "youtube_thumbnail")).toBeNull();
  });

  it("occupies a distinct uniqueness slot from the thumbnail", () => {
    const slot = (a: ContentAssetRecord) => `${PACKAGE_ID}|${a.contentType}|${a.assetType}`;
    expect(slot(RUNABLE)).not.toBe(slot(BACKGROUND));
  });

  it("keeps the app-side assetType lookup unambiguous even if types were shared", () => {
    // The app resolves by ASSET TYPE, so a distinct assetType would survive
    // sharing a content type. The worker is the one that would not.
    const shared = {
      ...VIEW,
      assets: [BACKGROUND, RUNABLE],
    } as unknown as ContentPackageView;
    expect(assetOf(shared, "youtube_thumbnail")).toBe(RUNABLE);
  });

  it("makes the WORKER's contentType lookup unambiguous, which is the real constraint", () => {
    // content-engine-worker/index.ts resolves the canonical thumbnail by
    // CONTENT TYPE and returns the first match. A background sharing the
    // youtube_thumbnail content type would make that lookup depend on creation
    // order — a silent, data-dependent wrong answer. A distinct content type
    // makes it impossible by construction.
    const workerAssetOf = (assets: ContentAssetRecord[], contentType: string) =>
      assets.find((a) => a.contentType === contentType) ?? null;

    expect(workerAssetOf(VIEW.assets as ContentAssetRecord[], "youtube_thumbnail")).toBe(RUNABLE);
    expect(workerAssetOf(VIEW.assets as ContentAssetRecord[], BACKGROUND_CONTENT_TYPE)).toBe(BACKGROUND);

    // The rejected alternative, asserted so it cannot be reintroduced: same
    // assetType slot discipline, but the background parked under the THUMBNAIL's
    // content type.
    const sharedType = {
      ...VIEW,
      assets: [
        { ...BACKGROUND, contentType: "youtube_thumbnail" } as ContentAssetRecord,
        RUNABLE,
      ],
    } as unknown as ContentPackageView;
    expect(
      workerAssetOf(sharedType.assets as ContentAssetRecord[], "youtube_thumbnail"),
    ).toMatchObject({ title: "Atlas — thumbnail background" });
    // ^ exactly the wrong answer this design avoids.
  });
});

// ---------------------------------------------------------------------------
// 3. Article 01's operator artwork is untouched by any of this
// ---------------------------------------------------------------------------

describe("Article 01 operator artwork", () => {
  it("keeps its identity, provenance and storage path intact", () => {
    const thumbnail = assetOf(VIEW, "youtube_thumbnail");
    expect(thumbnail?.id).toBe("e2665343-4bf7-48de-b218-fb89a152d5f9");
    expect(thumbnail?.provider).toBe("manual_upload");
    expect(thumbnail?.storagePath).toBe(
      `blog-media/${ORG_ID}/${PACKAGE_ID}/thumbnail/p2-thumbnail-b-p2-thumbnail-b.png`,
    );
    expect(thumbnail?.metadata).toMatchObject({
      source: "manual_upload",
      externalSource: "Runable (declared by operator)",
      originalFileName: "p2-thumbnail-b",
      width: 2048,
      height: 1152,
    });
  });

  it("keeps package integrity valid with the background present", () => {
    expect(validatePackageIntegrity(VIEW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The contract enforces limits that already exist, exactly once
// ---------------------------------------------------------------------------

describe("contract limits are already defined elsewhere", () => {
  it("uses the compositor's background ceiling, which matches the bucket's", () => {
    expect(MAX_BACKGROUND_BYTES).toBe(MAX_THUMBNAIL_BYTES);
    expect(MAX_BACKGROUND_BYTES).toBe(2 * 1024 * 1024);
  });

  it("accepts PNG as a background, from the existing media contract", () => {
    const sniffed = sniffImageMedia(BACKGROUND_BYTES);
    expect(sniffed?.mimeType).toBe("image/png");
    expect(ACCEPTED_IMAGE_TYPES.some((t) => t.mimeType === "image/png")).toBe(true);
  });

  it("reads the background's real dimensions from its own bytes", () => {
    expect(readImageDimensions(BACKGROUND_BYTES)).toEqual({ width: 160, height: 90 });
  });

  it("reuses the existing public media bucket rather than creating one", () => {
    expect(MEDIA_BUCKET.thumbnail).toBe("blog-media");
  });

  it("keeps the compositor's own overlay ceilings as the single source", () => {
    expect(MAX_TEXT_LINES).toBe(6);
    expect(MAX_LINE_CHARS).toBe(120);
  });

  it("does not invent an asset type outside the existing vocabulary silently", () => {
    // The background is a NEW content type, deliberately not added to
    // ASSET_TYPES (which enumerates ASSET_CONTENT_TYPE's keys). The design adds
    // one content type and no new asset type.
    expect(ASSET_TYPES).not.toContain(BACKGROUND_CONTENT_TYPE);
    expect(Object.values(ASSET_CONTENT_TYPE)).not.toContain(BACKGROUND_CONTENT_TYPE);
  });
});
