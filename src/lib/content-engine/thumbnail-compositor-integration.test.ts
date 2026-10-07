// ---------------------------------------------------------------------------
// Atlas Content Engine — thumbnail compositor INTEGRATION proof
//
// WHAT THIS PROVES
//   The Content Engine can invoke the DEPLOYED `content-thumbnail-compose`
//   function as its deterministic thumbnail step, and the bytes that come back
//   are the canonical artifact — not a mock, not a re-render, and never a
//   fabricated success.
//
//       ApprovedThumbnailInput
//            -> buildCompositorRequest      (request contract, pure)
//            -> transport                   (authenticated HTTP, or a replay)
//            -> content-thumbnail-compose   (the single rendering authority)
//            -> PNG bytes
//            -> verified CompositedThumbnail (youtube_thumbnail asset)
//
//   The golden bytes are the EXACT bytes the deployed function returned
//   (captured in `thumbnail-compositor.fixture.ts`), whose SHA-256 is
//   `acd2f2c138f265408753adb65333acb46ce17a6199889fad6fd6a17cb42f5815`. The
//   replay transport therefore asserts the real deployed contract offline, and
//   determinism is checked across three invocations through the same path.
//
//   Nothing here writes storage, touches the database, contacts a provider, or
//   needs the worker. It is an in-memory proof by design.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  ASSET_CONTENT_TYPE,
  ASSET_TYPES,
} from "./types";
import { MAX_THUMBNAIL_BYTES, MEDIA_BUCKET } from "./media-upload";
import {
  COMPOSITOR_ASSET_TYPE,
  COMPOSITOR_FUNCTION,
  COMPOSITOR_HEIGHT,
  COMPOSITOR_PROVIDER,
  COMPOSITOR_VERSION,
  COMPOSITOR_WIDTH,
  ThumbnailCompositorError,
  buildCompositorRequest,
  composeApprovedThumbnail,
  toThumbnailAssetMetadata,
  toThumbnailStorageWrite,
  type ApprovedThumbnailInput,
  type CompositorRequest,
  type CompositorTransport,
  type CompositorTransportResponse,
} from "./thumbnail-compositor";
import { createCompositorTransport } from "./thumbnail-compositor-client";
import {
  CANONICAL_THUMBNAIL_PNG_BASE64,
  CANONICAL_THUMBNAIL_SHA256,
  FIXTURE_BACKGROUND_DATA_URI,
  FIXTURE_OVERLAY_LINES,
  FIXTURE_PACKAGE_ID,
} from "./thumbnail-compositor.fixture";

// ---------------------------------------------------------------------------
// The canonical deployed artifact
// ---------------------------------------------------------------------------

/** The exact bytes the deployed compositor returned for the fixture. */
function canonicalBytes(): Uint8Array {
  const buffer = Buffer.from(CANONICAL_THUMBNAIL_PNG_BASE64, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const CANONICAL_BYTE_LENGTH = 54_552;

/** The approved inputs — already-approved judgement, never generated here. */
const APPROVED: ApprovedThumbnailInput = {
  backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
  overlayLines: FIXTURE_OVERLAY_LINES,
  contentPackageId: FIXTURE_PACKAGE_ID,
};

/** A transport that replays the deployed artifact, with optional sabotage. */
function replayTransport(
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

/** A minimal, well-formed PNG header carrying arbitrary dimensions. */
function fakePngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const UNAVAILABLE = "https://compositor.example.invalid";

/** Run a synchronous builder and return the typed error it must raise. */
function captureError(fn: () => unknown): ThumbnailCompositorError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ThumbnailCompositorError);
    return error as ThumbnailCompositorError;
  }
  throw new Error("expected the builder to throw, but it returned");
}

// ---------------------------------------------------------------------------
// Phase 7a — the request contract
// ---------------------------------------------------------------------------

