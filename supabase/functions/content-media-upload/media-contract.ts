// ---------------------------------------------------------------------------
// Atlas Content Studio — external media upload contract (Edge Function copy).
//
// This file is a byte-for-byte copy of the canonical module at
// `src/lib/content-engine/media-upload.ts`. The deployed function bundle only
// packages files inside its own directory, so the copy is what actually runs in
// production; `src/lib/content-engine/media-upload.test.ts` executes BOTH against
// identical vectors so the deployed contract can never drift from the one the
// test suite describes. Edit the canonical file, then re-copy it.
//
// The module is the SINGLE SOURCE OF TRUTH for what an externally produced
// thumbnail or video may be, how large it may be, what its real bytes are, and
// where the durable object lives. It is pure: no Supabase, no DOM, no fetch, so
// the browser and the Edge Function can share one definition and the test suite
// can execute it directly.
//
// WHY A CONTRACT MODULE AT ALL
// -----------------------------
// An upload is the one place where a user-supplied file crosses into durable
// Atlas storage. Three things must therefore be true at once, and each of them
// is easy to get subtly wrong in one place and right in another:
//
//   1. The DECLARED type (what the browser says) is never trusted. The real
//      type is decided from the file's magic bytes, so a `.png` that is really
//      an MP4 — or an HTML error page saved as `.jpg` — is rejected.
//   2. The storage path is DERIVED, never taken from the client. A user-supplied
//      filename is sanitized down to a safe token and is never allowed to
//      contribute a path separator, a `..` segment, or a leading dot.
//   3. The bucket is chosen by the CONTRACT, not by the request, so a caller
//      cannot aim an upload at a bucket Atlas does not publish from.
//
// WHY THE BUCKETS ARE WHAT THEY ARE
// ---------------------------------
// `blog-media` already exists for exactly this job: public read (crawlers and
// social platforms hold no Atlas session), images only, 2 MB. The thumbnail is
// published artwork — it is the blog hero AND the Open Graph image — so it
// belongs there and reuses that bucket's existing read policy. No new bucket,
// no new public-read policy, no new exposure.
//
// A video is NOT publication artwork: it is a large private working file that
// only the YouTube publishing step needs to read. `blog-media` would reject it
// on MIME type and on its 2 MB limit, and forcing it through would mean
// publishing unreviewed video to a public bucket. The video therefore goes to a
// dedicated PRIVATE bucket with a tenant-scoped read policy, so the bytes are
// reachable by Atlas and by the owning organization and by nobody else.
// ---------------------------------------------------------------------------

/** Which externally produced artefact is being uploaded. */
export type ManualMediaKind = "thumbnail" | "video" | "background";

/**
 * The logical asset each upload becomes. These are the EXISTING asset types —
 * this workflow invents no new vocabulary, so a manually uploaded thumbnail is
 * indistinguishable downstream from a generated one.
 */
export const MANUAL_MEDIA_ASSET_TYPE: Record<ManualMediaKind, string> = {
  thumbnail: "youtube_thumbnail",
  video: "youtube_video",
  // A compositor INPUT, not a thumbnail output. It lives in its own content
  // type so it occupies a different slot in the package's asset uniqueness
  // index and can never become an upsert target for the canonical thumbnail.
  background: "thumbnail_background",
};

/**
 * Provider recorded on the asset. `manual_upload` is the honest source: Atlas
 * did not generate these bytes. The optional `source` field records where the
 * user says they made it, and is only ever written when the user supplied it.
 */
export const MANUAL_MEDIA_PROVIDER = "manual_upload";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Thumbnail ceiling. `blog-media.file_size_limit` is 2 MB, so this matches the
 * bucket exactly: validating against the real limit means the server never
 * accepts a file Storage will then reject, and the browser can say so before
 * the upload starts.
 */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Video ceiling — a rendered short, not a feature-length film. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Canonical Atlas thumbnail geometry, and the 16:9 ratio it satisfies. */
