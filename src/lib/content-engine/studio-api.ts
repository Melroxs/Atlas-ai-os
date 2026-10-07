// ---------------------------------------------------------------------------
// Atlas Content Studio — the UI's single API surface.
//
// Every call goes through a Supabase RPC or a table read that enforces RLS (or
// an in-function guard). The page never talks to a provider, never sees a
// provider token, and never supplies an organization id — the server derives it.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase";
import { rpcCall } from "@/lib/actions/rpc";
import {
  createContentPackage,
  listContentConnections,
  listPackages,
  loadAutomation,
  loadContentPackage,
  loadStudioSummary,
  publishBlogPackage,
  reviewPackage,
  saveAutomation,
  upsertPublication,
  type StudioPackageRow,
} from "./client";
import type {
  ContentAutomationSettings,
  ContentPackageView,
  DestinationProvider,
} from "./types";
import {
  MAX_OVERLAY_LINES,
  MAX_OVERLAY_LINE_CHARS,
  THUMBNAIL_INPUT_CONTENT_TYPES,
  THUMBNAIL_OVERLAY_LINES_KEY,
} from "./types";
import {
  uploadManualMediaToPackage,
  type MediaUploadResult,
} from "./media-upload-client";
import type { ManualMediaKind } from "./media-upload";

function client(): SupabaseClient {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Atlas is not connected to Supabase in this environment.");
  }
  return supabase;
}

/** Slugify a topic into a URL-safe slug. Pure and stable. */
export function slugifyTopic(topic: string): string {
  return topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");
}

/** Keywords for an article, derived from its topic (never fabricated). */
export function keywordsForTopic(topic: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "your", "you",
    "why", "how", "what", "is", "are", "with", "that", "this", "it",
  ]);
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  // Deduplicated: a repeated word is one keyword, never two tags.
  return Array.from(new Set(words)).slice(0, 8);
}

