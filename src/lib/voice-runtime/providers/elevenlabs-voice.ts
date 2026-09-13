// ---------------------------------------------------------------------------
// Atlas Voice Runtime — ElevenLabs Speech Engine provider
//
// Implements the provider-agnostic `VoiceProviderAdapter` so ElevenLabs is
// selectable alongside the existing browser and NVIDIA NIM providers, with the
// registry's priority/fallback chain deciding what actually runs.
//
// SCOPE — ElevenLabs is the VOICE layer:
//   - speech-to-text (Scribe) and text-to-speech
//   - turn handling and interruption/cancellation of in-flight output
// It is NOT the brain. This adapter never reasons, never retrieves Atlas data
// and never runs a tool. Transcripts go to the existing Atlas conversation
// engine (conversation-converse) and answers come back as text to speak.
//
// SECRETS: the API key lives only in the `voice-transcribe` /
// `voice-synthesize` Edge Functions. The browser holds no ElevenLabs
// credential — this adapter talks to Atlas's own authenticated endpoints.
//
// Honest capability reporting:
//   - `speechToSpeech: false`  — Atlas's LLM is the responder, not ElevenLabs
//   - `streamingOutput: false` — the proxy returns a complete clip per answer
//   - `streamingInput: false`  — STT is clip-based, not a realtime socket
// A streaming/realtime upgrade is possible later without changing this
// contract, but nothing claims it today.
// ---------------------------------------------------------------------------

import type {
  VoiceProviderAdapter,
  VoiceProviderConfig,
  VoiceProviderCapabilities,
  VoiceSessionConfig,
  VoiceSessionHandle,
  VoiceSession,
  VoiceSessionState,
  VoiceEventHandler,
  VoiceEvent,
} from "../types";
import { createVoiceError } from "../errors";
import { createVoiceEvent, emitVoiceEvent } from "../events";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

// ---------------------------------------------------------------------------
// Injectable transport (keeps this adapter unit-testable without a browser)
// ---------------------------------------------------------------------------

export interface SpokenAudio {
  url: string;
  revoke: () => void;
}

export interface ElevenLabsVoiceTransport {
  transcribe(clip: Blob, opts?: { signal?: AbortSignal }): Promise<string>;
  speak(text: string, opts?: { signal?: AbortSignal }): Promise<SpokenAudio>;
  /** The environment can capture audio for transcription. */
  audioSupported(): boolean;
  /** The environment can play synthesized audio. */
  playbackSupported(): boolean;
}

export interface VoicePlayback {
  stop(): void;
  /** Resolves when playback ends OR fails — never rejects. */
  finished: Promise<void>;
}

export type PlaybackFactory = (url: string) => VoicePlayback;

/** Default browser playback via an <audio> element. */
export const defaultPlaybackFactory: PlaybackFactory = (url) => {
  if (typeof Audio === "undefined") {
    return { stop: () => {}, finished: Promise.resolve() };
  }
  const audio = new Audio(url);
  const finished = new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
  });
  void audio.play().catch(() => {
    // Autoplay blocked or decode failed — `finished` resolves via onerror.
  });
  return {
    stop: () => {
      try {
        audio.pause();
      } catch {
        // already stopped
      }
    },
    finished,
  };
};

/**
 * Default transport backed by the Atlas Edge Functions. Imported lazily so
 * this module stays importable in Node (tests, SSR) without a browser.
 */
