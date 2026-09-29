// ---------------------------------------------------------------------------
// Atlas Content Engine — video length, clips and assembly
//
// The Content Engine's product requirement is a 3-6 minute video. Text-to-video
// providers do NOT offer that: PixVerse, for example, renders short clips (5 or
// 8 seconds on v3.5/v4/v4.5, 1-15 on v6/c1). Pretending otherwise by sending
// `duration: 300` would be a request the provider rejects, so the engine models
// the real capability instead:
//
//   ARTICLE -> SCRIPT -> CLIP PLAN -> N short provider clips -> ASSEMBLY -> FINAL
//
// This module is pure and provider-agnostic: it knows nothing about PixVerse, it
// only knows how many clips a target length needs, how to track them durably,
// and what has to be true before a video may be published.
//
// `VideoAssembler` is the single seam where a real concatenator (ffmpeg worker,
// Mux/Shotstack, a storage-backed compose job) plugs in. Until one is
// configured, the default assembler reports `needs_assembler` — it never
// fabricates a media URL.
// ---------------------------------------------------------------------------

import type { VideoGenerationRequest } from "./types";

export const DEFAULT_TARGET_VIDEO_SECONDS = 300; // 5 minutes, mid-range.
export const MIN_TARGET_VIDEO_SECONDS = 180; // 3 minutes.
export const MAX_TARGET_VIDEO_SECONDS = 360; // 6 minutes.

/** Hard cap on provider calls per video, so a bad plan cannot run away. */
export const MAX_CLIPS = 24;

export type ClipStatus =
  | "pending" // not submitted yet
  | "submitted" // provider has a job id, not polled
  | "ready" // provider returned a media URL
  | "failed"; // provider reported failure

export interface Clip {
  index: number;
  /** The scene text sent to the provider. */
  prompt: string;
  durationSeconds: number;
  status: ClipStatus;
  /** Provider job id, persisted so a retry polls the SAME render. */
  providerJobId: string | null;
  /** Only ever set by a provider response. Never synthesised. */
  mediaUrl: string | null;
  error: string | null;
}

export interface ClipPlan {
  /** The full target length the package asked for. */
  targetDurationSeconds: number;
  /** What one provider call can render. Provider capability, not a wish. */
  clipDurationSeconds: number;
  clips: Clip[];
  /** True when clipDuration x clips cannot reach the target. */
  truncated: boolean;
}

export interface PlanClipsInput {
  /** The video script, or the article body when no script exists yet. */
  script: string;
  title: string;
  targetDurationSeconds?: number;
  /** What the configured provider can actually render in one call. */
  clipDurationSeconds: number;
  maxClips?: number;
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

/** Split a script into scene-sized chunks, deterministically. */
function scenesFrom(script: string): string[] {
  const sections = script
    .split(/\n(?=##\s|\n?\d+\.\s)/)
    .map((chunk) => chunk.replace(/^#+\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter((chunk) => chunk.length > 0);
  return sections.length > 0 ? sections : [script.trim()].filter(Boolean);
}

/**
 * Build the clip plan for a video. Deterministic: the same script and the same
 * provider capability always produce the same plan, which is what makes the
 * durable render state testable and resumable.
 */
export function planClips(input: PlanClipsInput): ClipPlan {
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

  // Spread the script's scenes across exactly `count` clips, so no scene is
  // dropped. When there are more clips than scenes the tail of the script is
  // the source for the extra ones: deterministic, and never a scene invented
  // that the article does not contain.
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
// Durable render state
// ---------------------------------------------------------------------------

export type RenderAction =
  | { kind: "submit"; clip: Clip }
  | { kind: "poll"; clip: Clip; jobId: string }
  | { kind: "assemble"; plan: ClipPlan }
  | { kind: "wait"; reason: string };

/** Start (or resume) a plan: the first not-yet-submitted clip is submitted. */
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
  if (failed) {
    return { kind: "wait", reason: `clip_${failed.index}_failed` };
  }

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

/** True when every clip is ready — the only state a publish may depend on. */
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

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type AssemblyResult =
  | { status: "ready"; mediaUrl: string; storagePath: string | null; provider: string }
  | { status: "needs_assembler"; reason: string }
  | { status: "failed"; error: string };

export interface VideoAssembler {
  id: string;
  isConfigured(): boolean;
  /**
   * Concatenate the ready clips into one file. Implementations must return a
   * URL that actually exists; returning one without producing a file is a lie
   * the engine cannot detect, which is why the default below refuses instead.
   */
  assemble(plan: ClipPlan): Promise<AssemblyResult>;
}

/**
 * The default assembler: honest, not capable. Atlas has no media concatenator
 * today (no ffmpeg worker, no media bucket), so this reports exactly that. It
 * exists so the workflow has a defined seam and so a package can never claim a
 * video that was never assembled.
 */
export const missingVideoAssembler: VideoAssembler = {
  id: "none",
  isConfigured: () => false,
  assemble: async (plan) => ({
    status: "needs_assembler",
    reason:
      plan.clips.length > 0 && isPlanComplete(plan)
        ? "All provider clips are ready, but no video assembler is configured. " +
          "Concatenate the clips to a single file, or configure an assembler, before publishing."
        : "Clips are still rendering; assembly runs once every clip is ready.",
  }),
};

/**
 * The request the engine sends for ONE clip. The clip duration is the provider's
 * capability, never the target video length.
 */
export function clipRequestFrom(
  plan: ClipPlan,
  clip: Clip,
  input: Omit<VideoGenerationRequest, "script" | "durationSeconds"> & { style: string },
): VideoGenerationRequest {
  return {
    ...input,
    script: clip.prompt,
    durationSeconds: clip.durationSeconds,
  };
}
