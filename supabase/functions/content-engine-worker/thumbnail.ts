// ---------------------------------------------------------------------------
// Atlas Content Engine — canonical thumbnail generation
//
// WHY THIS MODULE EXISTS
// ----------------------
// The Content Engine already had a `content_generate_thumbnail` step, but it
// could never actually run, and the shape it described was wrong in three ways
// that would only have surfaced after a provider was configured:
//
//  1. It had NO timeout. The image `fetch` carried no signal and no timer — the
//     exact defect Phase 6 fixed for the article — so a provider that accepted
//     and never answered would have left the job `processing` forever, with no
//     reclaim path.
//  2. It persisted the provider's URL as the authoritative asset. OpenAI-style
//     image URLs expire within the hour, so the "canonical" thumbnail would
//     stop resolving while the row still claimed to be authoritative. The fix
//     is to take the BYTES — inline base64 when the provider sends them, or
//     the bytes behind a short-lived URL pulled inside the same deadline — and
//     store them in Atlas's own public `blog-media` bucket, so the storage
//     path, not the provider, is the asset.
//  3. It built its own prompt from the article title and never read the
//     package's curated `imagePrompt`, which is the one piece of approved
//     visual direction Atlas actually stores.
//
// ONE CANONICAL IMAGE
// -------------------
// There is exactly one thumbnail asset per package
// (`youtube_thumbnail`), and the same stored object is what the canonical
// presentation points Blog hero / OG / YouTube at. This module does not create a
// Blog image, a YouTube image or an OG image; it creates the one image those
// destinations reference.
//
// WHY IT LIVES HERE AND NOT IN src/lib/content-engine/media.ts
// -----------------------------------------------------------
// `media.ts` holds the same provider contract for the browser and for the Studio
// settings screen, but a Supabase Edge Function is bundled from its own
// directory and cannot import application code from `src/`. The executable
// implementation therefore lives in the function, and the two are pinned to the
// same endpoint, env var names, model, size and request contract by a drift test
// in src/lib/content-engine/thumbnail-generation.test.ts, so they cannot
// silently diverge.
//
// THE REQUEST CARRIES NO OUTPUT-FORMAT PARAMETER
// ---------------------------------------------
// `response_format` used to be sent as `b64_json`. OpenAI rejects it outright
// on the current image contract: the parameter is documented for dall-e-2 and
// dall-e-3 only, is "not supported for the GPT image models", and the live
// provider answered HTTP 400
// `invalid_request_error / unknown_parameter / response_format`. So it is not
// sent, and no guessed replacement is invented in its place. Instead the
// response is read for whichever shape the provider actually returned — inline
// `b64_json`, or a short-lived `url` whose bytes are downloaded immediately —
// and both paths end in the same durable bytes in `blog-media`.
//
// It is a pure module with an injected `transport`/`upload`/`rpc` for exactly
// the reason provider-deadline.ts is: the test suite can EXECUTE the timeout,
// the decode and the persistence against a real socket instead of asserting on
// strings. Nothing here touches `Deno`.
// ---------------------------------------------------------------------------

import { ProviderTimeoutError, withProviderDeadline } from "./provider-deadline.ts";
import { describeProviderError, formatProviderError } from "./provider-error.ts";

/** The single canonical thumbnail identity, reused by every destination. */
export const THUMBNAIL_CONTENT_TYPE = "youtube_thumbnail";
export const THUMBNAIL_ASSET_TYPE = "youtube_thumbnail";
/** Atlas's existing public content-media bucket. Not a new one. */
export const THUMBNAIL_BUCKET = "blog-media";
export const THUMBNAIL_PROVIDER = "openai";

/**
 * The honest provider label for a thumbnail rendered by Atlas's OWN
 * deterministic compositor rather than by a generative provider.
 *
 * It is deliberately not `openai`: these bytes were not produced by a model, and
 * recording them as if they were would misstate where the artifact came from.
 * It matches `COMPOSITOR_PROVIDER` in the app-side adapter
 * (`src/lib/content-engine/thumbnail-compositor.ts`), so the same artifact is
 * labelled identically on both sides of the boundary.
 */
export const THUMBNAIL_COMPOSITOR_PROVIDER = "deterministic_compositor";

/**
 * The compositor build this step's output is expected to come from.
 *
 * Declared here rather than imported from `content-thumbnail-compose/`: a
 * Supabase Edge bundle is built from a function's OWN directory, so importing a
 * sibling function's source reaches outside the deploy source root and the
 * bundle silently loses it. The value is pinned to the compositor's
 * `COMPOSITOR_VERSION` by a drift test instead, which fails the build the moment
 * the two disagree. The adapter independently refuses any other version header,
 * so a mismatch fails loudly at runtime too.
 */
