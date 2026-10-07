// ---------------------------------------------------------------------------
// Atlas — deterministic thumbnail compositor
//
// WHAT THESE TESTS PIN
//   The compositor is the boundary that puts an APPROVED string onto a supplied
//   background without any model in the loop. The properties that must never
//   regress are therefore:
//
//     * DETERMINISM — identical input renders byte-identical PNG bytes, so an
//       artifact can be regenerated from its inputs;
//     * EXACT TEXT  — the approved string leaves as escaped SVG data and nothing
//       rewrites it;
//     * BACKGROUND  — the supplied raster is embedded and survives the render
//       unchanged (never re-rendered, never reinterpreted);
//     * FAIL-CLOSED — every malformed input is rejected explicitly and
//       machine-readably, and no provider or URL is ever contacted.
//
//   They execute the real resvg WASM in Node, so the rasterization path itself
//   is under test, not a mock.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSITOR_ERROR,
  COMPOSITOR_VERSION,
  TARGET_HEIGHT,
  TARGET_WIDTH,
  buildSvg,
  escapeXmlText,
  parseComposeRequest,
  type ThumbnailComposeInput,
} from "../../../supabase/functions/content-thumbnail-compose/compositor";
import {
  ensureResvgReady,
  rasterizeSvgToPng,
} from "../../../supabase/functions/content-thumbnail-compose/raster";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A fixed 160x90 (16:9) PNG: top half #070d1a, bottom half #1a2748. A fixed
// fixture (not generated at runtime) is what makes the canonical hash stable.
const FIXTURE_BACKGROUND_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAA8UlEQVR4nO3RQQnAMBAAwfv1VQMxECv1r6gqQmAZGAELO8+7CJvrBRxlcJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHzdofYQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcT8ZCBwN36MljQAAAABJRU5ErkJggg==";
const FIXTURE_BACKGROUND = `data:image/png;base64,${FIXTURE_BACKGROUND_BASE64}`;
// A different, valid PNG (1x1), used to prove the background is not ignored.
const OTHER_BACKGROUND =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const FIXTURE_LINES = ["NOTHING PUBLISHES", "WITHOUT A HUMAN"];
const FIXTURE_BOTTOM_RGB = [26, 39, 72];

// The canonical hash is established from an actual render, never faked. If the
// font, resvg version or layout constants change, this value changes and the
// change must be documented rather than papered over.
const CANONICAL_SHA256 = "acd2f2c138f265408753adb65333acb46ce17a6199889fad6fd6a17cb42f5815";

function requestBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    background: { dataUri: FIXTURE_BACKGROUND },
    text: { lines: FIXTURE_LINES },
    layout: { width: TARGET_WIDTH, height: TARGET_HEIGHT },
    metadata: { contentPackageId: "2d156c39-1b17-4c07-a670-6713ef84b19b" },
    ...over,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function compose(body: unknown): Promise<Uint8Array> {
  const parsed = parseComposeRequest(body);
  if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.code}`);
  await ensureResvgReady();
  const svg = buildSvg(parsed.input);
  return rasterizeSvgToPng(svg, parsed.input.layout.width).png;
}

// ---------------------------------------------------------------------------
// A minimal PNG reader, so the rendered PIXELS can be inspected rather than
// only the bytes. Handles the 8-bit truecolor forms resvg emits, all filters.
// ---------------------------------------------------------------------------

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function decodePng(bytes: Uint8Array): DecodedPng {
  expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = readU32(bytes, offset);
    offset += 4;
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    offset += 4;
    const data = bytes.slice(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      expect(data[8]).toBe(8); // bit depth
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[p++];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = cur;
          break;
        case 1:
          value = cur + a;
          break;
        case 2:
          value = cur + b;
          break;
        case 3:
          value = cur + ((a + b) >> 1);
          break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          value = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function pixelAt(img: DecodedPng, x: number, y: number): number[] {
  const i = y * img.width * img.channels + x * img.channels;
  return Array.from(img.pixels.slice(i, i + img.channels));
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("renders identical inputs to byte-identical PNGs across three runs", async () => {
    const a = await compose(requestBody());
    const b = await compose(requestBody());
    const c = await compose(requestBody());

    expect(sha256(a)).toBe(sha256(b));
    expect(sha256(b)).toBe(sha256(c));
    expect(a.byteLength).toBe(b.byteLength);
    expect(b.byteLength).toBe(c.byteLength);
  });

  it("matches the canonical fixture hash (established from a real render)", () => {
    // Read on every run so a change to the font, rasterizer or layout constants
    // cannot pass silently.
    return compose(requestBody()).then((png) => {
      expect(sha256(png)).toBe(CANONICAL_SHA256);
    });
  });

  it("produces the supported geometry and a valid PNG signature", async () => {
    const png = await compose(requestBody());
    const img = decodePng(png);
    expect(img.width).toBe(TARGET_WIDTH);
    expect(img.height).toBe(TARGET_HEIGHT);
    // Exactly 16:9.
    expect(img.width / img.height).toBeCloseTo(16 / 9, 6);
  });
});

// ---------------------------------------------------------------------------
// Exact text
// ---------------------------------------------------------------------------

describe("exact text as data", () => {
  it("escapes every XML-sensitive character", () => {
    expect(escapeXmlText(`A & B < C > D " E ' F`)).toBe(
      "A &amp; B &lt; C &gt; D &quot; E &apos; F",
    );
  });

  it("escapes losslessly: the escaped form decodes back to the original", () => {
    const hostile = `Tom & Jerry <script>alert("x")</script> it's`;
    const escaped = escapeXmlText(hostile);
    const decoded = escaped
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(hostile);
  });

  it("renders the approved line as escaped SVG text content, unmodified", async () => {
    const parsed = parseComposeRequest(requestBody());
    expect(parsed.ok).toBe(true);
    const svg = buildSvg((parsed as { input: ThumbnailComposeInput }).input);
    for (const line of FIXTURE_LINES) {
      expect(svg).toContain(`>${line}</text>`);
    }
    expect(svg).not.toContain("&amp;amp;");
  });

  it("safely renders XML-sensitive text without producing malformed output", async () => {
    const png = await compose(
      requestBody({ text: { lines: ["A & B", "<paid>", `it's "quoted"`] } }),
    );
    const img = decodePng(png);
    expect(img.width).toBe(TARGET_WIDTH);
    expect(img.height).toBe(TARGET_HEIGHT);
  });

  it("changes the rendered bytes when the text changes", async () => {
    const a = await compose(requestBody());
    const b = await compose(requestBody({ text: { lines: ["DIFFERENT WORDS"] } }));
    expect(sha256(a)).not.toBe(sha256(b));
  });
});

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

