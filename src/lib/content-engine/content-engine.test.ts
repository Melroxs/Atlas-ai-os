import { describe, expect, it, vi } from "vitest";
import {
  buildArticleBrief,
  buildLinkedInPost,
  buildThumbnailBrief,
  buildVideoScript,
  buildYouTubePresentation,
  scanForUnverifiedClaims,
  toOverlayText,
  validateGeneratedCopy,
} from "./copy";
import {
  assetOf,
  canPublish,
  classifyPublishError,
  crossLinks,
  describePublishFailure,
  destinationState,
  destinationStates,
  isRetryable,
  nextWorkflowStep,
  pendingDestinations,
  publicationFor,
  validatePackageIntegrity,
} from "./package";
import {
  buildLinkedInRequest,
  buildYouTubeRequest,
  linkedinAuthorUrn,
  publishToProvider,
  youtubePublisher,
  linkedinPublisher,
} from "./publishers";
import {
  buildImageRequest,
  buildPixVerseRequest,
  localMockVideoProvider,
  mediaProviderStatus,
  resolveImageProvider,
  resolveVideoProvider,
} from "./media";
import {
  DEFAULT_TOPIC_BANK,
  buildPublishRequest,
  blogUrlForSlug,
  handleContentAutomationTick,
  handleContentGeneratePackage,
  handleContentGenerateThumbnail,
  handleContentGenerateVideo,
  handleContentPublishLinkedIn,
  handleContentPublishYouTube,
  pickNextTopic,
  type ContentEnginePorts,
} from "./jobs";
import { publicationIdempotencyKey } from "./types";
import type {
  ContentAssetRecord,
  ContentAutomationSettings,
  ContentPackageView,
  ContentPublicationRecord,
  DestinationProvider,
  ProviderConnection,
  PublishTransport,
} from "./types";
import type { JobExecutionContext } from "@/lib/jobs/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPROVED_BODY = [
  "# Why Insurance Supplements Get Missed",
  "",
  "Supplements are missed because the evidence a carrier needs never makes it into the same package as the estimate.",
  "",
  "## The handoff between field and office",
  "",
  "When photos live in one place and the estimate lives in another, the person assembling the submission rebuilds context that already existed.",
  "That rebuild is where scope quietly disappears from the claim.",
  "",
  "## Documentation standards crews follow",
  "",
  "A standard only works when it is checkable in the field, before the crew leaves the property.",
  "",
  "## Reviewing before submission",
  "",
  "Reviewing the package against the carrier's own request list catches gaps while they can still be fixed.",
  "",
  "Atlas turns scattered job data into decisions.",
].join("\n");

function asset(partial: Partial<ContentAssetRecord> & { assetType: string }): ContentAssetRecord {
  return {
    _id: `asset-${partial.assetType}`,
    contentType: partial.contentType ?? "blog",
    status: partial.status ?? "drafted",
    title: partial.title ?? `${partial.assetType} title`,
    body: partial.body ?? null,
    storagePath: partial.storagePath ?? null,
    externalUrl: partial.externalUrl ?? null,
    externalId: partial.externalId ?? null,
    mimeType: partial.mimeType ?? null,
    provider: partial.provider ?? null,
    parentContentId: partial.parentContentId ?? "pkg-1",
    approvalStatus: partial.approvalStatus ?? "pending",
    metadata: partial.metadata ?? {},
    ...partial,
    assetType: partial.assetType,
  } as ContentAssetRecord;
}

function publication(
  provider: DestinationProvider,
  partial: Partial<ContentPublicationRecord> = {},
): ContentPublicationRecord {
  return {
    _id: `pub-${provider}`,
    organizationId: "org-1",
    contentPackageId: "pkg-1",
    assetId: null,
    provider,
    status: "queued",
    scheduledAt: null,
    attemptCount: 0,
    externalId: null,
    externalUrl: null,
    lastError: null,
    errorClass: null,
    publishedAt: null,
    idempotencyKey: publicationIdempotencyKey("pkg-1", provider, null),
    ...partial,
  };
}

const COMPLETE_PACKAGE: ContentPackageView = {
  packageId: "pkg-1",
  title: "Why Insurance Supplements Get Missed",
  slug: "why-insurance-supplements-get-missed",
  status: "in_review",
  approvalStatus: "pending",
  organizationId: "org-1",
  youtubeUrl: null,
  youtubeVideoId: null,
  youtubeThumbnailUrl: null,
  blogUrl: null,
  assets: [
    asset({ assetType: "blog_article", contentType: "blog", body: APPROVED_BODY, title: "Why Insurance Supplements Get Missed" }),
    asset({ assetType: "video_script", contentType: "video_script", body: "HOOK: …" }),
    asset({ assetType: "youtube_video", contentType: "youtube_video", externalUrl: "https://cdn.example/video.mp4" }),
    asset({ assetType: "youtube_thumbnail", contentType: "youtube_thumbnail", externalUrl: "https://cdn.example/thumb.jpg" }),
    asset({ assetType: "linkedin_post", contentType: "linkedin_post", body: "A native post." }),
  ],
  publications: [],
};

