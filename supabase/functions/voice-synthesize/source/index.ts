// ---------------------------------------------------------------------------
// voice-synthesize — Atlas Voice text-to-speech (ElevenLabs Speech Engine).
//
// Fills the long-standing `api.voice.synthesizeSpeech` contract in
// src/lib/api.ts. Until now that entry pointed at a function that did not
// exist, so the server-TTS path always fell back to browser speech synthesis.
//
// Voice layer ONLY. This function never reasons, never retrieves evidence and
// never executes an action: it turns Atlas's already-computed answer into
// audio. Atlas remains the brain (see conversation-converse).
//
// DEPLOYMENT CONTRACT: source/index.ts is the entry point (see
// conversation-converse/source/index.ts); the root index.ts shim keeps the
// standard Supabase CLI deploy path working.
//
// Security:
//   - ELEVENLABS_API_KEY is read from the function environment and used only
//     in the server-to-server `xi-api-key` header. It never reaches the
//     browser, localStorage, or the database.
//   - The caller's JWT is verified and the response never echoes provider
//     internals.
// ---------------------------------------------------------------------------

import {
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
  AtlasAuthError,
} from "../../_shared/edge-auth.ts";
import {
  ElevenLabsError,
  elevenLabsSynthesize,
  isElevenLabsConfigured,
} from "../../_shared/elevenlabs.ts";

/** Base64 encode without blowing the call stack on long audio buffers. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

interface SynthesizeBody {
  text?: unknown;
  voiceId?: unknown;
  previousText?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = atlasEdgePreflight(request);
  if (preflight) return preflight;

  const cors = atlasEdgeCorsHeaders(request);

  if (request.method !== "POST") {
    return atlasEdgeError("Method not allowed.", 405, cors);
  }

  try {
    const caller = await requireAtlasCaller(request);

    // An honest capability answer rather than a confusing provider error when
    // the environment simply has no key configured yet.
    if (!isElevenLabsConfigured()) {
      return atlasEdgeError(
        "Atlas Voice is not configured for this environment. Please contact support.",
        503,
        cors,
      );
    }

    const body = (await request.json().catch(() => ({}))) as SynthesizeBody;
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return atlasEdgeError("Nothing to speak.", 400, cors);
    }

    const result = await elevenLabsSynthesize(text, {
      voiceId: optionalString(body.voiceId),
      previousText: optionalString(body.previousText),
    });

    console.info("[voice-synthesize] ok", {
      user_id: caller.userId,
      organization_id: caller.tenantId,
      voice_id: result.voiceId,
      model_id: result.modelId,
      bytes: result.audio.byteLength,
      latency_ms: result.latencyMs,
    });

    return atlasEdgeJson(
      {
        mimeType: result.mimeType,
        audioB64: toBase64(result.audio),
        provider: "elevenlabs",
        voiceId: result.voiceId,
        modelId: result.modelId,
        outputFormat: result.outputFormat,
        latencyMs: result.latencyMs,
      },
      200,
      cors,
    );
  } catch (error) {
    if (error instanceof AtlasAuthError) {
      return atlasEdgeError(error.message, error.status, cors);
    }
    if (error instanceof ElevenLabsError) {
      return atlasEdgeError(error.message, error.status, cors);
    }
    console.error(
      "[voice-synthesize] unhandled:",
      error instanceof Error ? error.message : String(error),
    );
    return atlasEdgeError(
      "Atlas Voice is unavailable right now. Please try again.",
      500,
      cors,
    );
  }
});
