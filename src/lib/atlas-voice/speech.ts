// ---------------------------------------------------------------------------
// Atlas Voice — Speech output controller
//
// One place decides HOW Atlas answers are spoken, so every voice surface
// (the ambient provider and the centralised session) behaves identically:
//
//   1. ElevenLabs  — via the authenticated `voice-synthesize` Edge Function
//                    (elevenLabsSpeak); the API key never reaches the browser
//   2. Browser     — the existing Web Speech synthesis fallback
//
// Guarantees:
//   * Speech must never dead-end: any ElevenLabs failure (not_configured,
//     auth_failed, timeout, provider unavailable) falls back to browser speech.
//   * Only ONE Atlas utterance plays at a time — speaking again, or an
//     interruption command, stops the previous one first.
//   * Every synthesized object URL is revoked exactly once, whether playback
//     ended, errored, or was interrupted. No orphaned audio is left behind.
//   * `engine` reports what actually spoke (null until something has), so the
//     UI never claims ElevenLabs merely because the provider exists.
//
// This module is transport only. Atlas remains the reasoning/decision/action
// brain; ElevenLabs is the speech layer.
// ---------------------------------------------------------------------------

import {
  SpeechEngineError,
  elevenLabsSpeak,
  type SpokenAudio,
} from "./elevenlabs";
import { speakText, stopBrowserSpeaking } from "@/lib/voice";

/** Which engine produced the most recent Atlas utterance. */
export type SpeechEngine = "elevenlabs" | "browser";

export interface SpeechPlayback {
  /** Stop playback immediately. */
  stop: () => void;
  /** Resolves when playback ends OR is stopped — never rejects. */
  finished: Promise<void>;
}

/** Injectable transport, so the controller is testable without a browser. */
export interface AtlasSpeechDeps {
  synthesize: (text: string, opts: { signal: AbortSignal }) => Promise<SpokenAudio>;
  play: (url: string) => SpeechPlayback;
  speakBrowser: (text: string, opts?: { onEnd?: () => void }) => boolean;
  stopBrowser: () => void;
}

export interface SpeakOptions {
  /** Called once when speech finishes, errors, or is interrupted. */
  onEnd?: () => void;
  /** Called with the engine that is about to speak. */
  onEngine?: (engine: SpeechEngine) => void;
}

export interface AtlasSpeech {
  /** Engine that handled the most recent utterance (null before any). */
  readonly engine: SpeechEngine | null;
  /** Engine that will be attempted next. */
  readonly preferredEngine: SpeechEngine;
  /** True while audio is being synthesized or played. */
  readonly speaking: boolean;
  /** Speak `text`. Resolves with the engine that actually spoke. */
  speak: (text: string, options?: SpeakOptions) => Promise<SpeechEngine>;
  /** Stop all Atlas audio immediately (barge-in / interruption). */
  stop: () => void;
  /** Forget a learned "ElevenLabs unavailable" state (retry next time). */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Default transports
// ---------------------------------------------------------------------------

/** Play an object URL through an <audio> element, resolving on stop/end/error. */
function defaultPlay(url: string): SpeechPlayback {
  if (typeof Audio === "undefined") {
    return { stop: () => {}, finished: Promise.resolve() };
  }
  const audio = new Audio(url);
  let settled = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveFinished();
  };
  audio.onended = finish;
  audio.onerror = finish;
  void audio.play().catch(finish);
  return {
    stop: () => {
      try {
        audio.pause();
      } catch {
        // already stopped
      }
      finish();
    },
    finished,
  };
}

function defaultDeps(): AtlasSpeechDeps {
  return {
    synthesize: (text, opts) => elevenLabsSpeak(text, { signal: opts.signal }),
    play: defaultPlay,
    speakBrowser: (text, opts) => speakText(text, { onEnd: opts?.onEnd }),
    stopBrowser: stopBrowserSpeaking,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface SpeechRun {
  controller: AbortController;
  playback: SpeechPlayback | null;
  revoke: (() => void) | null;
  resolve?: (engine: SpeechEngine) => void;
}

export function createAtlasSpeech(deps: AtlasSpeechDeps): AtlasSpeech {
  let current: SpeechRun | null = null;
  let engine: SpeechEngine | null = null;
  let browserPreferred = false;

  function cleanup(run: SpeechRun): void {
    try {
      run.playback?.stop();
    } catch {
      // ignore
    }
    run.playback = null;
    try {
      run.revoke?.();
    } catch {
      // ignore
    }
    run.revoke = null;
  }

  function settle(run: SpeechRun, value: SpeechEngine): void {
    const resolve = run.resolve;
    run.resolve = undefined;
    resolve?.(value);
  }

  function stop(): void {
    const run = current;
    current = null;
    if (run) {
      run.controller.abort();
      cleanup(run);
      settle(run, engine ?? "browser");
    }
    deps.stopBrowser();
  }

  async function speak(text: string, options?: SpeakOptions): Promise<SpeechEngine> {
    const clean = (text ?? "").trim();
    if (!clean) {
      options?.onEnd?.();
      return engine ?? "browser";
    }

    // Interrupt anything already playing — never two streams at once.
    stop();

    const controller = new AbortController();
    const run: SpeechRun = { controller, playback: null, revoke: null };
    current = run;

    if (!browserPreferred) {
      try {
        const spoken = await deps.synthesize(clean, { signal: controller.signal });
        if (controller.signal.aborted || current !== run) {
          spoken.revoke();
          settle(run, "elevenlabs");
          return "elevenlabs";
        }

        run.revoke = spoken.revoke;
        engine = "elevenlabs";
        options?.onEngine?.("elevenlabs");

        const playback = deps.play(spoken.url);
        run.playback = playback;
        await playback.finished;

        cleanup(run);
        if (current === run) current = null;
        if (controller.signal.aborted) {
          settle(run, "elevenlabs");
          return "elevenlabs";
        }
        settle(run, "elevenlabs");
        options?.onEnd?.();
        return "elevenlabs";
      } catch (error) {
        cleanup(run);
        if (controller.signal.aborted || current !== run) {
          if (current === run) current = null;
          settle(run, "elevenlabs");
          return "elevenlabs";
        }
        // The server is not configured / unreachable: stop trying ElevenLabs
        // until reset() and let the browser engine speak the answer.
        const code = error instanceof SpeechEngineError ? error.code : "unavailable";
        if (code === "not_configured" || code === "unavailable" || code === "unauthorized") {
          browserPreferred = true;
        }
      }
    }

    // ---- Browser speech synthesis fallback ----
    engine = "browser";
    options?.onEngine?.("browser");
    return await new Promise<SpeechEngine>((resolve) => {
      run.resolve = resolve;
      const started = deps.speakBrowser(clean, {
        onEnd: () => {
          if (current === run) current = null;
          settle(run, "browser");
          options?.onEnd?.();
        },
      });
      if (!started) {
        if (current === run) current = null;
        settle(run, "browser");
        options?.onEnd?.();
      }
    });
  }

  return {
    get engine() {
      return engine;
    },
    get preferredEngine() {
      return browserPreferred ? "browser" : "elevenlabs";
    },
    get speaking() {
      return current !== null;
    },
    speak,
    stop,
    reset() {
      browserPreferred = false;
    },
  };
}

/**
 * The single Atlas speech controller used by every voice surface. Sharing one
 * instance is what guarantees a second answer can never talk over the first.
 */
export const atlasSpeech: AtlasSpeech = createAtlasSpeech(defaultDeps());
