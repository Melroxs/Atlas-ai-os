/**
 * Tests for the ElevenLabs Speech Engine server helper
 * (supabase/functions/_shared/elevenlabs.ts).
 *
 * The module reads its API key from Deno.env at call time and calls the
 * ElevenLabs HTTP API, so — exactly like the existing Paddle helper tests — we
 * stub a minimal Deno global and mock globalThis.fetch. No request leaves the
 * test process and no real credential is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElevenLabsError,
  ELEVENLABS_DEFAULT_STT_MODEL_ID,
  elevenLabsCapabilities,
  elevenLabsSynthesize,
  elevenLabsTranscribe,
  isElevenLabsConfigured,
  mimeTypeForOutputFormat,
} from "./elevenlabs";

const SECRET_KEY = "sk_test_atlas_voice_secret";

function stubDeno(env: Record<string, string>) {
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: { get: (key: string) => env[key] },
  };
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  stubDeno({ ELEVENLABS_API_KEY: SECRET_KEY });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("elevenlabs config", () => {
  it("reports configured only when the key is present", () => {
    stubDeno({ ELEVENLABS_API_KEY: SECRET_KEY });
    expect(isElevenLabsConfigured()).toBe(true);
    stubDeno({});
    expect(isElevenLabsConfigured()).toBe(false);
  });

  it("never exposes the API key through the client-safe capabilities", () => {
    const capabilities = elevenLabsCapabilities();
    expect(capabilities.configured).toBe(true);
    expect(JSON.stringify(capabilities)).not.toContain(SECRET_KEY);
    expect(Object.keys(capabilities)).not.toContain("apiKey");
  });
});

describe("mimeTypeForOutputFormat", () => {
  it("maps ElevenLabs output formats to audio MIME types", () => {
    expect(mimeTypeForOutputFormat("mp3_44100_128")).toBe("audio/mpeg");
    expect(mimeTypeForOutputFormat("opus_48000_64")).toBe("audio/ogg");
    expect(mimeTypeForOutputFormat("pcm_16000")).toBe("audio/L16");
    expect(mimeTypeForOutputFormat("ulaw_8000")).toBe("audio/basic");
  });
});

describe("elevenLabsSynthesize", () => {
  it("posts to the documented TTS endpoint with the key only in the header", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(
      async () => new Response(audio, { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsSynthesize("Opened the Carter claim.");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe(SECRET_KEY);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.text).toBe("Opened the Carter claim.");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    // The key must never travel in the body or the URL.
    expect(String(init.body)).not.toContain(SECRET_KEY);
    expect(url).not.toContain(SECRET_KEY);

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.audio.byteLength).toBe(4);
  });

  it("honors an explicit voice and model override", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await elevenLabsSynthesize("hi", { voiceId: "voice-xyz", modelId: "eleven_flash_v2_5" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/text-to-speech/voice-xyz");
    expect(JSON.parse(String(init.body)).model_id).toBe("eleven_flash_v2_5");
  });

  it("fails closed when no key is configured", async () => {
    stubDeno({});
    await expect(elevenLabsSynthesize("hello")).rejects.toBeInstanceOf(ElevenLabsError);
  });

  it("rejects empty text instead of calling the provider", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(elevenLabsSynthesize("   ")).rejects.toMatchObject({ code: "empty_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 429 onto a rate-limit error and hides the provider body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("quota_exceeded for account 42", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(elevenLabsSynthesize("hello")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("maps a 401 onto an auth error without leaking detail", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(`invalid key ${SECRET_KEY}`, { status: 401 }),
    ) as unknown as typeof fetch;

    const error = await elevenLabsSynthesize("hello").catch((e: unknown) => e);
    expect((error as ElevenLabsError).code).toBe("auth_failed");
    expect((error as Error).message).not.toContain(SECRET_KEY);
  });
});

describe("elevenLabsTranscribe", () => {
  it("posts multipart audio to the documented STT endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ text: "what's missing", language_code: "en", words: [{}, {}] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await elevenLabsTranscribe(new Uint8Array([7, 7, 7]), {
      mimeType: "audio/webm",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(SECRET_KEY);

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model_id")).toBe(ELEVENLABS_DEFAULT_STT_MODEL_ID);
    expect(form.get("file")).toBeTruthy();

    expect(result.text).toBe("what's missing");
    expect(result.languageCode).toBe("en");
    expect(result.wordCount).toBe(2);
  });

  it("returns an empty transcript honestly rather than inventing text", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await elevenLabsTranscribe(new Uint8Array([1]));
    expect(result.text).toBe("");
  });

  it("rejects empty audio before calling the provider", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(elevenLabsTranscribe(new Uint8Array(0))).rejects.toMatchObject({
      code: "empty_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized recording with a clear error", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(elevenLabsTranscribe(new Uint8Array(6 * 1024 * 1024))).rejects.toMatchObject({
      code: "invalid_request",
      status: 413,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
