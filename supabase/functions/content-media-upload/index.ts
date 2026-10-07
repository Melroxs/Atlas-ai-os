// ---------------------------------------------------------------------------
// Atlas Content Studio — external media upload.
//
// Receives a thumbnail or video that was produced OUTSIDE Atlas, stores the
// bytes as a durable Atlas object, and binds them to the EXISTING logical asset
// (`youtube_thumbnail` / `youtube_video`) on an existing content package.
//
// The trust model, in order, and nothing may be reordered:
//
//   1. `atlasEdgePreflight` answers CORS before any business logic.
//   2. `requireAtlasCaller` verifies the caller's own JWT and resolves their
//      organization from THEIR OWN membership. A client-supplied organization
//      id is never read, let alone trusted.
//   3. The package is read back and its organization is compared to the
//      caller's. A member of organization A cannot upload against organization
//      B's package even with a valid package id.
//   4. The file's real type is decided from its MAGIC BYTES, never from the
//      filename or the declared MIME type.
//   5. The storage path is DERIVED here from the verified org, the package, and
//      this upload's id. No client string contributes a path segment.
//   6. The object is written, and only after the write succeeds is the asset row
//      repointed. A failed upload therefore leaves the previous asset intact.
//
// This function NEVER enqueues a publication. Uploading media makes an asset
// available; it does not approve it and does not publish it. The existing
// review → approve → publish sequence is unchanged.
// ---------------------------------------------------------------------------

import {
  AtlasAuthError,
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import {
  MANUAL_MEDIA_ASSET_TYPE,
  MANUAL_MEDIA_PROVIDER,
  MAX_UPLOAD_REQUEST_BYTES,
  MEDIA_BUCKET,
  formatMediaBytes,
  manualMediaStoragePath,
  mediaObjectKey,
  readImageDimensions,
  validateManualMedia,
  type ManualMediaKind,
} from "./media-contract.ts";

const MAX_UUID = 36;

function env(key: string): string | null {
  return Deno.env.get(key) ?? null;
}

function supabaseUrl(): string {
  return env("SUPABASE_URL") ?? "";
}

function serviceRoleKey(): string {
  const secretKeys = env("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>;
      const key = parsed.default ?? parsed.service_role ?? "";
      if (key) return key;
    } catch {
      // fall through to the legacy variable
    }
  }
  return env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_UUID &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Service-role RPC. Used only after the caller has been authorized. */
async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey(),
      Authorization: `Bearer ${serviceRoleKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    // The provider/body is not echoed: it can contain a service key in an
    // error envelope, and this string is returned to the browser.
    throw new Error(`Atlas could not complete the upload (HTTP ${response.status}).`);
  }
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

interface PackageRow {
  organizationId: string | null;
  title: string | null;
  slug: string | null;
}

interface LoadedPackage {
  package: PackageRow;
  /** The storage path the package's existing media of this kind points at. */
  previousStoragePath: string | null;
}

/**
 * The package plus its existing media, read through the EXISTING read model.
 *
 * `content_package_get` already returns the package and every one of its
 * derivative assets, and already enforces organization scoping. Reading the
 * previous object path from it means the upload path needs no new read RPC and
 * cannot drift from what the Studio itself displays.
 */
async function loadPackage(packageId: string, kind: ManualMediaKind): Promise<LoadedPackage | null> {
  const raw = await rpc("content_package_get", { p_package: packageId });
  const data = (raw ?? {}) as {
    package?: Record<string, unknown>;
    assets?: Array<Record<string, unknown>>;
  };
  const pkg = data.package;
  if (!pkg || typeof pkg !== "object") return null;

  const assetType = MANUAL_MEDIA_ASSET_TYPE[kind];
  const existing = (data.assets ?? []).find((a) => a["assetType"] === assetType);
  const previousStoragePath =
    existing && typeof existing["storagePath"] === "string" && existing["storagePath"].length > 0
      ? (existing["storagePath"] as string)
      : null;

  return {
    package: {
      organizationId: (pkg.organizationId as string | null) ?? null,
      title: (pkg.title as string | null) ?? null,
      slug: (pkg.slug as string | null) ?? null,
    },
    previousStoragePath,
  };
}

/** Percent-encode each segment, leaving the separators intact. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function removeObject(kind: ManualMediaKind, storedPath: string): Promise<void> {
  const bucket = MEDIA_BUCKET[kind];
  try {
    await fetch(
      `${supabaseUrl()}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeKey(
        mediaObjectKey(storedPath, kind),
      )}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey(),
          Authorization: `Bearer ${serviceRoleKey()}`,
        },
      },
    );
  } catch {
    // A leftover object is a storage-hygiene issue, never a reason to fail an
    // upload that has already been recorded. The asset row already points at
    // the NEW object, so the database is never left referencing a deleted one.
  }
}