export const RECOMMENDED_THUMBNAIL_WIDTH = 2048;
export const RECOMMENDED_THUMBNAIL_HEIGHT = 1152;
export const TARGET_ASPECT_RATIO = 16 / 9;

/** Largest request body the Edge Function will parse, before decoding. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_VIDEO_BYTES + 1024 * 1024;

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** Public publication artwork. Reused, never created. */
export const THUMBNAIL_BUCKET = "blog-media";
/** Private, tenant-scoped working media for the YouTube handoff. */
export const VIDEO_BUCKET = "content-media";

export const MEDIA_BUCKET: Record<ManualMediaKind, string> = {
  thumbnail: THUMBNAIL_BUCKET,
  video: VIDEO_BUCKET,
  // Same public bucket: a background is publication artwork already, and adding
  // a bucket would add a read policy and a new exposure for no benefit.
  background: THUMBNAIL_BUCKET,
};

// ---------------------------------------------------------------------------
// Accepted types
// ---------------------------------------------------------------------------

export interface AcceptedMediaType {
  mimeType: string;
  extension: string;
  /** Browser `accept` hint. */
  label: string;
}

/**
 * Images the contract accepts. Chosen to match the formats `sniffImageFormat`
 * already recognises, so an uploaded image and a generated one are stored and
 * validated by exactly the same rules. SVG is deliberately absent: it is active
 * content served from a public bucket, and an upload surface is not the place to
 * introduce that.
 */
export const ACCEPTED_IMAGE_TYPES: readonly AcceptedMediaType[] = [
  { mimeType: "image/png", extension: "png", label: "PNG" },
  { mimeType: "image/jpeg", extension: "jpg", label: "JPEG" },
  { mimeType: "image/webp", extension: "webp", label: "WebP" },
];

/**
 * Video container types. MP4 is the primary target; WebM and QuickTime are
 * accepted because browsers and desktop renderers emit them and both carry a
 * reliable `ftyp` brand. Every one of them is identified from the container
 * header, never from the file extension.
 */
export const ACCEPTED_VIDEO_TYPES: readonly AcceptedMediaType[] = [
  { mimeType: "video/mp4", extension: "mp4", label: "MP4" },
  { mimeType: "video/webm", extension: "webm", label: "WebM" },
  { mimeType: "video/quicktime", extension: "mov", label: "QuickTime" },
];

/**
 * A compositor background accepts PNG ONLY.
 *
 * The deterministic compositor rasterises SVG onto this image and refuses
 * anything that is not a PNG, so accepting JPEG or WebP here would promise the
 * operator something the renderer would later refuse. Failing at upload time,
 * with the real reason, is the whole point of validating from bytes.
 */
export const ACCEPTED_BACKGROUND_TYPES: readonly AcceptedMediaType[] = [
  { mimeType: "image/png", extension: "png", label: "PNG" },
];

export const ACCEPTED_MEDIA_TYPES: Record<ManualMediaKind, readonly AcceptedMediaType[]> = {
  thumbnail: ACCEPTED_IMAGE_TYPES,
  video: ACCEPTED_VIDEO_TYPES,
  background: ACCEPTED_BACKGROUND_TYPES,
};

export const MAX_MEDIA_BYTES: Record<ManualMediaKind, number> = {
  thumbnail: MAX_THUMBNAIL_BYTES,
  video: MAX_VIDEO_BYTES,
  background: MAX_THUMBNAIL_BYTES,
};

/** The `accept` attribute for the file input. */
export function acceptAttribute(kind: ManualMediaKind): string {
  return ACCEPTED_MEDIA_TYPES[kind].map((t) => t.mimeType).join(",");
}

// ---------------------------------------------------------------------------
// Magic bytes — the real type
// ---------------------------------------------------------------------------

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}

/**
 * Identify an image from its magic bytes.
 *
 * Mirrors the generated-thumbnail validator so both paths reach storage under
 * the same rules. Returns null for anything that is not a real image, which is
 * the caller's signal to persist nothing.
 */