export const THUMBNAIL_COMPOSITOR_VERSION = "thumbnail-compositor-v1";
/**
 * Landscape master size, 16:9 exactly.
 *
 * `2048x1152` is the authorized size for the authorized model
 * (`gpt-image-2.5-flare`, configured through IMAGE_PROVIDER_MODEL). OpenAI
 * documents arbitrary `WIDTHxHEIGHT` for the current GPT image models subject to
 * each edge being a multiple of 16, a longer:shorter ratio of at most 3:1, a
 * total pixel count between 655,360 and 8,294,400, and outputs above
 * 3,686,400 px (2560x1440) being experimental. 2048x1152 satisfies all four
 * (128 and 72 edge units, ratio 1.778, 2,359,296 px) and is named by OpenAI as a
 * common "2K landscape" size.
 *
 * It replaces `1792x1024`, which was a DALL·E 3 value. That model was removed
 * from the API on 2026-05-12, and the size is not a GPT image standard size, so
 * the model and the size were replaced together.
 */
export const THUMBNAIL_SOURCE_SIZE = "2048x1152";

/** A body that is not JSON is a provider contract failure, not a crash. */
export const INVALID_JSON_MESSAGE = "The image provider returned a response that was not valid JSON.";

export const IMAGE_API_KEY_ENV = "IMAGE_PROVIDER_API_KEY";
export const IMAGE_BASE_URL_ENV = "IMAGE_PROVIDER_BASE_URL";
export const IMAGE_MODEL_ENV = "IMAGE_PROVIDER_MODEL";
/** The authorized credential may arrive under either name. */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

export type ThumbnailOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface ThumbnailTransportInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /**
   * Read the response as raw bytes instead of text. Image payloads are binary;
   * decoding them as text would corrupt them, so the byte read is explicit.
   */
  wantBytes?: boolean;
}

/**
 * Which renderer produces the canonical thumbnail.
 *
 * `undefined` keeps the existing generative-provider behaviour EXACTLY as it
 * was, so adding the compositor changes no production behaviour: nothing in the
 * deployed worker selects it yet.
 */
export type ThumbnailRenderer =
  | {
      kind: "compositor";
      /** Resolved input, produced by resolveThumbnailInputs from the references. */
      backgroundDataUri: string;
      overlayLines: string[];
      /** What the inputs were, recorded on the output so a render is traceable. */
      provenance?: Record<string, unknown>;
    }
  | { kind: "image_provider" };

/**
 * A compositor renderer as it ARRIVES in a job payload: by reference, never by
 * value. A multi-megabyte PNG data URI must not be written into a durable job
 * row, so the payload names the two approved assets and the worker resolves
 * them against the package it is already rendering for.
 */
export interface CompositorRendererRefs {
  kind: "compositor";
  backgroundAssetId: string;
  overlayAssetId: string;
}

/** A verified thumbnail: the adapter has already checked it. */
export interface ComposedThumbnailArtifact {
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lower-case hex. Recorded so a render is traceable. */
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
  mimeType: string;
}

/**
 * The compositor hook's contract.
 *
 * It mirrors the proven adapter (`composeApprovedThumbnail`) at the seam: the
 * bytes arrive ALREADY verified — PNG signature, 2048x1152 geometry, compositor
 * version header and SHA-256 all checked by the adapter — so this module never
 * re-implements a check the compositor boundary already owns. A refusal is
 * RETURNED, never thrown, so a rejected render can never be mistaken for an
 * artifact.
 */
/** The renderer kinds this step understands. Nothing else is accepted. */
export const THUMBNAIL_RENDERER_KINDS = ["image_provider", "compositor"] as const;

/**
 * The outcome of reading a renderer out of an untrusted job payload.
 *
 * ABSENT is a success with no renderer, which means the existing generative
 * provider — the default is preserved by returning nothing, never by guessing.
 */
