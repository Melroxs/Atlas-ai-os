// ---------------------------------------------------------------------------
// Atlas Content Studio — browser side of the external media upload.
//
// The browser's job is deliberately small:
//
//   * read the chosen file into memory,
//   * measure what it can cheaply (pixel dimensions, duration),
//   * pre-validate with the SAME contract module the server uses, so an
//     unsupported type or an oversized file is refused instantly with an
//     actionable message instead of after a slow round trip,
//   * hand the bytes to the Edge Function.
//
// What the browser deliberately does NOT do: choose a bucket, build a storage
// path, write a `content_asset` row, or touch a publication. The organization
// is derived server-side from the caller's own session, and the storage path is
// derived server-side from the verified organization and package. There is no
// client-side code path that can place a byte outside its own package prefix.
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";
import {
  MANUAL_MEDIA_PROVIDER,
  formatMediaBytes,
  readImageDimensions,
  validateManualMedia,
  type ManualMediaKind,
  type MediaValidationError,
} from "./media-upload";

export const MEDIA_UPLOAD_FUNCTION = "content-media-upload";

export interface MediaUploadResult {
  assetId: string;
  kind: ManualMediaKind;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  byteSizeLabel: string;
  fileName: string;
  provider: typeof MANUAL_MEDIA_PROVIDER;
  /** True when this upload replaced an earlier file of the same kind. */
  replaced: boolean;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Set only for a thumbnail: the public Atlas URL now used as hero + OG. */
  thumbnailUrl: string | null;
  /** A non-fatal note about the file, e.g. it is not 2048x1152. */
  warning: string | null;
  /** Always false. An upload never publishes anything. */
  published: false;
}

/** Rejection surfaced to the UI without a network round trip. */
export class MediaUploadRejected extends Error {
  readonly reason: MediaValidationError["reason"];
  constructor(failure: MediaValidationError) {
    super(failure.message);
    this.name = "MediaUploadRejected";
    this.reason = failure.reason;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a large video does not blow the argument limit of `apply`.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Read an image's pixel dimensions in the browser.
 *
 * Used only to warn about a non-recommended size. It is deliberately allowed to
 * fail: the server re-derives the format from the bytes, so a null here can
 * never affect what is stored.
 */
function readBrowserImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

/**
 * Read a video's duration in the browser, when the container exposes one.
 *
 * Also allowed to fail: duration is recorded as metadata when available and is
 * never a reason to refuse an otherwise valid file.
 */
function readBrowserVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const finish = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => finish(null);
    // A hard ceiling: a file the browser cannot open a header for is not worth
    // blocking the upload on.
    setTimeout(() => finish(null), 4000);
    video.src = url;
  });
}

export interface UploadManualMediaInput {
  kind: ManualMediaKind;
  file: File;
  /**
   * Where the user says the file was made, e.g. "Runable". Recorded only when
   * supplied; Atlas never asserts a provenance it was not told.
   */
  externalSource?: string | null;
  /** Injectable so tests do not depend on the platform. */
  now?: () => string;
}

function newUploadId(): string {
  return crypto.randomUUID();
}

/**
 * Validate and upload one externally produced media file onto a package.
 *
 * Throws `MediaUploadRejected` when the file fails the contract locally, and a
 * plain `Error` carrying the server's message when the server refuses it.
 *
 * The package id is an explicit argument: the caller names the package it is
 * working in, and the server independently verifies that the caller is allowed
 * to write to it.
 */
export async function uploadManualMediaToPackage(
  packageId: string,
  input: UploadManualMediaInput,
): Promise<MediaUploadResult> {
  const { kind, file } = input;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const [dimensions, durationSeconds] =
    kind === "thumbnail"
      ? [await readBrowserImageSize(file), null]
      : [null, await readBrowserVideoDuration(file)];

  const dimensionsFromBytes = kind === "thumbnail" ? readImageDimensions(bytes) : null;
  const validation = validateManualMedia({
    kind,
    bytes,
    fileName: file.name,
    declaredMimeType: file.type,
    width: dimensions?.width ?? dimensionsFromBytes?.width ?? null,
    height: dimensions?.height ?? dimensionsFromBytes?.height ?? null,
    durationSeconds,
  });
  if (!validation.ok) {
    throw new MediaUploadRejected(validation);
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data, error } = await supabase.functions.invoke(MEDIA_UPLOAD_FUNCTION, {
    body: {
      packageId,
      kind,
      uploadId: (input.now ?? newUploadId)(),
      fileName: validation.fileName,
      declaredMimeType: file.type || null,
      durationSeconds,
      externalSource: input.externalSource ?? null,
      data: bytesToBase64(bytes),
    },
  });

  if (error) {
    throw new Error(error.message || "The upload could not be completed.");
  }
  const payload = data as { data?: MediaUploadResult; error?: string } | null;
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.data) throw new Error("The upload could not be completed.");
  return payload.data;
}

/** Re-exported so the UI formats sizes with the same helper the server used. */
export { formatMediaBytes };
