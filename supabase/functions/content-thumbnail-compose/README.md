# content-thumbnail-compose

Deterministic thumbnail compositor. It renders an **approved overlay string**
onto a **supplied PNG background** and returns a **2048×1152 (16:9) PNG**.

It does **not** generate, rewrite or summarize copy, does **not** contact any
provider, does **not** fetch URLs, does **not** write storage or the database,
and does **not** publish anything.

- **Version:** `thumbnail-compositor-v1`
- **Entry point:** `index.ts` (Deno `serve`)
- **Deploy:** `verify_jwt = true` (see `supabase/config.toml`)

## Contract

```ts
type ThumbnailComposeRequest = {
  background: { dataUri: string };            // data:image/png;base64,… only
  text: { lines: string[] };                  // approved text, verbatim
  layout: {
    width: number;                            // must be 2048
    height: number;                           // must be 1152
    paddingPx?: number;                       // optional, bounded
    fontSizePx?: number;                      // optional; derived when omitted
    lineHeight?: number;                      // optional, 0 < x <= 4
    align?: "upper-left" | "upper-right";
  };
  metadata?: {
    contentPackageId?: string;                // echoed into a response header
    compositorVersion?: string;               // informational; the code wins
  };
};
```

**Success:** the response body is the PNG (`Content-Type: image/png`), with
`X-Compositor-Version`, `X-Compositor-Width`, `X-Compositor-Height`,
`X-Compositor-Bytes`, `X-Compositor-Duration-Ms` and (when supplied)
`X-Content-Package-Id`.

**Failure:** `{ data: null, error, code }` with `X-Compositor-Error-Code`, where
`code` is a stable, machine-readable value from `compositor.ts`
(`MISSING_BACKGROUND`, `UNSUPPORTED_BACKGROUND_TYPE`, `UNSUPPORTED_DIMENSIONS`,
`RASTERIZATION_FAILED`, …).

## Rendering path

```
approved text ──▶ escaped SVG <text> ─┐
                                      ├─▶ resvg (inlined WASM, embedded font) ──▶ PNG
background data URI ──▶ SVG <image> ──┘
```

No model is involved at any point. The only text transformation is lossless XML
escaping, so the string that ships is the string that was approved.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Deno handler: auth, body bound, parse, compose, respond, log. |
| `compositor.ts` | Pure contract/validation + SVG builder. No I/O. |
| `raster.ts` | The only resvg-aware module: WASM init + rasterize. No I/O. |
| `font.ts` | Isolated embedded-font boundary (swap the face here). |
| `base64.ts` | Shared base64 decoder. |
| `resvg-wasm-b64.ts` | **Generated.** `@resvg/resvg-wasm@2.6.2` WASM as base64. |
| `liberation-sans-bold-b64.ts` | **Generated.** Embedded font as base64. |
| `LICENSE_LIBERATION.txt` | OFL 1.1 text for the embedded font. |

## Why the WASM is inlined

Atlas deploys Edge Functions via the Management API, whose multipart walker
collects only `.ts/.tsx/.js/.mjs/.json` files read as UTF-8 — a `.wasm` or `.ttf`
cannot ship as a static file on that path (`static_files` needs the Supabase CLI
plus Docker bundling). The assets therefore arrive as base64 text and are decoded
at runtime; `initWasm` accepts the raw bytes.

## Bundle

Measured locally with the repository's build path (esbuild, `jsr:`/`https:`
external, matching the worker):

| | Bytes |
| --- | --- |
| Bundled `index.ts` (incl. `_shared`, resvg glue, inline assets) | 3,525,747 |
| Raw source sum shipped by the Management API walker | 3,524,079 |
| Edge server-side limit | 5,242,880 |
| Headroom | ≈ 1,717,000 |

## Font

Liberation Sans Bold, unmodified — **SIL Open Font License 1.1**. Notices and the
full licence text accompany the font. See `font.ts`.

## Import resolution

`raster.ts` imports `@resvg/resvg-wasm` as a bare specifier. Local tooling
(esbuild/vitest) resolves it from `node_modules`; the Deno/Edge runtime resolves
it through `import_map.json` in this directory, which maps the bare specifier to
`npm:@resvg/resvg-wasm@2.6.2`. Deploy with:

```
bunx supabase@latest functions deploy content-thumbnail-compose \
  --project-ref <ref> \
  --import-map supabase/functions/content-thumbnail-compose/import_map.json \
  --use-api
```

This is the repository's existing mechanism: `--use-api` bundles through the
Management API (no Docker), matching how the other `_shared`-importing functions
in this project are deployed.
