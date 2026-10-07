# Atlas — Deterministic Thumbnail Typography: Compositor Decision

**Status:** DECIDED, FEASIBILITY PROVEN, NOT IMPLEMENTED — implementation is gated on explicit authorization.
**Spike:** the chosen rasterizer was empirically validated on a real Deno runtime (see §9).
**Phase:** Atlas Content Engine, Phase 4 Remediation (provider configuration + typography readiness).
**Audience:** project operator / reviewer.

This document is the written choice required *before* any compositor dependency is added or any
compositor code is written. Nothing described below has been installed or implemented.

---

## 1. The requirement

The Article 01 thumbnail (and every thumbnail after it) must carry an **exact, pre-approved
overlay string** — for Article 01: `NOTHING PUBLISHES WITHOUT A HUMAN`.

"Exact" means:

* the string that ships is the string that was approved, byte-for-byte at the text-data level;
* the result is reproducible — the same request produces the same composed artifact;
* line breaks, position, font size, contrast and 16:9 output dimensions are predictable from the
  input, not emergent from a model;
* QA never depends on a generative model spelling or rendering text correctly.

"Deterministic" therefore excludes the current mechanism by definition.

## 2. What exists today

| Layer | File | Behaviour |
| --- | --- | --- |
| Thumbnail brief | `src/lib/content-engine/copy.ts` (`buildThumbnailBrief`, `toOverlayText`) | Computes `overlayText` (≤4 words, no digits) and puts it **into the prompt**: `Render the exact text "…" in clean, high-contrast type.` |
| Provider render | `supabase/functions/content-engine-worker/thumbnail.ts` (`generateThumbnail`) | POSTs the prompt to the image provider, validates/decodes the returned bytes, and returns them. **The bytes are stored as-is.** |
| Storage | worker `content_generate_thumbnail` case | Writes the provider bytes to `blog-media` under `<orgId>/<packageId>/thumbnail/…`. |

There is **no compositing step**. The only mechanism that puts text on the thumbnail today is an
instruction inside the prompt, i.e. the model's own typography.

There is **no image-processing library in the project**:

* `package.json` contains no `sharp`, `jimp`, `canvas`, `@napi-rs/canvas`, `imagescript`, `resvg`,
  `svg2img`, `text-to-svg`, `pureimage` or equivalent.
* `@zumer/snapdom` is listed as a dependency but is **not referenced anywhere in `src`** — it is a
  dead dependency, not a usable capability.

So: no deterministic compositor exists, and no existing dependency provides one.

## 3. What DOES already exist and is reusable

`src/lib/blog/visuals.ts` is an **in-repo, dependency-free, deterministic composition engine**:

* `renderAtlasArtwork(motif, seed, "hero" | "social")` emits a complete standalone SVG string.
* Determinism is explicit and deliberate — a hash-based PRNG (`seededUnit`) is used instead of
  `Math.random`, so the same article always yields byte-identical output.
* It renders **exact text as data** via SVG `<text>` elements, and it escapes/derives all geometry
  from fixed relative units (`w * 0.16`, `h * 0.04`, …), not from font metrics.
* It is already the production source of the current article artwork: `scripts/seed-blog-articles.mjs`
  imports it and uploads `<slug>/hero.svg` and `<slug>/social.svg` to the public `blog-media` bucket.
  Those are the placeholder assets currently referenced by the 20 published articles.

This is the "existing supported image-processing capability" this phase was asked to look for, and it
is the correct foundation: the deterministic text layer does not need to be invented.

## 4. The constraint that decides the output format

The composed artifact has two consumers, and they do not accept the same format:

| Consumer | Path | Accepted formats |
| --- | --- | --- |
| Blog hero / social card | `blog-media` bucket (public) | `image/svg+xml`, `image/png`, `image/jpeg`, `image/webp`, `image/avif` — **SVG is already in use here** |
| YouTube video thumbnail | `supabase/functions/content-engine-worker/index.ts` → `content_publish_youtube`, which `fetch`es the stored thumbnail URL and POSTs its bytes to `https://www.googleapis.com/upload/youtube/v3/thumbnails/set` | **JPEG / PNG only** |

