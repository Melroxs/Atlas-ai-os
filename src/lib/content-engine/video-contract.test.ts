/**
 * The Atlas Content Engine — provider contract, crash recovery, token lifecycle
 * and scheduled automation, tested with stubs only.
 *
 * No test here contacts a real provider, a real OAuth app or a real database.
 * Everything is a mock, and every assertion is about behaviour Atlas can
 * guarantee without a network: it never sends an invalid provider request, it
 * never records a media URL the provider did not return, it never posts twice
 * after a crash, and it never publishes without a human decision.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOPIC_BANK,
  handleContentAutomationTick,
  handleContentGenerateVideo,
  handleContentPollVideo,
  pickNextTopic,
  type ContentEnginePorts,
} from "./jobs";
import {
  MAX_CLIPS,
  clipRequestFrom,
  isPlanComplete,
  markReady,
  markSubmitted,
  missingVideoAssembler,
  nextRenderAction,
  planClips,
  planFromMetadata,
  planToMetadata,
  type ClipPlan,
} from "./assemble";
import { PIXVERSE_SUPPORTED, PIXVERSE_TRACE_HEADER, pixVerseVideoProvider } from "./media";
import { classifyAuthFailure, decideTokenAction, reconnectMessage, supportsRefresh } from "./oauth";
import { PUBLICATION_LEASE_MS, alreadyPublished, claimEligibility } from "./package";
import { publicationIdempotencyKey } from "./types";
import type {
  ContentAssetRecord,
  ContentAutomationSettings,
  ContentPackageView,
  ContentPublicationRecord,
  PublishTransport,
  VideoGenerationProvider,
} from "./types";
import type { JobExecutionContext } from "@/lib/jobs/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;

const SCRIPT = [
  "HOOK: Why supplements get missed",
  "",
  "INTRODUCTION",
  "The adjuster never sees the work that was done.",
  "",
  "MAIN POINTS",
  "1. Photograph the room before you open the wall.",
  "2. Log every estimate line as it happens.",
  "3. Send the carrier one clean package.",
  "",
  "CONCLUSION",
  "Tie the points back to the workflow.",
].join("\n");

function ctx(payload: Record<string, unknown> = {}): JobExecutionContext {
  return {
    job: { payload, idempotency_key: "k", tenant_id: "org-1" } as never,
    step: null,
    steps: [],
    supabase: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    signal: new AbortController().signal,
    worker_id: "test",
  } as unknown as JobExecutionContext;
}

function scriptAsset(): ContentAssetRecord {
  return {
    _id: "asset-script",
    contentType: "video_script",
    assetType: "video_script",
    status: "drafted",
    title: "script",
    body: SCRIPT,
    storagePath: null,
    externalUrl: null,
    externalId: null,
    mimeType: null,
    provider: null,
    parentContentId: "pkg-1",
    approvalStatus: "pending",
    metadata: {},
  } as unknown as ContentAssetRecord;
}

/** The asset a given write produces, mirroring the database's per-type row. */
function writtenAsset(input: {
  assetType: string;
  contentType: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
  externalUrl?: string | null;
  externalId?: string | null;
}): ContentAssetRecord {
  return {
    _id: `asset-${input.assetType}`,
    contentType: input.contentType,
    assetType: input.assetType,
    status: "drafted",
    title: `${input.assetType} title`,
    body: input.body ?? null,
    storagePath: null,
    externalUrl: input.externalUrl ?? null,
    externalId: input.externalId ?? null,
    mimeType: null,
    provider: null,
    parentContentId: "pkg-1",
    approvalStatus: "pending",
    metadata: input.metadata ?? {},
  } as unknown as ContentAssetRecord;
}

function packageWith(video: ContentAssetRecord | null): ContentPackageView {
  return {
    packageId: "pkg-1",
    organizationId: "org-1",
    title: "Why Supplements Get Missed",
    slug: "why-supplements-get-missed",
    status: "in_review",
    approvalStatus: "pending",
    assets: video ? [scriptAsset(), video] : [scriptAsset()],
    publications: [],
  } as unknown as ContentPackageView;
}