export type ThumbnailRendererRead =
  | { ok: true; renderer?: ThumbnailRenderer | CompositorRendererRefs }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * Read the renderer out of a job payload.
 *
 * The job payload is operator/automation supplied jsonb, so it is untrusted. It
 * is validated here rather than cast, for two reasons:
 *
 *   1. an UNKNOWN renderer must fail closed. Falling through to the image
 *      provider would be a silent fallback: a job that asked for the
 *      deterministic compositor would quietly pay a generative provider instead,
 *      which is exactly the substitution this system is built to avoid;
 *   2. the compositor inputs are checked for SHAPE here (an object with a
 *      background and at least one line) but NOT for validity — judging whether
 *      the background is an approved PNG, and whether the lines are approved
 *      copy, belongs to whoever approves them and to the adapter, not to a
 *      parser.
 */
export function readThumbnailRenderer(
  payload: Record<string, unknown> | null | undefined,
): ThumbnailRendererRead {
  const raw = payload?.renderer;
  // No renderer named at all: the default provider path, unchanged.
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "The thumbnail job's renderer is not a renderer object; no thumbnail was generated.",
      retryable: false,
    };
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === "image_provider") return { ok: true, renderer: { kind: "image_provider" } };
  if (record.kind !== "compositor") {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        `Unknown thumbnail renderer "${String(record.kind)}". Expected one of ` +
        `${THUMBNAIL_RENDERER_KINDS.join(", ")}. No thumbnail was generated.`,
      retryable: false,
    };
  }

  // Reference form: what a durable job payload carries. The worker resolves it.
  const backgroundAssetId = record.backgroundAssetId;
  const overlayAssetId = record.overlayAssetId;
  if (backgroundAssetId !== undefined || overlayAssetId !== undefined) {
    if (
      typeof backgroundAssetId !== "string" ||
      backgroundAssetId.trim() === "" ||
      typeof overlayAssetId !== "string" ||
      overlayAssetId.trim() === ""
    ) {
      return {
        ok: false,
        code: "VALIDATION",
        message:
          "A compositor thumbnail job must name both a backgroundAssetId and an overlayAssetId. " +
          "No thumbnail was generated.",
        retryable: false,
      };
    }
    return {
      ok: true,
      renderer: { kind: "compositor", backgroundAssetId, overlayAssetId },
    };
  }

  // Resolved form: what the step hands to this module after resolution.
  const backgroundDataUri = record.backgroundDataUri;
  const overlayLines = record.overlayLines;
  if (
    typeof backgroundDataUri !== "string" ||
    backgroundDataUri.trim() === "" ||
    !Array.isArray(overlayLines) ||
    overlayLines.length === 0 ||
    overlayLines.some((line) => typeof line !== "string")
  ) {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        "A compositor thumbnail job needs an approved backgroundAssetId and overlayAssetId " +
        "(or a resolved backgroundDataUri with overlay lines). No thumbnail was generated.",
      retryable: false,
    };
  }
  return {
    ok: true,
    renderer: { kind: "compositor", backgroundDataUri, overlayLines: overlayLines as string[] },
  };
}

export type ComposeThumbnailFn = (input: {
  backgroundDataUri: string;
  overlayLines: string[];
  contentPackageId: string;
  signal: AbortSignal;
}) => Promise<
  | { ok: true; artifact: ComposedThumbnailArtifact }
  | { ok: false; code: string; message: string; retryable: boolean }
>;

export interface ThumbnailDeps {
  env: { get(key: string): string | null };
  /**
   * Performs the provider exchange and reads the whole body. Returns `bytes`
   * only when the caller asked for them via `wantBytes`.
   */
  transport: (
    input: ThumbnailTransportInput,
  ) => Promise<{ ok: boolean; status: number; text: string; bytes?: Uint8Array }>;
  /** Writes the bytes into Atlas-owned storage. Throws on failure. */
  upload: (input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
    contentType: string;
  }) => Promise<void>;
  /** The durable, publicly readable URL for a stored object. */
  publicUrl: (path: string) => string;
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  timeoutMs: number;
  /** Injectable so the recorded render time is deterministic under test. */
  now?: () => number;
  /**
   * Renders the canonical thumbnail through the DETERMINISTIC compositor.
   *
   * Optional because the generative provider stays the default. It is injected
   * rather than imported so this module keeps no dependency on application code
   * (a Supabase Edge bundle is built from its own directory and cannot import
   * from `src/`), and so the suite can execute the real orchestration against
   * the real adapter with no deployment and no network.
   */
  composeThumbnail?: ComposeThumbnailFn;
}

// ---------------------------------------------------------------------------
// Prompt — the package's curated direction, plus deterministic constraints
// ---------------------------------------------------------------------------