const defaultTransport: ElevenLabsVoiceTransport = {
  async transcribe(clip, opts) {
    const { elevenLabsTranscribe, audioRecordingSupported } = await import(
      "@/lib/atlas-voice/elevenlabs"
    );
    if (!audioRecordingSupported()) {
      throw createVoiceError(
        "browser_unsupported",
        "This browser can't capture audio for Atlas Voice.",
        { provider: ELEVENLABS_PROVIDER_ID },
      );
    }
    return elevenLabsTranscribe(clip, { signal: opts?.signal });
  },
  async speak(text, opts) {
    const { elevenLabsSpeak } = await import("@/lib/atlas-voice/elevenlabs");
    const spoken = await elevenLabsSpeak(text, { signal: opts?.signal });
    return { url: spoken.url, revoke: spoken.revoke };
  },
  audioSupported() {
    if (typeof navigator === "undefined") return false;
    return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  },
  playbackSupported() {
    return typeof Audio !== "undefined";
  },
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ElevenLabsVoiceProvider implements VoiceProviderAdapter {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly name = "ElevenLabs Speech Engine";

  readonly capabilities: VoiceProviderCapabilities = {
    stt: true,
    tts: true,
    speechToSpeech: false,
    streamingInput: false,
    streamingOutput: false,
    interruption: true,
    voiceControl: true,
    realtime: false,
  };

  private readonly config: VoiceProviderConfig;
  private readonly transport: ElevenLabsVoiceTransport;
  private readonly playbackFactory: PlaybackFactory;

  constructor(
    config: VoiceProviderConfig,
    deps?: {
      transport?: ElevenLabsVoiceTransport;
      playbackFactory?: PlaybackFactory;
    },
  ) {
    this.config = config;
    this.transport = deps?.transport ?? defaultTransport;
    this.playbackFactory = deps?.playbackFactory ?? defaultPlaybackFactory;
  }

  /**
   * Available when this environment can record and/or play audio. The
   * server-side API key is deliberately NOT checkable from the browser: if it
   * is missing, the Edge Function returns a clear "not configured" error and
   * the session falls back to the browser provider.
   */
  isAvailable(): boolean {
    return this.transport.audioSupported() || this.transport.playbackSupported();
  }

  async createSession(config: VoiceSessionConfig): Promise<VoiceSessionHandle> {
    if (!this.isAvailable()) {
      throw createVoiceError(
        "provider_unavailable",
        "Atlas Voice needs a browser that can capture and play audio.",
        { provider: this.id },
      );
    }

    const sessionId = `${ELEVENLABS_PROVIDER_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: ElevenLabsSession = {
      id: sessionId,
      state: "idle",
      provider: ELEVENLABS_PROVIDER_ID,
      model: config.model || this.config.defaultModel,
      createdAt: Date.now(),
      lastStateChange: Date.now(),
      transcript: "",
      partialTranscript: "",
      _listeners: new Map(),
      _config: config,
    };

    emitVoiceEvent(
      createVoiceEvent("session.created", sessionId, {
        provider: ELEVENLABS_PROVIDER_ID,
        model: session.model,
      }),
    );

    return new ElevenLabsSessionHandle(session, this.transport, this.playbackFactory);
  }

  async healthCheck(): Promise<boolean> {
    return this.isAvailable();
  }
}

// ---------------------------------------------------------------------------
// Session handle
// ---------------------------------------------------------------------------

class ElevenLabsSessionHandle implements VoiceSessionHandle {
  private readonly _session: ElevenLabsSession;
  private readonly _transport: ElevenLabsVoiceTransport;
  private readonly _playbackFactory: PlaybackFactory;
  private _abort: AbortController | null = null;
  private _playback: VoicePlayback | null = null;
  private _spoken: SpokenAudio | null = null;

  constructor(
    session: ElevenLabsSession,
    transport: ElevenLabsVoiceTransport,
    playbackFactory: PlaybackFactory,
  ) {
    this._session = session;
    this._transport = transport;
    this._playbackFactory = playbackFactory;
  }

  get id(): string {
    return this._session.id;
  }
  get state(): VoiceSessionState {
    return this._session.state;
  }

  onEvent(handler: VoiceEventHandler): () => void {
    const id = `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._session._listeners.set(id, handler);
    return () => {
      this._session._listeners.delete(id);
    };
  }

  /** Transcribe a recorded clip with ElevenLabs Scribe. */
  async sendAudio(audioData: ArrayBuffer): Promise<void> {
    if (!audioData || audioData.byteLength === 0) return;

    this._setState("processing");
    this._emitEvent("audio.input_started", { bytes: audioData.byteLength });

    const controller = new AbortController();
    this._abort = controller;

    try {
      const clip = new Blob([audioData], { type: "audio/webm" });
      const text = await this._transport.transcribe(clip, { signal: controller.signal });
      this._session.transcript = text;
      this._emitEvent("audio.input_stopped", {});
      this._emitEvent("transcript.final", { transcript: text, isFinal: true });
      this._setState(text ? "completed" : "idle");
    } catch (error) {
      this._emitEvent("audio.input_stopped", {});
      if (controller.signal.aborted) {
        this._setState("interrupted");
        return;
      }
      const message = error instanceof Error ? error.message : "Transcription failed.";
      this._emitEvent("provider.error", { message });
      this._setState("error");
      throw createVoiceError("provider_error", message, {
        provider: ELEVENLABS_PROVIDER_ID,
      });
    } finally {
      if (this._abort === controller) this._abort = null;
    }
  }

  /** Speak an Atlas answer with ElevenLabs. */
  async sendText(text: string): Promise<void> {
    const clean = (text ?? "").trim();
    if (!clean) return;

    this._setState("processing");
    this._emitEvent("response.text_complete", { text: clean });

    const controller = new AbortController();
    this._abort = controller;
    let spoken: SpokenAudio | null = null;

    try {
      spoken = await this._transport.speak(clean, { signal: controller.signal });
      if (controller.signal.aborted) {
        spoken.revoke();
        this._setState("interrupted");
        return;
      }

      this._spoken = spoken;
      this._setState("speaking");
      this._emitEvent("audio.output_started", { url: spoken.url });

      const playback = this._playbackFactory(spoken.url);
      this._playback = playback;
      await playback.finished;

      this._cleanupAudio();
      if (this._session.state === "speaking") {
        this._emitEvent("audio.output_stopped", {});
        this._emitEvent("response.audio_complete", { text: clean });
        this._setState("completed");
        this._emitEvent("session.completed", {});
      }
    } catch (error) {
      spoken?.revoke();
      if (controller.signal.aborted) {
        this._setState("interrupted");
        return;
      }
      const message = error instanceof Error ? error.message : "Speech synthesis failed.";
      this._emitEvent("provider.error", { message });
      this._setState("error");
      throw createVoiceError("provider_error", message, {
        provider: ELEVENLABS_PROVIDER_ID,
      });
    } finally {
      if (this._abort === controller) this._abort = null;
    }
  }

  /** Cancel the in-flight request and stop playback immediately (barge-in). */
  async interrupt(): Promise<void> {
    const hadAudio = this._session.state === "speaking" || this._abort !== null;
    this._abort?.abort();
    this._abort = null;
    this._playback?.stop();
    this._playback = null;
    this._cleanupAudio();

    if (hadAudio) {
      this._emitEvent("interruption.detected", { source: ELEVENLABS_PROVIDER_ID });
    }
    this._setState("interrupted");
  }

  async cancel(): Promise<void> {
    await this.interrupt();
    await this.close();
  }

  async close(): Promise<void> {
    this._abort?.abort();
    this._abort = null;
    this._playback?.stop();
    this._playback = null;
    this._cleanupAudio();
    this._setState("closed");
    this._emitEvent("session.closed", {});
    this._session._listeners.clear();
  }

  getSession(): VoiceSession {
    const s = this._session;
    return {
      id: s.id,
      state: s.state,
      provider: s.provider,
      model: s.model,
      createdAt: s.createdAt,
      lastStateChange: s.lastStateChange,
      transcript: s.transcript,
      partialTranscript: s.partialTranscript,
    };
  }

  // -- Private helpers --

  private _cleanupAudio(): void {
    if (this._spoken) {
      this._spoken.revoke();
      this._spoken = null;
    }
  }

  private _setState(state: VoiceSessionState): void {
    this._session.state = state;
    this._session.lastStateChange = Date.now();
    this._emitEvent("session.state_changed", { state });
  }

  private _emitEvent(type: string, data: Record<string, unknown>): void {
    const event: VoiceEvent = {
      type: type as VoiceEvent["type"],
      timestamp: Date.now(),
      sessionId: this._session.id,
      data,
    };
    emitVoiceEvent(event);
    for (const handler of this._session._listeners.values()) {
      try {
        handler(event);
      } catch {
        // Subscriber errors never break the voice session.
      }
    }
  }
}

interface ElevenLabsSession extends VoiceSession {
  _listeners: Map<string, VoiceEventHandler>;
  _config: VoiceSessionConfig;
}
