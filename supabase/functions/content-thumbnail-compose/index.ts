// ---------------------------------------------------------------------------
// Atlas — content-thumbnail-compose (Supabase Edge Function)
//
// WHAT THIS FUNCTION IS
//   A deterministic raster boundary. It accepts an APPROVED overlay string and a
//   supplied PNG background, and returns a 2048x1152 (16:9) PNG with the exact
//   text composited onto the exact background. The text is rendered from
//   structured data by the embedded font — no image model, no OCR, no browser
//   canvas, no model typography.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * it does not generate, rewrite or summarize copy — it renders approved input;
//   * it does not fetch anything — the background arrives as a data URI, so there
//     is no SSRF surface and no provider is contacted;
//   * it does not write storage or the database — binding the rendered artifact
//     to a content package is a separate, later integration step;
//   * it does not publish anything.
//
// WHY IT IS A SEPARATE FUNCTION
//   The rasterizer ships an inlined WASM binary and an embedded font (~3.4 MB).
//   Isolating them here keeps that weight out of the content worker, gives the
//   function its own 5 MB bundle budget, and keeps rollback and testing scoped.
//
// TRUST MODEL
//   1. CORS is answered before any business logic.
//   2. The caller's own JWT is verified and their organization resolved from
//      their own membership (`requireAtlasCaller`) — no client tenant id is read.
//   3. The body is bounded before it is parsed, and the background is a
//      magic-byte-validated PNG data URI, so the function only ever accepts
//      image bytes, never a URL to fetch and never arbitrary markup.
// ---------------------------------------------------------------------------

import {
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import {
  COMPOSITOR_ERROR,
  COMPOSITOR_VERSION,
  MAX_REQUEST_BYTES,
  buildSvg,
  parseComposeRequest,
  type CompositorErrorCode,
} from "./compositor.ts";
import { ensureResvgReady, rasterizeSvgToPng } from "./raster.ts";

/** A rejection envelope that carries a machine-readable code alongside the
 *  human message. The `{ data: null, error }` shape is unchanged, so existing
 *  clients keep working; `code` is purely additive. */
function composeError(
  message: string,
  code: CompositorErrorCode,
  status: number,
  headers: Headers,
): Response {
  const body = JSON.stringify({ data: null, error: message, code });
  const merged = new Headers(headers);
  merged.set("Content-Type", "application/json");
  merged.set("X-Compositor-Error-Code", code);
  return new Response(body, { status, headers: merged });
}

/** Metadata-only structured log. Never the approved text, never image bytes,
 *  never a credential, never a full payload. */
function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "content_thumbnail_compose", ...event }));
}

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = atlasEdgePreflight(request);
  if (preflight) return preflight;

  if (request.method !== "POST") {
    return atlasEdgeError("Method not allowed.", 405, atlasEdgeCorsHeaders(request));
  }

  const cors = atlasEdgeCorsHeaders(request);
  const started = Date.now();

  try {
    // 1. Authorization, before any work. The compositor is CPU-heavy, so it is
    //    never exposed to an anonymous caller.
    await requireAtlasCaller(request);

    // 2. Bound the body before parsing. Content-Length is a client-controlled
    //    hint and is only used to fail fast; the parsed values are re-checked.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      log({ outcome: "rejected", code: COMPOSITOR_ERROR.BACKGROUND_TOO_LARGE });
      return composeError(
        "The compose request is too large.",
        COMPOSITOR_ERROR.BACKGROUND_TOO_LARGE,
        413,
        cors,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      log({ outcome: "rejected", code: COMPOSITOR_ERROR.MALFORMED_REQUEST });
      return composeError(
        "The request body must be valid JSON.",
        COMPOSITOR_ERROR.MALFORMED_REQUEST,
        400,
        cors,
      );
    }

    // 3. Strict validation. Every failure is explicit and machine-readable.
    const parsed = parseComposeRequest(body);
    if (!parsed.ok) {
      log({
        outcome: "rejected",
        code: parsed.code,
        contentPackageId: null,
      });
      return composeError(parsed.message, parsed.code, 400, cors);
    }

    const input = parsed.input;
    const packageId = input.contentPackageId;

    // 4. Compose and rasterize. The SVG is pure data; the rasterizer has no I/O.
    let png: Uint8Array;
    let width: number;
    let height: number;
    try {
      await ensureResvgReady();
      const svg = buildSvg(input);
      const rendered = rasterizeSvgToPng(svg, input.layout.width);
      png = rendered.png;
      width = rendered.width;
      height = rendered.height;
    } catch {
      const durationMs = Date.now() - started;
      log({
        outcome: "error",
        code: COMPOSITOR_ERROR.RASTERIZATION_FAILED,
        compositor: COMPOSITOR_VERSION,
        contentPackageId: packageId,
        durationMs,
      });
      return composeError(
        "The thumbnail could not be rendered.",
        COMPOSITOR_ERROR.RASTERIZATION_FAILED,
        500,
        cors,
      );
    }

    const durationMs = Date.now() - started;
    log({
      outcome: "ok",
      compositor: COMPOSITOR_VERSION,
      contentPackageId: packageId,
      durationMs,
      width,
      height,
      bytes: png.length,
      lines: input.lines.length,
    });

    const headers = new Headers(cors);
    headers.set("Content-Type", "image/png");
    headers.set("Content-Length", String(png.length));
    headers.set("Cache-Control", "no-store");
    headers.set("X-Compositor-Version", COMPOSITOR_VERSION);
    headers.set("X-Compositor-Width", String(width));
    headers.set("X-Compositor-Height", String(height));
    headers.set("X-Compositor-Bytes", String(png.length));
    headers.set("X-Compositor-Duration-Ms", String(durationMs));
    if (packageId) headers.set("X-Content-Package-Id", packageId);

    // Hand the response a standalone ArrayBuffer. `asPng()` returns a fresh
    // buffer, and Deno's response typing requires an ArrayBuffer-like body
    // rather than a Uint8Array view.
    return new Response(png.slice().buffer as ArrayBuffer, { status: 200, headers });
  } catch (error) {
    // AtlasAuthError carries its own status; anything else is a 500 whose body
    // never echoes internals.
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    const message =
      status === 500
        ? "The request could not be completed."
        : error instanceof Error
          ? error.message
          : "The request could not be completed.";
    log({ outcome: "error", status });
    return atlasEdgeError(message, status, cors);
  }
});