export const contentStudio = {
  summary: () => loadStudioSummary(client()),
  packages: (limit = 40): Promise<StudioPackageRow[]> => listPackages(client(), limit),
  package: (packageId: string): Promise<ContentPackageView | null> =>
    loadContentPackage(client(), packageId),
  automation: (): Promise<ContentAutomationSettings> => loadAutomation(client()),

  /** Publishing accounts (YouTube / LinkedIn). Tokens are never returned. */
  connections: () => listContentConnections(client()),

  saveAutomation: (input: Parameters<typeof saveAutomation>[1]) =>
    saveAutomation(client(), input),

  review: (packageId: string, decision: "in_review" | "approved" | "rejected" | "needs_changes", note?: string) =>
    reviewPackage(client(), { packageId, decision, note: note ?? null }),

  publishBlog: (packageId: string, slug: string | null) =>
    publishBlogPackage(client(), { packageId, slug }),

  /**
   * Queue one destination. The publication row is written first (idempotent on
   * package+provider+asset) and only then is the durable job enqueued, so a
   * double click cannot fan out into two posts and a retry resumes the same row.
   */
  queueDestination: async (packageId: string, provider: DestinationProvider) => {
    const supabase = client();
    const row = await upsertPublication(supabase, {
      packageId,
      provider,
      assetId: null,
      scheduledAt: null,
    });
    const publicationId = String((row as Record<string, unknown>)["_id"] ?? "");
    await rpcCall(supabase, "content_engine_enqueue", {
      p_package: packageId,
      p_job_type:
        provider === "youtube"
          ? "content_publish_youtube"
          : provider === "linkedin"
            ? "content_publish_linkedin"
            : "content_publish_blog",
      p_payload: { package_id: packageId, publication_id: publicationId },
      p_idempotency_key: `content:publish:${provider}:${packageId}`,
    });
    return { publicationId };
  },

  /** Create the package and immediately queue its generation. */
  startPackage: async (input: { topic: string; title?: string }) => {
    const supabase = client();
    const topic = input.topic.trim();
    const title = (input.title ?? topic).trim();
    const created = await createContentPackage(supabase, {
      topic,
      title,
      slug: slugifyTopic(topic),
      tags: keywordsForTopic(topic),
    });
    if (!created.ok || !created.content_id) {
      throw new Error(created.error ?? "The content package could not be created.");
    }
    await rpcCall(supabase, "content_engine_enqueue", {
      p_package: created.content_id,
      p_job_type: "content_generate_package",
      p_payload: { package_id: created.content_id, topic, source: "studio" },
      p_idempotency_key: `content:generate:${created.content_id}`,
    });
    return { packageId: created.content_id };
  },

  /**
   * Attach an externally produced media file to this package.
   *
   * The browser sends bytes and a filename; the SERVER derives the organization
   * from the caller's session, the storage path from the verified organization
   * and package, and the stored MIME type from the file's magic bytes. It binds
   * the result to the EXISTING `youtube_thumbnail` / `youtube_video` asset, so a
   * replacement updates that asset in place rather than creating a second one.
   *
   * This never publishes anything: the package still has to be reviewed and
   * approved, exactly as before.
   */
  uploadMedia: async (
    packageId: string,
    kind: ManualMediaKind,
    file: File,
    externalSource?: string | null,
  ): Promise<MediaUploadResult> =>
    uploadManualMediaToPackage(packageId, { kind, file, externalSource: externalSource ?? null }),

  /**
   * Save the APPROVED overlay copy for a package's compositor thumbnail.
   *
   * This writes an INPUT asset (`thumbnail_overlay`) and nothing else: no
   * thumbnail is rendered, nothing is published, and the canonical
   * `youtube_thumbnail` is not touched. The rows are written in `drafted` /
   * `pending`, so the worker will refuse to compose from them until a human
   * approves them through the EXISTING review workflow (`reviewPackage`, i.e.
   * `content_review_decide`). There is no parallel approval system.
   */
  saveThumbnailOverlay: async (
    packageId: string,
    lines: string[],
  ): Promise<{ assetId: string | null; error?: string }> => {
    const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (trimmed.length === 0) {
      return { assetId: null, error: "Enter at least one overlay line." };
    }
    if (trimmed.length > MAX_OVERLAY_LINES) {
      return { assetId: null, error: `At most ${MAX_OVERLAY_LINES} overlay lines are supported.` };
    }
    const tooLong = trimmed.find((line) => line.length > MAX_OVERLAY_LINE_CHARS);
    if (tooLong !== undefined) {
      return {
        assetId: null,
        error: `Each line is limited to ${MAX_OVERLAY_LINE_CHARS} characters: "${tooLong.slice(0, 24)}…" is too long.`,
      };
    }
    const view = await loadContentPackage(client(), packageId);
    const asset = await rpcCall(client(), "content_asset_upsert", {
      p_package: packageId,
      p_content_type: THUMBNAIL_INPUT_CONTENT_TYPES.overlay,
      p_asset_type: THUMBNAIL_INPUT_CONTENT_TYPES.overlay,
      p_title: `${view?.title ?? "Atlas"} — thumbnail overlay`,
      // Human-readable convenience ONLY. metadata.overlayLines is authoritative.
      p_body: trimmed.join("\n"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p_metadata: { [THUMBNAIL_OVERLAY_LINES_KEY]: trimmed } as any,
      p_provider: "manual_upload",
      p_status: "drafted",
    } as never);
    return { assetId: String((asset as { _id?: unknown })?._id ?? "") || null };
  },

  /**
   * Regenerate one derivative. Each queues only its own job: regenerating a
   * thumbnail never restarts the article or the video, and the asset row is
   * updated in place rather than duplicated.
   */
  regenerate: async (
    packageId: string,
    kind: "article" | "video" | "thumbnail" | "linkedin",
  ) => {
    const jobType =
      kind === "article"
        ? "content_generate_package"
        : kind === "video"
          ? "content_generate_video"
          : kind === "thumbnail"
            ? "content_generate_thumbnail"
            : "content_write_linkedin";
    await rpcCall(client(), "content_engine_enqueue", {
      p_package: packageId,
      p_job_type: jobType,
      p_payload: { package_id: packageId, content_id: packageId, regenerate: true },
      // A fresh key per regeneration request is intentional: the user asked for
      // a NEW render. Idempotency for the provider call itself is enforced by
      // the publication row, not by this key.
      p_idempotency_key: `content:regen:${kind}:${packageId}:${Date.now()}`,
    });
  },
};
