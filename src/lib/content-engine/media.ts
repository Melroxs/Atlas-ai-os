// ---------------------------------------------------------------------------
// Atlas Content Engine — media generation providers
//
// The engine asks for "a video for this script" and "a thumbnail for this
// article". Which vendor renders it is configuration, never a code path in the
// engine: PixVerse (video) and NVIDIA NIM (image) are adapters here, and both
// are replaceable without touching the workflow, the jobs or the UI.
//
// API keys live ONLY in Supabase Edge Function secrets and are read through the
// injected `env` port. Nothing in this module reads process.env directly, so it
// runs unchanged in the browser bundle (where it is never given a key) and in
// the edge function (which is where the calls actually happen).
// ---------------------------------------------------------------------------

import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "./types";

// ---------------------------------------------------------------------------
// Video — PixVerse
// ---------------------------------------------------------------------------

export const PIXVERSE_API_KEY_ENV = "VIDEO_PROVIDER_API_KEY";
export const PIXVERSE_BASE_URL = "https://app-api.pixverse.ai/openapi/v2";
export const PIXVERSE_TRACE_HEADER = "Ai-trace-id";

/** PixVerse models and the clip lengths each one actually accepts.
 *  v3.5 / v4 / v4.5: 5 or 8 seconds.  v5 / v5.5 / v5.6: 5, 8 or 10.  v6 / c1: 1-15.
 *  Atlas defaults to the longest universally supported clip (8s) and renders a
 *  3-6 minute video as a PLAN of short clips that are assembled afterwards. */
export const PIXVERSE_DEFAULT_MODEL = "v3.5";
export const PIXVERSE_CLIP_DURATION = 8;
export const PIXVERSE_SUPPORTED: Record<string, number[]> = {
  "v3.5": [5, 8],
  v4: [5, 8],
  "v4.5": [5, 8],
  v5: [5, 8, 10],
  "v5.5": [5, 8, 10],
  "v5.6": [5, 8, 10],
  v6: Array.from({ length: 15 }, (_, i) => i + 1),
  c1: Array.from({ length: 15 }, (_, i) => i + 1),
};

/** A request-scoped trace id. PixVerse requires a unique `Ai-trace-id` per call. */
export function newTraceId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Clip duration the selected model supports. A requested duration the model
 * cannot render is never forwarded: the engine renders more, shorter clips
 * instead of sending a value the API rejects.
 */
export function pixVerseClipDuration(model: string, requested: number): number {
  const supported = PIXVERSE_SUPPORTED[model] ?? PIXVERSE_SUPPORTED[PIXVERSE_DEFAULT_MODEL];
  if (supported.includes(requested)) return requested;
  return supported.includes(PIXVERSE_CLIP_DURATION)
    ? PIXVERSE_CLIP_DURATION
    : supported[supported.length - 1];
}

/**
 * One PixVerse render = ONE SHORT CLIP.
 *
 * `request.durationSeconds` is a clip length, not the video length: the caller
 * derives it from the clip plan (see ./assemble.ts). A whole-video request is
 * clamped to a supported clip rather than sent as an invalid duration.
 */
export function buildPixVerseRequest(
  request: VideoGenerationRequest,
  options: { model?: string; traceId?: string } = {},
): Record<string, unknown> {
  const model = options.model ?? PIXVERSE_DEFAULT_MODEL;
  return {
    aspect_ratio: request.aspectRatio,
    duration: pixVerseClipDuration(model, request.durationSeconds),
    model,
    quality: "540p",
    prompt: [request.title, request.style, request.script].filter(Boolean).join("\n\n").slice(0, 5000),
  };
}

