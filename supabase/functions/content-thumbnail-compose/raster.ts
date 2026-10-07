// ---------------------------------------------------------------------------
// Atlas — deterministic thumbnail compositor: rasterization
//
// WHAT THIS IS
//   The only module that knows about resvg. It initializes the inlined WASM once
//   and turns an SVG string into PNG bytes. It is deliberately thin, and it
//   performs NO I/O: no network, no filesystem, no storage, no database.
//
// WHY THE WASM IS INLINED
//   Atlas deploys Edge Functions through the Management API, whose multipart
//   walker ships only .ts/.tsx/.js/.mjs/.json files read as UTF-8. A `.wasm`
//   cannot be delivered as a static file on that path, so the binary is carried
//   as base64 text (resvg-wasm-b64.ts) and decoded at runtime. That is also why
//   `initWasm` accepts the raw bytes rather than a URL.
//
// DETERMINISM
//   System fonts are OFF (`loadSystemFonts: false`) and the embedded font is the
//   ONLY font buffer, so the glyphs cannot depend on whatever fonts happen to be
//   installed on the host. `fitTo` pins the output width, and resvg's PNG
//   encoder is deterministic for a given SVG, so identical input yields
//   byte-identical PNG bytes.
// ---------------------------------------------------------------------------

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { decodeBase64ToBytes } from "./base64.ts";
import { FONT_FAMILY, embeddedFontBuffers } from "./font.ts";
import { RESVG_WASM_BASE64 } from "./resvg-wasm-b64.ts";

export interface RasterizeResult {
  png: Uint8Array;
  width: number;
  height: number;
}

let initPromise: Promise<void> | null = null;
let wasmBytes: Uint8Array | null = null;

/**
 * Initialize the rasterizer exactly once per process.
 *
 * `initWasm` may only be called once, so concurrent callers share one promise.
 * If the module is somehow loaded twice, a redelivered "Already initialized"
 * error is treated as success rather than failing an otherwise-valid render.
 */
export function ensureResvgReady(): Promise<void> {
  if (!initPromise) {
    if (!wasmBytes) wasmBytes = decodeBase64ToBytes(RESVG_WASM_BASE64);
    initPromise = initWasm(wasmBytes).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Already initialized")) return;
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/**
 * Rasterize an SVG document to PNG bytes at the given width.
 *
 * The caller must have awaited `ensureResvgReady()`. Font resolution is pinned
 * to the embedded family so the render is host-independent.
 */
export function rasterizeSvgToPng(svg: string, width: number): RasterizeResult {
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontBuffers: embeddedFontBuffers(),
      defaultFontFamily: FONT_FAMILY,
    },
    fitTo: { mode: "width", value: width },
  });
  const image = resvg.render();
  return {
    png: image.asPng(),
    width: image.width,
    height: image.height,
  };
}
