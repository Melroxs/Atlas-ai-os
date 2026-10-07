// ---------------------------------------------------------------------------
// Atlas Content Engine — deterministic thumbnail compositor adapter (pure)
//
// WHAT THIS IS
//   The smallest possible seam between the Content Engine and the deployed
//   `content-thumbnail-compose` Edge Function. It:
//
//     * turns ALREADY-APPROVED inputs into the compositor's request contract,
//     * hands that request to an injected transport (the only I/O),
//     * verifies the response end to end — HTTP status, Content-Type, the
//       compositor version header, the PNG signature and the 2048x1152
//       dimensions — before it is allowed to become a media artifact,
//     * hashes the exact bytes it received, and
//     * maps the result onto the EXISTING media abstraction
//       (`youtube_thumbnail`, the same asset type the rest of the engine uses).
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * it does not render anything — the deployed compositor is the single
//     rendering authority, and the WASM/font never enter the app or the worker;
//   * it does not write, choose, rewrite or summarize copy — it forwards
//     approved lines verbatim;
//   * it does not fetch URLs, contact a provider, or touch storage/database;
//   * it does not import any image library.
//
// WHY A TRANSPORT SEAM
//   Every property that must be proven (status, headers, bytes, determinism) is
//   decided HERE, in pure code with no network, so the whole decision surface is
//   unit-testable. The authenticated HTTP call lives in the sibling
//   `thumbnail-compositor-client.ts`.
// ---------------------------------------------------------------------------

import { readImageDimensions, sniffImageMedia } from "./media-upload";

/** The deployed function this adapter invokes. */
export const COMPOSITOR_FUNCTION = "content-thumbnail-compose";
/** The only compositor version this adapter accepts. A newer renderer is a
 *  deliberate change that must be acknowledged here, never silently accepted. */
export const COMPOSITOR_VERSION = "thumbnail-compositor-v1";

/** The canonical thumbnail geometry, matching the compositor and the rest of
 *  the engine's 16:9 target. */
export const COMPOSITOR_WIDTH = 2048;
export const COMPOSITOR_HEIGHT = 1152;

/**
 * The asset identity this artifact becomes. `youtube_thumbnail` is the EXISTING
 * canonical thumbnail asset (`ASSET_TYPES` in ./types) — the same one the blog
 * hero, the Open Graph image and the YouTube publish step all read. No new
 * vocabulary is introduced.
 */
export const COMPOSITOR_ASSET_TYPE = "youtube_thumbnail";

/**
 * The honest provider label for an Atlas-rendered thumbnail. `openai` and
 * `manual_upload` already exist; a deterministic render by Atlas itself is
 * neither, so it is named for what actually produced the bytes.
 */
export const COMPOSITOR_PROVIDER = "deterministic_compositor";

// ---------------------------------------------------------------------------
// Errors — explicit, deterministic, machine-readable
// ---------------------------------------------------------------------------

export type ThumbnailCompositorErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "COMPOSITOR_REJECTED"
  | "HTTP_ERROR"
  | "BAD_CONTENT_TYPE"
  | "UNEXPECTED_VERSION"
  | "INVALID_PNG"
  | "WRONG_DIMENSIONS"
  | "NETWORK_ERROR"
  | "TIMEOUT";

/**
 * A compositor failure is NEVER a media artifact. This error is the only way a
 * failure leaves the adapter, so a caller cannot accidentally treat a rejected
 * render as a successful thumbnail.
 */
