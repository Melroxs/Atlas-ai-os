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
