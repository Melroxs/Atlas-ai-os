// ---------------------------------------------------------------------------
// voice-transcribe — Atlas Voice speech-to-text (ElevenLabs Scribe).
//
// Fills the `api.voice.transcribeAudio` contract in src/lib/api.ts. The
// browser records a short clip, posts it here, and receives only the
// transcript. The transcript is then handed to the EXISTING Atlas
// conversation engine — ElevenLabs never talks to the model directly and
// never becomes a second brain.
//
// DEPLOYMENT CONTRACT: source/index.ts is the entry point (see
// conversation-converse/source/index.ts); the root index.ts shim keeps the
// standard Supabase CLI deploy path working.
//
// Security:
//   - ELEVENLABS_API_KEY stays server-side (`xi-api-key` header only).
//   - The caller's JWT is verified before any audio is forwarded.
//   - Provider error bodies are logged server-side and never returned.
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
  elevenLabsTranscribe,
  isElevenLabsConfigured,
} from "../../_shared/elevenlabs.ts";

/** Decode base64 audio into bytes (chunked — clips can be a few MB). */
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface TranscribeBody {
  audioB64?: unknown;
  mimeType?: unknown;
  languageCode?: unknown;
  fileName?: unknown;
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

    if (!isElevenLabsConfigured()) {
      return atlasEdgeError(
        "Atlas Voice is not configured for this environment. Please contact support.",
        503,
        cors,
      );
    }

    const body = (await request.json().catch(() => ({}))) as TranscribeBody;
    const audioB64 = typeof body.audioB64 === "string" ? body.audioB64 : "";
    if (!audioB64) {
      return atlasEdgeError("No audio was received.", 400, cors);
    }

    let audio: Uint8Array;
    try {
      audio = fromBase64(audioB64);
    } catch {
      return atlasEdgeError("The recording could not be read.", 400, cors);
    }

    const result = await elevenLabsTranscribe(audio, {
      mimeType: optionalString(body.mimeType),
      fileName: optionalString(body.fileName),
      languageCode: optionalString(body.languageCode),
    });

    console.info("[voice-transcribe] ok", {
      user_id: caller.userId,
      organization_id: caller.tenantId,
      model_id: result.modelId,
      bytes: audio.byteLength,
      words: result.wordCount,
      latency_ms: result.latencyMs,
    });

    return atlasEdgeJson(
      {
        text: result.text,
        provider: "elevenlabs",
        languageCode: result.languageCode,
        wordCount: result.wordCount,
        modelId: result.modelId,
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
      "[voice-transcribe] unhandled:",
      error instanceof Error ? error.message : String(error),
    );
    return atlasEdgeError(
      "Atlas Voice is unavailable right now. Please try again.",
      500,
      cors,
    );
  }
});
