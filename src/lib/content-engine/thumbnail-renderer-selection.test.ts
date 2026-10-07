// ---------------------------------------------------------------------------
// Atlas Content Engine — thumbnail RENDERER SELECTION
//
// WHAT THESE TESTS PIN
//   A job may name the renderer that produces the canonical thumbnail, and the
//   step must obey that name EXACTLY:
//
//     * no renderer named      -> the existing generative provider (UNCHANGED)
//     * "image_provider"       -> the existing generative provider (UNCHANGED)
//     * "compositor"           -> the deterministic compositor
//     * anything else          -> an explicit, typed, non-retryable refusal
//     * compositor, not wired  -> NOT_CONFIGURED, never a silent fallback
//
//   The property that matters most is the one a "helpful" implementation would
//   get wrong: an UNKNOWN renderer must fail closed. Treating it as "not a
//   compositor" would quietly route a job that asked for a free deterministic
//   render into a paid generative provider — a substitution that is invisible
//   in the job result and impossible to notice later.
//
//   Pure functions and synthetic payloads only: no package, no storage, no
//   database, no provider, no network.
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_RENDERER_KINDS,
  generateThumbnail,
  readThumbnailRenderer,
  type ComposeThumbnailFn,
  type ThumbnailDeps,
} from "../../../supabase/functions/content-engine-worker/thumbnail";
import {
  FIXTURE_BACKGROUND_DATA_URI,
  FIXTURE_OVERLAY_LINES,
} from "./thumbnail-compositor.fixture";

const TENANT = "7c9e1b30-5a2d-4f18-9c63-2d4e6f8a1b20";
const PACKAGE = "3f2a7c10-9d41-4c8e-9a55-0b7c1d2e3f44";

