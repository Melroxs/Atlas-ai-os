// ---------------------------------------------------------------------------
// Atlas Content Engine — clip plan and durable render state (edge copy)
//
// A text-to-video provider renders SHORT clips; it does not render a 3-6 minute
// video in one call. The engine therefore plans the video as N clips, renders
// them through the provider one at a time, and assembles them afterwards. That
// plan is the durable render state: it is persisted on the `youtube_video`
// asset, so a crash, a retry or a redeploy resumes the SAME renders instead of
// paying for them twice.
//
// The Deployed Edge Function bundle cannot reach `src/`, so this is a copy of
// the pure half of `src/lib/content-engine/assemble.ts`, under the same
// parity-test guarantee the repo already uses for the integration primitives
// (`src/lib/content-engine/assemble-parity.test.ts`). Both copies are executed
// against identical vectors, so the plan the worker builds is the plan the
// tests describe.
// ---------------------------------------------------------------------------

export const DEFAULT_TARGET_VIDEO_SECONDS = 300; // 5 minutes, mid-range.
export const MIN_TARGET_VIDEO_SECONDS = 180; // 3 minutes.
export const MAX_TARGET_VIDEO_SECONDS = 360; // 6 minutes.
export const MAX_CLIPS = 24;

export type ClipStatus = "pending" | "submitted" | "ready" | "failed";

export interface Clip {
  index: number;
  prompt: string;
  durationSeconds: number;
  status: ClipStatus;
  providerJobId: string | null;
  mediaUrl: string | null;
  error: string | null;
}

export interface ClipPlan {
  targetDurationSeconds: number;
  clipDurationSeconds: number;
  clips: Clip[];
  truncated: boolean;
}

/** Clamp a requested target into the supported 3-6 minute band. */
export function clampTargetDuration(seconds: number | null | undefined): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : DEFAULT_TARGET_VIDEO_SECONDS;
  return Math.min(MAX_TARGET_VIDEO_SECONDS, Math.max(MIN_TARGET_VIDEO_SECONDS, Math.round(value)));
}

/** Clamp a provider clip duration to something every text-to-video API accepts. */
export function clampClipDuration(seconds: number | null | undefined, fallback = 5): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallback;
  return Math.min(15, Math.max(1, Math.round(value)));
}

