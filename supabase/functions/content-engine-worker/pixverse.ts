// ---------------------------------------------------------------------------
// Atlas Content Engine — PixVerse contract (edge copy)
//
// The Deployed Edge Function bundle cannot reach `src/`, so the worker keeps a
// copy of the provider contract that lives canonically in
// `src/lib/content-engine/media.ts`. This is the same arrangement, and the same
// guarantee, as `_shared/integration/primitives.ts`: a PARITY TEST executes both
// copies against identical vectors (see
// `src/lib/content-engine/pixverse-parity.test.ts`), so the worker's request can
// never drift from the tested one.
//
// The contract it encodes (docs.platform.pixverse.ai):
//   * `Ai-trace-id` is REQUIRED and must be unique per request;
//   * duration is a CLIP length, not a video length — 5/8 for v3.5/v4/v4.5,
//     5/8/10 for v5.x, 1-15 for v6/c1;
//   * generation is ASYNCHRONOUS: the response carries a `video_id`, never a
//     media URL;
//   * the result endpoint reports status 1 = success, 5 = generating,
//     7 = moderation failed.
// ---------------------------------------------------------------------------

export const PIXVERSE_BASE_URL = "https://app-api.pixverse.ai/openapi/v2";
export const PIXVERSE_TRACE_HEADER = "Ai-trace-id";
export const PIXVERSE_API_KEY_HEADER = "api-key";
export const PIXVERSE_DEFAULT_MODEL = "v3.5";
export const PIXVERSE_CLIP_DURATION = 8;
export const PIXVERSE_PROMPT_MAX = 5000;

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

/** A request-scoped trace id. The provider rejects a request without one. */
export function newTraceId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Clip duration the selected model actually accepts. A duration the model cannot
 * render is never forwarded — the engine renders more, shorter clips instead of
 * sending a value the API rejects. This is what makes `duration: 300` (the 5
 * minute TARGET) impossible to send by accident.
 */
export function pixVerseClipDuration(model: string, requested: number): number {
  const supported = PIXVERSE_SUPPORTED[model] ?? PIXVERSE_SUPPORTED[PIXVERSE_DEFAULT_MODEL];
  if (supported.includes(requested)) return requested;
  return supported.includes(PIXVERSE_CLIP_DURATION)
    ? PIXVERSE_CLIP_DURATION
    : supported[supported.length - 1];
}

export interface RenderRequestInput {
  aspectRatio: string;
  /** ONE clip length, taken from the clip plan. Never the target video length. */
  durationSeconds: number;
  title: string;
  style: string;
  script: string;
}

/** The JSON body for POST /video/text/generate. */
export function buildRenderRequest(
  request: RenderRequestInput,
  options: { model?: string } = {},
): Record<string, unknown> {
  const model = options.model ?? PIXVERSE_DEFAULT_MODEL;
  return {
    aspect_ratio: request.aspectRatio,
    duration: pixVerseClipDuration(model, request.durationSeconds),
    model,
    quality: "540p",
    prompt: [request.title, request.style, request.script]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, PIXVERSE_PROMPT_MAX),
  };
}

export function renderUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/video/text/generate`;
}

export function resultUrl(baseUrl: string, videoId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/video/result/${encodeURIComponent(videoId)}`;
}

export type RenderState = "pending" | "ready" | "failed";

export interface RenderResult {
  state: RenderState;
  /** Only ever a URL the provider returned. Never synthesised. */
  mediaUrl: string | null;
  error: string | null;
}

/**
 * Read the provider's result payload. A SUCCESS without a media file is a
 * failure, not a success: the engine must never record a media reference the
 * provider did not return, because that is how a package ends up claiming a
 * video that does not exist.
 */
export function readRenderResult(payload: unknown): RenderResult {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root["Resp"] ?? root["data"] ?? {}) as Record<string, unknown>;
  const status = String(data["status"] ?? "");
  const mediaUrl = typeof data["url"] === "string" ? (data["url"] as string) : null;

  if (status === "1" || status.toLowerCase() === "success") {
    return mediaUrl
      ? { state: "ready", mediaUrl, error: null }
      : {
          state: "failed",
          mediaUrl: null,
          error: "The video provider reported success without a media file.",
        };
  }
  if (status === "7" || status.toLowerCase() === "failed") {
    return { state: "failed", mediaUrl: null, error: "The video provider rejected this render." };
  }
  // 5 = generating. Anything unrecognised is treated as still-running rather
  // than as a failure, so an unknown status cannot destroy a good render.
  return { state: "pending", mediaUrl: null, error: null };
}

/** The provider job id from a generate response, or null. */
export function readVideoId(payload: unknown): string | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root["Resp"] ?? root["data"] ?? {}) as Record<string, unknown>;
  const id = data["video_id"] ?? data["id"];
  return id === undefined || id === null ? null : String(id);
}