export class ThumbnailCompositorError extends Error {
  readonly code: ThumbnailCompositorErrorCode;
  /** The HTTP status when one was observed, else null. */
  readonly status: number | null;
  /** Whether retrying the same approved input could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    code: ThumbnailCompositorErrorCode,
    message: string,
    options: { status?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ThumbnailCompositorError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// The compositor request contract (mirrors the deployed function)
// ---------------------------------------------------------------------------

export interface CompositorRequest {
  background: { dataUri: string };
  text: { lines: string[] };
  layout: { width: number; height: number };
  metadata?: { contentPackageId?: string; compositorVersion?: string };
}

/**
 * The inputs this adapter accepts. Every field is already APPROVED: the
 * background is an approved PNG, the lines are the approved overlay text. The
 * adapter adds no editorial value.
 */
export interface ApprovedThumbnailInput {
  /** An approved PNG background, as a base64 data URI. */
  backgroundDataUri: string;
  /** Approved overlay lines, verbatim (rendered as data by the compositor). */
  overlayLines: readonly string[];
  /** Provenance only — never used to derive copy. */
  contentPackageId?: string | null;
}

const PNG_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_OVERLAY_LINES = 6;
const MAX_LINE_CHARS = 120;

/**
 * Build the compositor request from approved inputs.
 *
 * Validation here is a fast, actionable pre-flight ONLY — the deployed
 * compositor remains the authority and re-validates everything. This never
 * transforms or generates text.
 */
export function buildCompositorRequest(input: ApprovedThumbnailInput): CompositorRequest {
  if (typeof input.backgroundDataUri !== "string" || !PNG_DATA_URI.test(input.backgroundDataUri)) {
    throw new ThumbnailCompositorError(
      "INVALID_INPUT",
      "A background PNG data URI (data:image/png;base64,...) is required.",
    );
  }
  const lines = input.overlayLines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ThumbnailCompositorError("INVALID_INPUT", "At least one approved overlay line is required.");
  }
  if (lines.length > MAX_OVERLAY_LINES) {
    throw new ThumbnailCompositorError(
      "INVALID_INPUT",
      `At most ${MAX_OVERLAY_LINES} overlay lines are supported.`,
    );
  }
  for (const line of lines) {
    if (typeof line !== "string" || line.trim().length === 0) {
      throw new ThumbnailCompositorError("INVALID_INPUT", "Overlay lines must be non-empty strings.");
    }
    if (line.length > MAX_LINE_CHARS) {
      throw new ThumbnailCompositorError(
        "INVALID_INPUT",
        `Overlay lines may not exceed ${MAX_LINE_CHARS} characters.`,
      );
    }
  }

