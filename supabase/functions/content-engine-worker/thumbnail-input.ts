// ---------------------------------------------------------------------------
// Atlas Content Engine — compositor thumbnail INPUT resolution
//
// WHAT THIS MODULE OWNS
// ---------------------
// The deterministic compositor consumes two AUTHORITATIVE inputs: an approved
// background PNG and approved, ordered overlay copy. This module resolves them
// from a package's own child assets and refuses to proceed unless every single
// precondition holds. It is the ONLY place that decides whether a compositor
// render may start.
//
// It is pure with one injected capability (`download`), so the whole decision
// surface — tenant scoping, approval, provenance, validation — is executable in
// the test suite without a network, a database or a storage bucket.
//
// WHY IT LIVES IN THE WORKER, NOT IN src/
// --------------------------------------
// A Supabase Edge Function is bundled from its own directory and cannot import
// application code. Putting the rules here means the DEPLOYED worker enforces
// them; a browser-side check would be a convenience, never the authority. The
// app mirrors only the vocabulary (content type names), pinned by a drift test.
//
// WHAT IT DELIBERATELY REFUSES TO DO
// ----------------------------------
//   * derive overlay copy from anything. There is no fallback to the title, the
//     article body, `imagePrompt`, `brandVoice`, `audience`, `primaryCta` or
//     `defaultTone`. If the approved lines are missing, the render does not
//     happen — a missing input is a refusal, never an invention;
//   * accept a reference to an asset belonging to another package or another
//     organization, even if the id is known;
//   * accept an unapproved input;
//   * treat a declared MIME type as proof of anything — the background's type
//     is decided from its own bytes;
//   * contact any provider. This module reads storage and nothing else.
// ---------------------------------------------------------------------------

/** The input content types. Mirrored in src/lib/content-engine/types.ts. */
export const THUMBNAIL_BACKGROUND_CONTENT_TYPE = "thumbnail_background";
export const THUMBNAIL_BACKGROUND_ASSET_TYPE = "thumbnail_background";
export const THUMBNAIL_OVERLAY_CONTENT_TYPE = "thumbnail_overlay";
export const THUMBNAIL_OVERLAY_ASSET_TYPE = "thumbnail_overlay";

/**
 * Limits.
 *
 * Deliberately declared HERE rather than imported from the compositor: importing
 * across function directories would drag the renderer into the worker bundle,
 * and two copies of one number is exactly how a limit silently diverges. They
 * are pinned to the compositor's own constants by a drift test instead.
 */
export const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024;
export const MAX_OVERLAY_LINES = 6;
export const MAX_OVERLAY_LINE_CHARS = 120;

/** Every refusal this module can produce. All are permanent. */
export type ThumbnailInputErrorCode =
  | "MISSING_BACKGROUND_REF"
  | "UNKNOWN_BACKGROUND"
  | "BACKGROUND_WRONG_PACKAGE"
  | "BACKGROUND_CROSS_ORG"
  | "BACKGROUND_NOT_APPROVED"
  | "BACKGROUND_NO_STORAGE"
  | "BACKGROUND_UNREADABLE"
  | "BACKGROUND_TOO_LARGE"
  | "BACKGROUND_NOT_PNG"
  | "MISSING_OVERLAY_REF"
  | "UNKNOWN_OVERLAY"
  | "OVERLAY_WRONG_PACKAGE"
  | "OVERLAY_CROSS_ORG"
  | "OVERLAY_NOT_APPROVED"
  | "OVERLAY_LINES_MISSING"
  | "OVERLAY_LINES_EMPTY"
  | "OVERLAY_TOO_MANY_LINES"
  | "OVERLAY_LINE_TOO_LONG"
  | "OVERLAY_LINE_BLANK"
  | "OVERLAY_INVALID_CHARACTERS";

export interface ThumbnailInputAsset {
  _id: string;
  contentType: string | null;
  assetType: string | null;
  parentContentId: string | null;
  organizationId: string | null;
  approvalStatus: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  storagePath: string | null;
  mimeType: string | null;
  provider: string | null;
  metadata: Record<string, unknown> | null;
}

/** What a resolved, validated render records about its own inputs. */
export interface ThumbnailInputProvenance {
  backgroundAssetId: string;
  backgroundSha256: string;
  backgroundStoragePath: string;
  backgroundApprovedBy: string | null;
  backgroundApprovedAt: number | null;
  overlayAssetId: string;
  overlayLines: string[];
  overlayApprovedBy: string | null;
  overlayApprovedAt: number | null;
}

