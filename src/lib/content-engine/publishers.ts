// ---------------------------------------------------------------------------
// Atlas Content Engine — publishers
//
// One contract (`ContentPublisher`), one implementation per destination. The
// engine never contains provider-specific branching: it looks a publisher up
// by destination and hands it a request, a connection and a transport.
//
// Adding Instagram / TikTok / Facebook later is a new object in
// CONTENT_PUBLISHERS plus a DESTINATIONS entry — no engine change.
//
// All provider request shapes are built by PURE functions so the payloads are
// unit-tested offline. Network calls go through an injected transport, which is
// the only thing the worker supplies, so nothing here can reach the network in
// a test or read a secret from the browser.
// ---------------------------------------------------------------------------

import { classifyPublishError, isRetryable } from "./package";
import type {
  ContentPublisher,
  DestinationProvider,
  ProviderConnection,
  PublishContext,
  PublishOutcome,
  PublishRequest,
  PublishTransport,
} from "./types";

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/** Uploading + tagging a video needs both upload and read scopes. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export const YOUTUBE_UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

/** Default category 27 = Education, which is what an Atlas explainer is. */
export const YOUTUBE_CATEGORY_EDUCATION = "27";

export interface YouTubeSnippet {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
  };
  status: {
    privacyStatus: "public" | "unlisted" | "private";
    selfDeclaredMadeForKids: boolean;
    madeForKids: boolean;
  };
}

export function buildYouTubeRequest(
  request: PublishRequest,
): YouTubeSnippet {
  const visibility = request.options["visibility"];
  const privacyStatus =
    visibility === "public" || visibility === "unlisted" || visibility === "private"
      ? visibility
      : "private"; // never publish publicly by default
  return {
    snippet: {
      title: request.title.slice(0, 100),
      description: request.body,
      tags: request.tags.slice(0, 15),
      categoryId:
        typeof request.options["categoryId"] === "string"
          ? request.options["categoryId"]
          : YOUTUBE_CATEGORY_EDUCATION,
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
      madeForKids: false,
    },
  };
}

/** YouTube thumbnails are set with a separate endpoint after the insert. */
export function youtubeThumbnailEndpoint(videoId: string): string {
  return `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`;
}

