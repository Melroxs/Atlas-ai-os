// ---------------------------------------------------------------------------
// Atlas Content Engine — package logic (pure, no I/O)
//
// The package is the unit of work: one blog article, the assets derived from
// it, and one publication record per destination. Nothing here publishes,
// talks to a provider or reads the database — the job handlers do that, and
// they call these functions to decide what a package still needs.
// ---------------------------------------------------------------------------

import type { ContentAssetRecord, ContentPublicationRecord } from "./types";
import {
  ASSET_DESTINATION,
  ASSET_TYPES,
  DESTINATION_LABEL,
  type AssetType,
  type ContentPackageView,
  type DestinationProvider,
  type DestinationState,
  type PublishErrorClass,
} from "./types";

// ---------------------------------------------------------------------------
// Asset lookup
// ---------------------------------------------------------------------------

/** The package's asset of one type, or null. Never invents a placeholder. */
export function assetOf(
  view: Pick<ContentPackageView, "assets">,
  assetType: AssetType,
): ContentAssetRecord | null {
  return (
    view.assets.find((a) => a.assetType === assetType) ?? null
  );
}

/** The asset that a destination publishes, or null when it is not generated. */
export function destinationAsset(
  view: Pick<ContentPackageView, "assets">,
  provider: DestinationProvider,
): ContentAssetRecord | null {
  const assetType = (Object.keys(ASSET_DESTINATION) as AssetType[]).find(
    (t) => ASSET_DESTINATION[t] === provider,
  );
  if (assetType === "blog_article") {
    return assetOf(view, "blog_article");
  }
  return assetType ? assetOf(view, assetType) : null;
}

/** Missing asset types for a package, in generation order. */
export function missingAssets(
  view: Pick<ContentPackageView, "assets">,
): AssetType[] {
  return ASSET_TYPES.filter((t) => !assetOf(view, t));
}

// ---------------------------------------------------------------------------
// Publication state
// ---------------------------------------------------------------------------

export function publicationFor(
  view: Pick<ContentPackageView, "publications">,
  provider: DestinationProvider,
): ContentPublicationRecord | null {
  return view.publications.find((p) => p.provider === provider) ?? null;
}

/** A publication that must not be sent again. */
export function isTerminal(publication: ContentPublicationRecord | null): boolean {
  return publication?.status === "published" || publication?.status === "cancelled";
}

/** The lease a worker holds on an in-flight publication. Mirrors
 *  atlas_jobs locked_at / lock_expires_at (20260918) and the publication
 *  table's own lockedAt / lockExpiresAt columns. */
export interface PublicationLease {
  lockedAt: number | null;
  lockExpiresAt: number | null;
}

export const PUBLICATION_LEASE_MS = 300_000;

/**
 * Whether a worker may take a publication.
 *
 *   queued | failed                        -> claimable
 *   processing + lease still valid         -> a live worker owns it
 *   processing + lease expired/absent      -> reclaimable (the owner died)
 *   published | cancelled                  -> never
 *
 * This mirrors public.content_publication_claim exactly; the type-level mirror
 * exists so the decision is testable offline and cannot drift silently.
 */
export function claimEligibility(
  publication: (ContentPublicationRecord & PublicationLease) | null,
  now: number,
): "claimable" | "lease_held" | "terminal" | "absent" {
  if (!publication) return "absent";
  if (publication.status === "published" || publication.status === "cancelled") return "terminal";
  if (publication.status === "processing") {
    if (publication.lockExpiresAt !== null && publication.lockExpiresAt > now) {
      return "lease_held";
    }
    return "claimable";
  }
  return "claimable";
}

/**
 * Can a retry skip the provider call because the external artefact already
 * exists? This is what makes a crash between provider success and completion
 * recoverable WITHOUT posting twice.
 */
export function alreadyPublished(publication: ContentPublicationRecord | null): boolean {
  return (
    publication?.status === "published" &&
    typeof publication.externalId === "string" &&
    publication.externalId.length > 0
  );
}

/**
 * Human-readable, actionable recovery text for a failed publication.
 * A provider's raw message never reaches the user.
 */