describe("background handling", () => {
  it("embeds the supplied data URI verbatim in the SVG", () => {
    const parsed = parseComposeRequest(requestBody());
    const svg = buildSvg((parsed as { input: ThumbnailComposeInput }).input);
    expect(svg).toContain(`xlink:href="${FIXTURE_BACKGROUND}"`);
  });

  it("preserves the background through rasterization", async () => {
    const png = await compose(requestBody());
    const img = decodePng(png);
    // The scrim fades to zero opacity at the bottom edge, so the bottom row is
    // the background's bottom band, unchanged.
    const sampled = pixelAt(img, 1024, img.height - 1).slice(0, 3);
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(sampled[i] - FIXTURE_BOTTOM_RGB[i])).toBeLessThanOrEqual(3);
    }
  });

  it("produces different bytes for a different background", async () => {
    const a = await compose(requestBody());
    const b = await compose(requestBody({ background: { dataUri: OTHER_BACKGROUND } }));
    expect(sha256(a)).not.toBe(sha256(b));
  });

  it("does not scale the output geometry to the background size", async () => {
    // A 1x1 background must still yield a 2048x1152 render.
    const png = await compose(requestBody({ background: { dataUri: OTHER_BACKGROUND } }));
    const img = decodePng(png);
    expect(img.width).toBe(TARGET_WIDTH);
    expect(img.height).toBe(TARGET_HEIGHT);
  });
});

// ---------------------------------------------------------------------------
// Malformed input — every failure explicit, deterministic and machine-readable
// ---------------------------------------------------------------------------