export type ResolveThumbnailInputsResult =
  | {
      ok: true;
      backgroundDataUri: string;
      overlayLines: string[];
      provenance: ThumbnailInputProvenance;
    }
  | { ok: false; code: ThumbnailInputErrorCode; message: string };

export interface ThumbnailInputDeps {
  /** Reads a stored object. Throws when the object is absent or unreadable. */
  download: (storagePath: string) => Promise<Uint8Array>;
}

// ---------------------------------------------------------------- helpers

function refuse(code: ThumbnailInputErrorCode, message: string): ResolveThumbnailInputsResult {
  return { ok: false, code, message };
}

/**
 * Control characters are rejected outright.
 *
 * They are invisible in an editor, break SVG text layout when escaped, and are
 * the usual way approved copy is corrupted between authoring and rendering.
 */
/* eslint-disable no-control-regex */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
/* eslint-enable no-control-regex */

function base64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** PNG signature: the ONLY proof of format, decided from the bytes. */
function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Find one input asset by reference and prove it is the kind it claims to be.
 *
 * `packageId` and `packageOrganizationId` are passed separately from the asset
 * list on purpose: the worker decides which package it is rendering for from
 * the JOB, and the caller proves the referenced asset actually hangs off that
 * package and that organization. Knowing an id is not authorisation.
 */
function locate(
  assets: readonly ThumbnailInputAsset[],
  assetId: string,
  expectedAssetType: string,
  kind: "BACKGROUND" | "OVERLAY",
): { ok: true; asset: ThumbnailInputAsset } | { ok: false; result: ResolveThumbnailInputsResult } {
  const label = kind === "BACKGROUND" ? "background" : "overlay";
  const asset = assets.find((a) => a._id === assetId);
  if (!asset) {
    return {
      ok: false,
      result: refuse(`UNKNOWN_${kind}`, `The ${label} asset ${assetId} was not found on this package.`),
    };
  }
  if (asset.assetType !== expectedAssetType || asset.contentType !== expectedAssetType) {
    return {
      ok: false,
      result: refuse(`UNKNOWN_${kind}`, `Asset ${assetId} is not a thumbnail ${label}.`),
    };
  }
  return { ok: true, asset };
}

// ---------------------------------------------------------------- the step

/**
 * Resolve and validate the compositor's inputs.
 *
 * Order is deliberate and is the same order the failure report reads in:
 * reference, ownership, approval, then content. Nothing is downloaded until the
 * background has been proven to be this package's, this organization's and
 * approved — so an unauthorized reference never causes a byte to be read.
 */
