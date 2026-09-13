// ---------------------------------------------------------------------------
// Atlas — ElevenLabs Speech Engine shared helpers (Deno Edge Functions)
//
// ElevenLabs is Atlas's VOICE LAYER only: speech-to-text (Scribe) and
// text-to-speech. It is never the conversational brain — the existing Atlas
// conversation engine (conversation-converse) remains the single intelligence
// layer for both typed and spoken input.
//
// Server-only secrets are read from Deno.env and NEVER leave this process:
//   ELEVENLABS_API_KEY          server API key (secret)
// Non-secret configuration:
//   ELEVENLABS_BASE_URL         defaults to https://api.elevenlabs.io
//   ELEVENLABS_VOICE_ID         default TTS voice
//   ELEVENLABS_MODEL_ID         default TTS model
//   ELEVENLABS_STT_MODEL_ID     default STT model
//   ELEVENLABS_OUTPUT_FORMAT    default TTS output format
//   ELEVENLABS_TIMEOUT_MS       per-request timeout
//
// API references (verified against the official docs):
//   TTS  POST /v1/text-to-speech/{voice_id}          JSON  { text, model_id }
//   STT  POST /v1/speech-to-text                     multipart { file, model_id }
//   Auth header: `xi-api-key: <key>`
// ---------------------------------------------------------------------------

export const ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
export const ELEVENLABS_DEFAULT_MODEL_ID = "eleven_multilingual_v2";
export const ELEVENLABS_DEFAULT_STT_MODEL_ID = "scribe_v2";
export const ELEVENLABS_DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
export const ELEVENLABS_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Guard rail: Atlas responses are short spoken answers, not documents. An
 * unbounded body could burn ElevenLabs credits and stall the request, so the
 * server truncates rather than forwarding an unbounded payload.
 */
export const ELEVENLABS_MAX_TTS_CHARS = 5_000;
/** Guard rail: 5 MB of audio is far more than a spoken command needs. */
export const ELEVENLABS_MAX_STT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  sttModelId: string;
  outputFormat: string;
  timeoutMs: number;
}

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

export function elevenLabsConfig(): ElevenLabsConfig {
  const timeout = Number(env("ELEVENLABS_TIMEOUT_MS"));
  return {
    apiKey: env("ELEVENLABS_API_KEY"),
    baseUrl: env("ELEVENLABS_BASE_URL") || ELEVENLABS_DEFAULT_BASE_URL,
    voiceId: env("ELEVENLABS_VOICE_ID") || ELEVENLABS_DEFAULT_VOICE_ID,
    modelId: env("ELEVENLABS_MODEL_ID") || ELEVENLABS_DEFAULT_MODEL_ID,
    sttModelId: env("ELEVENLABS_STT_MODEL_ID") || ELEVENLABS_DEFAULT_STT_MODEL_ID,
    outputFormat: env("ELEVENLABS_OUTPUT_FORMAT") || ELEVENLABS_DEFAULT_OUTPUT_FORMAT,
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0
        ? timeout
        : ELEVENLABS_DEFAULT_TIMEOUT_MS,
  };
}

/** True when the server holds an ElevenLabs key (the only secret required). */
export function isElevenLabsConfigured(): boolean {
  return elevenLabsConfig().apiKey.length > 0;
}

// ---------------------------------------------------------------------------
// Errors — internal detail is logged, never returned to the browser
// ---------------------------------------------------------------------------

export type ElevenLabsErrorCode =
  | "not_configured"
  | "auth_failed"
  | "rate_limited"
  | "timeout"
  | "invalid_request"
  | "provider_error"
  | "empty_input";