describe("malformed input fails closed", () => {
  const cases: Array<{ name: string; body: unknown; code: string }> = [
    { name: "missing background", body: { text: { lines: FIXTURE_LINES }, layout: {} }, code: COMPOSITOR_ERROR.MISSING_BACKGROUND },
    { name: "empty background data", body: requestBody({ background: { dataUri: "" } }), code: COMPOSITOR_ERROR.MISSING_BACKGROUND },
    { name: "non-string background", body: requestBody({ background: { dataUri: 42 } }), code: COMPOSITOR_ERROR.MISSING_BACKGROUND },
    { name: "invalid data URI (no data: prefix)", body: requestBody({ background: { dataUri: "http://x/y.png" } }), code: COMPOSITOR_ERROR.INVALID_BACKGROUND_DATA_URI },
    { name: "unsupported image type (jpeg)", body: requestBody({ background: { dataUri: "data:image/jpeg;base64,AAAA" } }), code: COMPOSITOR_ERROR.UNSUPPORTED_BACKGROUND_TYPE },
    { name: "invalid base64 charset", body: requestBody({ background: { dataUri: 'data:image/png;base64,AA"BB' } }), code: COMPOSITOR_ERROR.INVALID_BACKGROUND_DATA_URI },
    { name: "valid base64 but not a PNG", body: requestBody({ background: { dataUri: "data:image/png;base64,QUJDRA==" } }), code: COMPOSITOR_ERROR.INVALID_BACKGROUND_IMAGE },
    { name: "missing text", body: { background: { dataUri: FIXTURE_BACKGROUND }, layout: {} }, code: COMPOSITOR_ERROR.MISSING_TEXT },
    { name: "empty text array", body: requestBody({ text: { lines: [] } }), code: COMPOSITOR_ERROR.MISSING_TEXT },
    { name: "whitespace-only line", body: requestBody({ text: { lines: ["   "] } }), code: COMPOSITOR_ERROR.EMPTY_TEXT },
    { name: "too many lines", body: requestBody({ text: { lines: ["a", "b", "c", "d", "e", "f", "g"] } }), code: COMPOSITOR_ERROR.TOO_MANY_LINES },
    { name: "line too long", body: requestBody({ text: { lines: ["x".repeat(121)] } }), code: COMPOSITOR_ERROR.TEXT_LINE_TOO_LONG },
    { name: "control characters in text", body: requestBody({ text: { lines: ["bad\u0000text"] } }), code: COMPOSITOR_ERROR.INVALID_TEXT_CHARACTERS },
    { name: "non-string line", body: requestBody({ text: { lines: [123] } }), code: COMPOSITOR_ERROR.MALFORMED_REQUEST },
    { name: "zero width", body: requestBody({ layout: { width: 0, height: TARGET_HEIGHT } }), code: COMPOSITOR_ERROR.INVALID_DIMENSIONS },
    { name: "negative height", body: requestBody({ layout: { width: TARGET_WIDTH, height: -1 } }), code: COMPOSITOR_ERROR.INVALID_DIMENSIONS },
    { name: "non-numeric width", body: requestBody({ layout: { width: "wide", height: TARGET_HEIGHT } }), code: COMPOSITOR_ERROR.INVALID_DIMENSIONS },
    { name: "off-target dimensions", body: requestBody({ layout: { width: 1920, height: 1080 } }), code: COMPOSITOR_ERROR.UNSUPPORTED_DIMENSIONS },
    { name: "invalid align", body: requestBody({ layout: { width: TARGET_WIDTH, height: TARGET_HEIGHT, align: "center" } }), code: COMPOSITOR_ERROR.INVALID_LAYOUT },
    { name: "invalid padding", body: requestBody({ layout: { width: TARGET_WIDTH, height: TARGET_HEIGHT, paddingPx: -5 } }), code: COMPOSITOR_ERROR.INVALID_LAYOUT },
    { name: "invalid lineHeight", body: requestBody({ layout: { width: TARGET_WIDTH, height: TARGET_HEIGHT, lineHeight: 0 } }), code: COMPOSITOR_ERROR.INVALID_LAYOUT },
    { name: "unknown top-level key still fails on missing background", body: { text: { lines: ["only text"] } }, code: COMPOSITOR_ERROR.MISSING_BACKGROUND },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name}`, () => {
      const result = parseComposeRequest(testCase.body);
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe(testCase.code);
      expect(String((result as { message: string }).message).length).toBeGreaterThan(0);
    });
  }

  it("rejects a malformed request body that is not an object", () => {
    for (const body of [null, "text", 42, [], true]) {
      const result = parseComposeRequest(body);
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe(COMPOSITOR_ERROR.MALFORMED_REQUEST);
    }
  });

  it("rejects an oversized background before decoding it", () => {
    const huge = `data:image/png;base64,${"A".repeat(3_000_000)}`;
    const result = parseComposeRequest(requestBody({ background: { dataUri: huge } }));
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe(COMPOSITOR_ERROR.BACKGROUND_TOO_LARGE);
  });

  it("surfaces a rasterization failure as a thrown error, not a silent pass", async () => {
    await ensureResvgReady();
    expect(() => rasterizeSvgToPng("<svg><not closed", TARGET_WIDTH)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never contacts the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await compose(requestBody());
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a data URI that tries to smuggle XML/quote characters", () => {
    const hostile =
      'data:image/png;base64,"/><script>alert(1)</script>';
    const result = parseComposeRequest(requestBody({ background: { dataUri: hostile } }));
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe(COMPOSITOR_ERROR.INVALID_BACKGROUND_DATA_URI);
  });

  it("rejects a data URI that smuggles a remote URL", () => {
    const result = parseComposeRequest(
      requestBody({ background: { dataUri: "data:text/html;base64,PHNjcmlwdD4=" } }),
    );
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe(COMPOSITOR_ERROR.UNSUPPORTED_BACKGROUND_TYPE);
  });

  it("does not leak internal paths or secrets in rejection messages", () => {
    const result = parseComposeRequest(requestBody({ background: { dataUri: "data:image/png;base64,AAAA" } }));
    expect(result.ok).toBe(false);
    const message = String((result as { message: string }).message);
    expect(message).not.toMatch(/\/home\/|\/Users\/|node_modules|\.ts:/);
    expect(message).not.toMatch(/token|secret|key/i);
  });

  it("exposes the compositor version for provenance", () => {
    expect(COMPOSITOR_VERSION).toBe("thumbnail-compositor-v1");
  });
});
