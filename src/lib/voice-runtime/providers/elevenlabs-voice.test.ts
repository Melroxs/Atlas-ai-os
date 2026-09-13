import { describe, expect, it, vi } from "vitest";
import {
  ElevenLabsVoiceProvider,
  type ElevenLabsVoiceTransport,
  type PlaybackFactory,
} from "./elevenlabs-voice";
import type { VoiceEvent, VoiceProviderConfig } from "../types";
import { resetVoiceEvents } from "../events";

function makeConfig(): VoiceProviderConfig {
  return {
    id: "elevenlabs",
    name: "ElevenLabs Speech Engine",
    baseUrl: "https://api.elevenlabs.io",
    apiKey: "", // never populated in the browser
    defaultModel: "eleven_multilingual_v2",
    priority: 0,
    enabled: true,
    capabilities: {
      stt: true,
      tts: true,
      speechToSpeech: false,
      streamingInput: false,
      streamingOutput: false,
      interruption: true,
      voiceControl: true,
      realtime: false,
    },
  };
}

function makeTransport(overrides: Partial<ElevenLabsVoiceTransport> = {}): ElevenLabsVoiceTransport {
  return {
    transcribe: vi.fn(async () => "open the Carter claim"),
    speak: vi.fn(async () => ({ url: "blob:atlas", revoke: vi.fn() })),
    audioSupported: () => true,
    playbackSupported: () => true,
    ...overrides,
  };
}

const instantPlayback: PlaybackFactory = () => ({
  stop: vi.fn(),
  finished: Promise.resolve(),
});

function collect(handle: { onEvent: (h: (e: VoiceEvent) => void) => () => void }) {
  const events: VoiceEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return events;
}

describe("ElevenLabsVoiceProvider", () => {
  it("reports honest capabilities (Atlas is the brain, not ElevenLabs)", () => {
    const capabilities = new ElevenLabsVoiceProvider(makeConfig()).capabilities;
    expect(capabilities.stt).toBe(true);
    expect(capabilities.tts).toBe(true);
    expect(capabilities.interruption).toBe(true);
    // Not claimed until a streaming/realtime path actually exists.
    expect(capabilities.speechToSpeech).toBe(false);
    expect(capabilities.streamingOutput).toBe(false);
    expect(capabilities.realtime).toBe(false);
  });

  it("is unavailable when the environment cannot handle audio", () => {
    const provider = new ElevenLabsVoiceProvider(makeConfig(), {
      transport: makeTransport({ audioSupported: () => false, playbackSupported: () => false }),
    });
    expect(provider.isAvailable()).toBe(false);
  });

  it("transcribes recorded audio and emits a final transcript", async () => {
    resetVoiceEvents();
    const transport = makeTransport();
    const provider = new ElevenLabsVoiceProvider(makeConfig(), { transport });
    const handle = await provider.createSession({});
    const events = collect(handle);

    await handle.sendAudio(new ArrayBuffer(64));

    expect(transport.transcribe).toHaveBeenCalledTimes(1);
    const final = events.find((e) => e.type === "transcript.final");
    expect(final?.data.transcript).toBe("open the Carter claim");
    expect(handle.getSession().transcript).toBe("open the Carter claim");
  });

  it("speaks text and completes cleanly", async () => {
    resetVoiceEvents();
    const transport = makeTransport();
    const provider = new ElevenLabsVoiceProvider(makeConfig(), {
      transport,
      playbackFactory: instantPlayback,
    });
    const handle = await provider.createSession({});
    const events = collect(handle);

    await handle.sendText("Opened the Carter claim.");

    expect(transport.speak).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "audio.output_started")).toBe(true);
    expect(events.some((e) => e.type === "response.audio_complete")).toBe(true);
    expect(handle.state).toBe("completed");
  });

  it("cancels an in-flight response on interruption (barge-in)", async () => {
    resetVoiceEvents();
    const stop = vi.fn();
    const transport = makeTransport({
      speak: vi.fn(
        (_text: string, opts?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    const provider = new ElevenLabsVoiceProvider(makeConfig(), {
      transport,
      playbackFactory: () => ({ stop, finished: Promise.resolve() }),
    });
    const handle = await provider.createSession({});
    const events = collect(handle);

    const speaking = handle.sendText("A very long Atlas answer.");
    await handle.interrupt();

    await expect(speaking).resolves.toBeUndefined();
    expect(handle.state).toBe("interrupted");
  });

  it("surfaces a provider error instead of pretending it spoke", async () => {
    resetVoiceEvents();
    const transport = makeTransport({
      speak: vi.fn(async () => {
        throw new Error("ElevenLabs is unavailable.");
      }),
    });
    const provider = new ElevenLabsVoiceProvider(makeConfig(), { transport });
    const handle = await provider.createSession({});

    await expect(handle.sendText("Hello")).rejects.toThrow(/unavailable/i);
    expect(handle.state).toBe("error");
  });

  it("closes cleanly and emits session.closed", async () => {
    resetVoiceEvents();
    const provider = new ElevenLabsVoiceProvider(makeConfig(), {
      transport: makeTransport(),
    });
    const handle = await provider.createSession({});
    const events = collect(handle);

    await handle.close();

    expect(handle.state).toBe("closed");
    expect(events.some((e) => e.type === "session.closed")).toBe(true);
  });
});
