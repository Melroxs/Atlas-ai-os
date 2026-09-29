// ---------------------------------------------------------------------------
// Atlas Content Engine — durable job handlers
//
// The whole workflow runs on Atlas's existing durable queue (public.atlas_jobs
// through @/lib/jobs). Nothing here schedules work in the browser, and no
// handler performs a side effect before recording that it intends to:
//
//   topic -> article -> script -> video -> thumbnail -> blog presentation
//         -> LinkedIn post -> review -> approve -> publish blog/youtube/linkedin
//
// Every handler is idempotent:
//   * generation writes an ASSET keyed by (package, contentType, assetType), so
//     regenerating updates the existing row;
//   * publishing claims its publication row first (QUEUED/FAILED -> PROCESSING)
//     and skips the provider call when an external id already exists.
//
// A failure is always attributed to ONE destination. A failed YouTube upload
// leaves the article published and the LinkedIn post untouched.
// ---------------------------------------------------------------------------

import { createJobError } from "@/lib/jobs/engine";
import type { HandlerResult, JobExecutionContext } from "@/lib/jobs/types";
import {
  buildLinkedInPost,
  buildThumbnailBrief,
  buildVideoScript,
  buildYouTubePresentation,
  validateGeneratedCopy,
} from "./copy";
import { buildLinkedInRequest } from "./publishers";
import { mediaProviderStatus } from "./media";
import {
  buildArticleBrief,
  resolveBrand,
  type BrandContext,
} from "./copy";
import { resolveImageProvider, resolveVideoProvider, type ProviderEnv } from "./media";
import {
  DEFAULT_TARGET_VIDEO_SECONDS,
  clipRequestFrom,
  isPlanComplete,
  markFailed,
  markReady,
  markSubmitted,
  missingVideoAssembler,
  nextRenderAction,
  planClips,
  planFromMetadata,
  planToMetadata,
  type ClipPlan,
  type VideoAssembler,
} from "./assemble";
import {
  assetOf,
  canPublish,
  crossLinks,
  destinationStates,
  validatePackageIntegrity,
} from "./package";
import { publishToProvider } from "./publishers";
import type {
  ContentAutomationSettings,
  ContentPackageView,
  ContentPublicationRecord,
  DestinationProvider,
  ProviderConnection,
  PublishRequest,
  PublishTransport,
  VideoGenerationProvider,
  ImageGenerationProvider,
} from "./types";
import { DESTINATION_LABEL } from "./types";

// ---------------------------------------------------------------------------
// Ports (all I/O is injected — the handlers themselves are pure orchestration)
// ---------------------------------------------------------------------------

export interface ArticleGenerationInput {
  topic: string;
  brand: BrandContext;
  instructions: string;
  knowledge: Array<{ knowledgeId: string; title: string; statement: string }>;
}

export interface GeneratedArticle {
  title: string;
  body: string;
  summary: string;
  seo: Record<string, unknown>;
  /** Knowledge items the generator actually used. */
  knowledgeIds: string[];
  sourceIds: string[];
}