export function sniffImageMedia(bytes: Uint8Array): AcceptedMediaType | null {
  // PNG: \x89 P N G \r \n \x1a \n
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ACCEPTED_IMAGE_TYPES[0];
  }
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return ACCEPTED_IMAGE_TYPES[1];
  }
  // WebP: "RIFF" .... "WEBP"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return ACCEPTED_IMAGE_TYPES[2];
  }
  return null;
}

/**
 * Brands that identify an MP4-family container. ISO-BMFF puts a 4-byte `ftyp`
 * box at offset 4; the major brand that follows is what separates the types we
 * accept from QuickTime files that merely also carry `ftyp`.
 */
const ISOBMFF_BRANDS: Record<string, AcceptedMediaType> = {
  isom: ACCEPTED_VIDEO_TYPES[0],
  iso2: ACCEPTED_VIDEO_TYPES[0],
  iso4: ACCEPTED_VIDEO_TYPES[0],
  iso5: ACCEPTED_VIDEO_TYPES[0],
  iso6: ACCEPTED_VIDEO_TYPES[0],
  mp41: ACCEPTED_VIDEO_TYPES[0],
  mp42: ACCEPTED_VIDEO_TYPES[0],
  avc1: ACCEPTED_VIDEO_TYPES[0],
  dash: ACCEPTED_VIDEO_TYPES[0],
  mmp4: ACCEPTED_VIDEO_TYPES[0],
  m4v: ACCEPTED_VIDEO_TYPES[0],
  qt: ACCEPTED_VIDEO_TYPES[2],
  m4a: ACCEPTED_VIDEO_TYPES[2],
  m4p: ACCEPTED_VIDEO_TYPES[2],
};

/** Identify a video container from its magic bytes. */
export function sniffVideoMedia(bytes: Uint8Array): AcceptedMediaType | null {
  // ISO base media (MP4 / MOV): a 4-byte box size, then "ftyp", then the major
  // brand. Short brands are space- or NUL-padded out to four bytes, so the
  // brand is trimmed before it is looked up — "qt\0\0" is QuickTime, not an
  // unknown container.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).replace(/[\0\s]+$/, "");
    return ISOBMFF_BRANDS[brand] ?? null;
  }
  // Matroska / WebM: EBML header, then the "webm" DocType.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // DocType is a variable-length string; scanning a bounded prefix is enough
    // to tell webm from the generic matroska container, and a plain .mkv is not
    // an accepted type anyway.
    const head = ascii(bytes, 0, Math.min(bytes.length, 64));
    if (head.includes("webm")) return ACCEPTED_VIDEO_TYPES[1];
    return null;
  }
  return null;
}

/** Identify whichever media kind was requested, from its bytes alone. */
export function sniffMedia(kind: ManualMediaKind, bytes: Uint8Array): AcceptedMediaType | null {
  if (kind === "video") return sniffVideoMedia(bytes);
  if (kind === "background") {
    const image = sniffImageMedia(bytes);
    return image && image.mimeType === "image/png" ? image : null;
  }
  return sniffImageMedia(bytes);
}

// ---------------------------------------------------------------------------
// Filenames — sanitized, never trusted
// ---------------------------------------------------------------------------

/**
 * Reduce a user-supplied filename to a short, safe, lowercase token.
 *
 * This value is used for DISPLAY and for the object's final path segment, so it
 * must not be able to contain a separator, a parent-directory reference, a
 * leading dot, a NUL, or anything outside a conservative character set. A name
 * that sanitizes to nothing falls back to the asset kind, so the path is always
 * well-formed regardless of what the client sent.
 */
export function safeFileToken(fileName: string | null | undefined, fallback: string): string {
  const base = (fileName ?? "")
    .split(/[\\/]/)
    .pop() ?? "";
  const token = base
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 60)
    .replace(/[.\-]+$/, "");
  return token.length > 0 ? token : fallback;
}

// ---------------------------------------------------------------------------
// Deterministic storage paths
// ---------------------------------------------------------------------------