export function describePublishFailure(
  provider: DestinationProvider,
  errorClass: PublishErrorClass | null,
): string {
  const label = DESTINATION_LABEL[provider];
  switch (errorClass) {
    case "not_connected":
      return `${label} is not connected. Connect ${label} to publish.`;
    case "token_expired":
      return `${label} authorization expired. Reconnect ${label} to continue publishing.`;
    case "authorization_revoked":
      return `${label} access was revoked or the scopes changed. Reconnect ${label} with publishing permissions.`;
    case "rate_limited":
      return `${label} is rate limiting Atlas. The publication will retry automatically.`;
    case "invalid_content":
      return `${label} rejected the content. Review the asset and try again.`;
    case "network_error":
      return `${label} could not be reached. Atlas will retry.`;
    case "provider_error":
      return `${label} returned an error. Review the asset and retry.`;
    default:
      return `${label} publishing failed. Review the asset and retry.`;
  }
}

/** Map a provider/transport failure onto an actionable error class. */
export function classifyPublishError(input: {
  status?: number;
  code?: string | null;
  message?: string | null;
}): PublishErrorClass {
  const code = (input.code ?? "").toLowerCase();
  const message = (input.message ?? "").toLowerCase();

  if (
    code === "invalid_grant" ||
    code === "unauthorized_client" ||
    message.includes("invalid_grant") ||
    message.includes("token has been expired or revoked")
  ) {
    return "token_expired";
  }
  if (code === "insufficient_scope" || message.includes("insufficient permission")) {
    return "authorization_revoked";
  }
  if (input.status === 401 || code === "unauthenticated") return "token_expired";
  if (input.status === 403) return "authorization_revoked";
  if (input.status === 429 || code === "rate_limited") return "rate_limited";
  if (input.status === 400 || input.status === 422) return "invalid_content";
  if (input.status !== undefined && input.status >= 500) return "provider_error";
  if (message.includes("fetch failed") || message.includes("network")) {
    return "network_error";
  }
  if (message.includes("not connected") || code === "not_connected") {
    return "not_connected";
  }
  return "unknown";
}

/** A failure that is worth retrying without human intervention. */
export function isRetryable(errorClass: PublishErrorClass): boolean {
  return (
    errorClass === "rate_limited" ||
    errorClass === "network_error" ||
    errorClass === "provider_error" ||
    errorClass === "unknown"
  );
}

/**
 * The state of one destination: its publication, its terminal status, and what
 * the user should do next. Destinations are independent — a failed LinkedIn
 * post never invalidates a published blog article.
 */
export function destinationState(
  view: ContentPackageView,
  provider: DestinationProvider,
): DestinationState {
  const publication = publicationFor(view, provider);
  const terminal = isTerminal(publication);
  const status = publication?.status ?? "not_queued";

  if (!publication) {
    const asset = destinationAsset(view, provider);
    const ready =
      provider === "blog" ? view.status === "approved" || view.status === "published" : Boolean(asset);
    return {
      provider,
      publication: null,
      status: "not_queued",
      terminal: false,
      nextAction: ready
        ? `Ready to publish to ${DESTINATION_LABEL[provider]}`
        : provider === "blog"
          ? "Approve the article before publishing"
          : `Generate the ${DESTINATION_LABEL[provider]} asset first`,
    };
  }

  if (publication.status === "failed") {
    return {
      provider,
      publication,
      status,
      terminal: false,
      nextAction: describePublishFailure(provider, publication.errorClass),
    };
  }
  if (publication.status === "published") {
    return {
      provider,
      publication,
      status,
      terminal: true,
      nextAction: publication.externalUrl
        ? `Published — ${publication.externalUrl}`
        : "Published",
    };
  }
  return {
    provider,
    publication,
    status,
    terminal,
    nextAction:
      publication.status === "processing" ? "Publishing…" : "Waiting to publish",
  };
}

/** Every destination's independent state, for the package dashboard. */
export function destinationStates(view: ContentPackageView): DestinationState[] {
  return (["blog", "youtube", "linkedin"] as DestinationProvider[]).map((p) =>
    destinationState(view, p),
  );
}