function ctx(payload: Record<string, unknown> = {}): JobExecutionContext {
  return {
    job: { payload, idempotency_key: "k", tenant_id: null } as never,
    step: null,
    steps: [],
    supabase: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    signal: new AbortController().signal,
    worker_id: "test",
  } as unknown as JobExecutionContext;
}

function makePorts(overrides: Partial<ContentEnginePorts> = {}) {
  const calls = {
    assets: [] as Array<Record<string, unknown>>,
    enqueued: [] as Array<Record<string, unknown>>,
    publications: [] as Array<Record<string, unknown>>,
    completed: [] as Array<Record<string, unknown>>,
    failed: [] as Array<Record<string, unknown>>,
    presentations: [] as Array<Record<string, unknown>>,
    topics: [] as Array<Record<string, unknown>>,
  };
  const ports: ContentEnginePorts = {
    now: () => 1_760_000_000_000,
    env: { get: () => null },
    transport: vi.fn() as unknown as PublishTransport,
    loadPackage: vi.fn(async () => COMPLETE_PACKAGE),
    getConnection: vi.fn(async () => null),
    createPackage: vi.fn(async () => ({ packageId: "pkg-1" })),
    generateArticle: vi.fn(async () => ({
      title: "Why Insurance Supplements Get Missed",
      body: APPROVED_BODY,
      summary: "A short summary.",
      seo: {},
      knowledgeIds: [],
      sourceIds: [],
    })),
    upsertAsset: vi.fn(async (input) => {
      calls.assets.push(input as unknown as Record<string, unknown>);
      return { assetId: `asset-${String(input.assetType)}` };
    }),
    setBlogPresentation: vi.fn(async (input) => {
      calls.presentations.push(input as unknown as Record<string, unknown>);
    }),
    upsertPublication: vi.fn(async (input) => {
      calls.publications.push(input as unknown as Record<string, unknown>);
      return { publicationId: `pub-${String(input.provider)}` };
    }),
    claimPublication: vi.fn(async () => publication("youtube")),
    completePublication: vi.fn(async (input) => {
      calls.completed.push(input as unknown as Record<string, unknown>);
    }),
    failPublication: vi.fn(async (input) => {
      calls.failed.push(input as unknown as Record<string, unknown>);
    }),
    requestReview: vi.fn(async () => undefined),
    enqueue: vi.fn(async (input) => {
      calls.enqueued.push(input as unknown as Record<string, unknown>);
    }),
    listDueAutomations: vi.fn(async () => []),
    nextTopic: vi.fn(async () => null),
    noteTopic: vi.fn(async (input) => {
      calls.topics.push(input as unknown as Record<string, unknown>);
    }),
    getAutomation: vi.fn(async () => ({
      organizationId: "org-1",
      enabled: false,
      intervalSeconds: null,
      requireApproval: true,
      autoPublish: false,
      brandVoice: null,
      audience: null,
      primaryCta: null,
      defaultTone: null,
      coveredTopics: [],
      lastGeneratedAt: null,
      lastPackageId: null,
    })),
    ...overrides,
  };
  return { ports, calls };
}

function connection(provider: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    connectionId: `conn-${provider}`,
    provider,
    status: "connected",
    externalAccountId: provider === "youtube" ? "UC123" : "98765",
    accountName: "Atlas",
    scopes:
      provider === "youtube"
        ? ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]
        : ["w_member_social", "w_organization_social", "r_organization_social"],
    accessToken: "token-value",
    refreshToken: "refresh-value",
    expiresAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Package relationships + destination state
// ---------------------------------------------------------------------------

describe("package relationships", () => {
  it("treats every derivative as one package and finds assets by type", () => {
    expect(assetOf(COMPLETE_PACKAGE, "youtube_video")?._id).toBe("asset-youtube_video");
    expect(assetOf(COMPLETE_PACKAGE, "blog_hero_image")).toBeNull();
  });

  it("reports each destination independently — one failure never masks another", () => {
    const view: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      publications: [
        publication("blog", { status: "published", externalUrl: "https://atlas-ai-os.com/blog/x" }),
        publication("youtube", { status: "failed", errorClass: "token_expired" }),
      ],
    };
    const states = destinationStates(view);
    const blog = states.find((s) => s.provider === "blog")!;
    const youtube = states.find((s) => s.provider === "youtube")!;
    const linkedin = states.find((s) => s.provider === "linkedin")!;

    expect(blog.status).toBe("published");
    expect(blog.terminal).toBe(true);
    expect(youtube.status).toBe("failed");
    expect(youtube.terminal).toBe(false);
    expect(youtube.nextAction).toContain("Reconnect YouTube");
    expect(linkedin.status).toBe("not_queued");
    expect(pendingDestinations(view).sort()).toEqual(["linkedin", "youtube"]);
  });

  it("never reports a not-yet-generated destination as ready", () => {
    const view: ContentPackageView = { ...COMPLETE_PACKAGE, assets: [] };
    expect(destinationState(view, "youtube").nextAction).toContain("Generate");
    expect(destinationState(view, "blog").nextAction).toContain("Approve");
  });

  it("maps provider failures onto actionable, non-raw messages", () => {
    for (const cls of ["not_connected", "token_expired", "authorization_revoked", "invalid_content"] as const) {
      const message = describePublishFailure("youtube", cls);
      expect(message).toContain("YouTube");
      expect(message).not.toMatch(/HTTP|Bearer|eyJ/);
    }
  });

  it("classifies provider errors", () => {
    expect(classifyPublishError({ status: 401 })).toBe("token_expired");
    expect(classifyPublishError({ status: 403 })).toBe("authorization_revoked");
    expect(classifyPublishError({ status: 429 })).toBe("rate_limited");
    expect(classifyPublishError({ status: 400 })).toBe("invalid_content");
    expect(classifyPublishError({ status: 503 })).toBe("provider_error");
    expect(classifyPublishError({ code: "invalid_grant" })).toBe("token_expired");
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("token_expired")).toBe(false);
  });
});