export async function resolveThumbnailInputs(
  input: {
    packageId: string;
    packageOrganizationId: string | null;
    assets: readonly ThumbnailInputAsset[];
    backgroundAssetId: string;
    overlayAssetId: string;
  },
  deps: ThumbnailInputDeps,
): Promise<ResolveThumbnailInputsResult> {
  if (!input.backgroundAssetId) {
    return refuse("MISSING_BACKGROUND_REF", "A compositor render must name an approved background asset.");
  }
  if (!input.overlayAssetId) {
    return refuse("MISSING_OVERLAY_REF", "A compositor render must name an approved overlay asset.");
  }

  // --- background ownership + approval -----------------------------------
  const background = locate(input.assets, input.backgroundAssetId, THUMBNAIL_BACKGROUND_ASSET_TYPE, "BACKGROUND");
  if (!background.ok) return background.result;
  if (background.asset.parentContentId !== input.packageId) {
    return refuse(
      "BACKGROUND_WRONG_PACKAGE",
      "The background asset belongs to a different content package and cannot be used.",
    );
  }
  if (background.asset.organizationId !== input.packageOrganizationId) {
    return refuse(
      "BACKGROUND_CROSS_ORG",
      "The background asset does not belong to this package's organization.",
    );
  }
  if (background.asset.approvalStatus !== "approved") {
    return refuse(
      "BACKGROUND_NOT_APPROVED",
      "The background asset has not been approved by a human, so no thumbnail was composed.",
    );
  }
  if (!background.asset.storagePath) {
    return refuse("BACKGROUND_NO_STORAGE", "The approved background asset has no stored image.");
  }

  // --- overlay ownership + approval -------------------------------------
  const overlay = locate(input.assets, input.overlayAssetId, THUMBNAIL_OVERLAY_ASSET_TYPE, "OVERLAY");
  if (!overlay.ok) return overlay.result;
  if (overlay.asset.parentContentId !== input.packageId) {
    return refuse(
      "OVERLAY_WRONG_PACKAGE",
      "The overlay asset belongs to a different content package and cannot be used.",
    );
  }
  if (overlay.asset.organizationId !== input.packageOrganizationId) {
    return refuse("OVERLAY_CROSS_ORG", "The overlay asset does not belong to this package's organization.");
  }
  if (overlay.asset.approvalStatus !== "approved") {
    return refuse(
      "OVERLAY_NOT_APPROVED",
      "The overlay asset has not been approved by a human, so no thumbnail was composed.",
    );
  }

  // --- overlay copy ------------------------------------------------------
  const raw = overlay.asset.metadata?.overlayLines;
  if (raw === undefined || raw === null) {
    return refuse(
      "OVERLAY_LINES_MISSING",
      "The approved overlay asset carries no overlayLines, so there is no approved copy to render.",
    );
  }
  if (!Array.isArray(raw)) {
    return refuse("OVERLAY_LINES_MISSING", "The approved overlayLines must be an array of strings.");
  }
  if (raw.length === 0) {
    return refuse("OVERLAY_LINES_EMPTY", "The approved overlayLines array is empty.");
  }
  if (raw.length > MAX_OVERLAY_LINES) {
    return refuse(
      "OVERLAY_TOO_MANY_LINES",
      `At most ${MAX_OVERLAY_LINES} overlay lines are supported; this one has ${raw.length}.`,
    );
  }
  for (const line of raw) {
    if (typeof line !== "string") {
      return refuse("OVERLAY_LINES_MISSING", "Every overlay line must be a string.");
    }
    if (line.trim().length === 0) {
      return refuse("OVERLAY_LINE_BLANK", "An overlay line is blank; approved copy cannot contain empty lines.");
    }
    if (CONTROL_CHARACTERS.test(line)) {
      return refuse(
        "OVERLAY_INVALID_CHARACTERS",
        "An overlay line contains control characters, which are not renderable.",
      );
    }
    if (line.length > MAX_OVERLAY_LINE_CHARS) {
      return refuse(
        "OVERLAY_LINE_TOO_LONG",
        `An overlay line is ${line.length} characters; the limit is ${MAX_OVERLAY_LINE_CHARS}.`,
      );
    }
  }
  const overlayLines = raw as string[];

  // --- background bytes --------------------------------------------------
  let bytes: Uint8Array;
  try {
    bytes = await deps.download(background.asset.storagePath);
  } catch {
    return refuse(
      "BACKGROUND_UNREADABLE",
      "The approved background image could not be read from Atlas storage.",
    );
  }
  if (bytes.byteLength === 0) {
    return refuse("BACKGROUND_UNREADABLE", "The approved background image is empty.");
  }
  if (bytes.byteLength > MAX_BACKGROUND_BYTES) {
    return refuse(
      "BACKGROUND_TOO_LARGE",
      `The background is ${bytes.byteLength} bytes; the limit is ${MAX_BACKGROUND_BYTES}.`,
    );
  }
  if (!isPng(bytes)) {
    return refuse(
      "BACKGROUND_NOT_PNG",
      "The approved background is not a PNG image, so the compositor refused it.",
    );
  }

  const backgroundSha256 = await sha256Hex(bytes);

  return {
    ok: true,
    backgroundDataUri: `data:image/png;base64,${base64(bytes)}`,
    // Forwarded verbatim. Nothing in this module edits approved copy.
    overlayLines,
    provenance: {
      backgroundAssetId: background.asset._id,
      backgroundSha256,
      backgroundStoragePath: background.asset.storagePath,
      backgroundApprovedBy: str(background.asset.approvedBy),
      backgroundApprovedAt: num(background.asset.approvedAt),
      overlayAssetId: overlay.asset._id,
      overlayLines: [...overlayLines],
      overlayApprovedBy: str(overlay.asset.approvedBy),
      overlayApprovedAt: num(overlay.asset.approvedAt),
    },
  };
}