export const pixVerseVideoProvider: VideoGenerationProvider = {
  id: "pixverse",
  requiredEnvVars: [PIXVERSE_API_KEY_ENV],

  isConfigured(env) {
    return Boolean(env.get(PIXVERSE_API_KEY_ENV));
  },

  async generate(request, deps) {
    const key = deps.env.get(PIXVERSE_API_KEY_ENV);
    if (!key) {
      return {
        externalId: "",
        mediaUrl: null,
        storagePath: null,
        status: "failed",
        error: `${PIXVERSE_API_KEY_ENV} is not configured; no video provider is available.`,
      };
    }

    const model = deps.env.get("VIDEO_PROVIDER_MODEL") ?? PIXVERSE_DEFAULT_MODEL;
    const traceId = newTraceId();
    const response = await deps.transport({
      url: `${PIXVERSE_BASE_URL}/video/text/generate`,
      method: "POST",
      headers: {
        "api-key": key,
        "content-type": "application/json",
        // REQUIRED by the provider: a unique trace id per request.
        [PIXVERSE_TRACE_HEADER]: traceId,
      },
      body: buildPixVerseRequest(request, { model, traceId }),
    });

    if (!response.ok) {
      return {
        externalId: "",
        mediaUrl: null,
        storagePath: null,
        status: "failed",
        error: `The video provider rejected the render request (HTTP ${response.status}).`,
      };
    }

    const payload = (response.json ?? {}) as Record<string, unknown>;
    const data = (payload["Resp"] ?? payload["data"] ?? {}) as Record<string, unknown>;
    const externalId = data["video_id"] !== undefined ? String(data["video_id"]) : "";
    // Asynchronous by contract: a job id only, never a media URL.
    return {
      externalId,
      mediaUrl: null,
      storagePath: null,
      status: externalId ? "pending" : "failed",
      error: externalId ? undefined : "The video provider returned no render id.",
    };
  },

  async poll(externalId, deps) {
    const key = deps.env.get(PIXVERSE_API_KEY_ENV);
    if (!key) {
      return {
        externalId,
        mediaUrl: null,
        storagePath: null,
        status: "failed",
        error: "The video provider credential is no longer configured.",
      };
    }
    const response = await deps.transport({
      url: `${PIXVERSE_BASE_URL}/video/result/${encodeURIComponent(externalId)}`,
      method: "GET",
      headers: { "api-key": key, [PIXVERSE_TRACE_HEADER]: newTraceId() },
    });
    if (!response.ok) {
      return {
        externalId,
        mediaUrl: null,
        storagePath: null,
        status: "failed",
        error: `Could not read the render status (HTTP ${response.status}).`,
      };
    }
    const payload = (response.json ?? {}) as Record<string, unknown>;
    const data = (payload["Resp"] ?? payload["data"] ?? {}) as Record<string, unknown>;
    const status = String(data["status"] ?? "");
    const mediaUrl =
      typeof data["url"] === "string" ? (data["url"] as string) : null;

    if (status === "1" || status.toLowerCase() === "success") {
      // A completed render WITHOUT a URL is a failure, not a success: the engine
      // must never record a media reference the provider did not return.
      return mediaUrl
        ? { externalId, mediaUrl, storagePath: null, status: "ready" }
        : {
            externalId,
            mediaUrl: null,
            storagePath: null,
            status: "failed",
            error: "The video provider reported success without a media file.",
          };
    }
    if (status === "7" || status.toLowerCase() === "failed") {
      return {
        externalId,
        mediaUrl: null,
        storagePath: null,
        status: "failed",
        error: "The video provider reported the render as failed.",
      };
    }
    return { externalId, mediaUrl: null, storagePath: null, status: "pending" };
  },
};

// ---------------------------------------------------------------------------
// Video — deterministic local mock (tests + explicit local dev only)
// ---------------------------------------------------------------------------

/**
 * Enabled ONLY with `VIDEO_PROVIDER=local-mock`. It never reports a URL, so a
 * package that ran against the mock cannot be mistaken for a published video:
 * the asset is stored with status 'pending' and the UI shows it as such.
 */