describe("workflow progression", () => {
  it("advances through the documented steps in order", () => {
    const noArticle: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      assets: [asset({ assetType: "blog_article", contentType: "blog", body: "" })],
    };
    expect(nextWorkflowStep(noArticle)).toBe("article");

    const noScript: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      assets: [asset({ assetType: "blog_article", contentType: "blog", body: APPROVED_BODY })],
    };
    expect(nextWorkflowStep(noScript)).toBe("video_script");

    expect(nextWorkflowStep({ ...COMPLETE_PACKAGE, assets: COMPLETE_PACKAGE.assets.slice(0, 3) })).toBe("thumbnail");
    expect(nextWorkflowStep({ ...COMPLETE_PACKAGE, assets: COMPLETE_PACKAGE.assets.slice(0, 4) })).toBe("linkedin_post");
    expect(nextWorkflowStep(COMPLETE_PACKAGE)).toBe("review");
  });

  it("reports publish_blog first when the approved package has no publications", () => {
    const approved: ContentPackageView = { ...COMPLETE_PACKAGE, approvalStatus: "approved", status: "approved" };
    expect(nextWorkflowStep(approved)).toBe("publish_blog");
  });

  it("blocks publishing until a human approves", () => {
    expect(canPublish({ approvalStatus: "pending", status: "in_review" }).ok).toBe(false);
    expect(canPublish({ approvalStatus: "rejected", status: "in_review" }).ok).toBe(false);
    expect(canPublish({ approvalStatus: "needs_changes", status: "in_review" }).ok).toBe(false);
    expect(canPublish({ approvalStatus: "approved", status: "approved" }).ok).toBe(true);
    // autoPublish is an explicit opt-in and still requires the approved state.
    expect(
      canPublish({ approvalStatus: "pending", status: "drafted" }, { autoPublish: true }).ok,
    ).toBe(false);
    expect(canPublish({ approvalStatus: "archived", status: "archived" }).ok).toBe(false);
  });

  it("catches an inconsistent package", () => {
    const videoOnly: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      assets: [asset({ assetType: "blog_article", contentType: "blog", body: APPROVED_BODY }), asset({ assetType: "youtube_video", contentType: "youtube_video" })],
    };
    const errors = validatePackageIntegrity(videoOnly);
    expect(errors.join(" ")).toContain("video script");
    expect(errors.join(" ")).toContain("thumbnail");

    const mismatch: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      assets: [
        ...COMPLETE_PACKAGE.assets.filter((a) => a.assetType !== "youtube_video"),
        asset({
          assetType: "youtube_video",
          contentType: "youtube_video",
          metadata: { thumbnailUrl: "https://cdn.example/other.jpg" },
        }),
      ],
    };
    expect(validatePackageIntegrity(mismatch).join(" ")).toContain("does not match");
  });

  it("only ever cross-links real URLs", () => {
    expect(crossLinks({ blogUrl: null, youtubeUrl: null })).toEqual({ blog: null, youtube: null });
    expect(blogUrlForSlug("a-b")).toBe("https://atlas-ai-os.com/blog/a-b");
    expect(blogUrlForSlug(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("article brief + no-fabrication rules", () => {
  it("forbids invented facts when no knowledge was retrieved", () => {
    const brief = buildArticleBrief({ topic: "Why supplements get missed" });
    expect(brief.slug).toBe("why-supplements-get-missed");
    expect(brief.instructions).toContain("MUST NOT invent statistics");
    expect(brief.instructions).toContain("No knowledge items were retrieved");
    expect(brief.instructions).toContain("Do not cite any external source");
    expect(brief.knowledge).toEqual([]);
  });

  it("restricts claims and links to the supplied knowledge", () => {
    const brief = buildArticleBrief({
      topic: "Supplements",
      knowledge: [{ knowledgeId: "k1", title: "Xactimate line items", statement: "Line items must match scope." }],
      internalLinks: [{ title: "Blog", url: "https://atlas-ai-os.com/blog" }],
    });
    expect(brief.instructions).toContain("[k1]");
    expect(brief.instructions).toContain("https://atlas-ai-os.com/blog");
    expect(brief.instructions).toContain("KNOWLEDGE:");
  });

  it("flags statistical and code-shaped claims for evidence", () => {
    const flags = scanForUnverifiedClaims(
      "Roughly 40% of claims are denied. According to the IRC, most carriers require photos.",
    );
    const labels = flags.map((f) => f.label);
    expect(labels).toContain("statistic");
    expect(labels).toContain("attribution");
    expect(flags[0].excerpt.length).toBeGreaterThan(0);
  });

  it("refuses placeholder output outright", () => {
    expect(validateGeneratedCopy("").ok).toBe(false);
    expect(validateGeneratedCopy("TODO: write this").ok).toBe(false);
    expect(validateGeneratedCopy("As an AI language model, I cannot").ok).toBe(false);
    expect(validateGeneratedCopy("[x]()").ok).toBe(false);
    const clean = validateGeneratedCopy("A specific, useful paragraph about estimating workflow.");
    expect(clean.ok).toBe(true);
    expect(clean.errors).toEqual([]);
  });
});

describe("video script derives from the article", () => {
  it("uses the article's own headings as the video's main points", () => {
    const script = buildVideoScript({
      articleTitle: "Why Insurance Supplements Get Missed",
      articleBody: APPROVED_BODY,
      durationSeconds: 300,
    });
    expect(script.mainPoints).toContain("The handoff between field and office");
    expect(script.mainPoints).toContain("Documentation standards crews follow");
    expect(script.script).toContain("HOOK:");
    expect(script.script).toContain("CTA:");
    expect(script.wordTarget).toBe(750);
    expect(script.hook).not.toBe("");
  });

  it("clamps the duration to the documented 3-6 minute window", () => {
    expect(buildVideoScript({ articleTitle: "T", articleBody: APPROVED_BODY, durationSeconds: 30 }).durationSeconds).toBe(180);
    expect(buildVideoScript({ articleTitle: "T", articleBody: APPROVED_BODY, durationSeconds: 9_000 }).durationSeconds).toBe(600);
  });
});

describe("thumbnail brief", () => {
  it("keeps overlay text short and free of digits (no stat-shaped claims)", () => {
    const brief = buildThumbnailBrief({ articleTitle: "Why 40% of Insurance Supplements Get Missed" });
    expect(brief.overlayText).not.toMatch(/\d/);
    expect(brief.overlayText.split(" ").length).toBeLessThanOrEqual(4);
    expect(brief.prompt).toContain("Do not include invented statistics");
    expect(brief.width).toBe(1280);
    expect(brief.height).toBe(720);
  });

  it("strips digits from overlay text", () => {
    expect(toOverlayText("2024 Supplement Guide")).toBe("SUPPLEMENT GUIDE");
  });
});

describe("YouTube presentation", () => {
  it("carries the canonical blog URL back to the article", () => {
    const script = buildVideoScript({
      articleTitle: "Why Insurance Supplements Get Missed",
      articleBody: APPROVED_BODY,
    });
    const presentation = buildYouTubePresentation({
      articleTitle: "Why Insurance Supplements Get Missed",
      summary: "A summary.",
      script,
      blogUrl: "https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed",
      tags: ["Insurance", "insurance", "Restoration"],
    });
    expect(presentation.description).toContain("Read the full article on Atlas: https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed");
    expect(presentation.tags).toEqual(["insurance", "restoration"]);
    expect(presentation.title.length).toBeLessThanOrEqual(100);
  });

  it("never emits a link when the blog URL is unknown", () => {
    const script = buildVideoScript({ articleTitle: "T", articleBody: APPROVED_BODY });
    const presentation = buildYouTubePresentation({
      articleTitle: "T",
      summary: null,
      script,
      blogUrl: null,
      tags: [],
    });
    expect(presentation.description).not.toContain("Read the full article");
  });
});

describe("LinkedIn post", () => {
  const base = {
    articleTitle: "Why Insurance Supplements Get Missed",
    articleSummary: "Supplements are missed when evidence and estimate never meet.",
    articleStatus: "approved",
    approvalStatus: "approved",
    articleId: "pkg-1",
    sourceIds: ["s1"],
    knowledgeIds: ["k1"],
    keyPoints: ["The handoff breaks", "Standards must be checkable in the field"],
    blogUrl: "https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed",
    youtubeUrl: "https://www.youtube.com/watch?v=abc",
  };

  it("is a native post that drives to the owned article", () => {
    const post = buildLinkedInPost(base);
    expect(post.ok).toBe(true);
    expect(post.body).toContain("READ THE FULL ARTICLE → https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed");
    expect(post.body).toContain("WATCH THE VIDEO → https://www.youtube.com/watch?v=abc");
    expect(post.body!.length).toBeLessThan(APPROVED_BODY.length);
  });

  it("refuses to derive a post from an unapproved article", () => {
    const post = buildLinkedInPost({ ...base, approvalStatus: "pending", articleStatus: "in_review" });
    expect(post.ok).toBe(false);
    expect(post.error).toContain("approved");
  });

  it("reports missing links instead of inventing them", () => {
    const post = buildLinkedInPost({ ...base, blogUrl: null, youtubeUrl: null });
    expect(post.ok).toBe(true);
    expect(post.notes.join(" ")).toContain("No canonical blog URL");
    expect(post.body).not.toContain("https://");
  });
});

// ---------------------------------------------------------------------------
// Publishers
// ---------------------------------------------------------------------------

describe("YouTube publisher", () => {
  const request = {
    title: "A title",
    body: "Description",
    canonicalUrl: "https://atlas-ai-os.com/blog/x",
    youtubeUrl: null,
    tags: ["a", "b"],
    thumbnailUrl: "https://cdn.example/thumb.jpg",
    options: { videoUrl: "https://cdn.example/video.mp4" },
  };

  it("defaults to private visibility so nothing is published publicly by accident", () => {
    const body = buildYouTubeRequest(request);
    expect(body.status.privacyStatus).toBe("private");
    expect(body.snippet.categoryId).toBe("27");
    expect(buildYouTubeRequest({ ...request, options: { visibility: "public" } }).status.privacyStatus).toBe("public");
  });

  it("refuses to publish without a video file", async () => {
    const outcome = await publishToProvider({
      provider: "youtube",
      request: { ...request, options: {} },
      connection: connection("youtube"),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport: vi.fn() as unknown as PublishTransport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorClass).toBe("invalid_content");
      expect(outcome.retryable).toBe(false);
    }
  });

  it("reports missing scopes as an authorization problem, not a network one", async () => {
    const outcome = await publishToProvider({
      provider: "youtube",
      request,
      connection: connection("youtube", { scopes: [] }),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport: vi.fn() as unknown as PublishTransport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorClass).toBe("not_connected");
  });

  it("is idempotent: an already-published video is not re-uploaded", async () => {
    const transport = vi.fn();
    const outcome = await publishToProvider({
      provider: "youtube",
      request,
      connection: connection("youtube"),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport: transport as unknown as PublishTransport,
      alreadyPublishedExternalId: "existing-video-id",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.externalId).toBe("existing-video-id");
      expect(outcome.metadata).toEqual({ idempotent: true });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("uploads then records the provider id", async () => {
    const responses = [
      { status: 200, ok: true, json: {}, text: "", headers: { location: "https://upload.example/session" } },
      { status: 200, ok: true, json: { id: "video-123" }, text: "" },
      { status: 200, ok: true, json: {}, text: "" },
    ];
    const transport = vi.fn(async () => responses.shift()!) as unknown as PublishTransport;
    const outcome = await publishToProvider({
      provider: "youtube",
      request,
      connection: connection("youtube"),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.externalId).toBe("video-123");
      expect(outcome.externalUrl).toBe("https://www.youtube.com/watch?v=video-123");
    }
  });

  it("treats a provider failure as retryable without inventing success", async () => {
    const transport = vi.fn(async () => ({ status: 503, ok: false, json: {}, text: "unavailable" })) as unknown as PublishTransport;
    const outcome = await publishToProvider({
      provider: "youtube",
      request,
      connection: connection("youtube"),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorClass).toBe("provider_error");
      expect(outcome.retryable).toBe(true);
    }
  });

  it("exposes the canonical watch URL", () => {
    expect(youtubePublisher.publicUrl("abc")).toBe("https://www.youtube.com/watch?v=abc");
  });
});

describe("LinkedIn publisher", () => {
  const request = {
    title: "Why Insurance Supplements Get Missed",
    body: "A native post.",
    canonicalUrl: "https://atlas-ai-os.com/blog/x",
    youtubeUrl: null,
    tags: [],
    thumbnailUrl: null,
    options: {},
  };

  it("resolves a company page or a member author urn", () => {
    expect(linkedinAuthorUrn({ externalAccountId: "98765", accountName: "Atlas" })).toBe("urn:li:organization:98765");
    expect(linkedinAuthorUrn({ externalAccountId: "urn:li:person:abc", accountName: null })).toBe("urn:li:person:abc");
    expect(linkedinAuthorUrn({ externalAccountId: "", accountName: null })).toBeNull();
  });

  it("attaches the Atlas article as the post's card", () => {
    const body = buildLinkedInRequest(request, { externalAccountId: "98765", accountName: "Atlas" })!;
    expect(body.content?.article.source).toBe("https://atlas-ai-os.com/blog/x");
    expect(body.author).toBe("urn:li:organization:98765");
    expect(body.lifecycleState).toBe("PUBLISHED");
  });

  it("omits the card rather than inventing a URL", () => {
    const body = buildLinkedInRequest({ ...request, canonicalUrl: null }, { externalAccountId: "98765", accountName: "Atlas" })!;
    expect(body.content).toBeUndefined();
  });

  it("refuses to post when the author is unknown", async () => {
    const outcome = await publishToProvider({
      provider: "linkedin",
      request,
      connection: connection("linkedin", { externalAccountId: null }),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport: vi.fn() as unknown as PublishTransport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorClass).toBe("invalid_content");
  });

  it("records the post urn returned in the header", async () => {
    const transport = vi.fn(async () => ({
      status: 201,
      ok: true,
      json: {},
      text: "",
      externalId: "urn:li:share:123",
    })) as unknown as PublishTransport;
    const outcome = await publishToProvider({
      provider: "linkedin",
      request,
      connection: connection("linkedin"),
      context: { organizationId: "org-1", packageId: "pkg-1", assetId: null, now: () => 0, log: () => {} },
      transport,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.externalId).toBe("urn:li:share:123");
      expect(linkedinPublisher.publicUrl("urn:li:share:123")).toContain("/feed/update/");
    }
  });
});

// ---------------------------------------------------------------------------
// Media providers
// ---------------------------------------------------------------------------

describe("media providers", () => {
  it("never fabricates a video when no provider is configured", () => {
    expect(resolveVideoProvider({ get: () => null })).toBeNull();
    expect(resolveImageProvider({ get: () => null })).toBeNull();
    const status = mediaProviderStatus({ get: () => null });
    expect(status.video.configured).toBe(false);
    expect(status.image.requires).toContain("IMAGE_PROVIDER_API_KEY");
  });

  it("selects a configured provider", () => {
    const env = { get: (k: string) => (k === "VIDEO_PROVIDER_API_KEY" ? "key" : null) };
    expect(resolveVideoProvider(env)?.id).toBe("pixverse");
    expect(resolveVideoProvider({ get: (k) => (k === "VIDEO_PROVIDER" ? "local-mock" : null) })?.id).toBe("local-mock");
  });

  it("builds provider requests without leaking anything but the prompt", () => {
    // A whole-video request (the 5 minute TARGET) is clamped to a clip the
    // model can actually render. `duration: 300` is not a value any
    // text-to-video API accepts, and `negative_prompt` is not in the current
    // PixVerse schema at all.
    const video = buildPixVerseRequest({
      script: "script",
      title: "title",
      durationSeconds: 300,
      aspectRatio: "16:9",
      style: "clean",
      outputPrefix: "content/pkg/video",
    });
    expect(video["duration"]).toBe(8);
    expect(video["duration"]).not.toBe(300);
    expect(video["prompt"]).toContain("title");
    expect(video).not.toHaveProperty("negative_prompt");

    const image = buildImageRequest({
      prompt: "prompt",
      overlayText: null,
      aspectRatio: "16:9",
      width: 1280,
      height: 720,
      outputPrefix: "content/pkg/thumb",
    });
    expect(image["width"]).toBe(1280);
    expect(image["n"]).toBe(1);
  });

  it("the local mock never claims a real media URL", async () => {
    const result = await localMockVideoProvider.generate(
      {
        script: "s",
        title: "t",
        durationSeconds: 300,
        aspectRatio: "16:9",
        style: "clean",
        outputPrefix: "content/pkg/video",
      },
      { env: { get: () => null }, transport: vi.fn() as unknown as PublishTransport, now: () => 5 },
    );
    expect(result.mediaUrl).toBeNull();
    expect(result.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

describe("content_generate_package", () => {
  it("creates the package, writes the article and script, and fans out the rest", async () => {
    const { ports, calls } = makePorts();
    const result = await handleContentGeneratePackage(ports)(ctx({ topic: "Why supplements get missed" }));

    expect(result.success).toBe(true);
    const assetTypes = calls.assets.map((a) => a["assetType"]);
    expect(assetTypes).toEqual(["blog_article", "video_script"]);
    expect(calls.enqueued.map((e) => e["jobType"]).sort()).toEqual([
      "content_generate_thumbnail",
      "content_generate_video",
      "content_write_linkedin",
    ]);
    expect(calls.topics).toHaveLength(1);
  });

  it("requires a topic", async () => {
    const { ports } = makePorts();
    const result = await handleContentGeneratePackage(ports)(ctx({}));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION");
  });

  it("rejects AI output containing placeholders", async () => {
    const { ports } = makePorts({
      generateArticle: vi.fn(async () => ({
        title: "T",
        body: "TODO: write the article",
        summary: "s",
        seo: {},
        knowledgeIds: [],
        sourceIds: [],
      })),
    });
    const result = await handleContentGeneratePackage(ports)(ctx({ topic: "T" }));
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("rejected");
  });
});

describe("content_generate_video", () => {
  it("fails as NOT_CONFIGURED, and stores nothing, when no provider exists", async () => {
    const { ports, calls } = makePorts();
    const result = await handleContentGenerateVideo(ports, null)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_CONFIGURED");
    expect(calls.assets).toHaveLength(0);
  });

  it("records the provider's job id so a retry resumes the same render", async () => {
    const { ports, calls } = makePorts();
    const result = await handleContentGenerateVideo(ports, localMockVideoProvider)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(true);
    expect(calls.assets[0]["assetType"]).toBe("youtube_video");
    expect(String(calls.assets[0]["externalId"])).toMatch(/^mock-/);
    expect(calls.assets[0]["status"]).toBe("researching");
  });

  it("requires the script before rendering", async () => {
    const { ports } = makePorts({
      loadPackage: vi.fn(async () => ({ ...COMPLETE_PACKAGE, assets: COMPLETE_PACKAGE.assets.filter((a) => a.assetType !== "video_script") })),
    });
    const result = await handleContentGenerateVideo(ports, localMockVideoProvider)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION");
  });
});

describe("content_generate_thumbnail", () => {
  const imageProvider = {
    id: "test-image",
    requiredEnvVars: [],
    isConfigured: () => true,
    generate: vi.fn(async () => ({
      externalId: "img-1",
      imageUrl: "https://cdn.example/thumb.jpg",
      storagePath: null,
      status: "ready" as const,
    })),
  };

  it("reuses the existing thumbnail instead of regenerating it", async () => {
    const { ports, calls } = makePorts();
    const result = await handleContentGenerateThumbnail(ports, imageProvider)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(true);
    expect(result.result?.["reused"]).toBe(true);
    expect(calls.assets).toHaveLength(0);
  });

  it("sets the thumbnail as the blog hero when it generates one", async () => {
    const { ports, calls } = makePorts({
      loadPackage: vi.fn(async () => ({
        ...COMPLETE_PACKAGE,
        assets: COMPLETE_PACKAGE.assets.filter((a) => a.assetType !== "youtube_thumbnail"),
      })),
    });
    const result = await handleContentGenerateThumbnail(ports, imageProvider)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(true);
    expect(calls.presentations[0]["heroImageUrl"]).toBe("https://cdn.example/thumb.jpg");
  });
});

describe("publishing handlers", () => {
  it("blocks publishing until the package is approved", async () => {
    const { ports, calls } = makePorts({ getConnection: vi.fn(async () => connection("youtube")) });
    const result = await handleContentPublishYouTube(ports)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CONFLICT");
    expect(calls.completed).toHaveLength(0);
  });

  it("requires a connected destination", async () => {
    const { ports } = makePorts({
      loadPackage: vi.fn(async () => ({ ...COMPLETE_PACKAGE, approvalStatus: "approved" as const, status: "approved" as const })),
    });
    const result = await handleContentPublishYouTube(ports)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_CONFIGURED");
    expect(result.error?.message).toContain("not connected");
  });

  it("publishes YouTube, records the id, and wires the blog hero to it", async () => {
    // POST starts the resumable session (no id); PUT carries the bytes and
    // returns the created video resource.
    const transport = vi.fn(async (input: { method: string }) =>
      input.method === "PUT"
        ? { status: 200, ok: true, json: { id: "vid-1" }, text: "" }
        : { status: 200, ok: true, json: {}, text: "" },
    );
    const view: ContentPackageView = { ...COMPLETE_PACKAGE, approvalStatus: "approved", status: "approved" };
    const { ports, calls } = makePorts({
      loadPackage: vi.fn(async () => view),
      getConnection: vi.fn(async () => connection("youtube")),
      transport: transport as unknown as PublishTransport,
      claimPublication: vi.fn(async () => publication("youtube", { status: "processing" })),
    });
    const result = await handleContentPublishYouTube(ports)(ctx({ package_id: "pkg-1" }));

    expect(result.success).toBe(true);
    expect(calls.completed[0]["externalId"]).toBe("vid-1");
    expect(calls.presentations[0]["youtubeUrl"]).toBe("https://www.youtube.com/watch?v=vid-1");
    expect(calls.failed).toHaveLength(0);
  });

  it("records a failure against its own destination without touching the others", async () => {
    const transport = vi.fn(async () => ({ status: 401, ok: false, json: {}, text: "unauthorized" }));
    const { ports, calls } = makePorts({
      loadPackage: vi.fn(async () => ({ ...COMPLETE_PACKAGE, approvalStatus: "approved" as const, status: "approved" as const })),
      getConnection: vi.fn(async () => connection("linkedin")),
      transport: transport as unknown as PublishTransport,
      claimPublication: vi.fn(async () => publication("linkedin", { status: "processing" })),
    });
    const result = await handleContentPublishLinkedIn(ports)(ctx({ package_id: "pkg-1" }));

    expect(result.success).toBe(false);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]["errorClass"]).toBe("token_expired");
    expect(calls.completed).toHaveLength(0);
    // The publication is queued for exactly one destination.
    expect(calls.publications.map((p) => p["provider"])).toEqual(["linkedin"]);
  });

  it("skips a publication another worker already claimed", async () => {
    const { ports, calls } = makePorts({
      loadPackage: vi.fn(async () => ({ ...COMPLETE_PACKAGE, approvalStatus: "approved" as const, status: "approved" as const })),
      getConnection: vi.fn(async () => connection("youtube")),
      claimPublication: vi.fn(async () => null),
    });
    const result = await handleContentPublishYouTube(ports)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(true);
    expect(result.result?.["skipped"]).toBe("already_claimed");
    expect(calls.completed).toHaveLength(0);
  });

  it("keeps the legacy NOT_CONFIGURED behaviour for payloads with no package", async () => {
    const { ports } = makePorts();
    const result = await handleContentPublishLinkedIn(ports)(ctx({}));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_CONFIGURED");
  });

  it("builds a LinkedIn request that links to the owned article, not to YouTube", () => {
    const request = buildPublishRequest(
      { ...COMPLETE_PACKAGE, blogUrl: "https://atlas-ai-os.com/blog/x" },
      "linkedin",
      {},
    );
    expect(request.canonicalUrl).toBe("https://atlas-ai-os.com/blog/x");
    expect(request.body).toBe("A native post.");
  });

  it("never asks to publish publicly to YouTube", () => {
    const request = buildPublishRequest(COMPLETE_PACKAGE, "youtube", {});
    expect(request.options["visibility"]).toBe("private");
    expect(request.thumbnailUrl).toBe("https://cdn.example/thumb.jpg");
  });
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

describe("content automation", () => {
  const settings = (overrides: Partial<ContentAutomationSettings> = {}): ContentAutomationSettings => ({
    organizationId: "org-1",
    enabled: true,
    intervalSeconds: 604_800,
    requireApproval: true,
    autoPublish: false,
    brandVoice: null,
    audience: null,
    primaryCta: null,
    defaultTone: null,
    coveredTopics: [],
    lastGeneratedAt: null,
    lastPackageId: null,
    ...overrides,
  });

  it("skips topics the organization already covered", () => {
    expect(pickNextTopic(settings())).toBe(DEFAULT_TOPIC_BANK[0]);
    expect(pickNextTopic(settings({ coveredTopics: [DEFAULT_TOPIC_BANK[0]] }))).toBe(DEFAULT_TOPIC_BANK[1]);
  });

  it("returns nothing rather than recycling when everything is covered", () => {
    expect(pickNextTopic(settings({ coveredTopics: [...DEFAULT_TOPIC_BANK] }))).toBeNull();
    expect(pickNextTopic(settings(), ["only one"])).toBe("only one");
  });

  it("enqueues one package per due organization and nothing when topics run out", async () => {
    // Selection lives in the DATABASE (content_next_topic), so the tick asks
    // for a topic per organization and enqueues nothing when the bank is
    // exhausted for that organization.
    const nextTopic = vi.fn(async (organizationId: string | null) =>
      organizationId === "org-3" ? null : "why insurance supplements get missed",
    );
    const { ports, calls } = makePorts({
      listDueAutomations: vi.fn(async () => [
        settings(),
        settings({ organizationId: "org-2", enabled: false }),
        settings({ organizationId: "org-3", coveredTopics: [...DEFAULT_TOPIC_BANK] }),
      ]),
      nextTopic,
    });
    const result = await handleContentAutomationTick(ports)(ctx({}));
    expect(result.success).toBe(true);
    expect(calls.enqueued).toHaveLength(1);
    expect(calls.enqueued[0]["jobType"]).toBe("content_generate_package");
    // A disabled automation is never even asked for a topic.
    expect(nextTopic).not.toHaveBeenCalledWith("org-2");
  });
});

// ---------------------------------------------------------------------------
// Idempotency + tenancy
// ---------------------------------------------------------------------------

describe("idempotency and isolation", () => {
  it("builds a stable key per (package, destination, asset)", () => {
    expect(publicationIdempotencyKey("pkg-1", "youtube", "asset-1")).toBe("pkg-1:youtube:asset-1");
    expect(publicationIdempotencyKey("pkg-1", "blog", null)).toBe("pkg-1:blog:none");
    // Same inputs, same key: a retried enqueue deduplicates.
    expect(publicationIdempotencyKey("pkg-1", "youtube", "asset-1")).toBe(
      publicationIdempotencyKey("pkg-1", "youtube", "asset-1"),
    );
  });

  it("uses the same key the database upsert is written against", () => {
    expect(publicationIdempotencyKey("pkg-1", "linkedin", null)).toBe(publicationFor(
      { publications: [publication("linkedin")] },
      "linkedin",
    )?.idempotencyKey);
  });

  it("keeps publication state per destination so retries cannot cross-contaminate", () => {
    const view: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      publications: [publication("blog", { status: "published", externalId: "slug-1" })],
    };
    expect(publicationFor(view, "linkedin")).toBeNull();
    expect(publicationFor(view, "blog")?.status).toBe("published");
  });
});

describe("publish request assembly (two-way links and the shared visual)", () => {
  const brand = {
    audience: null,
    tone: null,
    primaryCta: null,
    brandVoice: null,
  };

  it("puts the canonical blog URL in the YouTube description", () => {
    const request = buildPublishRequest(COMPLETE_PACKAGE, "youtube", brand);
    expect(request.body).toContain(
      "Read the full article on Atlas: https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed",
    );
  });

  it("reuses the ONE thumbnail for the video poster instead of regenerating it", () => {
    const request = buildPublishRequest(COMPLETE_PACKAGE, "youtube", brand);
    expect(request.thumbnailUrl).toBe("https://cdn.example/thumb.jpg");
  });

  it("prefers a human-edited script outline over the derived one", () => {
    const edited: ContentPackageView = {
      ...COMPLETE_PACKAGE,
      assets: COMPLETE_PACKAGE.assets.map((a) =>
        a.assetType === "video_script"
          ? asset({
              assetType: "video_script",
              contentType: "video_script",
              body: "HOOK: edited by a human",
              metadata: { mainPoints: ["Point the human chose", "Another"] },
            })
          : a,
      ),
    };
    const request = buildPublishRequest(edited, "youtube", brand);
    expect(request.body).toContain("Point the human chose");
    // Still derived from the ARTICLE, never from an unrelated topic.
    expect(request.body).toContain("Why Insurance Supplements Get Missed");
  });

  it("emits no blog link at all when the article has no slug yet", () => {
    const unpublished: ContentPackageView = { ...COMPLETE_PACKAGE, slug: null };
    const request = buildPublishRequest(unpublished, "youtube", brand);
    expect(request.body).not.toContain("Read the full article");
    expect(request.canonicalUrl).toBeNull();
  });

  it("sends LinkedIn the native post, pointing at the OWNED article", () => {
    const request = buildPublishRequest(COMPLETE_PACKAGE, "linkedin", brand);
    expect(request.body).toBe("A native post.");
    expect(request.canonicalUrl).toBe(
      "https://atlas-ai-os.com/blog/why-insurance-supplements-get-missed",
    );
  });
});