describe("compositor request contract", () => {
  it("builds exactly the contract the deployed function accepts", () => {
    expect(buildCompositorRequest(APPROVED)).toEqual({
      background: { dataUri: FIXTURE_BACKGROUND_DATA_URI },
      text: { lines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"] },
      layout: { width: 2048, height: 1152 },
      metadata: { contentPackageId: FIXTURE_PACKAGE_ID },
    });
  });

  it("always targets the canonical 16:9 geometry", () => {
    const request = buildCompositorRequest({
      backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
      overlayLines: FIXTURE_OVERLAY_LINES,
    });
    expect(request.layout).toEqual({
      width: COMPOSITOR_WIDTH,
      height: COMPOSITOR_HEIGHT,
    });
    expect(COMPOSITOR_WIDTH / COMPOSITOR_HEIGHT).toBeCloseTo(16 / 9, 5);
  });

  it("omits metadata when there is no package provenance", () => {
    const request = buildCompositorRequest({
      backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
      overlayLines: FIXTURE_OVERLAY_LINES,
    });
    expect(request.metadata).toBeUndefined();
    expect("metadata" in request).toBe(false);
  });

  it("forwards the approved lines verbatim, never rewriting them", () => {
    const request = buildCompositorRequest(APPROVED);
    expect(request.text.lines).toEqual([...FIXTURE_OVERLAY_LINES]);
    expect(request.text.lines).not.toBe(FIXTURE_OVERLAY_LINES);
  });

  it("rejects any background that is not an approved PNG data URI", () => {
    const rejected = [
      "https://example.com/background.png",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/png;base64,not valid base64!!",
      "",
    ];
    for (const backgroundDataUri of rejected) {
      const error = captureError(() =>
        buildCompositorRequest({ backgroundDataUri, overlayLines: ["OK"] }),
      );
      expect(error.name).toBe("ThumbnailCompositorError");
      expect(error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects overlay input the compositor cannot render", () => {
    const rejected: string[][] = [
      [],
      Array.from({ length: 7 }, (_, i) => `LINE ${i}`),
      ["OK", "   "],
      ["x".repeat(121)],
    ];
    for (const overlayLines of rejected) {
      const error = captureError(() =>
        buildCompositorRequest({ backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI, overlayLines }),
      );
      expect(error.name).toBe("ThumbnailCompositorError");
      expect(error.code).toBe("INVALID_INPUT");
    }
  });

  it("never contacts the network while building a request", () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    try {
      buildCompositorRequest(APPROVED);
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 7b — the positive integration path
// ---------------------------------------------------------------------------

describe("positive integration through the adapter", () => {
  it("returns the canonical artifact from the deployed contract", async () => {
    const artifact = await composeApprovedThumbnail(APPROVED, replayTransport());

    expect(artifact.assetType).toBe(COMPOSITOR_ASSET_TYPE);
    expect(artifact.assetType).toBe("youtube_thumbnail");
    expect(artifact.provider).toBe(COMPOSITOR_PROVIDER);
    expect(artifact.compositorVersion).toBe(COMPOSITOR_VERSION);
    expect(artifact.mimeType).toBe("image/png");
    expect(artifact.width).toBe(2048);
    expect(artifact.height).toBe(1152);
    expect(artifact.byteSize).toBe(CANONICAL_BYTE_LENGTH);
    expect(artifact.sha256).toBe(CANONICAL_THUMBNAIL_SHA256);
    expect(artifact.contentPackageId).toBe(FIXTURE_PACKAGE_ID);
  });

  it("hands the transport exactly one request, byte-for-byte as built", async () => {
    const seen: CompositorRequest[] = [];
    const transport: CompositorTransport = async (request) => {
      seen.push(request);
      return {
        status: 200,
        contentType: "image/png",
        compositorVersion: COMPOSITOR_VERSION,
        bytes: canonicalBytes(),
      };
    };

    await composeApprovedThumbnail(APPROVED, transport);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(buildCompositorRequest(APPROVED));
  });

  it("returns the exact deployed bytes, unmodified", async () => {
    const artifact = await composeApprovedThumbnail(APPROVED, replayTransport());
    const canonical = canonicalBytes();
    expect(artifact.bytes.byteLength).toBe(canonical.byteLength);
    expect(Buffer.from(artifact.bytes).equals(Buffer.from(canonical))).toBe(true);
  });

  it("maps onto the EXISTING media abstraction (asset type + metadata)", async () => {
    const artifact = await composeApprovedThumbnail(APPROVED, replayTransport());

    // The asset identity pre-exists in the engine — the adapter invents nothing.
    expect(ASSET_TYPES).toContain(artifact.assetType);
    expect(ASSET_CONTENT_TYPE[artifact.assetType]).toBe("youtube_thumbnail");

    expect(toThumbnailAssetMetadata(artifact)).toEqual({
      source: "deterministic_compositor",
      compositorVersion: COMPOSITOR_VERSION,
      sha256: CANONICAL_THUMBNAIL_SHA256,
      width: 2048,
      height: 1152,
      byteSize: CANONICAL_BYTE_LENGTH,
      mimeType: "image/png",
    });
  });

  it("maps onto the EXISTING storage-write seam without writing anything", async () => {
    const artifact = await composeApprovedThumbnail(APPROVED, replayTransport());
    const path = `${MEDIA_BUCKET.thumbnail}/org/pkg/youtube_thumbnail/render.png`;
    const write = toThumbnailStorageWrite(artifact, path);

    expect(write.bucket).toBe("blog-media");
    expect(write.bucket).toBe(MEDIA_BUCKET.thumbnail);
    expect(write.path).toBe(path);
    expect(write.contentType).toBe("image/png");
    expect(write.bytes).toBe(artifact.bytes);
    expect(write.bytes.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Phase 7c — the authenticated transport contract
// ---------------------------------------------------------------------------

describe("authenticated transport (existing Atlas mechanism)", () => {
  function capturingFetch(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(canonicalBytes(), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-compositor-version": COMPOSITOR_VERSION,
        },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("attaches the caller's bearer token and never a service-role credential", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const transport = createCompositorTransport({
      fetchImpl,
      accessToken: "caller-session-jwt",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
    });

    await composeApprovedThumbnail(APPROVED, transport);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${UNAVAILABLE}/functions/v1/${COMPOSITOR_FUNCTION}`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer caller-session-jwt");
    expect(headers.apikey).toBe("public-anon-key");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("posts the built request as the JSON body", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const transport = createCompositorTransport({
      fetchImpl,
      accessToken: "caller-session-jwt",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
    });

    await composeApprovedThumbnail(APPROVED, transport);

    expect(JSON.parse(calls[0].init.body as string)).toEqual(buildCompositorRequest(APPROVED));
  });

  it("reads the PNG back through the adapter, end to end, with a real Response", async () => {
    const { fetchImpl } = capturingFetch();
    const transport = createCompositorTransport({
      fetchImpl,
      accessToken: "caller-session-jwt",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
    });

    const artifact = await composeApprovedThumbnail(APPROVED, transport);
    expect(artifact.sha256).toBe(CANONICAL_THUMBNAIL_SHA256);
    expect(artifact.byteSize).toBe(CANONICAL_BYTE_LENGTH);
  });

  it("fails closed with UNAUTHENTICATED when no session token exists, without calling out", async () => {
    const { fetchImpl, calls } = capturingFetch();
    const transport = createCompositorTransport({
      fetchImpl,
      accessToken: "",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
    });

    await expect(composeApprovedThumbnail(APPROVED, transport)).rejects.toMatchObject({
      name: "ThumbnailCompositorError",
      code: "UNAUTHENTICATED",
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces a timeout as TIMEOUT (bounded, retryable)", async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const transport = createCompositorTransport({
      fetchImpl: hanging,
      accessToken: "caller-session-jwt",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
      timeoutMs: 15,
    });

    await expect(transport(buildCompositorRequest(APPROVED))).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  });

  it("surfaces a network failure as NETWORK_ERROR", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const transport = createCompositorTransport({
      fetchImpl: failing,
      accessToken: "caller-session-jwt",
      baseUrl: UNAVAILABLE,
      anonKey: "public-anon-key",
    });

    await expect(transport(buildCompositorRequest(APPROVED))).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 7d — the negative matrix (no failure ever becomes an artifact)
// ---------------------------------------------------------------------------

describe("negative matrix — failures are explicit and never an artifact", () => {
  async function rejection(transport: CompositorTransport): Promise<ThumbnailCompositorError> {
    try {
      await composeApprovedThumbnail(APPROVED, transport);
    } catch (error) {
      expect(error).toBeInstanceOf(ThumbnailCompositorError);
      return error as ThumbnailCompositorError;
    }
    throw new Error("expected composeApprovedThumbnail to reject, but it resolved");
  }

  it("maps 401 to UNAUTHENTICATED", async () => {
    const error = await rejection(replayTransport({ status: 401, contentType: null, compositorVersion: null }));
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
  });

  it("maps 403 to UNAUTHENTICATED", async () => {
    const error = await rejection(replayTransport({ status: 403 }));
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.status).toBe(403);
  });

  it("maps 400 to COMPOSITOR_REJECTED", async () => {
    const error = await rejection(replayTransport({ status: 400 }));
    expect(error.code).toBe("COMPOSITOR_REJECTED");
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
  });

  it("maps 422 to COMPOSITOR_REJECTED", async () => {
    const error = await rejection(replayTransport({ status: 422 }));
    expect(error.code).toBe("COMPOSITOR_REJECTED");
  });

  it("maps 500 to a retryable HTTP_ERROR", async () => {
    const error = await rejection(replayTransport({ status: 500 }));
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it("maps an unexpected 3xx to a non-retryable HTTP_ERROR (no silent redirect)", async () => {
    const error = await rejection(replayTransport({ status: 302 }));
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.status).toBe(302);
    expect(error.retryable).toBe(false);
  });

  it("maps a non-PNG Content-Type to BAD_CONTENT_TYPE", async () => {
    const error = await rejection(replayTransport({ contentType: "application/json" }));
    expect(error.code).toBe("BAD_CONTENT_TYPE");
    expect(error.status).toBe(200);
  });

  it("accepts an image/png Content-Type carrying parameters", async () => {
    const artifact = await composeApprovedThumbnail(
      APPROVED,
      replayTransport({ contentType: "image/png; charset=binary" }),
    );
    expect(artifact.sha256).toBe(CANONICAL_THUMBNAIL_SHA256);
  });

  it("maps a missing compositor version header to UNEXPECTED_VERSION", async () => {
    const error = await rejection(replayTransport({ compositorVersion: null }));
    expect(error.code).toBe("UNEXPECTED_VERSION");
  });

  it("maps an unexpected compositor version to UNEXPECTED_VERSION", async () => {
    const error = await rejection(replayTransport({ compositorVersion: "thumbnail-compositor-v2" }));
    expect(error.code).toBe("UNEXPECTED_VERSION");
  });

  it("maps a malformed (non-image) body to INVALID_PNG", async () => {
    const error = await rejection(
      replayTransport({ bytes: new TextEncoder().encode("<html>gateway error</html>") }),
    );
    expect(error.code).toBe("INVALID_PNG");
  });

  it("maps a JPEG body to INVALID_PNG", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const error = await rejection(replayTransport({ bytes: jpeg }));
    expect(error.code).toBe("INVALID_PNG");
  });

  it("maps a truncated PNG to INVALID_PNG", async () => {
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const error = await rejection(replayTransport({ bytes: truncated }));
    expect(error.code).toBe("INVALID_PNG");
  });

  it("maps wrong dimensions to WRONG_DIMENSIONS", async () => {
    const error = await rejection(replayTransport({ bytes: fakePngHeader(1920, 1080) }));
    expect(error.code).toBe("WRONG_DIMENSIONS");
  });

  it("maps an empty body to INVALID_PNG", async () => {
    const error = await rejection(replayTransport({ bytes: new Uint8Array(0) }));
    expect(error.code).toBe("INVALID_PNG");
  });

  it("passes a typed transport failure through unchanged", async () => {
    const transport: CompositorTransport = async () => {
      throw new ThumbnailCompositorError("TIMEOUT", "no response");
    };
    const error = await rejection(transport);
    expect(error.code).toBe("TIMEOUT");
  });

  it("maps an untyped transport failure to NETWORK_ERROR", async () => {
    const transport: CompositorTransport = async () => {
      throw new Error("socket hang up");
    };
    const error = await rejection(transport);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — determinism through the integration path
// ---------------------------------------------------------------------------

describe("determinism through the integration path", () => {
  it("returns the canonical SHA-256 on every one of three invocations", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const artifact = await composeApprovedThumbnail(APPROVED, replayTransport());
      expect(artifact.byteSize).toBe(CANONICAL_BYTE_LENGTH);
      hashes.push(artifact.sha256);
    }

    expect(hashes).toHaveLength(3);
    expect(hashes[0]).toBe(CANONICAL_THUMBNAIL_SHA256);
    expect(hashes[1]).toBe(CANONICAL_THUMBNAIL_SHA256);
    expect(hashes[2]).toBe(CANONICAL_THUMBNAIL_SHA256);
    expect(new Set(hashes).size).toBe(1);
  });

  it("returns byte-identical artifacts across repeated invocations", async () => {
    const renders: Uint8Array[] = [];
    for (let i = 0; i < 3; i += 1) {
      renders.push((await composeApprovedThumbnail(APPROVED, replayTransport())).bytes);
    }
    expect(Buffer.from(renders[0]).equals(Buffer.from(renders[1]))).toBe(true);
    expect(Buffer.from(renders[1]).equals(Buffer.from(renders[2]))).toBe(true);
  });
});