/** Write bytes into Atlas storage. Throws on any non-2xx. */
async function uploadObject(input: {
  kind: ManualMediaKind;
  /** The stored Atlas path, which carries the bucket as its first segment. */
  storedPath: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<void> {
  const response = await fetch(
    `${supabaseUrl()}/storage/v1/object/${encodeURIComponent(MEDIA_BUCKET[input.kind])}/${encodeKey(
      mediaObjectKey(input.storedPath, input.kind),
    )}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey(),
        Authorization: `Bearer ${serviceRoleKey()}`,
        "content-type": input.contentType,
        // A fresh object per upload: a replacement never overwrites the bytes
        // the current asset still points at.
        "x-upsert": "false",
      },
      body: new Blob([input.bytes.slice().buffer as ArrayBuffer], {
        type: input.contentType,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Atlas storage rejected the file (HTTP ${response.status}).`);
  }
}

/** Decode the request's base64 payload into bytes. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isMediaKind(value: unknown): value is ManualMediaKind {
  return value === "thumbnail" || value === "video";
}

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = atlasEdgePreflight(request);
  if (preflight) return preflight;

  if (request.method !== "POST") {
    return atlasEdgeError("Method not allowed.", 405, atlasEdgeCorsHeaders(request));
  }

  try {
    // 1. Who is calling, and which organization do they actually belong to.
    const caller = await requireAtlasCaller(request);
    if (!caller.tenantId) {
      return atlasEdgeError(
        "Your account is not a member of any workspace yet.",
        403,
        atlasEdgeCorsHeaders(request),
      );
    }

    // 2. Reject an oversized body before parsing it. The Content-Length header
    // is a hint a client controls, so it is only used to fail fast; the decoded
    // length is what actually gates the upload.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_REQUEST_BYTES) {
      return atlasEdgeError(
        "That file is too large to upload.",
        413,
        atlasEdgeCorsHeaders(request),
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const packageId = body["packageId"];
    const kind = body["kind"];
    const uploadId = typeof body["uploadId"] === "string" ? body["uploadId"] : null;
    const fileName = typeof body["fileName"] === "string" ? body["fileName"] : null;
    const declaredMimeType =
      typeof body["declaredMimeType"] === "string" ? body["declaredMimeType"] : null;
    const externalSource =
      typeof body["externalSource"] === "string" ? body["externalSource"].slice(0, 60) : null;
    const durationSeconds = Number.isFinite(Number(body["durationSeconds"]))
      ? Number(body["durationSeconds"])
      : null;
    const data = body["data"];

    if (!isUuid(packageId)) {
      return atlasEdgeError("A valid content package is required.", 400, atlasEdgeCorsHeaders(request));
    }
    if (!isMediaKind(kind)) {
      return atlasEdgeError("Unsupported media kind.", 400, atlasEdgeCorsHeaders(request));
    }
    if (typeof data !== "string" || data.length === 0) {
      return atlasEdgeError("No file content was received.", 400, atlasEdgeCorsHeaders(request));
    }
    if (!uploadId || uploadId.length > 64) {
      return atlasEdgeError("A valid upload id is required.", 400, atlasEdgeCorsHeaders(request));
    }    // 3. Package ownership. The organization comes from the PACKAGE and is then
    //    compared with the caller's own membership, so a valid package id belonging
    //    to another organization is rejected here and nowhere else.
    const loaded = await loadPackage(packageId, kind);
    if (!loaded) {
      return atlasEdgeError("That content package could not be found.", 404, atlasEdgeCorsHeaders(request));
    }
    const pkg = loaded.package;
    if (pkg.organizationId === null) {
      return atlasEdgeError(
        "This package is not owned by a workspace, so media cannot be uploaded to it.",
        403,
        atlasEdgeCorsHeaders(request),
      );
    }
    if (pkg.organizationId !== caller.tenantId) {
      return atlasEdgeError(
        "That content package belongs to another organization.",
        403,
        atlasEdgeCorsHeaders(request),
      );
    }

    // 4. The real type, from the bytes.
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      return atlasEdgeError("That file could not be read.", 400, atlasEdgeCorsHeaders(request));
    }

    const dimensions = kind === "thumbnail" ? readImageDimensions(bytes) : null;
    const validation = validateManualMedia({
      kind,
      bytes,
      fileName,
      declaredMimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      durationSeconds,
    });
    if (!validation.ok) {
      return atlasEdgeError(validation.message, 415, atlasEdgeCorsHeaders(request));
    }

    // 5. The path, derived. Organization and package come from verified values;
    //    the only client strings are sanitized tokens.
    let storagePath: string;
    try {
      storagePath = manualMediaStoragePath({
        kind,
        organizationId: pkg.organizationId,
        packageId,
        uploadId,
        fileName: validation.fileName,
        extension: validation.type.extension,
      });
    } catch {
      return atlasEdgeError("The upload could not be prepared.", 400, atlasEdgeCorsHeaders(request));
    }

    // 6. Write, then record. The asset is repointed only after the object exists,
    //    so a failure above leaves the previous asset and its bytes untouched.
    await uploadObject({
      kind,
      storedPath: storagePath,
      bytes: validation.bytes,
      contentType: validation.type.mimeType,
    });

    const priorPath = loaded.previousStoragePath;

    const asset = (await rpc("content_asset_upsert", {
      p_package: packageId,
      p_content_type: MANUAL_MEDIA_ASSET_TYPE[kind],
      p_asset_type: MANUAL_MEDIA_ASSET_TYPE[kind],
      p_title: `${pkg.title ?? "Atlas"} — ${kind}`,
      p_body: null,
      p_storage_path: storagePath,
      // The durable Atlas object is the authority. No provider URL is stored,
      // because there is no provider: these bytes were uploaded by a person.
      p_external_url: null,
      p_external_id: null,
      p_mime_type: validation.type.mimeType,
      p_metadata: {
        source: MANUAL_MEDIA_PROVIDER,
        uploadedAt: Date.now(),
        originalFileName: validation.fileName,
        byteSize: validation.byteLength,
        byteSizeLabel: formatMediaBytes(validation.byteLength),
        mimeType: validation.type.mimeType,
        ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
        ...(durationSeconds !== null ? { durationSeconds } : {}),
        // Recorded ONLY when the user actually said where they made it. Atlas
        // never asserts a provenance it was not told.
        ...(externalSource ? { externalSource } : {}),
      },
      p_provider: MANUAL_MEDIA_PROVIDER,
      p_status: "drafted",
    })) as Record<string, unknown> | null;

    if (!asset || typeof asset["_id"] !== "string") {
      // The object exists but the asset does not. Remove the orphan so storage
      // does not accumulate bytes nothing points at. The previous asset, if any,
      // was never modified, so the package still resolves to working media.
      await removeObject(kind, storagePath);
      return atlasEdgeError(
        "The upload could not be attached to this package.",
        500,
        atlasEdgeCorsHeaders(request),
      );
    }

    // 7. The thumbnail is publication artwork: the blog hero and the Open Graph
    //    image are the SAME bytes, via the existing presentation RPC. The video
    //    is not public artwork, so it is deliberately NOT added to the
    //    presentation and gets no public URL here.
    let thumbnailUrl: string | null = null;
    if (kind === "thumbnail") {
      thumbnailUrl = `${supabaseUrl()}/storage/v1/object/public/${storagePath}`;
      await rpc("content_set_youtube_presentation", {
        p_package: packageId,
        p_youtube_url: null,
        p_youtube_video_id: null,
        p_thumbnail_url: thumbnailUrl,
        p_seo: {},
      });
    }

    // 8. Retire the previous object, now that the asset points at the new one.
    //    This runs last, and only for an object this package already owned, so
    //    the database is never left pointing at a deleted object.
    if (priorPath && priorPath !== storagePath) {
      await removeObject(kind, priorPath);
    }

    return atlasEdgeJson(
      {
        assetId: asset["_id"],
        kind,
        storagePath,
        mimeType: validation.type.mimeType,
        byteSize: validation.byteLength,
        byteSizeLabel: formatMediaBytes(validation.byteLength),
        fileName: validation.fileName,
        provider: MANUAL_MEDIA_PROVIDER,
        replaced: priorPath !== null && priorPath !== storagePath,
        ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
        ...(durationSeconds !== null ? { durationSeconds } : {}),
        thumbnailUrl,
        warning: validation.warning,
        // Explicit and server-authored: an upload never publishes anything.
        published: false,
      },
      200,
      atlasEdgeCorsHeaders(request),
    );
  } catch (error) {
    const status = error instanceof AtlasAuthError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "The upload could not be completed.";
    return atlasEdgeError(message, status, atlasEdgeCorsHeaders(request));
  }
});
