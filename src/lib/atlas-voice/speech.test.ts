import { describe, expect, it, vi } from "vitest";
import { SpeechEngineError, type SpokenAudio } from "./elevenlabs";
import {
  createAtlasSpeech,
  type AtlasSpeechDeps,
  type SpeechPlayback,
} from "./speech";

function spoken(revoke = vi.fn()): SpokenAudio {
  return { url: "blob:atlas", mimeType: "audio/mpeg", voiceId: "voice-1", revoke };
}

function resolvedPlayback(stop?: () => void): SpeechPlayback {
  return { stop: stop ?? (() => {}), finished: Promise.resolve() };
}

interface Harness {
  deps: AtlasSpeechDeps;
  synthesize: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  speakBrowser: ReturnType<typeof vi.fn>;
  stopBrowser: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<AtlasSpeechDeps> = {}): Harness {
  const synthesize = vi.fn(async () => spoken());
  const play = vi.fn(() => resolvedPlayback());
  const speakBrowser = vi.fn(() => true);
  const stopBrowser = vi.fn();
  const deps: AtlasSpeechDeps = {
    synthesize: synthesize as unknown as AtlasSpeechDeps["synthesize"],
    play: play as unknown as AtlasSpeechDeps["play"],
    speakBrowser: speakBrowser as unknown as AtlasSpeechDeps["speakBrowser"],
    stopBrowser,
    ...overrides,
  };
  return { deps, synthesize, play, speakBrowser, stopBrowser };
}

describe("Atlas speech controller", () => {
  it("reports no engine until something has actually spoken", () => {
    const speech = createAtlasSpeech(harness().deps);
    expect(speech.engine).toBeNull();
    // The preference is not a claim — it is only what will be attempted next.
    expect(speech.preferredEngine).toBe("elevenlabs");
  });

  it("uses ElevenLabs when available and revokes the object URL afterwards", async () => {
    const revoke = vi.fn();
    const { deps } = harness({ synthesize: vi.fn(async () => spoken(revoke)) as never });
    const speech = createAtlasSpeech(deps);

    const onEngine = vi.fn();
    const onEnd = vi.fn();
    const used = await speech.speak("Opened the Carter claim.", { onEngine, onEnd });

    expect(used).toBe("elevenlabs");
    expect(speech.engine).toBe("elevenlabs");
    expect(onEngine).toHaveBeenCalledWith("elevenlabs");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("falls back to browser speech when the server is not configured", async () => {
    const synthesize = vi.fn(async () => {
      throw new SpeechEngineError("not_configured", "Atlas Voice isn't configured yet.");
    });
    const speakBrowser = vi.fn((_text: string, opts?: { onEnd?: () => void }) => {
      opts?.onEnd?.();
      return true;
    });
    const { deps } = harness({
      synthesize: synthesize as never,
      speakBrowser: speakBrowser as never,
    });
    const speech = createAtlasSpeech(deps);

    const onEngine = vi.fn();
    const used = await speech.speak("Hello", { onEngine });

    expect(used).toBe("browser");
    expect(speakBrowser).toHaveBeenCalledTimes(1);
    expect(onEngine).toHaveBeenCalledWith("browser");
    // Learned state: the next utterance skips ElevenLabs entirely.
    expect(speech.preferredEngine).toBe("browser");
    const usedAgain = await speech.speak("Again");
    expect(usedAgain).toBe("browser");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight ElevenLabs request on interruption", async () => {
    let aborted = false;
    const synthesize = vi.fn(
      (_text: string, opts: { signal: AbortSignal }) =>
        new Promise<SpokenAudio>((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new SpeechEngineError("aborted", "interrupted"));
          });
        }),
    );
    const speakBrowser = vi.fn(() => true);
    const { deps } = harness({
      synthesize: synthesize as never,
      speakBrowser: speakBrowser as never,
    });
    const speech = createAtlasSpeech(deps);

    const pending = speech.speak("A long Atlas answer.");
    speech.stop();

    await expect(pending).resolves.toBe("elevenlabs");
    expect(aborted).toBe(true);
    // Interruption must not fall through to browser speech.
    expect(speakBrowser).not.toHaveBeenCalled();
  });

  it("stops playback, revokes the URL and cancels browser speech on stop", async () => {
    const revoke = vi.fn();
    const playbackStop = vi.fn();
    let finishPlayback: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finishPlayback = resolve;
    });
    const play = vi.fn(() => ({
      stop: () => {
        playbackStop();
        finishPlayback();
      },
      finished,
    }));

    const { deps, stopBrowser } = harness({
      synthesize: vi.fn(async () => spoken(revoke)) as never,
      play: play as never,
    });
    const speech = createAtlasSpeech(deps);

    const pending = speech.speak("A very long Atlas answer.");
    // Let the ElevenLabs call resolve and playback begin.
    await Promise.resolve();
    await Promise.resolve();

    speech.stop();

    await expect(pending).resolves.toBe("elevenlabs");
    expect(playbackStop).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(stopBrowser).toHaveBeenCalled();
  });

  it("never plays two Atlas answers at once", async () => {
    const playbacks: Array<ReturnType<typeof vi.fn>> = [];
    const play = vi.fn(() => {
      const stop = vi.fn();
      playbacks.push(stop);
      return { stop, finished: new Promise<void>(() => {}) };
    });

    const { deps } = harness({ play: play as never });
    const speech = createAtlasSpeech(deps);

    void speech.speak("First answer.");
    await Promise.resolve();
    await Promise.resolve();
    void speech.speak("Second answer.");
    await Promise.resolve();

    // The first playback must have been stopped when the second one started.
    expect(playbacks[0]).toHaveBeenCalled();
  });

  it("still ends cleanly when no audio output is available", async () => {
    const { deps } = harness({
      synthesize: vi.fn(async () => {
        throw new SpeechEngineError("not_configured", "not configured");
      }) as never,
      speakBrowser: vi.fn(() => false) as never,
    });
    const speech = createAtlasSpeech(deps);

    const onEnd = vi.fn();
    const used = await speech.speak("Hello", { onEnd });
    expect(used).toBe("browser");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