Consequence: an SVG-only compositor is sufficient for the blog, but it **cannot** satisfy the
`youtube_thumbnail` asset contract — YouTube rejects SVG. The composited artifact must therefore be
**raster**, or rasterized before it reaches the YouTube publish step.

## 5. Options considered

Runtime constraints: the media worker runs as a **Supabase Edge Function (Deno)**. Native N-API
modules cannot load there, and the build host is Node-only (no `apt`/`pip`/`uv`, and uploaded files
lose their executable bit).

| # | Option | Determinism | Edge-runtime fit | Cost | Verdict |
| --- | --- | --- | --- | --- | --- |
| A | Extend `src/lib/blog/visuals.ts` technique → SVG output | Full: exact `<text>`, fixed geometry, no randomness | Exact (pure string building) | Zero deps | **Insufficient alone** — blog only; YouTube needs raster |
| B | A + rasterize the composed SVG with `@resvg/resvg-wasm` | Full: same SVG → same PNG, byte-identical on Node and Deno | **PROVEN** (§9): WASM inlined as base64 — no asset loaders, no `static_files`, no native modules | 1 dependency (MPL-2.0) + 2 inlined assets, 3.35 MB bundle | **Recommended — spike passed** |
| C | `imagescript` (pure TypeScript) | High: `Image.renderText` vector fonts, deterministic | Deno-compatible | 6.6 MB package (ships its own WASM codecs); font handling is on us; license is `(AGPL-3.0-or-later OR MIT)` — the MIT branch is usable but warrants a legal check | Fallback only |
| D | `sharp` / `@napi-rs/canvas` / node-canvas | Full | **Not loadable on Supabase Edge** (native N-API). Requires moving compositing to a separate Node host | High operational cost | Rejected |
| E | Hand-rolled PNG decode + encode + embedded bitmap font | Full | Exact | Zero deps, but requires implementing PNG inflate/unfilter and a font, and yields visibly pixelated type at 2048×1152 | Rejected: high risk, poor brand result |
| F | Client-side: render the composed SVG in the Content Studio, rasterize to PNG, upload through the already-deployed `content-media-upload` / manual-media path | Layout exact; raster bytes vary by the browser's font rasterizer (per-environment, not global) | No new server dependency at all | Zero deps, reuses authorized Phase 1/2 paths | Fallback if B's bundle spike fails |

## 6. Decision

**Chosen architecture (primary):**

```
image model  →  background image, generated WITHOUT text
             →  deterministic compositor:
                  • builds an SVG using the existing visuals.ts technique
                    (fixed relative geometry, deterministic line breaks,
                     deterministic font size, fixed font stack, fixed scrim)
                  • embeds the exact approved overlay text as DATA (XML-escaped <text>)
             →  rasterize deterministically (resolution + font pinned) to PNG
             →  final thumbnail bytes
             →  storage (blog-media)
             →  database linkage (youtube_thumbnail asset, existing path)
```

**Chosen foundation:** `src/lib/blog/visuals.ts` (reuse the deterministic technique; do not
re-invent it, and do not replace it).
**Chosen rasterizer:** `@resvg/resvg-wasm` + one bundled font file — *subject to a feasibility spike*,
because bundling a `.wasm` asset and a font into a Supabase Edge Function bundle is not yet proven in
this project.
**Documented fallback if the spike fails:** option F (client-side rasterization through the already-authorized
manual-media upload path), accepting per-environment raster variance with the layout still deterministic.

**Property guarantees this architecture provides:**