export const localMockVideoProvider: VideoGenerationProvider = {
  id: "local-mock",
  requiredEnvVars: [],

  isConfigured() {
    return true;
  },

  async generate(request, deps) {
    const externalId = `mock-${deps.now()}-${request.outputPrefix.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
    return {
      externalId,
      mediaUrl: null,
      storagePath: null,
      status: "pending",
      error: undefined,
    };
  },

  async poll(externalId) {
    return {
      externalId,
      mediaUrl: null,
      storagePath: null,
      status: "ready",
      error: undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Image — NVIDIA NIM (already an Atlas AI provider; no new vendor or key)
// ---------------------------------------------------------------------------

export const IMAGE_API_KEY_ENV = "IMAGE_PROVIDER_API_KEY";
export const IMAGE_PROVIDER_BASE_URL_ENV = "IMAGE_PROVIDER_BASE_URL";
export const IMAGE_PROVIDER_MODEL_ENV = "IMAGE_PROVIDER_MODEL";

/**
 * Atlas has NO verified image-generation endpoint. The AI runtime
 * (NVIDIA NIM) is wired for CHAT COMPLETIONS only, and its own runtime report
 * records live image validation as unverified. So this adapter refuses to guess
 * an endpoint or a model: both are explicit configuration, and without them the
 * provider reports NOT CONFIGURED instead of pretending a thumbnail exists.
 */
export function buildImageRequest(
  request: ImageGenerationRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    width: request.width,
    height: request.height,
    // One image per package: the thumbnail is the shared visual identity, not
    // a pool of candidates to choose from after the fact.
    n: 1,
    response_format: "url",
  };
}

export const IMAGE_PROVIDER_REQUIRED = [
  IMAGE_API_KEY_ENV,
  IMAGE_PROVIDER_BASE_URL_ENV,
  IMAGE_PROVIDER_MODEL_ENV,
];

export const nvidiaNimImageProvider: ImageGenerationProvider = {
  id: "nvidia-nim",
  requiredEnvVars: IMAGE_PROVIDER_REQUIRED,

  isConfigured(env) {
    return Boolean(
      (env.get(IMAGE_API_KEY_ENV) ?? env.get("NVIDIA_NIM_API_KEY")) &&
        env.get(IMAGE_PROVIDER_BASE_URL_ENV) &&
        env.get(IMAGE_PROVIDER_MODEL_ENV),
    );
  },

  async generate(request, deps) {
    const key = deps.env.get(IMAGE_API_KEY_ENV) ?? deps.env.get("NVIDIA_NIM_API_KEY");
    const baseUrl = deps.env.get(IMAGE_PROVIDER_BASE_URL_ENV);
    const model = deps.env.get(IMAGE_PROVIDER_MODEL_ENV);
    if (!key || !baseUrl || !model) {
      return {
        externalId: "",
        imageUrl: null,
        storagePath: null,
        status: "failed",
        error:
          `No verified image provider is configured. Set ${IMAGE_PROVIDER_BASE_URL_ENV} and ` +
          `${IMAGE_PROVIDER_MODEL_ENV} (and ${IMAGE_API_KEY_ENV}) to the provider Atlas should use. ` +
          "No thumbnail was generated.",
      };
    }
    const response = await deps.transport({
      url: baseUrl.replace(/\/+$/, ""),
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: buildImageRequest(request, model),
    });
    if (!response.ok) {
      return {
        externalId: "",
        imageUrl: null,
        storagePath: null,
        status: "failed",
        error: `The image provider rejected the request (HTTP ${response.status}).`,
      };
    }
    const payload = (response.json ?? {}) as Record<string, unknown>;
    const list = Array.isArray(payload["data"]) ? (payload["data"] as Array<Record<string, unknown>>) : [];
    const imageUrl = typeof list[0]?.["url"] === "string" ? (list[0]["url"] as string) : null;
    if (!imageUrl) {
      return {
        externalId: "",
        imageUrl: null,
        storagePath: null,
        status: "failed",
        error: "The image provider returned no image.",
      };
    }
    return {
      externalId: `${deps.now()}`,
      imageUrl,
      storagePath: null,
      status: "ready",
    };
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ProviderEnv {
  get(key: string): string | null;
}

export const VIDEO_PROVIDERS: VideoGenerationProvider[] = [
  pixVerseVideoProvider,
  localMockVideoProvider,
];

export const IMAGE_PROVIDERS: ImageGenerationProvider[] = [
  nvidiaNimImageProvider,
];

/**
 * Pick the configured video provider. Returns null when NOTHING is configured
 * so the job fails loudly with an actionable message instead of inventing a
 * video — a missing provider is a configuration state, not a creative choice.
 */
export function resolveVideoProvider(env: ProviderEnv): VideoGenerationProvider | null {
  const requested = env.get("VIDEO_PROVIDER")?.trim();
  if (requested) {
    const match = VIDEO_PROVIDERS.find((p) => p.id === requested);
    if (match && match.isConfigured(env)) return match;
    return null;
  }
  return VIDEO_PROVIDERS.find((p) => p.id !== "local-mock" && p.isConfigured(env)) ?? null;
}

export function resolveImageProvider(env: ProviderEnv): ImageGenerationProvider | null {
  const requested = env.get("IMAGE_PROVIDER")?.trim();
  if (requested) {
    const match = IMAGE_PROVIDERS.find((p) => p.id === requested);
    if (match && match.isConfigured(env)) return match;
    return null;
  }
  return IMAGE_PROVIDERS.find((p) => p.isConfigured(env)) ?? null;
}

/** Which media providers are ready, for the Content Studio settings screen. */
export function mediaProviderStatus(env: ProviderEnv): {
  video: { id: string; configured: boolean; requires: string[] };
  image: { id: string; configured: boolean; requires: string[] };
} {
  const video = resolveVideoProvider(env);
  const image = resolveImageProvider(env);
  return {
    video: {
      id: video?.id ?? "none",
      configured: Boolean(video),
      requires: video?.requiredEnvVars ?? [PIXVERSE_API_KEY_ENV],
    },
    image: {
      id: image?.id ?? "none",
      configured: Boolean(image),
      requires: image?.requiredEnvVars ?? IMAGE_PROVIDER_REQUIRED,
    },
  };
}