/** Destinations that still need work (not published, not cancelled). */
export function pendingDestinations(view: ContentPackageView): DestinationProvider[] {
  return destinationStates(view)
    .filter((s) => !s.terminal)
    .map((s) => s.provider);
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const WORKFLOW_STEPS = [
  "topic",
  "article",
  "video_script",
  "video",
  "thumbnail",
  "blog_presentation",
  "linkedin_post",
  "review",
  "approve",
  "publish_blog",
  "publish_youtube",
  "publish_linkedin",
] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export const WORKFLOW_STEP_LABEL: Record<WorkflowStep, string> = {
  topic: "Topic",
  article: "Article",
  video_script: "Video script",
  video: "Video",
  thumbnail: "Thumbnail",
  blog_presentation: "Blog presentation",
  linkedin_post: "LinkedIn post",
  review: "Human review",
  approve: "Approval",
  publish_blog: "Publish blog",
  publish_youtube: "Publish YouTube",
  publish_linkedin: "Publish LinkedIn",
};

/**
 * The next step the engine should take, derived from what actually exists.
 * Deterministic, so a retried orchestration enqueues the same work rather than
 * skipping ahead.
 */
export function nextWorkflowStep(view: ContentPackageView): WorkflowStep | null {
  if (!view.title.trim()) return "topic";
  const body = assetOf(view, "blog_article")?.body ?? null;
  if (!body || body.trim().length === 0) return "article";
  if (!assetOf(view, "video_script")) return "video_script";
  if (!assetOf(view, "youtube_video")) return "video";
  if (!assetOf(view, "youtube_thumbnail")) return "thumbnail";
  if (!assetOf(view, "linkedin_post")) return "linkedin_post";
  if (view.approvalStatus !== "approved") return "review";
  const states = destinationStates(view);
  if (states.some((s) => s.status === "failed" || s.status === "not_queued")) {
    const next = states.find((s) => s.status === "failed" || s.status === "not_queued");
    if (next) {
      return next.provider === "blog"
        ? "publish_blog"
        : next.provider === "youtube"
          ? "publish_youtube"
          : "publish_linkedin";
    }
  }
  return null;
}

/**
 * Publishing gate. Authentication and authorization are separate: a fully
 * authenticated user still cannot publish generated content until a human has
 * approved it. `autoPublish` is an explicit, org-level opt-in.
 */
export function canPublish(
  view: Pick<ContentPackageView, "approvalStatus" | "status">,
  options: { autoPublish: boolean } = { autoPublish: false },
): { ok: boolean; reason?: string } {
  if (view.status === "archived") {
    return { ok: false, reason: "Archived packages cannot be published." };
  }
  if (view.approvalStatus === "approved") return { ok: true };
  if (options.autoPublish && view.status === "approved") return { ok: true };
  if (view.approvalStatus === "rejected") {
    return { ok: false, reason: "The package was rejected. Update it and re-review." };
  }
  if (view.approvalStatus === "needs_changes") {
    return { ok: false, reason: "Changes were requested before this can be published." };
  }
  return {
    ok: false,
    reason: "The package must be approved by a human before it can be published.",
  };
}

/**
 * Whether a package's assets are internally consistent:
 * the video script derives from the article, and the LinkedIn post and video
 * exist before they are queued for publishing.
 */
export function validatePackageIntegrity(view: ContentPackageView): string[] {
  const errors: string[] = [];
  const article = assetOf(view, "blog_article");
  if (!article?.body?.trim()) {
    errors.push("The package has no article body.");
  }
  const video = assetOf(view, "youtube_video");
  const script = assetOf(view, "video_script");
  if (video && !script) {
    errors.push("A video asset exists without the video script it was generated from.");
  }
  const thumbnail = assetOf(view, "youtube_thumbnail");
  if (video && !thumbnail) {
    errors.push("A video asset exists without the shared thumbnail.");
  }
  // The thumbnail is the canonical visual: if both exist they must agree, so a
  // stale thumbnail is caught before it is used as the blog hero.
  const videoThumb = video?.metadata?.["thumbnailUrl"];
  if (typeof videoThumb === "string" && thumbnail?.externalUrl && videoThumb !== thumbnail.externalUrl) {
    errors.push("The video's thumbnail does not match the package thumbnail.");
  }
  return errors;
}

/**
 * The two-way content relationship: the blog carries the canonical YouTube URL
 * and the video description carries the canonical blog URL. Returns only real
 * URLs — never a placeholder, so a broken link can never be published.
 */
export function crossLinks(
  view: Pick<ContentPackageView, "blogUrl" | "youtubeUrl">,
): { blog: string | null; youtube: string | null } {
  return {
    blog: view.blogUrl ?? null,
    youtube: view.youtubeUrl ?? null,
  };
}
