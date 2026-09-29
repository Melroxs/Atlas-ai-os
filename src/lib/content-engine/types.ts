// ---------------------------------------------------------------------------
// Atlas Content Engine — canonical types
//
// ONE IDEA -> ONE CONTENT PACKAGE -> BLOG + VIDEO + THUMBNAIL + LINKEDIN
//
// This module deliberately does NOT redefine anything Atlas already owns:
//   - the content row / status machine   -> @/lib/platform/types + content.ts
//   - provider definitions + adapters    -> @/lib/atlas-data/connectors-registry
//   - credentials / OAuth state          -> public.connections (20260922)
//   - the durable queue                  -> @/lib/jobs
//
// It adds only what a multi-destination content package needs: the destination
// model, the asset vocabulary, the publishing contract, and the provider
// contracts for video and thumbnail generation.
// ---------------------------------------------------------------------------

import type { ContentApprovalStatus, ContentStatus } from "@/lib/platform/types";

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_TYPES = [
  "blog_article",
  "blog_hero_image",
  "video_script",
  "youtube_video",
  "youtube_thumbnail",
  "linkedin_post",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * `contentType` values the database accepts for an asset row. The video script
 * and the two media assets are their own content types so the existing
 * (parent, contentType, assetType) uniqueness gives regeneration semantics for
 * free: regenerating a thumbnail updates its row instead of adding a second.
 */
export const ASSET_CONTENT_TYPE: Record<AssetType, string> = {
  blog_article: "blog",
  blog_hero_image: "youtube_thumbnail",
  video_script: "video_script",
  youtube_video: "youtube_video",
  youtube_thumbnail: "youtube_thumbnail",
  linkedin_post: "linkedin_post",
};

/** Which destination each asset type is published to (null = not published). */
export const ASSET_DESTINATION: Record<AssetType, DestinationProvider | null> = {
  blog_article: "blog",
  blog_hero_image: null,
  video_script: null,
  youtube_video: "youtube",
  youtube_thumbnail: null,
  linkedin_post: "linkedin",
};

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export const DESTINATIONS = ["blog", "youtube", "linkedin"] as const;
export type DestinationProvider = (typeof DESTINATIONS)[number];

export const DESTINATION_LABEL: Record<DestinationProvider, string> = {
  blog: "Atlas Blog",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

export const PUBLICATION_STATUSES = [
  "queued",
  "processing",
  "published",
  "failed",
  "cancelled",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Error classes the UI turns into an actionable instruction. A raw provider
 * message is never shown to a user.
 */
export const PUBLISH_ERROR_CLASSES = [
  "not_connected",
  "token_expired",
  "authorization_revoked",
  "rate_limited",
  "invalid_content",
  "provider_error",
  "network_error",
  "unknown",
] as const;
export type PublishErrorClass = (typeof PUBLISH_ERROR_CLASSES)[number];

/** The single idempotency key for one logical publication. Mirrors the SQL
 *  function public.content_publication_key(). */
export function publicationIdempotencyKey(
  packageId: string,
  provider: DestinationProvider,
  assetId: string | null,
): string {
  return `${packageId}:${provider}:${assetId ?? "none"}`;
}

// ---------------------------------------------------------------------------
// Records (shape of the database rows)
// ---------------------------------------------------------------------------

export interface ContentPublicationRecord {
  _id: string;
  organizationId: string | null;
  contentPackageId: string;
  assetId: string | null;
  provider: DestinationProvider;
  status: PublicationStatus;
  scheduledAt: number | null;
  attemptCount: number;
  externalId: string | null;
  externalUrl: string | null;
  lastError: string | null;
  errorClass: PublishErrorClass | null;
  publishedAt: number | null;
  /** Worker lease, mirroring atlas_jobs locked_at / lock_expires_at. */
  lockedAt: number | null;
  lockExpiresAt: number | null;
  idempotencyKey: string;
}

export interface ContentAssetRecord {
  _id: string;
  contentType: string;
  assetType: AssetType | string | null;
  status: ContentStatus;
  title: string;
  body: string | null;
  storagePath: string | null;
  externalUrl: string | null;
  externalId: string | null;
  mimeType: string | null;
  provider: string | null;
  parentContentId: string | null;
  approvalStatus: ContentApprovalStatus;
  metadata: Record<string, unknown>;
}

/** A content package plus every derivative and every destination's state. */
export interface ContentPackageView {
  packageId: string;
  title: string;
  slug: string | null;
  status: ContentStatus;
  approvalStatus: ContentApprovalStatus;
  organizationId: string | null;
  youtubeUrl: string | null;
  youtubeVideoId: string | null;
  youtubeThumbnailUrl: string | null;
  blogUrl: string | null;
  assets: ContentAssetRecord[];
  publications: ContentPublicationRecord[];
}

export interface DestinationState {
  provider: DestinationProvider;
  /** The publication row, when one exists. */
  publication: ContentPublicationRecord | null;
  status: PublicationStatus | "not_queued";
  /** True when the destination is finished and must not be re-sent. */
  terminal: boolean;
  /** Human-readable, actionable next step. */
  nextAction: string;
}

// ---------------------------------------------------------------------------
// Publishing contract
// ---------------------------------------------------------------------------

export interface PublishContext {
  organizationId: string;
  packageId: string;
  assetId: string | null;
  /** Injected clock — deterministic in tests. */
  now: () => number;
  log: (event: string, detail?: Record<string, unknown>) => void;
}

export interface PublishRequest {
  /** Title for providers that take one (YouTube). */
  title: string;
  /** Long-form body: article, video description, LinkedIn post text. */
  body: string;
  /** Public URL of the owned page this publication should link back to. */
  canonicalUrl: string | null;
  /** Related YouTube URL, when the destination should cross-link. */
  youtubeUrl: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  /** Provider-specific extras (visibility, playlist, urn…). */
  options: Record<string, unknown>;
}

export type PublishOutcome =
  | { ok: true; externalId: string; externalUrl: string | null; metadata?: Record<string, unknown> }
  | { ok: false; errorClass: PublishErrorClass; error: string; retryable: boolean };

/**
 * Every destination implements this. Adding Instagram/TikTok/Facebook later is
 * a new implementation plus a DESTINATIONS entry — no engine change.
 */
export interface ContentPublisher {
  provider: DestinationProvider;
  /** Scopes the OAuth connection must carry for publishing to work. */
  requiredScopes: string[];
  /**
   * Build the provider request. Pure: no network, no database, no env. This is
   * what the tests pin, so a malformed provider payload is caught offline.
   */
  buildRequest(input: {
    request: PublishRequest;
    connection: ProviderConnection;
  }): Record<string, unknown>;
  /** The endpoint the request is sent to. */
  endpoint(connection: ProviderConnection): string;
  /** Publish through an injected transport (the worker supplies fetch). */
  publish(input: {
    request: PublishRequest;
    connection: ProviderConnection;
    context: PublishContext;
    transport: PublishTransport;
  }): Promise<PublishOutcome>;
  /** Where the published artefact can be opened. */
  publicUrl(externalId: string, metadata?: Record<string, unknown>): string | null;
}

/** Only the material the publisher needs — never a raw token dump. */
export interface ProviderConnection {
  connectionId: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  accountName: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface PublishTransportInput {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: unknown;
  /**
   * Stream these bytes from a URL. Binary uploads (the video file, the
   * thumbnail image) cannot travel as JSON, so the transport fetches the media
   * server-side and forwards it. The browser never sees the file or the token.
   */
  media?: { url: string; contentType?: string };
}

export interface PublishTransportResponse {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
  headers?: Record<string, string>;
  /**
   * Provider-assigned id lifted from the response headers when the body does
   * not carry one — LinkedIn returns the post URN as `x-restli-id`.
   */
  externalId?: string;
}

export interface PublishTransport {
  (input: PublishTransportInput): Promise<PublishTransportResponse>;
}

// ---------------------------------------------------------------------------
// Media generation contracts (video + thumbnail)
// ---------------------------------------------------------------------------

export interface VideoGenerationRequest {
  /** The approved article, as the single source of truth for the video. */
  script: string;
  title: string;
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16" | "1:1";
  /** OpenAI-compatible prompt guidance derived from the script. */
  style: string;
  /** Storage bucket/prefix the finished file should land in. */
  outputPrefix: string;
}

export interface VideoGenerationResult {
  /** Provider job id, for polling or idempotent re-submission. */
  externalId: string;
  /** Direct media URL, when the provider returns one. */
  mediaUrl: string | null;
  storagePath: string | null;
  status: "ready" | "pending" | "failed";
  error?: string;
}

export interface VideoGenerationProvider {
  id: string;
  /** True when the provider needs an API key that is not configured. */
  isConfigured(env: { get(key: string): string | null }): boolean;
  requiredEnvVars: string[];
  generate(
    request: VideoGenerationRequest,
    deps: { env: { get(key: string): string | null }; transport: PublishTransport; now: () => number },
  ): Promise<VideoGenerationResult>;
  /** Poll an asynchronous render started by generate(). */
  poll?(
    externalId: string,
    deps: { env: { get(key: string): string | null }; transport: PublishTransport; now: () => number },
  ): Promise<VideoGenerationResult>;
}

export interface ImageGenerationRequest {
  prompt: string;
  /** Exact text the thumbnail may render (kept short — no fabricated stats). */
  overlayText: string | null;
  aspectRatio: "16:9";
  width: number;
  height: number;
  outputPrefix: string;
}

export interface ImageGenerationResult {
  externalId: string;
  imageUrl: string | null;
  storagePath: string | null;
  status: "ready" | "failed";
  error?: string;
}

export interface ImageGenerationProvider {
  id: string;
  isConfigured(env: { get(key: string): string | null }): boolean;
  requiredEnvVars: string[];
  generate(
    request: ImageGenerationRequest,
    deps: { env: { get(key: string): string | null }; transport: PublishTransport; now: () => number },
  ): Promise<ImageGenerationResult>;
}

// ---------------------------------------------------------------------------
// Automation settings (mirrors public.atlasContentAutomation)
// ---------------------------------------------------------------------------

export interface ContentAutomationSettings {
  organizationId: string | null;
  enabled: boolean;
  intervalSeconds: number | null;
  requireApproval: boolean;
  autoPublish: boolean;
  brandVoice: string | null;
  audience: string | null;
  primaryCta: string | null;
  defaultTone: string | null;
  coveredTopics: string[];
  lastGeneratedAt: number | null;
  lastPackageId: string | null;
}

export const AUTOMATION_FREQUENCIES = [
  { id: "manual", label: "Manual only", seconds: null },
  { id: "daily", label: "Every day", seconds: 86_400 },
  { id: "every_2_days", label: "Every 2 days", seconds: 172_800 },
  { id: "weekly", label: "Every week", seconds: 604_800 },
] as const;
export type AutomationFrequencyId = (typeof AUTOMATION_FREQUENCIES)[number]["id"];