* overlay text is passed as data and is never hard-coded (Article 01's string is not special-cased);
* identical input → identical output; no `Math.random`, no wall-clock, no locale-dependent formatting;
* line breaking, position, font size, contrast and 16:9 dimensions are computed, not emergent;
* contrast is guaranteed by a fixed scrim behind the text, so it is independent of the background image;
* no LLM is used to validate the rendered text;
* the background prompt will explicitly forbid the model from drawing text, so no model typography is
  ever relied upon for compliance.

## 7. Authorization required before implementation

None of the following has been done:

1. No dependency installed (`@resvg/resvg-wasm` or `imagescript`).
2. No compositor module written.
3. No font asset added.
4. No worker step changed.
5. No prompt changed to remove the model-typography instruction.

Before implementation proceeds, the operator must authorize **one** of:

* **(B)** adding `@resvg/resvg-wasm` plus a bundled font, after a bundling spike proves both load in the
  deployed Edge Function; or
* **(C)** adding `imagescript` plus a bitmap font; or
* **(F)** the client-side rasterization route (no new dependency).

## 8. Interaction with provider readiness

This decision is independent of the two provider blockers:

* `VIDEO_PROVIDER_API_KEY` is absent → PixVerse cannot run (`PIXVERSE_PROVIDER_BLOCKED`).
* The OpenAI image project has no usable credit → `OPENAI_IMAGE_PROVIDER_BLOCKED_BY_CREDIT`.

Even with a compositor in place, no thumbnail background can be produced until the image provider has
usable credit, and no video can be produced until the video credential exists.

## 9. Feasibility spike results (rasterization only)

No production file, dependency, database row or media object was touched. The spike ran in a throwaway
`.tmp-spike/` directory that was deleted afterwards; a real Deno binary was installed into that
directory only.

**Runtime facts (authoritative).** Supabase Edge Functions officially support WebAssembly
(`supabase.com/docs/guides/functions/wasm`). Shipping a `.wasm` as a **static file** requires Supabase
CLI ≥ 2.7.0 **and local Docker bundling** — it is explicitly *not* supported on the CLI's API path.
Atlas deploys via the Management API (`scripts/deploy-blog-sitemap.mjs` pattern), and that deployer's
walker collects only `.ts|.tsx|.js|.mjs|.json` as UTF-8 text — so **a `.wasm` or `.ttf` cannot be
shipped as a file at all through Atlas's deploy path**. Server-side bundling is capped at **5 MB**
(local Docker bundling would allow 20 MB).

Therefore the rasterizer must be shipped as **base64 inlined in a `.ts` module**. That is what was tested.

**Measured results** (`@resvg/resvg-wasm@2.6.2`, one bundled font):

| Measurement | Result |
| --- | --- |
| WASM binary raw / base64 source | 2,478,606 B / 3,304,808 chars |
| Bundled font raw / base64 source | 137,052 B / 182,736 chars |
| Spike bundle (no asset loaders) | 3,508,099 B (3.35 MB) |
| Current worker local bundle (remote `jsr:` deps external) | 78,520 B |
| Projected worker bundle with assets inlined | ≈ 3.40 MB (1.60 MB headroom under the 5 MB limit, before server-resolved deps such as supabase-js) |
| End-to-end render (background data-URI + exact text → 2048×1152 PNG) | valid PNG, 78,690 B, exact 16:9 |
| Determinism | 3 consecutive renders byte-identical |
| **Node vs Deno output** | **identical sha256 (`dc1286f1…`)** — byte-for-byte reproducible across runtimes |
| Render time | 55–180 ms |
| Exact text as data | confirmed present in the composed SVG (`NOTHING PUBLISHES` / `WITHOUT A HUMAN`) |
| Embedded raster background | decoded and composited correctly by the WASM |

**Verdict:** option **B is feasible and proven.** Inlining base64 makes the approach independent of the
bundler, of `static_files`, and of Docker — which is the only variant that fits Atlas's actual deploy
path. Native options (D) remain impossible; `imagescript` (C) is a viable but heavier fallback.

**What this spike does NOT prove.** The spike ran on Deno 2.9.6 locally, not on the deployed Edge
runtime (documentation states production is on Deno 1.46 with Deno 2.1 rolling out; `WebAssembly`,
`atob` and `Uint8Array` are stable on both, so the risk is low). The Management API's server-side
bundler may also differ from local esbuild. The definitive confirmation is deploying a throwaway
function, which is a production change and was not authorised for this spike. A production font must
also be chosen and its redistribution licence checked (the spike used Liberation Sans).

## 10. Implementation record (compositor built, NOT deployed)

Option **B** was implemented in the isolated Edge Function
`supabase/functions/content-thumbnail-compose/` (version `thumbnail-compositor-v1`). Nothing was
deployed, no production media was generated, and the content-engine publishing flow was not touched.

**Font decided.** Liberation Sans Bold, **unmodified**, under the **SIL Open Font License 1.1**
(copyright (c) 2010 Google Corporation — Reserved Font Names Arimo, Tinos, Cousine; (c) 2012 Red Hat,
Inc. — Reserved Font Name Liberation). OFL 1.1 permits embedding and redistribution alongside
software given the notice and licence accompany the font, the font is not sold alone, and no modified
version uses a Reserved Font Name — all satisfied. The licence text ships as
`LICENSE_LIBERATION.txt`, and font loading is isolated in `font.ts` so the face is replaceable.

The spike's font was therefore confirmed as a legitimate production choice rather than a placeholder.

**Dependency.** Exactly one new dependency: `@resvg/resvg-wasm@2.6.2` (MPL-2.0). Its WASM is inlined
as base64 in `resvg-wasm-b64.ts`; the font is inlined in `liberation-sans-bold-b64.ts`.

**Measured bundle.** 3,525,747 bytes bundled (esbuild, `jsr:`/`https:` external), against a 5,242,880
byte server-side limit — ≈1,717,000 bytes (1.64 MB) of headroom. The raw source sum the Management
API walker ships is 3,524,079 bytes.

**Canonical fixture hash — CHANGED, and why.** The new determinism fixture hashes to

```
acd2f2c138f265408753adb65333acb46ce17a6199889fad6fd6a17cb42f5815
```

This is **not** the spike's `dc1286f1…`, and the difference is expected and documented rather than
forced: the spike's throwaway directory (and therefore its exact SVG template, its background fixture
and its layout arithmetic) was deleted, so its bytes cannot be reproduced. The implementation uses its
own documented layout (deterministic padding, a derived font size, a fixed scrim) and its own fixed
160×90 background fixture. The new hash is established from a real render and is the expected test
value; a change to the font, the rasterizer version or the layout constants will change it and must be
re-recorded, never faked.

