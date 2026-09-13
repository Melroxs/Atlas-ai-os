// ---------------------------------------------------------------------------
// Atlas Voice — ElevenLabs Speech Engine client transport
//
// The browser NEVER holds an ElevenLabs credential. Both directions go
// through authenticated Supabase Edge Functions:
//
//   speech-to-text : MediaRecorder clip → voice-transcribe → transcript
//   text-to-speech : Atlas answer        → voice-synthesize → audio bytes
//
// This module is deliberately thin: it moves audio/transcripts and nothing
// else. Atlas conversation, retrieval, tools and permissions all live in the
// existing Atlas layers — ElevenLabs is only the voice.
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";

/** Which engine actually produced/consumed the audio. Reported honestly. */
export type SpeechEngine = "elevenlabs" | "browser";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SpeechEngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SpeechEngineError";
    this.code = code;
  }
}

/** Map a failed Edge Function call onto a user-understandable error. */
function speechErrorFrom(message: string): SpeechEngineError {
  const lower = message.toLowerCase();
  if (lower.includes("session expired") || lower.includes("unauthorized")) {
    return new SpeechEngineError("unauthorized", "Your session expired. Please sign in again.");
  }
  if (lower.includes("not configured")) {
    return new SpeechEngineError(
      "not_configured",
      "Atlas Voice isn't configured yet. You can keep typing to Atlas.",
    );
  }
  if (lower.includes("rate limit")) {
    return new SpeechEngineError("rate_limited", "Atlas Voice is busy. Please try again shortly.");
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new SpeechEngineError("timeout", "Atlas Voice timed out. Please try again.");
  }
  return new SpeechEngineError(
    "unavailable",
    "I couldn't connect to Atlas Voice. Please try again.",
  );
}

async function invokeVoiceFunction<T>(
  name: "voice-transcribe" | "voice-synthesize",
  body: Record<string, unknown>,
): Promise<T> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new SpeechEngineError("unavailable", "Atlas Voice is unavailable right now.");
  }

  let data: unknown;
  let error: unknown;
  try {
    const response = await supabase.functions.invoke(name, { body });
    data = response.data;
    error = response.error;
  } catch (err) {
    // supabase-js throws FunctionsFetchError when the function is missing or
    // the network drops. Treat it as "voice engine unavailable" so callers can
    // fall back to the browser engine instead of dead-ending.
    throw speechErrorFrom(err instanceof Error ? err.message : String(err));
  }

  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw speechErrorFrom(message);
  }

  const payload = data as { data?: unknown; error?: string } | null;
  if (payload && typeof payload === "object" && typeof payload.error === "string") {
    throw speechErrorFrom(payload.error);
  }
  const unwrapped =
    payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  return unwrapped as T;
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

interface SynthesizePayload {
  mimeType?: string;
  audioB64?: string;
  provider?: string;
  voiceId?: string;
}

export interface SpokenAudio {
  /** Object URL for an <audio> element. Call `revoke()` when done. */
  url: string;
  mimeType: string;
  voiceId: string | null;
  revoke: () => void;
}

/**
 * Synthesize `text` with ElevenLabs and return a playable object URL.
 * Throws SpeechEngineError (callers fall back to browser speech synthesis).
 */
export async function elevenLabsSpeak(
  text: string,
  options?: { previousText?: string; signal?: AbortSignal },
): Promise<SpokenAudio> {
  const clean = (text ?? "").trim();
  if (!clean) throw new SpeechEngineError("empty", "Nothing to speak.");
  if (options?.signal?.aborted) {
    throw new SpeechEngineError("aborted", "Speech was interrupted.");
  }

  const payload = await invokeVoiceFunction<SynthesizePayload>("voice-synthesize", {
    text: clean,
    ...(options?.previousText ? { previousText: options.previousText } : {}),
  });

  const audioB64 = payload?.audioB64;
  if (!audioB64) {
    throw new SpeechEngineError("unavailable", "I couldn't speak that response.");
  }

  const mimeType = payload.mimeType || "audio/mpeg";
  const bytes = base64ToBytes(audioB64);
  // Blob takes an ArrayBuffer; slice the view so exactly these bytes are used.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);

  return {
    url,
    mimeType,
    voiceId: payload.voiceId ?? null,
    revoke: () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // already revoked
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

interface TranscribePayload {
  text?: string;
  provider?: string;
  languageCode?: string | null;
}

/**
 * Transcribe a recorded audio clip with ElevenLabs Scribe.
 * Returns the trimmed transcript (empty string when nothing was said).
 */
export async function elevenLabsTranscribe(
  clip: Blob,
  options?: { languageCode?: string; signal?: AbortSignal },
): Promise<string> {
  if (!clip || clip.size === 0) return "";
  if (options?.signal?.aborted) {
    throw new SpeechEngineError("aborted", "Recording was cancelled.");
  }

  const audioB64 = await blobToBase64(clip);
  const payload = await invokeVoiceFunction<TranscribePayload>("voice-transcribe", {
    audioB64,
    mimeType: clip.type || "audio/webm",
    fileName: "atlas-voice.webm",
    ...(options?.languageCode ? { languageCode: options.languageCode } : {}),
  });

  return (payload?.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Encoding helpers (chunked: clips can be several megabytes)
// ---------------------------------------------------------------------------

/** Base64-encode a Blob without overflowing the call stack. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** True when this browser can record a clip for server-side transcription. */
export function audioRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export interface AudioRecorder {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/**
 * Start recording from the microphone. Throws SpeechEngineError with code
 * `permission_denied` when the user blocks the microphone, so the UI can say
 * so plainly instead of showing a generic failure.
 */
export async function startAudioRecording(): Promise<AudioRecorder> {
  if (!audioRecordingSupported()) {
    throw new SpeechEngineError(
      "unsupported",
      "This browser can't record audio for Atlas Voice. You can still type to Atlas.",
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new SpeechEngineError(
      "permission_denied",
      "Atlas Voice needs microphone access. Allow the microphone in your browser and try again.",
    );
  }

  const mimeType = pickRecordingMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  let settled = false;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  const releaseStream = () => {
    stream.getTracks().forEach((track) => track.stop());
  };

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const finish = () => {
          if (settled) return;
          settled = true;
          releaseStream();
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        recorder.onstop = finish;
        try {
          recorder.stop();
        } catch {
          finish();
        }
      }),
    cancel: () => {
      if (settled) return;
      settled = true;
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
      releaseStream();
    },
  };
}

/** First MediaRecorder MIME type the browser actually supports. */
function pickRecordingMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // isTypeSupported can throw on some engines — treat as unsupported
    }
  }
  return undefined;
}