/**
 * Build the render prompt.
 *
 * The package's `imagePrompt` is the creative direction an operator already
 * approved, so it leads. Only DETERMINISTIC technical constraints are appended —
 * format, framing and prohibitions. The creative brief is never rewritten here,
 * and the article title is used for subject context, not as a replacement brief,
 * because a title alone is not an art direction.
 */
export function buildThumbnailPrompt(input: {
  imagePrompt: string;
  articleTitle: string | null;
  brandVoice: string | null;
}): string {
  return [
    input.imagePrompt.trim(),
    input.articleTitle ? `Subject: ${input.articleTitle.trim()}.` : "",
    input.brandVoice ? `Brand voice: ${input.brandVoice.trim()}.` : "",
    // Deterministic constraints only.
    `Landscape ${THUMBNAIL_SOURCE_SIZE} master, suitable as a YouTube thumbnail and a blog hero image.`,
    "A single strong focal subject, readable composition that survives being shrunk to a small card.",
    "No fabricated statistics, no charts with numbers, no invented logos, awards or certifications.",
    "No misleading claims and no text baked into the image; any required wording is added deterministically downstream.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Bytes — decode, identify, and name deterministically
// ---------------------------------------------------------------------------

export interface ImageFormat {
  mimeType: string;
  extension: string;
}

/**
 * Identify the real image format from its magic bytes.
 *
 * The provider does not get to decide what Atlas claims it stored: a hardcoded
 * `image/jpeg` on a PNG is a metadata lie that breaks anything downstream that
 * trusts the MIME type. If the bytes are not a recognised image, nothing is
 * persisted.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12) {
    const head = String.fromCharCode(...bytes.slice(0, 4));
    const tail = String.fromCharCode(...bytes.slice(8, 12));
    if (head === "RIFF" && tail === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "GIF8") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  return null;
}

/** Decode provider base64 into raw bytes. Throws only on malformed input. */
export function decodeBase64Image(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The durable object path for a package's thumbnail.
 *
 * Derived from the package slug so it is DETERMINISTIC: a retry overwrites the
 * same object instead of accumulating a new one, which is what keeps a retried
 * job from littering storage with near-duplicate images.
 */
export function thumbnailStoragePath(input: {
  slug: string | null;
  packageId: string;
  extension: string;
}): string {
  const safeSlug =
    input.slug && /^[a-z0-9][a-z0-9-]*$/i.test(input.slug) ? input.slug : input.packageId;
  return `${THUMBNAIL_BUCKET}/${safeSlug}/thumbnail.${input.extension}`;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Whether this package already has a usable canonical thumbnail.
 *
 * A durable `storagePath` is the real proof. An `externalUrl` is accepted only
 * for rows written before durability existed, so a legacy asset is reused rather
 * than regenerated needlessly — but a regeneration request always wins, because
 * the operator explicitly asked for a new render.
 */
export function hasUsableThumbnail(
  existing: { storagePath: string | null; externalUrl: string | null } | null,
  regenerate: boolean,
): boolean {
  if (regenerate) return false;
  if (!existing) return false;
  return Boolean(existing.storagePath || existing.externalUrl);
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export async function generateThumbnail(
  input: {
    packageId: string;
    tenantId: string;
    packageOrganizationId: string | null;
    packageTitle: string;
    packageSlug: string | null;
    imagePrompt: string | null;
    articleTitle: string | null;
    brandVoice: string | null;
    existing: { storagePath: string | null; externalUrl: string | null } | null;
    regenerate: boolean;
    /**
     * Explicit authorisation to REPLACE an existing canonical thumbnail.
     *
     * `regenerate` and this are NOT the same decision. `regenerate` means "render
     * again"; it does not mean "it is acceptable to destroy an artifact a human
     * supplied". This flag is the separate, attributable consent for that, and it
     * is only set by an operator path. It is deliberately required IN ADDITION to
     * `regenerate`, so neither one alone can silently overwrite operator artwork.
     */
    replaceExistingThumbnail?: boolean;
    /**
     * Identity of the asset a compositor render will replace, recorded on the
     * output so the substitution stays auditable.
     */
    supersedes?: { assetId: string | null; provider: string | null; source: string | null } | null;
    /** Which renderer produces the bytes. Absent = the generative provider. */
    renderer?: ThumbnailRenderer;
  },
  deps: ThumbnailDeps,
): Promise<ThumbnailOutcome> {
  // Tenant safety, before anything is generated or stored. A package that does
  // not belong to the job's tenant must never produce an asset, and the check
  // happens here rather than relying on a later write failing.
  if (!input.packageOrganizationId || input.packageOrganizationId !== input.tenantId) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "The content package does not belong to this tenant; no thumbnail was generated.",
      retryable: false,
    };
  }

  if (hasUsableThumbnail(input.existing, input.regenerate)) {
    return { ok: true, result: { reused: true, package_id: input.packageId } };
  }

  // Fail CLOSED on an unrecognised renderer. Treating it as "not a compositor"
  // would silently fall back to the generative provider, turning an explicit
  // request for a deterministic render into a paid model call. Only the two
  // known kinds may proceed, and only one of them reaches a provider.
  const rendererKind = (input.renderer as { kind?: unknown } | undefined)?.kind;
  if (
    rendererKind !== undefined &&
    rendererKind !== "compositor" &&
    rendererKind !== "image_provider"
  ) {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        `Unknown thumbnail renderer "${String(rendererKind)}". Expected one of ` +
        `${THUMBNAIL_RENDERER_KINDS.join(", ")}. No thumbnail was generated.`,
      retryable: false,
    };
  }

  // The deterministic compositor is an ALTERNATIVE renderer on this same media
  // step: it shares the tenant precondition above, the idempotency check, the
  // deadline, and the entire persistence tail. Only the origin of the bytes
  // differs. It is selected explicitly and nothing in production selects it yet.
  if (input.renderer?.kind === "compositor") {
    // REPLACEMENT CONSENT.
    //
    // Reaching this point means `regenerate` was true and a usable thumbnail
    // already exists, because the reuse check above returned early otherwise.
    // Rendering here would overwrite whatever is there — and that is very often
    // a human-supplied asset. Without an EXPLICIT, separate authorisation this
    // step refuses, because "render again" was never consent to destroy an
    // operator's artwork.
    if (input.existing && input.replaceExistingThumbnail !== true) {
      return {
        ok: false,
        code: "REPLACEMENT_NOT_AUTHORIZED",
        message:
          "This package already has a canonical thumbnail, so it was left untouched. Replacing it " +
          "requires explicit operator authorization (replaceExistingThumbnail).",
        retryable: false,
      };
    }
    return composeCanonicalThumbnail(input, input.renderer, deps);
  }

  const baseUrl = deps.env.get(IMAGE_BASE_URL_ENV);
  const model = deps.env.get(IMAGE_MODEL_ENV);
  const key = deps.env.get(IMAGE_API_KEY_ENV) ?? deps.env.get(OPENAI_API_KEY_ENV);
  if (!baseUrl || !model || !key) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message:
        `No verified image provider is configured. Set ${IMAGE_BASE_URL_ENV} and ${IMAGE_MODEL_ENV} ` +
        `(with ${IMAGE_API_KEY_ENV}) to the image endpoint Atlas should use. No thumbnail was generated.`,
      retryable: false,
    };
  }

  // The curated brief is required. Falling back to a title-only prompt would
  // silently discard the approved visual direction, which is worse than not
  // generating an image at all.
  const imagePrompt = input.imagePrompt?.trim();
  if (!imagePrompt) {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        "The content package has no curated imagePrompt, so a thumbnail cannot be rendered " +
        "without inventing visual direction. Set an imagePrompt on the package first.",
      retryable: false,
    };
  }

  const prompt = buildThumbnailPrompt({
    imagePrompt,
    articleTitle: input.articleTitle,
    brandVoice: input.brandVoice,
  });

  const timeoutMs = deps.timeoutMs;
  const timeoutFailure = (): ThumbnailOutcome => ({
    ok: false,
    code: "PROVIDER_TIMEOUT",
    message:
      `The image provider did not respond within ${Math.round(timeoutMs / 1000)} seconds. ` +
      "The request was aborted and no thumbnail was written.",
    retryable: true,
  });

  type Outcome =
    | { kind: "json"; payload: Record<string, unknown> }
    | { kind: "bytes"; bytes: Uint8Array }
    | { kind: "invalid"; reason: string }
    | { kind: "http"; status: number; body: string };
  let outcome: Outcome;
  try {
    // Headers AND the (potentially multi-megabyte) body are inside the deadline,
    // and the abort tears the socket down so the provider stops rendering work
    // Atlas has already abandoned. A follow-up download of a short-lived image
    // URL shares the SAME deadline rather than starting a second one, so the
    // total time this step can occupy is still bounded by the configured value.
    outcome = await withProviderDeadline(timeoutMs, async (signal) => {
      const res = await deps.transport({
        url: baseUrl.replace(/\/+$/, ""),
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        // Only contract-verified parameters. OpenAI rejects `response_format`
        // on the current image contract (HTTP 400, unknown_parameter), and no
        // undocumented substitute is invented in its place.
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size: THUMBNAIL_SOURCE_SIZE,
        }),
        signal,
      });
      // The body travels with a rejection so the reason is observable. It is
      // sanitized, bounded and redacted before it can reach job state; nothing
      // about the request itself changes.
      if (!res.ok) return { kind: "http", status: res.status, body: res.text } as const;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(res.text) as Record<string, unknown>;
      } catch {
        return { kind: "invalid", reason: INVALID_JSON_MESSAGE } as const;
      }

      const images = Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>[])
        : [];
      const first = images[0] ?? null;

      // Shape A — inline base64. Decoded below and validated before storage.
      if (typeof first?.["b64_json"] === "string") {
        return { kind: "json", payload } as const;
      }

      // Shape B — a short-lived URL. The URL is NEVER stored: the bytes behind
      // it are pulled now, inside this deadline, so `blog-media` ends up owning
      // the image. A provider URL is only valid for about an hour, so anything
      // that stored one would rot while still claiming to be authoritative.
      const remote = typeof first?.["url"] === "string" ? (first["url"] as string) : null;
      if (!remote) {
        return {
          kind: "invalid",
          reason: "The image provider returned neither image bytes nor an image URL.",
        } as const;
      }
      if (!remote.startsWith("https://")) {
        return {
          kind: "invalid",
          reason: "The image provider returned an image URL that is not an https URL.",
        } as const;
      }
      const download = await deps.transport({
        url: remote,
        method: "GET",
        headers: {},
        wantBytes: true,
        signal,
      });
      if (!download.ok || !download.bytes || download.bytes.length === 0) {
        return {
          kind: "invalid",
          reason:
            "The image provider returned a temporary image URL, but its image bytes could " +
            "not be downloaded, so no durable thumbnail could be written.",
        } as const;
      }
      return { kind: "bytes", bytes: download.bytes } as const;
    });
  } catch (error) {
    if (error instanceof ProviderTimeoutError) return timeoutFailure();
    // A malformed payload is a provider contract failure, not a crash.
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        message: INVALID_JSON_MESSAGE,
        retryable: true,
      };
    }
    throw error;
  }

  if (outcome.kind === "http") {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: formatProviderError(
        describeProviderError({
          provider: THUMBNAIL_PROVIDER,
          status: outcome.status,
          body: outcome.body,
        }),
      ),
      retryable: true,
    };
  }

  if (outcome.kind === "invalid") {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: outcome.reason,
      retryable: true,
    };
  }

  let bytes: Uint8Array;
  if (outcome.kind === "bytes") {
    // Already the real image bytes, downloaded from the provider's short-lived
    // URL inside the deadline above. They still go through the same validation
    // as inline base64 before anything is stored.
    bytes = outcome.bytes;
  } else {
    const data = Array.isArray(outcome.payload.data)
      ? (outcome.payload.data as Record<string, unknown>[])
      : [];
    const base64 = typeof data[0]?.b64_json === "string" ? (data[0].b64_json as string) : null;
    if (!base64) {
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        message:
          "The image provider returned a response without image bytes, so no durable " +
          "thumbnail could be written.",
        retryable: true,
      };
    }
    try {
      bytes = decodeBase64Image(base64);
    } catch {
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        message: "The image provider returned image bytes that could not be decoded.",
        retryable: true,
      };
    }
  }
  if (bytes.length === 0) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: "The image provider returned an empty image.",
      retryable: true,
    };
  }

  return persistThumbnail(input, bytes, deps, {
    provider: THUMBNAIL_PROVIDER,
    sourceLabel: "The image provider",
    failureCode: "PROVIDER_ERROR",
    metadata: {
      // The curated brief travels WITH the asset so the rendered image can
      // always be traced back to the direction that produced it.
      imagePrompt,
      source: THUMBNAIL_PROVIDER,
      model,
      size: THUMBNAIL_SOURCE_SIZE,
      // `content_asset_upsert` merges metadata, so a compositor render's keys
      // would otherwise survive a later provider render and misattribute this
      // image. They are explicitly cleared to null on this path.
      renderer: null,
      compositorVersion: null,
      backgroundAssetId: null,
      backgroundSha256: null,
      overlayAssetId: null,
      overlayLines: null,
      sha256: null,
      supersedes: null,
      generatedAt: (deps.now ?? Date.now)(),
    },
  });
}