function scenesFrom(script: string): string[] {
  const sections = script
    .split(/\n(?=##\s|\n?\d+\.\s)/)
    .map((chunk) => chunk.replace(/^#+\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter((chunk) => chunk.length > 0);
  return sections.length > 0 ? sections : [script.trim()].filter(Boolean);
}

/** Build the clip plan. Deterministic: same script + same capability => same plan. */
export function planClips(input: {
  script: string;
  title: string;
  targetDurationSeconds?: number;
  clipDurationSeconds: number;
  maxClips?: number;
}): ClipPlan {
  const clipDuration = clampClipDuration(input.clipDurationSeconds);
  const target = clampTargetDuration(input.targetDurationSeconds);
  const maxClips = Math.max(1, Math.min(input.maxClips ?? MAX_CLIPS, MAX_CLIPS));

  const scenes = scenesFrom(input.script);
  const wanted = Math.ceil(target / clipDuration);
  // The plan is sized by the TARGET LENGTH, not by how many scenes the script
  // happens to have: a short script still has to reach the 3-6 minute band, so
  // the scenes are spread across as many clips as the length needs and the
  // last scene is developed further once they run out. Capping the count at the
  // scene count would silently produce a 24-second "5 minute" video.
  const count = Math.max(1, Math.min(wanted, maxClips));

  const clips: Clip[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.min(scenes.length - 1, Math.floor((i * scenes.length) / count));
    const to = Math.max(from + 1, Math.floor(((i + 1) * scenes.length) / count));
    const body = scenes.slice(from, to).join(" ").replace(/\s+/g, " ").trim();
    const prompt = `${i === 0 ? `${input.title}. ` : ""}${body}`.slice(0, 2000);
    clips.push({
      index: i,
      prompt,
      durationSeconds: clipDuration,
      status: "pending",
      providerJobId: null,
      mediaUrl: null,
      error: null,
    });
  }

  return {
    targetDurationSeconds: target,
    clipDurationSeconds: clipDuration,
    clips,
    truncated: clipDuration * count < target,
  };
}

// ---------------------------------------------------------------------------
// The single next action. The worker never loops over the plan in one request;
// it performs exactly this action and requeues.
// ---------------------------------------------------------------------------

export type RenderAction =
  | { kind: "submit"; clip: Clip }
  | { kind: "poll"; clip: Clip; jobId: string }
  | { kind: "assemble"; plan: ClipPlan }
  | { kind: "wait"; reason: string };

export function nextRenderAction(plan: ClipPlan): RenderAction {
  const next = plan.clips.find((c) => c.status === "pending");
  if (next) return { kind: "submit", clip: next };

  const submitted = plan.clips.find((c) => c.status === "submitted");
  if (submitted) {
    return submitted.providerJobId
      ? { kind: "poll", clip: submitted, jobId: submitted.providerJobId }
      : { kind: "wait", reason: "clip_submitted_without_provider_job_id" };
  }

  const failed = plan.clips.find((c) => c.status === "failed");
  if (failed) return { kind: "wait", reason: `clip_${failed.index}_failed` };

  return { kind: "assemble", plan };
}

export function markSubmitted(plan: ClipPlan, index: number, providerJobId: string): ClipPlan {
  return withClip(plan, index, (clip) => ({
    ...clip,
    status: "submitted",
    providerJobId,
    error: null,
  }));
}

export function markReady(plan: ClipPlan, index: number, mediaUrl: string): ClipPlan {
  return withClip(plan, index, (clip) => ({ ...clip, status: "ready", mediaUrl, error: null }));
}

export function markFailed(plan: ClipPlan, index: number, error: string): ClipPlan {
  return withClip(plan, index, (clip) => ({ ...clip, status: "failed", error }));
}

function withClip(plan: ClipPlan, index: number, fn: (clip: Clip) => Clip): ClipPlan {
  return { ...plan, clips: plan.clips.map((clip) => (clip.index === index ? fn(clip) : clip)) };
}

/** True when every clip is ready — the only state an assembly may depend on. */
export function isPlanComplete(plan: ClipPlan): boolean {
  return plan.clips.length > 0 && plan.clips.every((c) => c.status === "ready");
}

/** Rebuild a plan from persisted metadata, or null when it is not a plan. */
export function planFromMetadata(value: unknown): ClipPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["targetDurationSeconds"] !== "number" || !Array.isArray(raw["clips"])) return null;
  const clips = (raw["clips"] as unknown[])
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry["index"] === "number")
    .map((entry) => ({
      index: Number(entry["index"]),
      prompt: String(entry["prompt"] ?? ""),
      durationSeconds: Number(entry["durationSeconds"] ?? 5),
      status: (entry["status"] as ClipStatus | undefined) ?? "pending",
      providerJobId: (entry["providerJobId"] as string | null) ?? null,
      mediaUrl: (entry["mediaUrl"] as string | null) ?? null,
      error: (entry["error"] as string | null) ?? null,
    }))
    .sort((a, b) => a.index - b.index);
  if (clips.length === 0) return null;
  return {
    targetDurationSeconds: Number(raw["targetDurationSeconds"]),
    clipDurationSeconds: Number(raw["clipDurationSeconds"] ?? 5),
    clips,
    truncated: Boolean(raw["truncated"]),
  };
}

/** How the plan is persisted on the `youtube_video` asset's metadata. */
export function planToMetadata(plan: ClipPlan): Record<string, unknown> {
  return {
    renderStatus: isPlanComplete(plan) ? "clips_complete" : "rendering",
    targetDurationSeconds: plan.targetDurationSeconds,
    clipDurationSeconds: plan.clipDurationSeconds,
    truncated: plan.truncated,
    clips: plan.clips,
  };
}