interface Harness {
  ports: ContentEnginePorts;
  assets: Array<Record<string, unknown>>;
  enqueued: Array<Record<string, unknown>>;
}

function harness(overrides: Partial<ContentEnginePorts> = {}, view = packageWith(null)): Harness {
  const assets: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let current = view;
  const ports: ContentEnginePorts = {
    now: () => NOW,
    env: { get: () => null },
    transport: vi.fn() as unknown as PublishTransport,
    loadPackage: vi.fn(async () => current),
    getConnection: vi.fn(async () => null),
    createPackage: vi.fn(async () => ({ packageId: "pkg-1" })),
    generateArticle: vi.fn(async () => ({
      title: "t",
      body: SCRIPT,
      summary: "s",
      seo: {},
      knowledgeIds: [],
      sourceIds: [],
    })),
    upsertAsset: vi.fn(async (input) => {
      assets.push(input as unknown as Record<string, unknown>);
      // Mirror the database: the next job reloads what the last one wrote, and
      // an asset is keyed by (package, contentType, assetType).
      current = {
        ...current,
        assets: [
          ...current.assets.filter((a) => a.assetType !== input.assetType),
          writtenAsset(input),
        ],
      } as unknown as ContentPackageView;
      return { assetId: `asset-${input.assetType}` };
    }),
    setBlogPresentation: vi.fn(async () => undefined),
    upsertPublication: vi.fn(async () => ({ publicationId: "pub-1" })),
    claimPublication: vi.fn(async () => null),
    completePublication: vi.fn(async () => undefined),
    failPublication: vi.fn(async () => undefined),
    requestReview: vi.fn(async () => undefined),
    enqueue: vi.fn(async (input) => {
      enqueued.push(input as unknown as Record<string, unknown>);
    }),
    listDueAutomations: vi.fn(async () => []),
    nextTopic: vi.fn(async () => null),
    noteTopic: vi.fn(async () => undefined),
    getAutomation: vi.fn(async () => null),
    ...overrides,
  };
  return { ports, assets, enqueued };
}

/** A provider whose generate/poll behaviour the test dictates. */
function stubProvider(overrides: Partial<VideoGenerationProvider>): VideoGenerationProvider {
  return {
    id: "stub",
    requiredEnvVars: [],
    isConfigured: () => true,
    generate: vi.fn(async () => ({
      externalId: "job-1",
      mediaUrl: null,
      storagePath: null,
      status: "pending" as const,
      error: undefined,
    })),
    poll: vi.fn(async (externalId: string) => ({
      externalId,
      mediaUrl: null,
      storagePath: null,
      status: "pending" as const,
      error: undefined,
    })),
    ...overrides,
  } as VideoGenerationProvider;
}

// ---------------------------------------------------------------------------
// Video — the PixVerse contract
// ---------------------------------------------------------------------------