// ---------------------------------------------------------------------------
// The deterministic compositor path
// ---------------------------------------------------------------------------
//
// It reuses every existing safety property of the media step rather than adding
// a parallel one:
//
//   * the tenant precondition runs BEFORE it (in generateThumbnail, above);
//   * `hasUsableThumbnail` runs BEFORE it, so a second execution of the same
//     job reuses the stored object instead of rendering again;
//   * the render is bounded by the same image deadline, with the same abort;
//   * the persistence tail is literally the same function the provider path
//     uses — one bucket, one path convention, one asset identity, one
//     presentation hook.
//
// What it deliberately does NOT do is promise anything the provider path does
// not also promise: no invented copy, no rewritten overlay text, no second
// thumbnail asset, and no path from a rendered thumbnail to a published one.
// Publication stays behind the existing human-approval gate.

async function composeCanonicalThumbnail(
  input: {
    packageId: string;
    packageTitle: string;
    packageSlug: string | null;
    renderer?: ThumbnailRenderer;
    supersedes?: { assetId: string | null; provider: string | null; source: string | null } | null;
  },
  renderer: Extract<ThumbnailRenderer, { kind: "compositor" }>,
  deps: ThumbnailDeps,
): Promise<ThumbnailOutcome> {
  const compose = deps.composeThumbnail;
  if (!compose) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "The deterministic thumbnail compositor is not wired into this deployment.",
      retryable: false,
    };
  }

  const backgroundDataUri =
    typeof renderer.backgroundDataUri === "string" ? renderer.backgroundDataUri.trim() : "";
  const overlayLines = Array.isArray(renderer.overlayLines) ? renderer.overlayLines : [];
  if (!backgroundDataUri || overlayLines.length === 0) {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        "A compositor render needs an approved background image and approved overlay lines. " +
        "Nothing was rendered.",
      retryable: false,
    };
  }

  const timeoutMs = deps.timeoutMs;
  let composed: Awaited<ReturnType<ComposeThumbnailFn>>;
  try {
    composed = await withProviderDeadline(timeoutMs, (signal) =>
      compose({
        backgroundDataUri,
        // Forwarded VERBATIM. Neither this module nor the compositor is a
        // copywriter: these lines were approved before they arrived, and
        // validating them is the adapter's job because the adapter owns the
        // compositor contract.
        overlayLines,
        contentPackageId: input.packageId,
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof ProviderTimeoutError) {
      return {
        ok: false,
        code: "PROVIDER_TIMEOUT",
        message:
          `The deterministic thumbnail compositor did not respond within ${Math.round(timeoutMs / 1000)} seconds. ` +
          "The request was aborted and no thumbnail was written.",
        retryable: true,
      };
    }
    throw error;
  }

  if (!composed.ok) {
    // The adapter's classification is authoritative: it knows which failures are
    // transient (5xx, network, timeout) and which are permanent (rejected
    // request, wrong type, wrong geometry, unexpected renderer version).
    // Nothing retries forever, and a refusal never becomes an artifact.
    return {
      ok: false,
      code: composed.code,
      message: composed.message,
      retryable: composed.retryable,
    };
  }

  const artifact = composed.artifact;
  if (!artifact || !artifact.bytes || artifact.bytes.length === 0) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message:
        "The thumbnail compositor returned no image bytes, so no durable thumbnail could be written.",
      retryable: true,
    };
  }

  return persistThumbnail(input, artifact.bytes, deps, {
    provider: THUMBNAIL_COMPOSITOR_PROVIDER,
    sourceLabel: "The thumbnail compositor",
    failureCode: "PROVIDER_ERROR",
    metadata: compositorProvenance(input, artifact, deps.now),
  });
}