**Determinism confirmed in the test suite.** Three consecutive renders produce identical SHA-256 and
identical byte length; the output is a valid 2048×1152 PNG (exactly 16:9); the approved text is
present as escaped SVG data; the supplied background survives rasterization (a bottom-row pixel equals
the fixture's bottom band); and no network call is made.

**One deployment prerequisite remains (out of scope).** `raster.ts` imports `@resvg/resvg-wasm` as a
bare specifier, which resolves locally but must resolve on the Edge runtime (an `npm:` specifier or an
import map). This is a first-deploy concern, not part of the implementation phase.

## 11. Controlled Edge deployment proof (2026-10-01)

The compositor was deployed to project `ibxvzxblyhzwokljkslt` as the **only** function changed, via the
repository's existing mechanism (`supabase functions deploy ... --use-api`, i.e. Management-API bundle),
with `verify_jwt = true`. Result: `status=ACTIVE`, `updated_at=2026-10-01T05:45:19Z`.

**Import resolution.** `raster.ts` keeps the bare `@resvg/resvg-wasm` specifier (resolved from
`node_modules` locally); `import_map.json` in the function directory maps it to
`npm:@resvg/resvg-wasm@2.6.2` for the Deno/Edge runtime — the smallest change, keeping local
tooling working. Verified locally with `deno check --import-map ...` before deploying.

**Runtime proof.** A live invocation of the canonical fixture returned HTTP 200, `image/png`,
2048x1152, 54,552 bytes, and SHA-256

```
acd2f2c138f265408753adb65333acb46ce17a6199889fad6fd6a17cb42f5815
```

— byte-identical to the local canonical hash. Cold ~1.6 s, warm ~1.1-2.0 s.

**Failures verified on the deployed runtime:** unauthenticated -> 401 (gateway). Malformed JSON,
missing background/text, JPEG/WebP/SVG/HTML/URL backgrounds, malformed base64, XML-sensitive payloads,
non-PNG bytes, off-target dimensions, too many lines, over-long lines and control characters -> HTTP
400 with the matching `code`. An oversized background (>2 MB) -> 400 `BACKGROUND_TOO_LARGE`.

**No production side effects:** row/object counts unchanged from the pre-deploy baseline (content items
24, published blog 20, publications 0, provenance 0, storage objects 5551, blog-media 41, content-media 1);
the deployed bundle contains no storage/RPC write markers. No migration, no media generation, no
publishing, no provider call, and no commit/push/merge.

## 12. Content-engine integration proof (2026-10-01)

Proves the Content Engine can drive the **deployed** compositor as its deterministic thumbnail step,
without wiring it into the worker and without any storage/database write.

**The seam.** `src/lib/content-engine/thumbnail-compositor.ts` is a pure adapter: it turns
already-approved inputs into the compositor request, hands that request to an injected transport (the
only I/O), verifies status, `Content-Type`, `X-Compositor-Version`, the PNG signature and the
2048x1152 geometry, hashes the exact bytes, and maps the result onto the EXISTING `youtube_thumbnail`
asset (plus the existing `content_asset_upsert` metadata shape and the `blog-media` storage-write
shape). It renders nothing, rewrites no copy, and fetches no URL.

**Authentication.** `src/lib/content-engine/thumbnail-compositor-client.ts` invokes the function the
same way the shipped `content-media-upload` function is invoked: the caller's Supabase session JWT in
`Authorization`, the public anon key in `apikey`, a bounded (30 s) request. No credential is
hardcoded, the service-role key is never used, and JWT verification is not disabled.

**Determinism.** Three invocations through the integration path produce the same SHA-256 on every
render:

```
acd2f2c138f265408753adb65333acb46ce17a6199889fad6fd6a17cb42f5815
```

**One adapter bug found and fixed.** The adapter passed a `kind` argument to `sniffImageMedia`, which
takes only the bytes; the extra argument made the PNG check read the string `"thumbnail"` and reject
every valid response as `INVALID_PNG`. The integration test caught it; the call is now
`sniffImageMedia(bytes)`.

**No production side effects:** storage counts unchanged (`storage.objects` 5551, `blog-media` 41,
`content-media` 1). No migration applied, no article generated, no publishing, no worker run, no
provider call, and no commit/push/merge.

## 13. Worker orchestration proof (2026-10-01)

Proves the EXISTING worker media step can orchestrate the proven adapter as an alternative renderer.
No new queue, job type, state machine, asset identity or schema change — and no deployment.

**What changed in code (all additive).** `supabase/functions/content-engine-worker/thumbnail.ts`:

1. `THUMBNAIL_COMPOSITOR_PROVIDER = "deterministic_compositor"` — the honest label for Atlas-rendered
   bytes, matching the adapter's `COMPOSITOR_PROVIDER`.
2. A `ThumbnailRenderer` selector on the step input. Absent/undefined keeps the generative-provider
   path **byte-for-byte unchanged**, so no production behaviour changes: nothing deployed selects
   the compositor.
3. `composeCanonicalThumbnail` — the compositor branch. It reuses the tenant precondition and
   `hasUsableThumbnail` idempotency check that already run above it, is bounded by the SAME image
   deadline with the same abort, and forwards the approved overlay lines verbatim.
4. `persistThumbnail` — the persistence tail, extracted so BOTH renderers share ONE implementation
   (one bucket, one deterministic path, one `youtube_thumbnail` asset, one presentation hook).
   Behaviour-preserving: the existing 40 thumbnail tests still pass unchanged.

The renderer arrives through an INJECTED `deps.composeThumbnail`, not an import, because a Supabase
Edge bundle cannot import from `src/`. The adapter's typed errors become the step's typed failures
directly — no translation table was invented.

**Idempotency.** Executing the same job twice: run 1 renders (1 compose, 1 upload, 1 object, 1
asset row); run 2 returns `reused: true` with **zero** renders, uploads and objects. An explicit
`regenerate` does re-render, but into the SAME derived path, so it overwrites rather than
accumulating.

**Failure after external success.** With the bytes stored and `content_asset_upsert` failing, the
rejection propagates (the worker loop records it as retryable INTERNAL — never as success), no asset
row exists, and the retry rewrites the SAME object: 1 object, 1 asset. No orphan.

**Approval gating — reported, not changed.** The engine generates media BEFORE review by design
(`nextWorkflowStep` orders `thumbnail` ahead of `review`) and gates PUBLISHING instead
(`canPublish`, and the worker's `stepPublish`). The compositor renderer changes nothing about that:
a composited thumbnail confers no approval, and an unapproved package still cannot publish. Adding
a generation-time approval gate WOULD have changed existing production behaviour, so it was not done.

**Verification:** `bun tsc -b --noEmit` clean; a standalone strict `tsc` pass over the Edge-side
module (which `tsconfig.app.json` does not cover) clean — it caught and fixed one real narrowing
error; `src/lib/content-engine` 423/423 (21 new); full suite 3191 passed / 5 skipped / 1
pre-existing failure (`edge-functions-integrity` → `integrations-oauth`). No deployment, no job, no
migration, no storage write, no commit/push/merge.

## 14. Thumbnail input contract audit (2026-10-01)

Read-only audit of where authoritative compositor inputs should live. Result: **MISSING CONTRACT.**

**What exists.** `atlasContentItems` is one table holding both content-item lifecycle state and
assets (children via `parentContentId`). A repo-wide search for `backgroundDataUri`, `overlayLines`,
`background_image`, `overlay_lines`, `thumbnailLayout`, `renderer` finds them ONLY in the adapter,
the compositor, the fixture and the tests — never in a package field, an asset field, a job payload
or a metadata convention. `ASSET_TYPES` has no background/hero-background type;
`atlasContentAutomation` (the org settings that could carry a renderer preference) has no renderer
column. `content_package_get` does return the whole package row, so `metadata` jsonb is readable by
the worker — but `metadata` is today an OUTPUT-provenance channel (`content_asset_upsert` writes
render identity into it), and writing declared inputs into the same blob would mix directions.

**What is missing.**

- `MISSING CONTRACT: an approved overlay-copy contract.` No field anywhere holds per-thumbnail
  approved lines. `imagePrompt` is a generative-provider brief and must never be used as overlay
  copy; deriving copy from `title` is inventing marketing language.
- `MISSING CONTRACT: an approved background-image contract.` No approved background exists as an
  asset. The only stored image in the project is the Article 01 thumbnail, which is the step's
  OUTPUT, not an input. Producing one would need an image-generation provider, which is a separate
  phase.
- Consequence: the compositor cannot be driven from package data today without inventing values.

**Worker wiring (implemented, additive, undeployed).** `readThumbnailRenderer` in `thumbnail.ts`
parses and validates `job.payload.renderer`; `stepGenerateThumbnail` in `index.ts` now reads it and
passes it to `generateThumbnail`. An absent `renderer` names no renderer, so the generative provider
stays the default. An UNKNOWN renderer now fails closed with a typed, non-retryable `VALIDATION`
instead of falling through to the provider — previously an unrecognised kind would have silently
substituted a paid model call for a requested deterministic render.

**Article 01 publication state explained.** `status = published` + `publishTarget = atlas_blog` +
`publishedAt` is the ATLAS-INTERNAL content lifecycle: `src/lib/blog/queries.ts` reads the live blog
straight from `atlasContentItems`, and the platform state machine gates `approved → published`.
`atlasContentPublications` is a DIFFERENT thing — the content-engine per-destination channel ledger
(`blog`/`youtube`/`linkedin`) written only by `stepPublish`, with leases and external ids. Article 01
has never been published through that flow, so zero rows is expected, not an inconsistency.