  const request: CompositorRequest = {
    background: { dataUri: input.backgroundDataUri },
    text: { lines: [...lines] },
    layout: { width: COMPOSITOR_WIDTH, height: COMPOSITOR_HEIGHT },
  };
  if (input.contentPackageId) {
    request.metadata = { contentPackageId: input.contentPackageId };
  }
  return request;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** Exactly what the adapter needs to know about one compositor response. */
export interface CompositorTransportResponse {
  status: number;
  contentType: string | null;
  compositorVersion: string | null;
  bytes: Uint8Array;
}

export type CompositorTransport = (
  request: CompositorRequest,
) => Promise<CompositorTransportResponse>;

// ---------------------------------------------------------------------------
// The artifact — mapped onto the existing media abstraction
// ---------------------------------------------------------------------------

export interface CompositedThumbnail {
  /** The EXISTING canonical thumbnail asset type. */
  assetType: typeof COMPOSITOR_ASSET_TYPE;
  provider: typeof COMPOSITOR_PROVIDER;
  compositorVersion: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteSize: number;
  /** SHA-256 of the exact returned bytes, lower-case hex. */
  sha256: string;
  contentPackageId: string | null;
  /** The rendered PNG, in memory. Persisting it is a separate, explicit step. */
  bytes: Uint8Array;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Invoke the compositor through `transport` and return a verified artifact.
 *
 * Every stage fails closed with a typed, machine-readable error. The returned
 * artifact is only ever constructed from bytes that passed EVERY check.
 */
export async function composeApprovedThumbnail(
  input: ApprovedThumbnailInput,
  transport: CompositorTransport,
): Promise<CompositedThumbnail> {
  const request = buildCompositorRequest(input);

  let response: CompositorTransportResponse;
  try {
    response = await transport(request);
  } catch (error) {
    // A typed transport failure (e.g. UNAUTHENTICATED/TIMEOUT) passes through.
    if (error instanceof ThumbnailCompositorError) throw error;
    throw new ThumbnailCompositorError(
      "NETWORK_ERROR",
      "The thumbnail compositor could not be reached.",
      { retryable: true, cause: error },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ThumbnailCompositorError(
      "UNAUTHENTICATED",
      "The thumbnail compositor rejected the caller's credentials.",
      { status: response.status },
    );
  }
  if (response.status === 400 || response.status === 422) {
    throw new ThumbnailCompositorError(
      "COMPOSITOR_REJECTED",
      "The thumbnail compositor rejected the request.",
      { status: response.status },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ThumbnailCompositorError(
      "HTTP_ERROR",
      `The thumbnail compositor returned HTTP ${response.status}.`,
      { status: response.status, retryable: response.status >= 500 },
    );
  }

  const contentType = (response.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "image/png") {
    throw new ThumbnailCompositorError(
      "BAD_CONTENT_TYPE",
      `The thumbnail compositor returned "${response.contentType ?? ""}" instead of image/png.`,
      { status: response.status },
    );
  }

  if (response.compositorVersion !== COMPOSITOR_VERSION) {
    throw new ThumbnailCompositorError(
      "UNEXPECTED_VERSION",
      `The thumbnail compositor reported version "${response.compositorVersion ?? ""}" instead of "${COMPOSITOR_VERSION}".`,
      { status: response.status },
    );
  }

  const bytes = response.bytes;
  const sniffed = sniffImageMedia(bytes);
  if (!sniffed || sniffed.mimeType !== "image/png") {
    throw new ThumbnailCompositorError("INVALID_PNG", "The compositor response is not a PNG image.", {
      status: response.status,
    });
  }
  const dimensions = readImageDimensions(bytes);
  if (!dimensions) {
    throw new ThumbnailCompositorError(
      "INVALID_PNG",
      "The compositor response has no readable PNG dimensions.",
      { status: response.status },
    );
  }
  if (dimensions.width !== COMPOSITOR_WIDTH || dimensions.height !== COMPOSITOR_HEIGHT) {
    throw new ThumbnailCompositorError(
      "WRONG_DIMENSIONS",
      `The compositor returned ${dimensions.width}x${dimensions.height} instead of ${COMPOSITOR_WIDTH}x${COMPOSITOR_HEIGHT}.`,
      { status: response.status },
    );
  }

  return {
    assetType: COMPOSITOR_ASSET_TYPE,
    provider: COMPOSITOR_PROVIDER,
    compositorVersion: COMPOSITOR_VERSION,
    mimeType: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    byteSize: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    contentPackageId: input.contentPackageId ?? null,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Mapping onto the existing media abstraction
// ---------------------------------------------------------------------------

/**
 * The `p_metadata` payload for the existing `content_asset_upsert` RPC.
 *
 * This is the shape the pipeline already stores for a generated thumbnail
 * (see the worker's thumbnail step), extended with the compositor identity and
 * the content hash so an artifact can always be traced back to the exact
 * renderer that produced it. Nothing here is written by this adapter.
 */
export function toThumbnailAssetMetadata(artifact: CompositedThumbnail): Record<string, unknown> {
  return {
    source: artifact.provider,
    compositorVersion: artifact.compositorVersion,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    byteSize: artifact.byteSize,
    mimeType: artifact.mimeType,
  };
}

/**
 * The storage-write input for the existing `blog-media` upload path — the same
 * `{ bucket, path, bytes, contentType }` shape the worker's thumbnail step
 * already consumes. Returning it here does NOT write anything; a caller that
 * chooses to persist an artifact does so through the existing upload seam.
 */
export function toThumbnailStorageWrite(
  artifact: CompositedThumbnail,
  storagePath: string,
): { bucket: string; path: string; bytes: Uint8Array; contentType: string } {
  return {
    bucket: "blog-media",
    path: storagePath,
    bytes: artifact.bytes,
    contentType: artifact.mimeType,
  };
}