/**
 * The COMPLETE provenance set for a compositor output.
 *
 * Every key is written on every render, including the ones that are null. That
 * is not tidiness: `content_asset_upsert` MERGES metadata (`existing || excluded`),
 * so a key that is simply omitted SURVIVES into the next render. A new render
 * would then carry the previous render's output hash or background id, and an
 * artifact would claim to have been produced from inputs it never saw. Writing
 * the full set each time — with explicit nulls — is what makes "this metadata
 * describes exactly this render" true.
 */
function compositorProvenance(
  input: {
    renderer?: ThumbnailRenderer;
    supersedes?: { assetId: string | null; provider: string | null; source: string | null } | null;
  },
  artifact: ComposedThumbnailArtifact,
  now: () => number = () => Date.now(),
): Record<string, unknown> {
  const renderer = input.renderer;
  const provenance =
    renderer?.kind === "compositor" && renderer.provenance ? renderer.provenance : {};
  const supersedes = input.supersedes ?? null;

  return {
    source: THUMBNAIL_COMPOSITOR_PROVIDER,
    renderer: "content-thumbnail-compose",
    compositorVersion: THUMBNAIL_COMPOSITOR_VERSION,

    // Inputs, or explicit nulls when the render was not reference-resolved.
    backgroundAssetId: (provenance.backgroundAssetId as string | undefined) ?? null,
    backgroundSha256: (provenance.backgroundSha256 as string | undefined) ?? null,
    backgroundStoragePath: (provenance.backgroundStoragePath as string | undefined) ?? null,
    backgroundApprovedBy: (provenance.backgroundApprovedBy as string | undefined) ?? null,
    backgroundApprovedAt: (provenance.backgroundApprovedAt as number | undefined) ?? null,
    overlayAssetId: (provenance.overlayAssetId as string | undefined) ?? null,
    overlayLines: (provenance.overlayLines as string[] | undefined) ?? null,
    overlayApprovedBy: (provenance.overlayApprovedBy as string | undefined) ?? null,
    overlayApprovedAt: (provenance.overlayApprovedAt as number | undefined) ?? null,

    // What this render produced.
    width: artifact.width,
    height: artifact.height,
    byteSize: artifact.byteSize,
    mimeType: artifact.mimeType,
    sha256: artifact.sha256,
    generatedAt: now(),

    // What it replaced, or explicit null when it replaced nothing.
    supersedes: supersedes
      ? {
          assetId: supersedes.assetId ?? null,
          provider: supersedes.provider ?? null,
          source: supersedes.source ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// The one persistence tail, shared by every renderer
// ---------------------------------------------------------------------------
//
// Bytes in, one canonical `youtube_thumbnail` asset out. Keeping it SINGLE is
// what stops two renderers from drifting into two storage conventions, two
// metadata shapes or two presentation hooks. A renderer's only freedom is WHERE
// the bytes come from, never what happens to them afterwards.

async function persistThumbnail(
  input: { packageId: string; packageTitle: string; packageSlug: string | null },
  bytes: Uint8Array,
  deps: ThumbnailDeps,
  options: {
    provider: string;
    sourceLabel: string;
    failureCode: string;
    metadata: Record<string, unknown>;
  },
): Promise<ThumbnailOutcome> {
  const format = sniffImageFormat(bytes);
  if (!format) {
    return {
      ok: false,
      code: options.failureCode,
      message: `${options.sourceLabel} returned data that is not a recognisable image format.`,
      retryable: true,
    };
  }

  const storagePath = thumbnailStoragePath({
    slug: input.packageSlug,
    packageId: input.packageId,
    extension: format.extension,
  });

  try {
    await deps.upload({
      bucket: THUMBNAIL_BUCKET,
      path: storagePath,
      bytes,
      contentType: format.mimeType,
    });
  } catch {
    // Storage failed, so nothing is marked authored. The asset row is written
    // only after the bytes are durable.
    return {
      ok: false,
      code: "STORAGE_ERROR",
      message: "The generated thumbnail could not be written to Atlas storage.",
      retryable: true,
    };
  }

  const assetId = await deps.rpc("content_asset_upsert", {
    p_package: input.packageId,
    p_content_type: THUMBNAIL_CONTENT_TYPE,
    p_asset_type: THUMBNAIL_ASSET_TYPE,
    p_title: `${input.packageTitle} — thumbnail`,
    p_body: null,
    // The stored object IS the asset. A provider URL is never authoritative.
    p_storage_path: storagePath,
    p_external_url: null,
    p_external_id: null,
    p_mime_type: format.mimeType,
    p_metadata: options.metadata,
    p_provider: options.provider,
    p_status: "drafted",
  });

  const publicUrl = deps.publicUrl(storagePath);

  // The existing presentation hook: the same stored object becomes the Blog
  // hero / OG / YouTube reference. No second asset is created here.
  await deps.rpc("content_set_youtube_presentation", {
    p_package: input.packageId,
    p_youtube_url: null,
    p_youtube_video_id: null,
    p_thumbnail_url: publicUrl,
    p_seo: {},
  });

  return {
    ok: true,
    result: {
      package_id: input.packageId,
      asset_id: String((assetId as { _id?: unknown })?._id ?? ""),
      storage_path: storagePath,
      url: publicUrl,
      mime_type: format.mimeType,
      provider: options.provider,
    },
  };
}