/** UUID shape, or nothing. Guards every id interpolated into a path. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The durable object path for an uploaded media file.
 *
 * Two properties matter and both are load-bearing:
 *
 *   * SCOPED — the organization and the package are the first two segments, so
 *     one tenant's bytes can never be written under another tenant's prefix,
 *     and one package's media can never be written under another package's.
 *   * DETERMINISTIC PER UPLOAD — the final segment carries a caller-supplied
 *     `uploadId` (a client-generated id for THIS upload attempt), so replacing
 *     a thumbnail writes a NEW object and leaves the previous one intact until
 *     the asset row is repointed. A failed replacement therefore cannot destroy
 *     the working asset, and a successful one is never a partial overwrite.
 *
 * The organization and package ids are validated as UUIDs and the file token is
 * sanitized, so no client input can escape its prefix.
 */
export function manualMediaStoragePath(input: {
  kind: ManualMediaKind;
  organizationId: string;
  packageId: string;
  uploadId: string;
  fileName: string | null | undefined;
  extension: string;
}): string {
  if (!isUuid(input.organizationId)) {
    throw new Error("A valid organization id is required to build a media path.");
  }
  if (!isUuid(input.packageId)) {
    throw new Error("A valid content package id is required to build a media path.");
  }
  const ext = /^[a-z0-9]{1,8}$/.test(input.extension) ? input.extension : "bin";
  const uploadId = safeFileToken(input.uploadId, "upload");
  const name = safeFileToken(input.fileName, input.kind);
  // The name is stored WITHOUT its extension and the real, sniffed extension is
  // appended once. A user-supplied name that already ends in ".mp4" would
  // otherwise produce "clip.mp4.mp4", so a trailing extension of any kind is
  // dropped first: the bytes, not the filename, decide the format.
  const stem = name.replace(/\.[a-z0-9]{1,8}$/, "") || input.kind;
  return [
    MEDIA_BUCKET[input.kind],
    input.organizationId,
    input.packageId,
    input.kind,
    `${uploadId}-${stem}.${ext}`,
  ].join("/");
}

/**
 * The object key for a stored media path, with the bucket prefix removed.
 *
 * Atlas stores a media path WITH its bucket as the first segment — that is the
 * existing convention, and it is what the public object URL is built from, so an
 * uploaded asset and a generated one are interchangeable. The Supabase Storage
 * API, however, is addressed as `/object/{bucket}/{key}` and rejects a key that
 * repeats the bucket, and the browser client is already scoped to one bucket and
 * expects the key alone.
 *
 * Both callers therefore derive the key through this one function. If the stored
 * value ever stops carrying the bucket prefix, the key is returned unchanged, so
 * the two conventions cannot disagree silently.
 */