export interface ContentEnginePorts {
  now(): number;
  env: ProviderEnv;
  transport: PublishTransport;
  /** Load a package with its assets and publications. */
  loadPackage(packageId: string): Promise<ContentPackageView | null>;
  /** The organization's connection for a destination (credentials included). */
  getConnection(provider: DestinationProvider): Promise<ProviderConnection | null>;
  /** Create the package's blog row (or return the existing one). */
  createPackage(input: {
    topic: string;
    title: string;
    organizationId: string | null;
    slug: string;
    tags: string[];
  }): Promise<{ packageId: string }>;
  /** The AI article writer. Isolated behind a port so it is mockable. */
  generateArticle(input: ArticleGenerationInput): Promise<GeneratedArticle>;
  upsertAsset(input: {
    packageId: string;
    contentType: string;
    assetType: string;
    title: string;
    body?: string | null;
    storagePath?: string | null;
    externalUrl?: string | null;
    externalId?: string | null;
    mimeType?: string | null;
    metadata?: Record<string, unknown>;
    provider?: string | null;
    status?: string;
  }): Promise<{ assetId: string }>;
  /** Persist the blog hero/video presentation (thumbnail + YouTube URL). */
  setBlogPresentation(input: {
    packageId: string;
    heroImageUrl: string | null;
    youtubeUrl: string | null;
    youtubeVideoId: string | null;
    seo: Record<string, unknown>;
  }): Promise<void>;
  upsertPublication(input: {
    packageId: string;
    provider: DestinationProvider;
    assetId: string | null;
    status: "queued";
    scheduledAt: number | null;
  }): Promise<{ publicationId: string }>;
  claimPublication(
    publicationId: string,
  ): Promise<ContentPublicationRecord | null>;
  completePublication(input: {
    publicationId: string;
    externalId: string;
    externalUrl: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  failPublication(input: {
    publicationId: string;
    error: string;
    errorClass: string;
  }): Promise<void>;
  /** Move the package into human review once every asset exists. */
  requestReview(input: { packageId: string; note: string }): Promise<void>;
  enqueue(input: {
    jobType: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    tenantId?: string | null;
  }): Promise<void>;
  listDueAutomations(): Promise<ContentAutomationSettings[]>;
  /**
   * The next UNCOVERED topic for the organization, chosen by the database from
   * the curated bank (content_next_topic) so selection is deterministic,
   * tenant-safe and identical on every run. Null when everything is covered.
   */
  nextTopic(organizationId: string | null): Promise<string | null>;
  noteTopic(input: { topic: string; packageId: string }): Promise<void>;
  /** Load the latest automation settings for the package's organization. */
  getAutomation(organizationId: string | null): Promise<ContentAutomationSettings | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Job errors keep the same shape the rest of Atlas uses. */
function failure(
  code: string,
  message: string,
  details: Record<string, unknown>,
  retryable: boolean,
): HandlerResult {
  return { success: false, error: createJobError(code, message, details, retryable) };
}

const BASE_URL = "https://atlas-ai-os.com";

/**
 * The video script for a package: derived from the article, unless the package
 * already stores a script whose outline was edited by a human. The video can
 * therefore never drift onto a different argument than the article.
 */
function videoScriptFor(
  view: ContentPackageView,
  articleBody: string,
  cta: string,
): ReturnType<typeof buildVideoScript> {
  const derived = buildVideoScript({
    articleTitle: view.title,
    articleBody,
    cta,
  });
  const stored = assetOf(view, "video_script");
  const points = stored?.metadata?.["mainPoints"];
  if (Array.isArray(points) && points.length > 0) {
    return {
      ...derived,
      mainPoints: points.map((point) => String(point)),
      ...(typeof stored?.body === "string" && stored.body.trim()
        ? { script: stored.body }
        : {}),
    };
  }
  return derived;
}

/** The canonical public URL of a published article. */
export function blogUrlForSlug(slug: string | null): string | null {
  return slug ? `${BASE_URL}/blog/${slug}` : null;
}

/**
 * Build the request a destination needs, from the package alone. Uses only
 * real URLs: the cross-links are omitted when the counterpart does not exist
 * yet, so a published post can never contain a broken link.
 */
export function buildPublishRequest(
  view: ContentPackageView,
  provider: DestinationProvider,
  brand: BrandContext,
): PublishRequest {
  const resolved = resolveBrand(brand);
  const links = crossLinks(view);
  const blogUrl = links.blog ?? blogUrlForSlug(view.slug);
  const article = assetOf(view, "blog_article");
  const thumbnail = assetOf(view, "youtube_thumbnail");

  if (provider === "linkedin") {
    const asset = assetOf(view, "linkedin_post");
    return {
      title: view.title,
      body: asset?.body ?? "",
      // LinkedIn drives traffic to the OWNED article.
      canonicalUrl: blogUrl,
      youtubeUrl: links.youtube,
      tags: [],
      thumbnailUrl: thumbnail?.externalUrl ?? null,
      options: { assetId: asset?._id ?? null },
    };
  }

  if (provider === "youtube") {
    const video = assetOf(view, "youtube_video");
    const presentation = buildYouTubePresentation({
      articleTitle: view.title,
      summary: article?.body ? article.body.replace(/\s+/g, " ").trim().slice(0, 280) : null,
      // The script is derived from the ARTICLE (the single source of truth), and
      // a script asset's stored main points win when they exist, so a human
      // edit to the outline is what the video description is built from.
      script: videoScriptFor(view, article?.body ?? "", resolved.cta),
      // The video description carries the canonical BLOG url.
      blogUrl,
      tags: [],
      cta: resolved.cta,
    });
    return {
      title: presentation.title,
      body: presentation.description,
      canonicalUrl: blogUrl,
      youtubeUrl: links.youtube,
      tags: presentation.tags,
      // The shared thumbnail: the blog hero and the video's poster are the same
      // artefact, never regenerated per channel.
      thumbnailUrl: thumbnail?.externalUrl ?? null,
      options: {
        videoUrl: video?.externalUrl ?? null,
        assetId: video?._id ?? null,
        visibility: "private",
      },
    };
  }

  // Blog
  return {
    title: view.title,
    body: article?.body ?? "",
    canonicalUrl: blogUrl,
    youtubeUrl: links.youtube,
    tags: [],
    thumbnailUrl: thumbnail?.externalUrl ?? null,
    options: {},
  };
}

// ---------------------------------------------------------------------------
// content_generate_package
// ---------------------------------------------------------------------------

export function handleContentGeneratePackage(
  ports: ContentEnginePorts,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const payload = ctx.job.payload ?? {};
    const topic = str(payload.topic) ?? str(payload.title);
    if (!topic) {
      return failure("VALIDATION", "A topic is required to generate a package.", {}, false);
    }
    const organizationId = str(payload.organization_id) ?? str(payload.tenant_id);

    const automation = await ports.getAutomation(organizationId);
    const brand: BrandContext = {
      audience: automation?.audience ?? null,
      tone: automation?.defaultTone ?? null,
      primaryCta: automation?.primaryCta ?? null,
      brandVoice: automation?.brandVoice ?? null,
    };

    const brief = buildArticleBrief({ topic, brand });

    // 1. The package row exists before anything is generated, so a crash
    //    mid-generation leaves a visible draft rather than orphaned work.
    const existingPackageId = str(payload.package_id);
    const created = existingPackageId
      ? { packageId: existingPackageId }
      : await ports.createPackage({
          topic,
          title: topic,
          organizationId,
          slug: brief.slug,
          tags: brief.tags,
        });

    // 2. Article (AI, through the port) + the no-fabrication check.
    const article = await ports.generateArticle({
      topic,
      brand,
      instructions: brief.instructions,
      knowledge: brief.knowledge,
    });

    const copyCheck = validateGeneratedCopy(`${article.title}\n${article.body}`);
    if (!copyCheck.ok) {
      return failure(
        "VALIDATION",
        `Generated article rejected: ${copyCheck.errors.join(" ")}`,
        { package_id: created.packageId, errors: copyCheck.errors },
        false,
      );
    }

    await ports.upsertAsset({
      packageId: created.packageId,
      contentType: "blog",
      assetType: "blog_article",
      title: article.title,
      body: article.body,
      metadata: {
        summary: article.summary,
        warnings: copyCheck.warnings,
        unverifiedClaims: copyCheck.warnings.length,
      },
      status: "drafted",
    });

    // 3. The video script is derived from the ARTICLE, never from the topic.
    const script = buildVideoScript({
      articleTitle: article.title,
      articleBody: article.body,
      cta: resolveBrand(brand).cta,
    });
    await ports.upsertAsset({
      packageId: created.packageId,
      contentType: "video_script",
      assetType: "video_script",
      title: `${article.title} — video script`,
      body: script.script,
      metadata: {
        durationSeconds: script.durationSeconds,
        wordTarget: script.wordTarget,
        hook: script.hook,
        mainPoints: script.mainPoints,
      },
      status: "drafted",
    });

    // 4. Media + LinkedIn, each on its own job so one failure cannot block the
    //    rest of the package.
    await ports.enqueue({
      jobType: "content_generate_video",
      payload: { package_id: created.packageId, tenant_id: organizationId },
      idempotencyKey: `content:video:${created.packageId}`,
      tenantId: organizationId,
    });
    await ports.enqueue({
      jobType: "content_generate_thumbnail",
      payload: { package_id: created.packageId, tenant_id: organizationId },
      idempotencyKey: `content:thumbnail:${created.packageId}`,
      tenantId: organizationId,
    });
    await ports.enqueue({
      jobType: "content_write_linkedin",
      payload: { content_id: created.packageId, tenant_id: organizationId },
      idempotencyKey: `content:linkedin-draft:${created.packageId}`,
      tenantId: organizationId,
    });

    await ports.noteTopic({ topic, packageId: created.packageId });

    // ONE IDEA -> ONE PACKAGE -> HUMAN APPROVAL -> INDEPENDENT PUBLISHING.
    // The article and the script are the authored content a human reviews, so
    // this is where the package enters review; the derivative media jobs keep
    // rendering alongside it. Nothing here publishes anything, and the review
    // can only ever move a package FORWARD: an approved package is never
    // pushed back into review by a retried job.
    const review = await ports.loadPackage(created.packageId);
    if (review && packageNeedsReview(review).ready && review.approvalStatus === "pending") {
      await ports.requestReview({
        packageId: created.packageId,
        note:
          "The article and video script are drafted and waiting for a decision. " +
          "Approve to publish to each connected destination.",
      });
    }

    return {
      success: true,
      result: {
        package_id: created.packageId,
        title: article.title,
        warnings: copyCheck.warnings,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// content_generate_video
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// content_generate_video — build the CLIP PLAN, submit the first clip
// ---------------------------------------------------------------------------
//
// A text-to-video provider renders SHORT clips, not a 3-6 minute video. This
// handler therefore plans the video as N clips, submits clip 1 and stops. The
// durable `content_poll_video` job advances the plan (poll -> next clip ->
// assembly), so the worker never sits in a polling loop and a crash resumes the
// SAME renders from the persisted plan.
export function handleContentGenerateVideo(
  ports: ContentEnginePorts,
  providerOverride?: VideoGenerationProvider | null,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const packageId = str((ctx.job.payload ?? {})["package_id"]);
    if (!packageId) return failure("VALIDATION", "package_id is required.", {}, false);

    const view = await ports.loadPackage(packageId);
    if (!view) {
      return failure("NOT_FOUND", `Content package ${packageId} not found.`, { package_id: packageId }, false);
    }

    const scriptAsset = assetOf(view, "video_script");
    if (!scriptAsset?.body) {
      return failure(
        "VALIDATION",
        "The package has no video script; generate the article first.",
        { package_id: packageId },
        false,
      );
    }

    const provider =
      providerOverride === undefined ? resolveVideoProvider(ports.env) : providerOverride;
    if (!provider) {
      const status = mediaProviderStatus(ports.env);
      // A missing provider is configuration, not a rendering failure. Nothing
      // is invented and nothing is reported as generated.
      return failure(
        "NOT_CONFIGURED",
        `No video provider is configured. Set ${status.video.requires.join(" or ")} to enable video generation.`,
        { package_id: packageId, provider: status.video.id },
        false,
      );
    }

    const clipDuration = Number(scriptAsset.metadata?.["clipDurationSeconds"] ?? 0) || undefined;
    const plan = planClips({
      script: scriptAsset.body,
      title: view.title,
      targetDurationSeconds:
        Number(scriptAsset.metadata?.["targetDurationSeconds"] ?? DEFAULT_TARGET_VIDEO_SECONDS) ||
        DEFAULT_TARGET_VIDEO_SECONDS,
      clipDurationSeconds: clipDuration ?? 8,
    });

    const first = nextRenderAction(plan);
    if (first.kind !== "submit") {
      // A resumed package already has every clip submitted.
      await persistVideoPlan(ports, packageId, view.title, plan, provider.id);
      return { success: true, result: { package_id: packageId, resumed: true } };
    }

    const result = await provider.generate(
      clipRequestFrom(plan, first.clip, {
        title: view.title,
        aspectRatio: "16:9",
        style: "clean B2B explainer, Atlas brand, restrained palette",
        outputPrefix: `content/${packageId}/video`,
      }),
      { env: ports.env, transport: ports.transport, now: ports.now },
    );

    if (result.status === "failed" || !result.externalId) {
      return failure(
        "PROVIDER_ERROR",
        result.error ?? "The video provider failed to start the render.",
        { package_id: packageId, provider: provider.id, clip: first.clip.index },
        true,
      );
    }

    const next = markSubmitted(plan, first.clip.index, result.externalId);
    await persistVideoPlan(ports, packageId, view.title, next, provider.id);

    // Advance durably: the poll job is what moves this forward.
    await ports.enqueue({
      jobType: "content_poll_video",
      payload: { package_id: packageId },
      idempotencyKey: `content:video-poll:${packageId}:${first.clip.index}`,
    });

    return {
      success: true,
      result: {
        package_id: packageId,
        provider: provider.id,
        clips: next.clips.length,
        target_duration_seconds: next.targetDurationSeconds,
        clip_duration_seconds: next.clipDurationSeconds,
        first_clip: first.clip.index,
      },
    };
  };
}

async function persistVideoPlan(
  ports: ContentEnginePorts,
  packageId: string,
  title: string,
  plan: ClipPlan,
  providerId: string,
): Promise<void> {
  await ports.upsertAsset({
    packageId,
    contentType: "youtube_video",
    assetType: "youtube_video",
    title: `${title} — video`,
    externalId: plan.clips.find((c) => c.providerJobId)?.providerJobId ?? null,
    mimeType: "video/mp4",
    provider: providerId,
    metadata: planToMetadata(plan),
    // 'ready' only once every clip is ready AND assembled. A provider job id on
    // its own is never 'ready'.
    status: isPlanComplete(plan) ? "drafted" : "researching",
  });
}

// ---------------------------------------------------------------------------
// content_poll_video — advance the durable plan one step
// ---------------------------------------------------------------------------
export function handleContentPollVideo(
  ports: ContentEnginePorts,
  providerOverride?: VideoGenerationProvider | null,
  assemblerOverride?: VideoAssembler | null,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const packageId = str((ctx.job.payload ?? {})["package_id"]);
    if (!packageId) return failure("VALIDATION", "package_id is required.", {}, false);

    const view = await ports.loadPackage(packageId);
    if (!view) {
      return failure("NOT_FOUND", `Content package ${packageId} not found.`, { package_id: packageId }, false);
    }

    const videoAsset = assetOf(view, "youtube_video");
    const plan = planFromMetadata(videoAsset?.metadata);
    if (!plan) {
      return failure(
        "VALIDATION",
        "This package has no video render plan; run content_generate_video first.",
        { package_id: packageId },
        false,
      );
    }

    const provider =
      providerOverride === undefined ? resolveVideoProvider(ports.env) : providerOverride;
    if (!provider) {
      return failure(
        "NOT_CONFIGURED",
        "No video provider is configured; the render cannot be resumed.",
        { package_id: packageId },
        false,
      );
    }

    const action = nextRenderAction(plan);

    if (action.kind === "submit") {
      const result = await provider.generate(
        clipRequestFrom(plan, action.clip, {
          title: view.title,
          aspectRatio: "16:9",
          style: "clean B2B explainer, Atlas brand, restrained palette",
          outputPrefix: `content/${packageId}/video`,
        }),
        { env: ports.env, transport: ports.transport, now: ports.now },
      );
      if (result.status === "failed" || !result.externalId) {
        const next = markFailed(plan, action.clip.index, result.error ?? "render rejected");
        await persistVideoPlan(ports, packageId, view.title, next, provider.id);
        return failure(
          "PROVIDER_ERROR",
          result.error ?? "The video provider rejected a clip render.",
          { package_id: packageId, clip: action.clip.index },
          true,
        );
      }
      const next = markSubmitted(plan, action.clip.index, result.externalId);
      await persistVideoPlan(ports, packageId, view.title, next, provider.id);
      await ports.enqueue({
        jobType: "content_poll_video",
        payload: { package_id: packageId },
        idempotencyKey: `content:video-poll:${packageId}:${action.clip.index}`,
      });
      return {
        success: true,
        result: { package_id: packageId, submitted_clip: action.clip.index },
      };
    }

    if (action.kind === "poll") {
      const result = provider.poll
        ? await provider.poll(action.jobId, {
            env: ports.env,
            transport: ports.transport,
            now: ports.now,
          })
        : null;

      if (!result) {
        return failure(
          "VALIDATION",
          "The configured video provider cannot report render status.",
          { package_id: packageId },
          false,
        );
      }
      if (result.status === "failed") {
        const next = markFailed(plan, action.clip.index, result.error ?? "render failed");
        await persistVideoPlan(ports, packageId, view.title, next, provider.id);
        return failure(
          "PROVIDER_ERROR",
          result.error ?? "The video provider reported a failed render.",
          { package_id: packageId, clip: action.clip.index },
          true,
        );
      }
      if (result.status === "pending") {
        // Still rendering: requeue rather than sleep in the worker.
        await ports.enqueue({
          jobType: "content_poll_video",
          payload: { package_id: packageId, delay_seconds: 60 },
          idempotencyKey: `content:video-poll:${packageId}:${action.clip.index}:${Math.floor(ports.now() / 60_000)}`,
        });
        return {
          success: true,
          result: { package_id: packageId, polling_clip: action.clip.index },
        };
      }

      // ready — the provider returned a real media URL, or it did not.
      if (!result.mediaUrl) {
        const next = markFailed(
          plan,
          action.clip.index,
          "The video provider reported success without a media file.",
        );
        await persistVideoPlan(ports, packageId, view.title, next, provider.id);
        return failure(
          "PROVIDER_ERROR",
          "The video provider reported success without a media file.",
          { package_id: packageId, clip: action.clip.index },
          true,
        );
      }
      const next = markReady(plan, action.clip.index, result.mediaUrl);
      await persistVideoPlan(ports, packageId, view.title, next, provider.id);
      await ports.enqueue({
        jobType: "content_poll_video",
        payload: { package_id: packageId },
        idempotencyKey: `content:video-poll:${packageId}:${action.clip.index + 1}`,
      });
      return {
        success: true,
        result: { package_id: packageId, ready_clip: action.clip.index },
      };
    }

    if (action.kind === "assemble") {
      const assembler = assemblerOverride === undefined ? missingVideoAssembler : assemblerOverride;
      if (!assembler?.isConfigured()) {
        // Honest stop: the clips exist, no concatenator does. The package is NOT
        // marked ready and no media URL is invented.
        return failure(
          "NOT_CONFIGURED",
          missingVideoAssembler.assemble === undefined
            ? "No video assembler is configured."
            : "Every clip is rendered, but no video assembler is configured yet. " +
              `Concatenate the ${action.plan.clips.length} rendered clips to one file before publishing.`,
          { package_id: packageId, clips: action.plan.clips.length },
          false,
        );
      }
      const assembled = await assembler.assemble(action.plan);
      if (assembled.status !== "ready") {
        return failure(
          assembled.status === "failed" ? "PROVIDER_ERROR" : "NOT_CONFIGURED",
          assembled.status === "failed"
            ? assembled.error
            : assembled.reason,
          { package_id: packageId },
          assembled.status === "failed",
        );
      }
      await ports.upsertAsset({
        packageId,
        contentType: "youtube_video",
        assetType: "youtube_video",
        title: `${view.title} — video`,
        externalUrl: assembled.mediaUrl,
        storagePath: assembled.storagePath,
        mimeType: "video/mp4",
        provider: assembler.id,
        metadata: { ...planToMetadata(action.plan), renderStatus: "ready", assembledBy: assembler.id },
        status: "drafted",
      });
      return {
        success: true,
        result: { package_id: packageId, media_url: assembled.mediaUrl },
      };
    }

    return {
      success: true,
      result: { package_id: packageId, waiting: action.reason },
    };
  };
}

// ---------------------------------------------------------------------------
// content_generate_thumbnail
// ---------------------------------------------------------------------------

export function handleContentGenerateThumbnail(
  ports: ContentEnginePorts,
  providerOverride?: ImageGenerationProvider | null,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const packageId = str((ctx.job.payload ?? {})["package_id"]);
    if (!packageId) return failure("VALIDATION", "package_id is required.", {}, false);

    const view = await ports.loadPackage(packageId);
    if (!view) {
      return failure("NOT_FOUND", `Content package ${packageId} not found.`, { package_id: packageId }, false);
    }

    // One thumbnail per package: an existing valid image is reused rather than
    // regenerated, so YouTube, the blog hero and LinkedIn stay identical.
    const existing = assetOf(view, "youtube_thumbnail");
    if (existing?.externalUrl && (ctx.job.payload ?? {})["regenerate"] !== true) {
      return { success: true, result: { package_id: packageId, reused: true, url: existing.externalUrl } };
    }

    const provider =
      providerOverride === undefined ? resolveImageProvider(ports.env) : providerOverride;
    if (!provider) {
      const status = mediaProviderStatus(ports.env);
      return failure(
        "NOT_CONFIGURED",
        `No image provider is configured. Set ${status.image.requires.join(" or ")} to enable thumbnail generation.`,
        { package_id: packageId, provider: status.image.id },
        false,
      );
    }

    const automation = await ports.getAutomation(view.organizationId);
    const brief = buildThumbnailBrief({
      articleTitle: view.title,
      brandVoice: automation?.brandVoice ?? null,
    });

    const result = await provider.generate(
      {
        prompt: brief.prompt,
        overlayText: brief.overlayText,
        aspectRatio: brief.aspectRatio,
        width: brief.width,
        height: brief.height,
        outputPrefix: `content/${packageId}/thumbnail`,
      },
      { env: ports.env, transport: ports.transport, now: ports.now },
    );

    if (result.status === "failed" || !result.imageUrl) {
      return failure(
        "PROVIDER_ERROR",
        result.error ?? "The image provider returned no image.",
        { package_id: packageId, provider: provider.id },
        true,
      );
    }

    await ports.upsertAsset({
      packageId,
      contentType: "youtube_thumbnail",
      assetType: "youtube_thumbnail",
      title: `${view.title} — thumbnail`,
      externalUrl: result.imageUrl,
      storagePath: result.storagePath,
      mimeType: "image/jpeg",
      provider: provider.id,
      metadata: {
        overlayText: brief.overlayText,
        width: brief.width,
        height: brief.height,
      },
      status: "drafted",
    });

    // The thumbnail is the canonical visual for the blog hero card too.
    await ports.setBlogPresentation({
      packageId,
      heroImageUrl: result.imageUrl,
      youtubeUrl: view.youtubeUrl,
      youtubeVideoId: view.youtubeVideoId,
      seo: { image: result.imageUrl },
    });

    return {
      success: true,
      result: { package_id: packageId, provider: provider.id, url: result.imageUrl },
    };
  };
}

// ---------------------------------------------------------------------------
// Publishing — one handler per destination, one publication row each
// ---------------------------------------------------------------------------

async function runPublication(
  ports: ContentEnginePorts,
  provider: DestinationProvider,
  ctx: JobExecutionContext,
): Promise<HandlerResult> {
  const payload = ctx.job.payload ?? {};
  const packageId = str(payload["package_id"]) ?? str(payload["content_id"]);
  if (!packageId) return failure("VALIDATION", "package_id is required.", {}, false);

  const view = await ports.loadPackage(packageId);
  if (!view) {
    return failure("NOT_FOUND", `Content package ${packageId} not found.`, { package_id: packageId }, false);
  }

  // Human approval is enforced here as well as in the database. Authentication
  // is not authorization: an approved package is a precondition for publishing.
  const automation = await ports.getAutomation(view.organizationId);
  const gate = canPublish(view, { autoPublish: Boolean(automation?.autoPublish) });
  if (!gate.ok) {
    return failure("CONFLICT", gate.reason ?? "The package is not approved.", { package_id: packageId }, false);
  }

  const integrity = validatePackageIntegrity(view);
  if (integrity.length > 0 && provider !== "blog") {
    return failure(
      "VALIDATION",
      `Publication blocked: ${integrity.join(" ")}`,
      { package_id: packageId, errors: integrity },
      false,
    );
  }

  const connection = await ports.getConnection(provider);
  if (!connection || connection.status !== "connected") {
    return failure(
      "NOT_CONFIGURED",
      `${DESTINATION_LABEL[provider]} is not connected. Connect ${DESTINATION_LABEL[provider]} to publish.`,
      { package_id: packageId, provider },
      false,
    );
  }

  const asset = provider === "youtube"
    ? assetOf(view, "youtube_video")
    : provider === "linkedin"
      ? assetOf(view, "linkedin_post")
      : assetOf(view, "blog_article");

  const publication = await ports.upsertPublication({
    packageId,
    provider,
    assetId: asset?._id ?? null,
    status: "queued",
    scheduledAt: null,
  });

  const claimed = await ports.claimPublication(publication.publicationId);
  if (!claimed) {
    // Another worker holds it. Not an error: the work is already happening.
    return { success: true, result: { package_id: packageId, provider, skipped: "already_claimed" } };
  }

  const request = buildPublishRequest(view, provider, {
    audience: automation?.audience ?? null,
    tone: automation?.defaultTone ?? null,
    primaryCta: automation?.primaryCta ?? null,
    brandVoice: automation?.brandVoice ?? null,
  });

  if (provider === "linkedin" && !request.body.trim()) {
    await ports.failPublication({
      publicationId: publication.publicationId,
      error: "The package has no LinkedIn post to publish.",
      errorClass: "invalid_content",
    });
    return failure("VALIDATION", "The package has no LinkedIn post to publish.", { package_id: packageId }, false);
  }

  const outcome = await publishToProvider({
    provider,
    request,
    connection,
    context: {
      organizationId: view.organizationId ?? "",
      packageId,
      assetId: asset?._id ?? null,
      now: ports.now,
      log: (event, detail) => ctx.logger.info?.(event, detail ?? {}),
    },
    transport: ports.transport,
    // The provider id already on the row is what makes a retried job a no-op.
    alreadyPublishedExternalId: claimed.externalId,
  });

  if (!outcome.ok) {
    await ports.failPublication({
      publicationId: publication.publicationId,
      error: outcome.error,
      errorClass: outcome.errorClass,
    });
    return failure(
      outcome.retryable ? "PROVIDER_ERROR" : "NOT_CONFIGURED",
      outcome.error,
      { package_id: packageId, provider, error_class: outcome.errorClass },
      outcome.retryable,
    );
  }

  await ports.completePublication({
    publicationId: publication.publicationId,
    externalId: outcome.externalId,
    externalUrl: outcome.externalUrl,
    metadata: outcome.metadata ?? {},
  });

  // YouTube publishes as private/unlisted until a human flips it public; the
  // blog records the canonical YouTube URL so the hero card can play it.
  if (provider === "youtube") {
    await ports.upsertAsset({
      packageId,
      contentType: "youtube_video",
      assetType: "youtube_video",
      title: `${view.title} — video`,
      externalId: outcome.externalId,
      externalUrl: outcome.externalUrl,
      metadata: { publishedAt: ports.now(), thumbnailUrl: assetOf(view, "youtube_thumbnail")?.externalUrl ?? null },
      status: "published",
    });
    await ports.setBlogPresentation({
      packageId,
      heroImageUrl: assetOf(view, "youtube_thumbnail")?.externalUrl ?? null,
      youtubeUrl: outcome.externalUrl,
      youtubeVideoId: outcome.externalId,
      seo: {},
    });
  }

  return {
    success: true,
    result: {
      package_id: packageId,
      provider,
      external_id: outcome.externalId,
      external_url: outcome.externalUrl,
    },
  };
}

export function handleContentPublishYouTube(
  ports: ContentEnginePorts,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return (ctx) => runPublication(ports, "youtube", ctx);
}

/**
 * LinkedIn. The legacy platform handler is preserved for payloads without a
 * publication id (it reports NOT_CONFIGURED rather than faking a post); the
 * Content Engine path runs whenever a package id is present.
 */
export function handleContentPublishLinkedIn(
  ports: ContentEnginePorts,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const payload = ctx.job.payload ?? {};
    const hasPackage = str(payload["package_id"]) ?? str(payload["content_id"]);
    if (!hasPackage) {
      return failure(
        "NOT_CONFIGURED",
        "LinkedIn distribution is not configured for this environment. No post was created.",
        { platform: "linkedin", status: "NOT_CONFIGURED" },
        false,
      );
    }
    return runPublication(ports, "linkedin", ctx);
  };
}

// ---------------------------------------------------------------------------
// content_write_linkedin (Content Engine version)
// ---------------------------------------------------------------------------

/**
 * Is this package's AUTHORED content complete enough for a human to review?
 *
 * The article and the video script are what a human actually reviews; the
 * video, the thumbnail and the LinkedIn draft are derivatives that keep
 * rendering afterwards and that may legitimately be unavailable when a media
 * provider is not configured. Requiring them here would strand a finished
 * article in draft forever.
 */
function packageNeedsReview(view: ContentPackageView): { ready: boolean; missing: string[] } {
  const required = ["blog_article", "video_script"];
  const missing = required.filter((type) => !assetOf(view, type as never));
  return { ready: missing.length === 0, missing };
}

export function handleContentWriteLinkedIn(
  ports: ContentEnginePorts,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async (ctx) => {
    const packageId = str((ctx.job.payload ?? {})["content_id"]) ?? str((ctx.job.payload ?? {})["package_id"]);
    if (!packageId) return failure("VALIDATION", "content_id is required.", {}, false);

    const view = await ports.loadPackage(packageId);
    if (!view) {
      return failure("NOT_FOUND", `Content package ${packageId} not found.`, { package_id: packageId }, false);
    }

    const article = assetOf(view, "blog_article");
    const script = assetOf(view, "video_script");
    const automation = await ports.getAutomation(view.organizationId);

    const post = buildLinkedInPost({
      articleId: packageId,
      articleTitle: view.title,
      articleSummary:
        typeof article?.metadata?.["summary"] === "string"
          ? (article.metadata["summary"] as string)
          : article?.body?.slice(0, 300) ?? null,
      articleStatus: view.status,
      approvalStatus: view.approvalStatus,
      sourceIds: [],
      knowledgeIds: [],
      keyPoints: Array.isArray(script?.metadata?.["mainPoints"])
        ? (script?.metadata?.["mainPoints"] as string[])
        : [],
      blogUrl: blogUrlForSlug(view.slug),
      youtubeUrl: view.youtubeUrl,
      cta: automation?.primaryCta ?? null,
    });

    if (!post.ok || !post.body) {
      return failure(
        "VALIDATION",
        post.error ?? "A LinkedIn post could not be derived from this article.",
        { package_id: packageId },
        false,
      );
    }

    await ports.upsertAsset({
      packageId,
      contentType: "linkedin_post",
      assetType: "linkedin_post",
      title: `${view.title} — LinkedIn`,
      body: post.body,
      metadata: { notes: post.notes },
      status: "drafted",
    });

    return { success: true, result: { package_id: packageId, notes: post.notes } };
  };
}

// ---------------------------------------------------------------------------
// content_automation_tick
// ---------------------------------------------------------------------------

export function handleContentAutomationTick(
  ports: ContentEnginePorts,
): (ctx: JobExecutionContext) => Promise<HandlerResult> {
  return async () => {
    const due = await ports.listDueAutomations();
    const enqueued: string[] = [];
    const exhausted: string[] = [];
    for (const automation of due) {
      if (!automation.enabled || !automation.organizationId) continue;
      // Selection lives in the database (content_next_topic): deterministic,
      // tenant-scoped, and it reads the organization's own covered topics.
      const topic = await ports.nextTopic(automation.organizationId);
      if (!topic) {
        // Everything in the bank is covered: enqueue nothing rather than
        // recycle an article the audience has already been sent.
        exhausted.push(automation.organizationId);
        continue;
      }
      await ports.enqueue({
        jobType: "content_generate_package",
        payload: { topic, tenant_id: automation.organizationId, automated: true },
        // One package per organization per scheduled occurrence.
        idempotencyKey: `content:auto:${automation.organizationId}:${Math.floor(ports.now() / 1000)}`,
        tenantId: automation.organizationId,
      });
      enqueued.push(automation.organizationId);
    }
    return {
      success: true,
      result: { organizations: enqueued.length, enqueued, exhausted },
    };
  };
}

/**
 * The pure mirror of the database's content_next_topic(). Kept for the Studio
 * preview and for offline tests; the executable path is the SQL function, so a
 * package is never generated from a topic only this list knows about.
 * Topic selection must not repeat what the organization already covered. The
 * candidate list is drawn from the knowledge the organization actually has, and
 * anything already in coveredTopics is skipped. When everything is covered the
 * tick enqueues nothing rather than recycling a topic.
 */
export function pickNextTopic(
  automation: ContentAutomationSettings,
  candidates: string[] = DEFAULT_TOPIC_BANK,
): string | null {
  const covered = new Set(automation.coveredTopics.map((t) => t.toLowerCase().trim()));
  const next = candidates.find((c) => !covered.has(c.toLowerCase().trim()));
  return next ?? null;
}

/**
 * The starter topic bank. Real topics for Atlas's audience (workflow and
 * operations), never a statistic or a claim that would need evidence.
 */
export const DEFAULT_TOPIC_BANK: string[] = [
  "why insurance supplements get missed",
  "building a documentation standard your crew will actually follow",
  "the handoff between field capture and estimating",
  "how to keep job evidence organized before the adjuster asks",
  "reducing rework in restoration estimates",
  "what a clean carrier submission package looks like",
  "turning completed jobs into repeatable playbooks",
];

/** A destination's display helper for the studio UI. */
export function destinationSummary(view: ContentPackageView): string {
  return destinationStates(view)
    .map((s) => `${DESTINATION_LABEL[s.provider]}: ${s.status}`)
    .join(" · ");
}

/** Build the LinkedIn body without AI, for the UI's live preview. */
export function previewLinkedInPost(
  view: ContentPackageView,
  brand: BrandContext,
): string {
  const body = buildLinkedInRequest(
    buildPublishRequest(view, "linkedin", brand),
    { externalAccountId: "0", accountName: null },
  );
  return body?.commentary ?? "";
}