export class ElevenLabsError extends Error {
  readonly code: ElevenLabsErrorCode;
  readonly status: number;
  constructor(code: ElevenLabsErrorCode, message: string, status = 502) {
    super(message);
    this.name = "ElevenLabsError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Map an ElevenLabs HTTP failure onto an Atlas error. The provider's response
 * body is truncated for the server log only — it is never returned to the
 * caller, so provider internals and any echoed credentials stay server-side.
 */
async function providerError(
  operation: string,
  response: Response,
): Promise<ElevenLabsError> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  console.error(
    `[elevenlabs] ${operation} failed (HTTP ${response.status}): ${detail}`,
  );
  if (response.status === 401 || response.status === 403) {
    return new ElevenLabsError(
      "auth_failed",
      "Atlas Voice is not authorized with the speech provider.",
      502,
    );
  }
  if (response.status === 429) {
    return new ElevenLabsError(
      "rate_limited",
      "Atlas Voice is temporarily rate limited. Please try again shortly.",
      429,
    );
  }
  if (response.status === 400 || response.status === 422) {
    return new ElevenLabsError(
      "invalid_request",
      "Atlas Voice could not process that request.",
      400,
    );
  }
  return new ElevenLabsError(
    "provider_error",
    "Atlas Voice is unavailable right now. Please try again.",
    502,
  );
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

export interface SynthesizeResult {
  audio: Uint8Array;
  mimeType: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  latencyMs: number;
}

/** Map an ElevenLabs `output_format` codec onto an audio MIME type. */
export function mimeTypeForOutputFormat(outputFormat: string): string {
  const codec = outputFormat.split("_")[0]?.toLowerCase() ?? "";
  switch (codec) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/ogg";
    case "pcm":
      return "audio/L16";
    case "ulaw":
    case "alaw":
      return "audio/basic";
    default:
      return "audio/mpeg";
  }
}

/**
 * Synthesize speech for `text` with the configured (or overridden) voice.
 *
 * `previousText` allows ElevenLabs to keep prosody continuous across the
 * streamed segments of a single Atlas answer (see the API's `previous_text`).
 */
export async function elevenLabsSynthesize(
  text: string,
  options?: {
    voiceId?: string;
    modelId?: string;
    outputFormat?: string;
    previousText?: string;
    signal?: AbortSignal;
  },
): Promise<SynthesizeResult> {
  const config = elevenLabsConfig();
  if (!config.apiKey) {
    throw new ElevenLabsError(
      "not_configured",
      "Atlas Voice is not configured for this environment.",
      503,
    );
  }

  const spoken = (text ?? "").trim();
  if (!spoken) {
    throw new ElevenLabsError("empty_input", "Nothing to speak.", 400);
  }
  const bounded =
    spoken.length > ELEVENLABS_MAX_TTS_CHARS
      ? spoken.slice(0, ELEVENLABS_MAX_TTS_CHARS)
      : spoken;

  const voiceId = options?.voiceId?.trim() || config.voiceId;
  const modelId = options?.modelId?.trim() || config.modelId;
  const outputFormat = options?.outputFormat?.trim() || config.outputFormat;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      `${config.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: bounded,
          model_id: modelId,
          ...(options?.previousText
            ? { previous_text: options.previousText.slice(-1_000) }
            : {}),
        }),
        signal: options?.signal ?? controller.signal,
      },
    );

    if (!response.ok) throw await providerError("tts", response);

    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw new ElevenLabsError(
        "provider_error",
        "Atlas Voice returned no audio. Please try again.",
        502,
      );
    }

    return {
      audio,
      mimeType: mimeTypeForOutputFormat(outputFormat),
      voiceId,
      modelId,
      outputFormat,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ElevenLabsError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ElevenLabsError(
        "timeout",
        "Atlas Voice timed out. Please try again.",
        504,
      );
    }
    console.error(
      "[elevenlabs] tts transport failure:",
      error instanceof Error ? error.message : String(error),
    );
    throw new ElevenLabsError(
      "provider_error",
      "Atlas Voice is unavailable right now. Please try again.",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface TranscribeResult {
  text: string;
  languageCode: string | null;
  /** Number of word timings returned — used for honest diagnostics only. */
  wordCount: number;
  modelId: string;
  latencyMs: number;
}

/** The STT response shape Atlas consumes (other fields are ignored). */
interface ElevenLabsTranscript {
  text?: unknown;
  language_code?: unknown;
  language_probability?: unknown;
  words?: unknown;
}

/**
 * Transcribe an audio clip with ElevenLabs Scribe.
 *
 * The browser records the clip and posts it to the `voice-transcribe` Edge
 * Function; only this server-side call ever sees ELEVENLABS_API_KEY.
 */
export async function elevenLabsTranscribe(
  audio: Uint8Array,
  options?: {
    mimeType?: string;
    fileName?: string;
    languageCode?: string;
    modelId?: string;
    signal?: AbortSignal;
  },
): Promise<TranscribeResult> {
  const config = elevenLabsConfig();
  if (!config.apiKey) {
    throw new ElevenLabsError(
      "not_configured",
      "Atlas Voice is not configured for this environment.",
      503,
    );
  }
  if (!audio || audio.byteLength === 0) {
    throw new ElevenLabsError("empty_input", "No audio was received.", 400);
  }
  if (audio.byteLength > ELEVENLABS_MAX_STT_BYTES) {
    throw new ElevenLabsError(
      "invalid_request",
      "That recording is too long for Atlas Voice. Please keep it under a minute.",
      413,
    );
  }

  const modelId = options?.modelId?.trim() || config.sttModelId;
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: options?.mimeType || "audio/webm" }),
    options?.fileName || "atlas-voice.webm",
  );
  form.append("model_id", modelId);
  if (options?.languageCode) form.append("language_code", options.languageCode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${config.baseUrl}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": config.apiKey },
      body: form,
      signal: options?.signal ?? controller.signal,
    });

    if (!response.ok) throw await providerError("stt", response);

    const json = (await response.json()) as ElevenLabsTranscript;
    const text = typeof json.text === "string" ? json.text.trim() : "";
    const words = Array.isArray(json.words) ? json.words.length : 0;

    return {
      text,
      languageCode:
        typeof json.language_code === "string" ? json.language_code : null,
      wordCount: words,
      modelId,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ElevenLabsError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ElevenLabsError(
        "timeout",
        "Atlas Voice timed out. Please try again.",
        504,
      );
    }
    console.error(
      "[elevenlabs] stt transport failure:",
      error instanceof Error ? error.message : String(error),
    );
    throw new ElevenLabsError(
      "provider_error",
      "Atlas Voice is unavailable right now. Please try again.",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Client-safe capability description
// ---------------------------------------------------------------------------

export interface ElevenLabsCapabilities {
  configured: boolean;
  stt: boolean;
  tts: boolean;
  streamingOutput: boolean;
  interruption: boolean;
  voiceId: string;
  modelId: string;
  sttModelId: string;
  outputFormat: string;
}

/**
 * What the BROWSER may know. Deliberately excludes the API key and any
 * credential material — only the provider's public voice/model identifiers so
 * the UI can report honestly which engine is speaking.
 */
export function elevenLabsCapabilities(): ElevenLabsCapabilities {
  const config = elevenLabsConfig();
  const configured = config.apiKey.length > 0;
  return {
    configured,
    stt: configured,
    tts: configured,
    streamingOutput: false,
    interruption: true,
    voiceId: config.voiceId,
    modelId: config.modelId,
    sttModelId: config.sttModelId,
    outputFormat: config.outputFormat,
  };
}