export function mediaObjectKey(storedPath: string, kind: ManualMediaKind): string {
  const bucket = `${MEDIA_BUCKET[kind]}/`;
  return storedPath.startsWith(bucket) ? storedPath.slice(bucket.length) : storedPath;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type MediaRejectionReason =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "type_mismatch";

export interface MediaValidationOk {
  ok: true;
  /** The real type, decided from the bytes. */
  type: AcceptedMediaType;
  bytes: Uint8Array;
  byteLength: number;
  /** The user-facing name, already sanitized. */
  fileName: string;
  /** A non-fatal note, e.g. the image is not the recommended 2048x1152. */
  warning: string | null;
}

export interface MediaValidationError {
  ok: false;
  reason: MediaRejectionReason;
  message: string;
}

export type MediaValidationResult = MediaValidationOk | MediaValidationError;

export interface ValidateMediaInput {
  kind: ManualMediaKind;
  bytes: Uint8Array;
  fileName: string | null | undefined;
  /** What the browser claimed. Used only to cross-check, never to decide. */
  declaredMimeType?: string | null;
  /** Pixel dimensions, when the caller could cheaply determine them. */
  width?: number | null;
  height?: number | null;
  /** Media duration in seconds, when known. */
  durationSeconds?: number | null;
}

/** Human-readable byte size, for the UI. */
export function formatMediaBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** The `accept` list as a human string, e.g. "PNG, JPEG, WebP". */
export function acceptedLabel(kind: ManualMediaKind): string {
  return ACCEPTED_MEDIA_TYPES[kind].map((t) => t.label).join(", ");
}

/**
 * The complete acceptance decision for one candidate file.
 *
 * Order matters and is deliberate: emptiness and size are checked before the
 * bytes are sniffed, and the sniffed type is decided BEFORE any declared type
 * is consulted. A declared type can only ever add a warning, never grant
 * acceptance — otherwise a caller could claim `image/png` for arbitrary bytes.
 */
export function validateManualMedia(input: ValidateMediaInput): MediaValidationResult {
  const { kind, bytes } = input;
  const limit = MAX_MEDIA_BYTES[kind];

  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, reason: "empty", message: "That file is empty. Choose a file with content in it." };
  }
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      reason: "too_large",
      message: `That ${kind} is ${formatMediaBytes(bytes.byteLength)}. The limit is ${formatMediaBytes(limit)}.`,
    };
  }

  const type = sniffMedia(kind, bytes);
  if (!type) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: `That file is not a ${acceptedLabel(kind)} file. Accepted formats: ${acceptedLabel(kind)}.`,
    };
  }

  const warnings: string[] = [];

  // A declared type that disagrees with the bytes is worth telling the user
  // about, but it is NOT a rejection: the real bytes are already proven to be
  // an accepted format, and the bytes are what Atlas stores.
  const declared = (input.declaredMimeType ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== type.mimeType) {
    // image/jpg is a common (non-standard) spelling of image/jpeg.
    const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
    if (normalized !== type.mimeType) {
      warnings.push(
        `The file reports itself as ${declared} but its contents are ${type.mimeType}. Atlas stored it as ${type.mimeType}.`,
      );
    }
  }

  if (kind === "background") {
    // A background is NOT expected to be 2048x1152 — the compositor composes to
    // that geometry itself. Its only real requirement is that it is a PNG, which
    // sniffing has already proven, so there is nothing to warn about.
    return {
      ok: true,
      type,
      bytes,
      byteLength: bytes.byteLength,
      fileName: safeFileToken(input.fileName, "background.png"),
      warning: null,
    };
  }

  if (kind === "thumbnail") {
    const w = input.width ?? null;
    const h = input.height ?? null;
    if (w && h) {
      if (w !== RECOMMENDED_THUMBNAIL_WIDTH || h !== RECOMMENDED_THUMBNAIL_HEIGHT) {
        warnings.push(
          `Recommended size is ${RECOMMENDED_THUMBNAIL_WIDTH}x${RECOMMENDED_THUMBNAIL_HEIGHT} (16:9). This image is ${w}x${h}.`,
        );
      }
    } else {
      warnings.push(
        `Recommended size is ${RECOMMENDED_THUMBNAIL_WIDTH}x${RECOMMENDED_THUMBNAIL_HEIGHT} (16:9); the dimensions of this file could not be read.`,
      );
    }
  }

  return {
    ok: true,
    type,
    bytes,
    byteLength: bytes.byteLength,
    fileName: safeFileToken(input.fileName, `${kind}.${type.extension}`),
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

/**
 * Read pixel dimensions from the bytes themselves, for the formats that carry
 * them in a fixed header. Returns null when the format does not put the size
 * where we can read it cheaply, which is a normal outcome, not a failure — the
 * image is still valid and is still stored.
 *
 * Only PNG and JPEG are parsed. That is enough to tell a user their file is
 * 512x512 when they expected 2048x1152, without pulling in an image decoder.
 */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: IHDR is the first chunk; width/height are big-endian uint32 at 16/20.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    ascii(bytes, 12, 16) === "IHDR"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the marker segments to the first SOFn frame header.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return { width, height };
      }
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
    return null;
  }
  return null;
}