export const youtubePublisher: ContentPublisher = {
  provider: "youtube",
  requiredScopes: YOUTUBE_SCOPES,

  buildRequest({ request }) {
    return buildYouTubeRequest(request) as unknown as Record<string, unknown>;
  },

  endpoint() {
    return YOUTUBE_UPLOAD_ENDPOINT;
  },

  async publish({ request, connection, context, transport }) {
    const videoUrl = request.options["videoUrl"];
    if (typeof videoUrl !== "string" || videoUrl.length === 0) {
      // A YouTube insert with no media is not a publish. Failing here is what
      // stops an empty video from ever being "successfully" published.
      return {
        ok: false,
        errorClass: "invalid_content",
        error: "The package has no generated video file to upload.",
        retryable: false,
      };
    }
    if (!connection.accessToken) {
      return {
        ok: false,
        errorClass: "not_connected",
        error: "YouTube is not connected for this organization.",
        retryable: false,
      };
    }

    const metadata = buildYouTubeRequest(request);
    const init = await transport({
      url: YOUTUBE_UPLOAD_ENDPOINT,
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
      },
      body: metadata,
    });

    if (!init.ok) {
      const errorClass = classifyPublishError({
        status: init.status,
        message: init.text,
      });
      return {
        ok: false,
        errorClass,
        error: `YouTube rejected the upload request (HTTP ${init.status}).`,
        retryable: isRetryable(errorClass),
      };
    }

    // A resumable upload session returns its URL in the Location header; some
    // proxies surface it in the body instead, so both are honoured.
    const headerLocation = init.headers?.["location"];
    const bodyLocation =
      typeof init.json === "object" && init.json !== null
        ? ((init.json as Record<string, unknown>)["location"] as string | undefined)
        : undefined;
    const target = headerLocation ?? bodyLocation ?? YOUTUBE_UPLOAD_ENDPOINT;
    const uploaded = await transport({
      url: target,
      method: "PUT",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "content-type": "video/mp4",
      },
      body: metadata,
      media: { url: videoUrl, contentType: "video/mp4" },
    });

    if (!uploaded.ok) {
      const errorClass = classifyPublishError({
        status: uploaded.status,
        message: uploaded.text,
      });
      return {
        ok: false,
        errorClass,
        error: `YouTube upload failed (HTTP ${uploaded.status}).`,
        retryable: isRetryable(errorClass),
      };
    }

    const payload = (uploaded.json ?? {}) as Record<string, unknown>;
    const externalId = typeof payload["id"] === "string" ? (payload["id"] as string) : "";
    if (!externalId) {
      return {
        ok: false,
        errorClass: "provider_error",
        error: "YouTube returned no video id; the upload is unconfirmed.",
        retryable: true,
      };
    }

    context.log("youtube.published", { videoId: externalId });

    // Attach the package thumbnail to the uploaded video. A failure here does
    // not invalidate the publication — YouTube uses its own default frame — so
    // it is reported as a warning in metadata rather than a failed publish.
    let thumbnailAttached = false;
    if (request.thumbnailUrl) {
      const thumb = await transport({
        url: youtubeThumbnailEndpoint(externalId),
        method: "POST",
        headers: { authorization: `Bearer ${connection.accessToken}` },
        media: { url: request.thumbnailUrl, contentType: "image/jpeg" },
      });
      thumbnailAttached = thumb.ok;
    }

    return {
      ok: true,
      externalId,
      externalUrl: youtubePublisher.publicUrl(externalId),
      metadata: { thumbnailAttached, privacyStatus: metadata.status.privacyStatus },
    };
  },

  publicUrl(externalId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}`;
  },
};

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

/**
 * The posting scope differs by author type: a member post needs
 * w_member_social, a company page post needs the organization scopes. Both are
 * requested so either connection can publish.
 */
export const LINKEDIN_SCOPES = [
  "w_member_social",
  "w_organization_social",
  "r_organization_social",
];

export const LINKEDIN_POSTS_ENDPOINT = "https://api.linkedin.com/rest/posts";
/** Pinned API version — LinkedIn requires an explicit version header. */
export const LINKEDIN_API_VERSION = "202401";

export interface LinkedInPostBody {
  author: string;
  commentary: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  distribution: { feedDistribution: "MAIN_FEED" };
  lifecycleState: "PUBLISHED";
  isReshareDisabledByAuthor: boolean;
  content?: {
    article: { source: string; title: string; description?: string };
  };
}

/**
 * Resolve the LinkedIn author URN. An organization connection publishes as the
 * page; a member connection publishes as the person. The account id is stored
 * by the OAuth callback and is never taken from the browser.
 */
export function linkedinAuthorUrn(connection: Pick<ProviderConnection, "externalAccountId" | "accountName">): string | null {
  const id = connection.externalAccountId?.trim();
  if (!id) return null;
  if (id.startsWith("urn:li:")) return id;
  if (/^\d+$/.test(id) && connection.accountName) return `urn:li:organization:${id}`;
  if (/^\d+$/.test(id)) return `urn:li:person:${id}`;
  return null;
}

export function buildLinkedInRequest(
  request: PublishRequest,
  connection: Pick<ProviderConnection, "externalAccountId" | "accountName">,
): LinkedInPostBody | null {
  const author = linkedinAuthorUrn(connection);
  if (!author) return null;

  const body: LinkedInPostBody = {
    author,
    commentary: request.body.slice(0, 3_000),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  // The blog is the primary owned destination: the post carries an article card
  // pointing at the Atlas article so the LinkedIn click lands on Atlas, not on
  // a YouTube watch page.
  if (request.canonicalUrl) {
    body.content = {
      article: {
        source: request.canonicalUrl,
        title: request.title.slice(0, 200),
      },
    };
  }
  return body;
}

export const linkedinPublisher: ContentPublisher = {
  provider: "linkedin",
  requiredScopes: LINKEDIN_SCOPES,

  buildRequest({ request, connection }) {
    return (buildLinkedInRequest(request, connection) ?? {}) as Record<string, unknown>;
  },

  endpoint() {
    return LINKEDIN_POSTS_ENDPOINT;
  },

  async publish({ request, connection, context, transport }) {
    const body = buildLinkedInRequest(request, connection);
    if (!body) {
      return {
        ok: false,
        errorClass: "invalid_content",
        error:
          "The LinkedIn connection has no account id; reconnect LinkedIn to resolve the posting author.",
        retryable: false,
      };
    }
    if (!connection.accessToken) {
      return {
        ok: false,
        errorClass: "not_connected",
        error: "LinkedIn is not connected for this organization.",
        retryable: false,
      };
    }

    const result = await transport({
      url: LINKEDIN_POSTS_ENDPOINT,
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "content-type": "application/json",
        "linkedin-version": LINKEDIN_API_VERSION,
        "x-restli-protocol-version": "2.0.0",
      },
      body,
    });

    if (!result.ok) {
      const errorClass = classifyPublishError({ status: result.status, message: result.text });
      return {
        ok: false,
        errorClass,
        error: `LinkedIn rejected the post (HTTP ${result.status}).`,
        retryable: isRetryable(errorClass),
      };
    }

    // LinkedIn returns the post URN in the `x-restli-id` header; a JSON body is
    // not guaranteed, so the transport surfaces the header value as `externalId`
    // when present.
    const withHeader = result as { externalId?: string };
    const externalId =
      withHeader.externalId ??
      (typeof result.json === "object" && result.json !== null
        ? ((result.json as Record<string, unknown>)["id"] as string | undefined)
        : undefined);

    if (!externalId) {
      return {
        ok: false,
        errorClass: "provider_error",
        error: "LinkedIn returned no post id; the post is unconfirmed.",
        retryable: true,
      };
    }

    context.log("linkedin.published", { postUrn: externalId });
    return {
      ok: true,
      externalId,
      externalUrl: linkedinPublisher.publicUrl(externalId),
      metadata: { author: body.author },
    };
  },

  publicUrl(externalId) {
    return `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}`;
  },
};

// ---------------------------------------------------------------------------
// Registry + shared execution
// ---------------------------------------------------------------------------

export const CONTENT_PUBLISHERS: Record<DestinationProvider, ContentPublisher | null> = {
  // The blog is published by the existing platform handler (content_publish_blog)
  // against Atlas's own database — it has no external provider to talk to.
  blog: null,
  youtube: youtubePublisher,
  linkedin: linkedinPublisher,
};

export function getPublisher(provider: DestinationProvider): ContentPublisher | null {
  return CONTENT_PUBLISHERS[provider] ?? null;
}

/**
 * Run one publication.
 *
 * Idempotency is enforced twice, deliberately:
 *   1. before the call — a publication that already has an external id is
 *      returned as-is instead of being re-sent (a retried job cannot double-post);
 *   2. after the call — the provider's id is what the database records, so a
 *      second worker that races the first converges on the same row.
 */
export async function publishToProvider(input: {
  provider: DestinationProvider;
  request: PublishRequest;
  connection: ProviderConnection;
  context: PublishContext;
  transport: PublishTransport;
  /** Set when the publication row already carries a provider id. */
  alreadyPublishedExternalId?: string | null;
}): Promise<PublishOutcome> {
  if (input.alreadyPublishedExternalId) {
    return {
      ok: true,
      externalId: input.alreadyPublishedExternalId,
      externalUrl: getPublisher(input.provider)?.publicUrl(input.alreadyPublishedExternalId) ?? null,
      metadata: { idempotent: true },
    };
  }

  const publisher = getPublisher(input.provider);
  if (!publisher) {
    return {
      ok: false,
      errorClass: "invalid_content",
      error: `No publisher is implemented for "${input.provider}".`,
      retryable: false,
    };
  }

  // A connection whose scopes do not cover publishing cannot publish — this is
  // an authorization failure, not an authentication one.
  const missing = publisher.requiredScopes.filter(
    (scope) => !input.connection.scopes.includes(scope),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      errorClass: "not_connected",
      error: `The ${input.provider} connection is missing required permissions. Reconnect ${input.provider}.`,
      retryable: false,
    };
  }

  try {
    return await publisher.publish(input);
  } catch {
    // Never surface a raw provider/transport error to the user.
    return {
      ok: false,
      errorClass: "network_error",
      error: `The ${input.provider} request could not be completed.`,
      retryable: true,
    };
  }
}