/** A one-pixel PNG: real magic bytes, no rendering involved. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

function compositorPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    renderer: {
      kind: "compositor",
      backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
      overlayLines: [...FIXTURE_OVERLAY_LINES],
      ...over,
    },
  };
}

interface Recorder {
  deps: ThumbnailDeps;
  composed: number;
  providerCalls: number;
}

function recorder(options: { compose?: ComposeThumbnailFn | undefined } = {}): Recorder {
  const rec: Recorder = { deps: null as unknown as ThumbnailDeps, composed: 0, providerCalls: 0 };
  const compose: ComposeThumbnailFn =
    options.compose ??
    (async () => {
      rec.composed += 1;
      return {
        ok: true,
        artifact: {
          bytes: TINY_PNG,
          sha256: "0".repeat(64),
          width: 2048,
          height: 1152,
          byteSize: TINY_PNG.byteLength,
          mimeType: "image/png",
        },
      };
    });

  rec.deps = {
    env: { get: () => null },
    transport: async () => {
      rec.providerCalls += 1;
      // No image provider is configured, so the provider path must already have
      // refused before this could ever run.
      throw new Error("the generative provider must not be reached");
    },
    upload: async () => {},
    publicUrl: (p) => `https://project.supabase.co/storage/v1/object/public/${p}`,
    rpc: async (name) => (name === "content_asset_upsert" ? { _id: "asset-1" } : null),
    timeoutMs: 1_000,
    composeThumbnail: compose,
  };
  return rec;
}

function stepInput(renderer: unknown): Parameters<typeof generateThumbnail>[0] {
  return {
    packageId: PACKAGE,
    tenantId: TENANT,
    packageOrganizationId: TENANT,
    packageTitle: "Synthetic",
    packageSlug: "synthetic",
    imagePrompt: null,
    articleTitle: null,
    brandVoice: null,
    existing: null,
    regenerate: false,
    renderer,
  } as Parameters<typeof generateThumbnail>[0];
}

// ---------------------------------------------------------------------------
// Reading the renderer out of an untrusted payload
// ---------------------------------------------------------------------------

describe("reading the renderer from a job payload", () => {
  it("names no renderer when the payload has none", () => {
    expect(readThumbnailRenderer({ package_id: PACKAGE })).toEqual({ ok: true });
    expect(readThumbnailRenderer({ package_id: PACKAGE, renderer: null })).toEqual({ ok: true });
    expect(readThumbnailRenderer(null)).toEqual({ ok: true });
    expect(readThumbnailRenderer(undefined)).toEqual({ ok: true });
  });

  it("reads an explicit image_provider", () => {
    expect(readThumbnailRenderer({ renderer: { kind: "image_provider" } })).toEqual({
      ok: true,
      renderer: { kind: "image_provider" },
    });
  });

  it("reads a well-formed compositor request", () => {
    const read = readThumbnailRenderer(compositorPayload());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.renderer).toEqual({
      kind: "compositor",
      backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
      overlayLines: ["NOTHING PUBLISHES", "WITHOUT A HUMAN"],
    });
  });

  it.each([
    ["an unknown renderer name", { kind: "openai" }],
    ["a typo", { kind: "compositer" }],
    ["a missing kind", { backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI }],
    ["a missing background", { kind: "compositor", overlayLines: ["A"] }],
    ["an empty background", { kind: "compositor", backgroundDataUri: "   ", overlayLines: ["A"] }],
    ["no overlay lines", { kind: "compositor", backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI }],
    [
      "a non-string overlay line",
      {
        kind: "compositor",
        backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI,
        overlayLines: ["ok", 7],
      },
    ],
    ["overlay lines that are not an array", { kind: "compositor", backgroundDataUri: FIXTURE_BACKGROUND_DATA_URI, overlayLines: "A" }],
  ])("refuses %s", (_label, renderer) => {
    const read = readThumbnailRenderer({ renderer });
    expect(read).toMatchObject({ ok: false, code: "VALIDATION", retryable: false });
  });

  it("refuses a renderer that is not an object", () => {
    expect(readThumbnailRenderer({ renderer: "compositor" })).toMatchObject({ ok: false });
    expect(readThumbnailRenderer({ renderer: ["compositor"] })).toMatchObject({ ok: false });
  });

  it("names exactly the two supported renderers", () => {
    expect(THUMBNAIL_RENDERER_KINDS).toEqual(["image_provider", "compositor"]);
  });
});

// ---------------------------------------------------------------------------
// What the step does with it
// ---------------------------------------------------------------------------

describe("the step obeys the renderer it was given", () => {
  it("uses the deterministic compositor when the payload asks for it", async () => {
    const rec = recorder();
    const read = readThumbnailRenderer(compositorPayload());
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const outcome = await generateThumbnail(stepInput(read.renderer), rec.deps);

    expect(outcome.ok).toBe(true);
    expect(rec.composed).toBe(1);
    expect(rec.providerCalls).toBe(0);
  });

  it("keeps the generative provider as the default when no renderer is named", async () => {
    const rec = recorder();
    const read = readThumbnailRenderer({ package_id: PACKAGE });
    expect(read.renderer).toBeUndefined();

    const outcome = await generateThumbnail(stepInput(read.renderer), rec.deps);

    // No provider is configured in this world, so the provider path refuses —
    // which is exactly the pre-existing default behaviour.
    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED", retryable: false });
    expect(rec.composed).toBe(0);
    expect(rec.providerCalls).toBe(0);
  });

  it("keeps the generative provider when image_provider is named explicitly", async () => {
    const rec = recorder();
    const read = readThumbnailRenderer({ renderer: { kind: "image_provider" } });

    const outcome = await generateThumbnail(stepInput(read.renderer), rec.deps);

    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED", retryable: false });
    expect(rec.composed).toBe(0);
  });

  it("refuses an unknown renderer instead of falling back to the provider", async () => {
    const rec = recorder();

    const outcome = await generateThumbnail(
      stepInput({ kind: "some_other_renderer" } as never),
      rec.deps,
    );

    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION", retryable: false });
    // The critical assertion: a substitution did NOT happen.
    expect(rec.composed).toBe(0);
    expect(rec.providerCalls).toBe(0);
  });

  it("reports NOT_CONFIGURED when the compositor is selected but not wired", async () => {
    const rec = recorder({ compose: undefined as unknown as ComposeThumbnailFn });
    rec.deps.composeThumbnail = undefined;

    const read = readThumbnailRenderer(compositorPayload());
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const outcome = await generateThumbnail(stepInput(read.renderer), rec.deps);

    expect(outcome).toMatchObject({ ok: false, code: "NOT_CONFIGURED", retryable: false });
    expect(rec.providerCalls).toBe(0);
  });

  it("stores the compositor's real bytes, not a fabricated artifact", async () => {
    const uploaded: Uint8Array[] = [];
    const rec = recorder();
    rec.deps.upload = async ({ bytes }) => {
      uploaded.push(bytes);
    };

    const read = readThumbnailRenderer(compositorPayload());
    if (!read.ok) return;
    await generateThumbnail(stepInput(read.renderer), rec.deps);

    expect(uploaded).toHaveLength(1);
    expect(Buffer.from(uploaded[0]).equals(Buffer.from(TINY_PNG))).toBe(true);
  });
});