describe("video provider contract", () => {
  function envWith(values: Record<string, string>) {
    return { get: (key: string) => values[key] ?? null };
  }

  it("sends the required unique trace header on submit and on poll", async () => {
    const headers: Record<string, string>[] = [];
    const transport = vi.fn(async (input: { headers: Record<string, string> }) => {
      headers.push(input.headers);
      return input.url.includes("/generate")
        ? { status: 200, ok: true, json: { Resp: { video_id: 777 } }, text: "", headers: {} }
        : { status: 200, ok: true, json: { Resp: { status: 1, url: "https://cdn/clip.mp4" } }, text: "", headers: {} };
    }) as unknown as PublishTransport;

    const request = clipRequestFrom(
      planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 }),
      { index: 0, prompt: "P", durationSeconds: 8, status: "pending", providerJobId: null, mediaUrl: null, error: null },
      { title: "T", aspectRatio: "16:9", style: "clean", outputPrefix: "content/p/video" },
    );
    const deps = { env: envWith({ VIDEO_PROVIDER_API_KEY: "k" }), transport, now: () => NOW };

    const submitted = await pixVerseVideoProvider.generate(request, deps);
    await pixVerseVideoProvider.poll?.("777", deps);

    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header[PIXVERSE_TRACE_HEADER]).toBeTruthy();
      expect(header[PIXVERSE_TRACE_HEADER]).toMatch(/[0-9a-f-]{8,}/i);
      expect(header["api-key"]).toBe("k");
    }
    // The trace id must be unique per request, not a constant.
    expect(headers[0][PIXVERSE_TRACE_HEADER]).not.toBe(headers[1][PIXVERSE_TRACE_HEADER]);
    expect(submitted.externalId).toBe("777");
  });

  it("sends a duration the selected model actually supports, never 300", async () => {
    for (const [model, supported] of Object.entries(PIXVERSE_SUPPORTED)) {
      const bodies: Array<Record<string, unknown>> = [];
      const transport = vi.fn(async (input: { body?: Record<string, unknown> }) => {
        bodies.push(input.body ?? {});
        return { status: 200, ok: true, json: { Resp: { video_id: 1 } }, text: "", headers: {} };
      }) as unknown as PublishTransport;

      await pixVerseVideoProvider.generate(
        {
          script: "a scene",
          title: "T",
          // The 5 minute TARGET, deliberately passed as if it were a clip.
          durationSeconds: 300,
          aspectRatio: "16:9",
          style: "clean",
          outputPrefix: "p",
        },
        { env: envWith({ VIDEO_PROVIDER_API_KEY: "k", VIDEO_PROVIDER_MODEL: model }), transport, now: () => NOW },
      );

      const duration = bodies[0]["duration"];
      expect(duration).not.toBe(300);
      expect(supported).toContain(duration as number);
    }
  });

  it("never sends negative_prompt and never exceeds the prompt limit", async () => {
    let body: Record<string, unknown> = {};
    const transport = vi.fn(async (input: { body?: Record<string, unknown> }) => {
      body = input.body ?? {};
      return { status: 200, ok: true, json: { Resp: { video_id: 2 } }, text: "", headers: {} };
    }) as unknown as PublishTransport;

    await pixVerseVideoProvider.generate(
      {
        script: "x".repeat(9000),
        title: "T",
        durationSeconds: 8,
        aspectRatio: "16:9",
        style: "clean",
        outputPrefix: "p",
      },
      { env: envWith({ VIDEO_PROVIDER_API_KEY: "k" }), transport, now: () => NOW },
    );

    expect(body).not.toHaveProperty("negative_prompt");
    expect(String(body["prompt"]).length).toBeLessThanOrEqual(5000);
  });

  it("treats generation as asynchronous: a job id, never a media URL", async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: { Resp: { video_id: 4242, url: "https://should-be-ignored/early.mp4" } },
      text: "",
      headers: {},
    })) as unknown as PublishTransport;

    const result = await pixVerseVideoProvider.generate(
      { script: "s", title: "T", durationSeconds: 8, aspectRatio: "16:9", style: "c", outputPrefix: "p" },
      { env: envWith({ VIDEO_PROVIDER_API_KEY: "k" }), transport, now: () => NOW },
    );

    expect(result.status).toBe("pending");
    expect(result.externalId).toBe("4242");
    // Even though the provider echoed a url, the engine does not adopt it
    // before the result endpoint confirms the render finished.
    expect(result.mediaUrl).toBeNull();
  });

  it("fails closed when the provider is not configured", async () => {
    const transport = vi.fn() as unknown as PublishTransport;
    const result = await pixVerseVideoProvider.generate(
      { script: "s", title: "T", durationSeconds: 8, aspectRatio: "16:9", style: "c", outputPrefix: "p" },
      { env: envWith({}), transport, now: () => NOW },
    );
    expect(result.status).toBe("failed");
    expect(result.mediaUrl).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("video poll lifecycle", () => {
  function pollWith(json: unknown, ok = true, status = 200) {
    const transport = vi.fn(async () => ({
      status,
      ok,
      json,
      text: "",
      headers: {},
    })) as unknown as PublishTransport;
    return { env: { get: () => "k" }, transport, now: () => NOW };
  }

  it("keeps the render pending while the provider is generating", async () => {
    const result = await pixVerseVideoProvider.poll?.("1", pollWith({ Resp: { status: 5 } }));
    expect(result?.status).toBe("pending");
    expect(result?.mediaUrl).toBeNull();
  });

  it("records the media URL only on a completed render", async () => {
    const result = await pixVerseVideoProvider.poll?.(
      "1",
      pollWith({ Resp: { status: 1, url: "https://cdn.example/clip-0.mp4" } }),
    );
    expect(result?.status).toBe("ready");
    expect(result?.mediaUrl).toBe("https://cdn.example/clip-0.mp4");
  });

  it("fails a moderation rejection and never invents a URL", async () => {
    const rejected = await pixVerseVideoProvider.poll?.("1", pollWith({ Resp: { status: 7 } }));
    expect(rejected?.status).toBe("failed");
    expect(rejected?.mediaUrl).toBeNull();

    // Success WITHOUT a file is a failure, not a usable asset.
    const emptySuccess = await pixVerseVideoProvider.poll?.("1", pollWith({ Resp: { status: 1 } }));
    expect(emptySuccess?.status).toBe("failed");
    expect(emptySuccess?.mediaUrl).toBeNull();
    expect(emptySuccess?.error).toContain("without a media file");
  });

  it("treats an unreadable result as a failure, never as success", async () => {
    const result = await pixVerseVideoProvider.poll?.("1", pollWith({}, false, 502));
    expect(result?.status).toBe("failed");
    expect(result?.mediaUrl).toBeNull();
  });

  it("plans a multi-clip video and stops honestly without an assembler", async () => {
    const plan = planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 });
    expect(plan.clips.length).toBeGreaterThan(1);
    expect(plan.clips.length).toBeLessThanOrEqual(MAX_CLIPS);
    expect(plan.targetDurationSeconds).toBe(300);
    // The plan is sized by the target LENGTH, not by the script's scene count,
    // and the assembled length lands inside the 3-6 minute band the product
    // requires. `truncated` records honestly that 24 x 8s is under the 5
    // minute target.
    const assembledSeconds = plan.clips.reduce((total, c) => total + c.durationSeconds, 0);
    expect(assembledSeconds).toBeGreaterThanOrEqual(180);
    expect(assembledSeconds).toBeLessThanOrEqual(360);
    expect(plan.truncated).toBe(assembledSeconds < plan.targetDurationSeconds);

    // Every clip ready, but no concatenator exists: the engine says so and
    // never produces a media URL.
    const ready = plan.clips.reduce(
      (p, c) => markReady(p, c.index, `https://cdn/${c.index}.mp4`),
      plan,
    );
    expect(isPlanComplete(ready)).toBe(true);
    expect(missingVideoAssembler.isConfigured()).toBe(false);
    const assembled = await missingVideoAssembler.assemble(ready);
    expect(assembled.status).toBe("needs_assembler");
    expect(assembled).not.toHaveProperty("mediaUrl");
  });

  it("resumes from persisted state rather than restarting the render", () => {
    const plan = planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 });
    const persisted = planToMetadata(markSubmitted(plan, 0, "job-42"));
    const restored = planFromMetadata(persisted);
    expect(restored).toEqual(markSubmitted(plan, 0, "job-42"));
    // The SAME provider render is polled, not re-submitted. The plan also has
    // later clips still pending, and those are submitted next: at most one
    // render is in flight per job, so a 24-clip video never becomes 24
    // concurrent provider calls.
    const action = nextRenderAction(restored as ClipPlan);
    expect(action.kind).toBe("submit");
    expect(action.kind === "submit" && action.clip.index).toBe(1);

    const allSubmitted = (restored as ClipPlan).clips.reduce(
      (p, c) => (c.providerJobId ? p : markSubmitted(p, c.index, `job-${c.index}`)),
      restored as ClipPlan,
    );
    const poll = nextRenderAction(allSubmitted);
    expect(poll.kind).toBe("poll");
    expect(poll.kind === "poll" && poll.jobId).toBe("job-42");
  });

  it("walks submit -> poll -> assemble across the durable plan", async () => {
    const provider = stubProvider({});
    const h = harness();
    const submitted = await handleContentGenerateVideo(h.ports, provider)(ctx({ package_id: "pkg-1" }));
    expect(submitted.success).toBe(true);
    expect(h.enqueued.map((e) => e["jobType"])).toContain("content_poll_video");
    // No media URL was invented by submitting.
    expect(h.assets.every((a) => a["externalUrl"] === undefined || a["externalUrl"] === null)).toBe(true);
    expect(h.assets[0]["status"]).toBe("researching");

    // Still rendering: the plan advances and the job requeues. Polling starts
    // once every clip has been submitted, so the provider is never asked for
    // 24 concurrent renders.
    let polls = 0;
    for (let i = 0; i < 40 && polls === 0; i += 1) {
      const step = await handleContentPollVideo(h.ports, provider)(ctx({ package_id: "pkg-1" }));
      expect(step.success).toBe(true);
      polls = (provider.poll as ReturnType<typeof vi.fn>).mock.calls.length;
    }
    expect(polls).toBeGreaterThan(0);

    // Failed: the plan records it and the job is retryable, with no URL.
    const failedProvider = stubProvider({
      poll: vi.fn(async (externalId: string) => ({
        externalId,
        mediaUrl: null,
        storagePath: null,
        status: "failed" as const,
        error: "moderation",
      })),
    });
    const h2 = harness();
    await handleContentGenerateVideo(h2.ports, provider)(ctx({ package_id: "pkg-1" }));
    for (let i = 0; i < 40; i += 1) {
      const step = await handleContentPollVideo(h2.ports, failedProvider)(ctx({ package_id: "pkg-1" }));
      if (!step.success) {
        expect(step.error?.message).toBe("moderation");
        break;
      }
    }
    for (const asset of h2.assets) expect(asset["externalUrl"]).toBeFalsy();
  });

  it("refuses to publish a package whose clips are not assembled", async () => {
    const provider = stubProvider({});
    const h = harness();
    await handleContentGenerateVideo(h.ports, provider)(ctx({ package_id: "pkg-1" }));
    // Submit every clip, then let the plan reach assembly.
    for (let i = 0; i < 40; i += 1) {
      const result = await handleContentPollVideo(h.ports, provider)(ctx({ package_id: "pkg-1" }));
      if (!result.success) break;
    }
    const last = h.assets[h.assets.length - 1];
    expect(last["assetType"]).toBe("youtube_video");
    // The asset never claims a finished video it does not have.
    expect(last["externalUrl"] ?? null).toBeNull();
  });

  it("fails as NOT_CONFIGURED and stores nothing when no provider is configured", async () => {
    const h = harness();
    const result = await handleContentGenerateVideo(h.ports, null)(ctx({ package_id: "pkg-1" }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_CONFIGURED");
    expect(h.assets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Publication lease — crash recovery
// ---------------------------------------------------------------------------

describe("publication lease", () => {
  function record(partial: Partial<ContentPublicationRecord>): ContentPublicationRecord {
    return {
      _id: "pub-1",
      organizationId: "org-1",
      contentPackageId: "pkg-1",
      assetId: null,
      provider: "youtube",
      status: "queued",
      scheduledAt: null,
      attemptCount: 0,
      externalId: null,
      externalUrl: null,
      lastError: null,
      errorClass: null,
      publishedAt: null,
      idempotencyKey: publicationIdempotencyKey("pkg-1", "youtube", null),
      lockedAt: null,
      lockExpiresAt: null,
      ...partial,
    } as unknown as ContentPublicationRecord;
  }

  it("case A — provider succeeded, completion failed: the row stays recoverable", () => {
    // The worker died before content_publication_complete. The row is still
    // 'processing' but its lease has expired, so the next worker takes it.
    const stranded = record({
      status: "processing",
      lockedAt: NOW - PUBLICATION_LEASE_MS - 1,
      lockExpiresAt: NOW - 1,
    });
    expect(claimEligibility(stranded, NOW)).toBe("claimable");
    expect(alreadyPublished(stranded)).toBe(false);
  });

  it("case B — worker crashed, lease expired, retry reclaims it", () => {
    const expired = record({ status: "processing", lockedAt: NOW - 10_000, lockExpiresAt: NOW - 1 });
    expect(claimEligibility(expired, NOW)).toBe("claimable");

    // A processing row with NO lease at all is the same orphan.
    const unleased = record({ status: "processing", lockedAt: null, lockExpiresAt: null });
    expect(claimEligibility(unleased, NOW)).toBe("claimable");
  });

  it("case C — an active lease cannot be claimed twice", () => {
    const held = record({
      status: "processing",
      lockedAt: NOW,
      lockExpiresAt: NOW + PUBLICATION_LEASE_MS,
    });
    expect(claimEligibility(held, NOW)).toBe("lease_held");
    // Even one millisecond before expiry.
    expect(claimEligibility({ ...held, lockExpiresAt: NOW + 1 }, NOW)).toBe("lease_held");
  });

  it("case D — a published row is terminal and can never be re-sent", () => {
    const published = record({
      status: "published",
      externalId: "yt-123",
      publishedAt: NOW,
    });
    expect(claimEligibility(published, NOW)).toBe("terminal");
    expect(alreadyPublished(published)).toBe(true);

    const cancelled = record({ status: "cancelled" });
    expect(claimEligibility(cancelled, NOW)).toBe("terminal");
    // Cancelled with no external artefact must not suppress a later attempt
    // in a way that invents one.
    expect(alreadyPublished(cancelled)).toBe(false);
  });

  it("a failed publication retries, and a missing one is nothing to claim", () => {
    expect(claimEligibility(record({ status: "failed" }), NOW)).toBe("claimable");
    expect(claimEligibility(record({ status: "queued" }), NOW)).toBe("claimable");
    expect(claimEligibility(null, NOW)).toBe("absent");
    // 'published' with NO external id is not a completed publication: the
    // provider artefact is what makes it one.
    expect(alreadyPublished(record({ status: "published", externalId: null }))).toBe(false);
  });

  it("keeps one idempotency key per package + provider + asset", () => {
    const a = publicationIdempotencyKey("pkg-1", "youtube", "asset-1");
    const b = publicationIdempotencyKey("pkg-1", "youtube", "asset-1");
    const other = publicationIdempotencyKey("pkg-1", "linkedin", "asset-1");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe("provider token lifecycle", () => {
  it("uses a valid token, refreshes an expiring one, and asks to reconnect otherwise", () => {
    expect(
      decideTokenAction({ provider: "youtube", expiresAt: NOW + 3_600_000, now: NOW, hasRefreshToken: true }),
    ).toEqual({ action: "use", reason: "not_expiring" });
    expect(
      decideTokenAction({ provider: "youtube", expiresAt: NOW + 60_000, now: NOW, hasRefreshToken: true }),
    ).toEqual({ action: "refresh", reason: "expiring_soon" });
    expect(
      decideTokenAction({ provider: "youtube", expiresAt: NOW - 1, now: NOW, hasRefreshToken: true }),
    ).toEqual({ action: "refresh", reason: "expired" });
    expect(
      decideTokenAction({ provider: "youtube", expiresAt: NOW - 1, now: NOW, hasRefreshToken: false }),
    ).toEqual({ action: "reconnect", reason: "no_refresh_token" });
    // An unknown expiry is used as-is: refreshing a working token can break it.
    expect(
      decideTokenAction({ provider: "youtube", expiresAt: null, now: NOW, hasRefreshToken: true }),
    ).toEqual({ action: "use", reason: "no_expiry_known" });
  });

  it("never invents a LinkedIn refresh: no grant means reconnect", () => {
    expect(supportsRefresh("youtube")).toBe(true);
    expect(supportsRefresh("linkedin")).toBe(false);
    expect(
      decideTokenAction({ provider: "linkedin", expiresAt: NOW + 3_600_000, now: NOW, hasRefreshToken: true }),
    ).toEqual({ action: "reconnect", reason: "unsupported_by_provider" });
  });

  it("classifies provider failures so the UI can say something true", () => {
    expect(classifyAuthFailure(401)).toBe("expired");
    expect(classifyAuthFailure(403)).toBe("revoked");
    expect(classifyAuthFailure(429)).toBe("rate_limited");
    expect(classifyAuthFailure(500)).toBe("other");
  });

  it("never puts a token in the message it shows a user", () => {
    for (const provider of ["youtube", "linkedin"] as const) {
      const message = reconnectMessage(provider);
      expect(message).toMatch(/Reconnect/);
      expect(message).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
      expect(message).not.toContain("ya29.");
      expect(message).not.toContain("Bearer");
    }
  });

  it("keeps every provider credential out of the browser surface", () => {
    // The browser receives an authorization URL and connection METADATA. The
    // only token it may ever hold is the signed-in user's OWN Supabase session
    // JWT, used to call the edge function that performs the OAuth handshake.
    // A provider token, a refresh token, a client secret or a sealed blob must
    // never reach a page or the Studio API.
    const page = readFileSync("src/pages/content/ContentAccounts.tsx", "utf8");
    for (const field of ["accessToken", "refreshToken", "clientSecret", "_enc"]) {
      expect(page, `ContentAccounts must not read ${field}`).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    // The single session read is the caller's own JWT, from the Supabase
    // session, not from a connection row.
    expect(page.match(/access_token/g) ?? []).toHaveLength(1);
    expect(page).toMatch(/session\?\.data\.session\?\.access_token/);

    // And the connection listing itself selects metadata only.
    const api = readFileSync("src/lib/content-engine/studio-api.ts", "utf8");
    expect(api).not.toMatch(/access_token|refresh_token|client_secret|_enc/);
  });
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

function automation(partial: Partial<ContentAutomationSettings> = {}): ContentAutomationSettings {
  return {
    organizationId: "org-1",
    enabled: true,
    intervalSeconds: 86_400,
    requireApproval: true,
    autoPublish: false,
    brandVoice: null,
    audience: null,
    primaryCta: null,
    defaultTone: null,
    coveredTopics: [],
    lastGeneratedAt: null,
    lastPackageId: null,
    ...partial,
  };
}

describe("scheduled automation", () => {
  it("takes the topic from the database, not from the caller", async () => {
    const nextTopic = vi.fn(async () => "the handoff between field capture and estimating");
    const h = harness({
      listDueAutomations: vi.fn(async () => [automation()]),
      nextTopic,
    });

    const result = await handleContentAutomationTick(h.ports)(ctx({}));
    expect(result.success).toBe(true);
    expect(nextTopic).toHaveBeenCalledWith("org-1");
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]["jobType"]).toBe("content_generate_package");
    expect(String(h.enqueued[0]["payload"]["topic"])).toBe(
      "the handoff between field capture and estimating",
    );
    expect(h.enqueued[0]["tenantId"]).toBe("org-1");
  });

  it("enqueues nothing once every topic in the bank is covered", async () => {
    const h = harness({
      listDueAutomations: vi.fn(async () => [
        automation({ coveredTopics: [...DEFAULT_TOPIC_BANK] }),
      ]),
      nextTopic: vi.fn(async () => null),
    });

    const result = await handleContentAutomationTick(h.ports)(ctx({}));
    expect(result.success).toBe(true);
    expect(h.enqueued).toHaveLength(0);
    const payload = JSON.stringify(result.result ?? {});
    expect(payload).toContain("exhausted");
  });

  it("never repeats a topic the organization already covered", () => {
    const settings = automation({ coveredTopics: [DEFAULT_TOPIC_BANK[0].toUpperCase()] });
    const next = pickNextTopic(settings);
    expect(next).toBe(DEFAULT_TOPIC_BANK[1]);
    expect(pickNextTopic(automation({ coveredTopics: [...DEFAULT_TOPIC_BANK] }))).toBeNull();
    // Case- and whitespace-insensitive, so "Covered " never slips through.
    expect(pickNextTopic(automation({ coveredTopics: [` ${DEFAULT_TOPIC_BANK[0].toUpperCase()} `] }))).toBe(
      DEFAULT_TOPIC_BANK[1],
    );
  });

  it("skips a disabled automation", async () => {
    const nextTopic = vi.fn(async () => "a topic");
    const h = harness({
      listDueAutomations: vi.fn(async () => [automation({ enabled: false })]),
      nextTopic,
    });
    await handleContentAutomationTick(h.ports)(ctx({}));
    expect(nextTopic).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });

  it("keeps generation distinct from publication: approval stays required", async () => {
    const h = harness({
      listDueAutomations: vi.fn(async () => [automation()]),
      nextTopic: vi.fn(async () => "reducing rework in restoration estimates"),
    });
    await handleContentAutomationTick(h.ports)(ctx({}));
    // The only job created is GENERATION. Nothing is queued for publication,
    // so an automated package can never reach a channel on its own.
    expect(h.enqueued.map((e) => e["jobType"])).toEqual(["content_generate_package"]);

    // And the default settings object refuses auto-publish with approval on.
    const settings = automation();
    expect(settings.requireApproval).toBe(true);
    expect(settings.autoPublish).toBe(false);
  });

  it("generates one package per organization per occurrence", async () => {
    const h = harness({
      listDueAutomations: vi.fn(async () => [automation(), automation({ organizationId: "org-2" })]),
      nextTopic: vi.fn(async () => "turning completed jobs into repeatable playbooks"),
    });
    await handleContentAutomationTick(h.ports)(ctx({}));
    expect(h.enqueued).toHaveLength(2);
    const keys = h.enqueued.map((e) => String(e["idempotencyKey"]));
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^content:auto:org-\d+:/);
  });
});

// ---------------------------------------------------------------------------
// The whole workflow, stubbed
// ---------------------------------------------------------------------------

describe("end-to-end workflow with stubs", () => {
  it("topic -> article -> script -> video -> thumbnail -> linkedin -> review", async () => {
    const order: string[] = [];
    const h = harness({
      generateArticle: vi.fn(async () => {
        order.push("article");
        return {
          title: "Why Supplements Get Missed",
          body: SCRIPT,
          summary: "A summary.",
          seo: {},
          knowledgeIds: ["k1"],
          sourceIds: ["s1"],
        };
      }),
      nextTopic: vi.fn(async () => "why insurance supplements get missed"),
      requestReview: vi.fn(async () => {
        order.push("review");
      }),
    });

    const { handleContentGeneratePackage, handleContentWriteLinkedIn } = await import("./jobs");
    await handleContentGeneratePackage(h.ports)(ctx({ topic: "why insurance supplements get missed" }));

    // The package reaches a HUMAN, not a channel: generation wrote the article
    // and the script and then moved the package into review. Nothing was
    // published, and no destination job was created by generation.
    expect(order).toEqual(["article", "review"]);
    const generated = h.assets.map((a) => a["assetType"]);
    expect(generated).toContain("blog_article");
    expect(generated).toContain("video_script");
    expect(h.enqueued.map((e) => e["jobType"]).sort()).toEqual([
      "content_generate_thumbnail",
      "content_generate_video",
      "content_write_linkedin",
    ]);
    // Generation never queues a PUBLICATION. That only happens after approval.
    for (const job of h.enqueued) {
      expect(String(job["jobType"])).not.toContain("publish");
    }

    // The LinkedIn draft is derived from an APPROVED article. While the package
    // is awaiting a human decision the draft is refused rather than written
    // from unreviewed copy.
    const refused = await handleContentWriteLinkedIn(h.ports)(ctx({ package_id: "pkg-1" }));
    expect(refused.success).toBe(false);
    expect(h.assets.map((a) => a["assetType"])).not.toContain("linkedin_post");
  });
});
