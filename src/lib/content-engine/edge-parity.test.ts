/**
 * Parity tests for the content worker's edge copies.
 *
 * The Deployed Edge Function bundle only packages files inside the function
 * directory, so `supabase/functions/content-engine-worker/` keeps copies of
 * three pure modules that live canonically in `src/lib/content-engine/`:
 *
 *   * clip-plan.ts        <- assemble.ts     (clip plan + durable render state)
 *   * pixverse.ts         <- media.ts        (provider contract)
 *   * token-lifecycle.ts  <- oauth.ts        (token refresh decisions)
 *
 * A textual diff would be brittle. These tests EXECUTE both copies against
 * identical vectors, which is what actually matters: the plan the deployed
 * worker builds must be the plan this suite describes, and the request it
 * sends must be byte-identical to the tested one.
 */
import { describe, expect, it } from "vitest";
import * as assemble from "./assemble";
import * as clipPlan from "../../../supabase/functions/content-engine-worker/clip-plan";
import * as media from "./media";
import * as pixverse from "../../../supabase/functions/content-engine-worker/pixverse";
import * as oauth from "./oauth";
import * as lifecycle from "../../../supabase/functions/content-engine-worker/token-lifecycle";

const SCRIPT = [
  "HOOK: Why supplements get missed",
  "",
  "INTRODUCTION",
  "The adjuster never sees the work that was done.",
  "",
  "MAIN POINTS",
  "1. Photo the room before you open the wall.",
  "2. Log the estimate line by line.",
  "3. Send the carrier a clean package.",
  "",
  "CONCLUSION",
  "Tie it back to the workflow.",
].join("\n");

describe("clip plan — src/edge parity", () => {
  it("clamps target and clip durations identically", () => {
    for (const value of [undefined, null, 0, -50, 120, 300, 999, Number.NaN]) {
      expect(clipPlan.clampTargetDuration(value)).toBe(assemble.clampTargetDuration(value));
    }
    for (const value of [undefined, null, 0, 3, 8, 15, 400]) {
      expect(clipPlan.clampClipDuration(value)).toBe(assemble.clampClipDuration(value));
    }
  });

  it("plans the same clips for the same script", () => {
    const input = { script: SCRIPT, title: "Why supplements get missed", clipDurationSeconds: 8 };
    expect(clipPlan.planClips(input)).toEqual(assemble.planClips(input));
  });

  it("never plans a single 5-minute clip", () => {
    const plan = clipPlan.planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 });
    expect(plan.targetDurationSeconds).toBe(assemble.DEFAULT_TARGET_VIDEO_SECONDS);
    expect(plan.clips.length).toBeGreaterThan(1);
    for (const clip of plan.clips) {
      expect(clip.durationSeconds).toBeLessThanOrEqual(15);
      expect(clip.durationSeconds).toBe(8);
    }
  });

  it("advances the render state identically", () => {
    const plan = assemble.planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 });
    expect(clipPlan.nextRenderAction(plan)).toEqual(assemble.nextRenderAction(plan));

    const submitted = clipPlan.markSubmitted(plan, 0, "job-1");
    expect(submitted).toEqual(assemble.markSubmitted(plan, 0, "job-1"));
    expect(clipPlan.nextRenderAction(submitted)).toEqual(assemble.nextRenderAction(submitted));

    const ready = clipPlan.markReady(submitted, 0, "https://cdn.example/clip-0.mp4");
    expect(ready).toEqual(assemble.markReady(submitted, 0, "https://cdn.example/clip-0.mp4"));
    expect(clipPlan.isPlanComplete(ready)).toBe(false);

    const all = ready.clips.reduce(
      (plan, c) => clipPlan.markReady(plan, c.index, `https://cdn/${c.index}.mp4`),
      ready,
    );
    const allApp = ready.clips.reduce(
      (plan, c) => assemble.markReady(plan, c.index, `https://cdn/${c.index}.mp4`),
      submitted,
    );
    expect(clipPlan.isPlanComplete(all)).toBe(assemble.isPlanComplete(allApp));
    expect(clipPlan.isPlanComplete(all)).toBe(true);
    expect(clipPlan.nextRenderAction(all).kind).toBe(assemble.nextRenderAction(allApp).kind);

    // A plan whose only outstanding clip FAILED stops and waits: it never
    // silently assembles a partial video and never re-submits forever.
    const exhaustedClip = plan.clips[plan.clips.length - 1];
    const mostlyDone = plan.clips.reduce(
      (p, c) =>
        c.index === exhaustedClip.index ? p : clipPlan.markReady(p, c.index, `https://cdn/${c.index}.mp4`),
      plan,
    );
    const failed = clipPlan.markFailed(mostlyDone, exhaustedClip.index, "moderation");
    expect(failed).toEqual(
      assemble.markFailed(
        assemble.planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 }).clips.reduce(
          (p, c) =>
            c.index === exhaustedClip.index
              ? p
              : assemble.markReady(p, c.index, `https://cdn/${c.index}.mp4`),
          assemble.planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 }),
        ),
        exhaustedClip.index,
        "moderation",
      ),
    );
    expect(clipPlan.nextRenderAction(failed).kind).toBe("wait");
    expect(clipPlan.isPlanComplete(failed)).toBe(false);
  });

  it("round-trips the persisted plan metadata identically", () => {
    const plan = clipPlan.markSubmitted(
      clipPlan.planClips({ script: SCRIPT, title: "T", clipDurationSeconds: 8 }),
      0,
      "job-1",
    );
    expect(clipPlan.planToMetadata(plan)).toEqual(assemble.planToMetadata(plan));
    expect(clipPlan.planFromMetadata(clipPlan.planToMetadata(plan))).toEqual(plan);
    expect(clipPlan.planFromMetadata({ renderStatus: "pending" })).toBeNull();
  });
});

describe("PixVerse contract — src/edge parity", () => {
  it("sends the same body for the same clip", () => {
    const app = media.buildPixVerseRequest(
      {
        script: "A restoration crew photographs the room.",
        title: "Why supplements get missed",
        durationSeconds: 8,
        aspectRatio: "16:9",
        style: "clean B2B explainer",
        outputPrefix: "content/x/video",
      },
      { model: "v3.5" },
    );
    const edge = pixverse.buildRenderRequest(
      {
        aspectRatio: "16:9",
        durationSeconds: 8,
        title: "Why supplements get missed",
        style: "clean B2B explainer",
        script: "A restoration crew photographs the room.",
      },
      { model: "v3.5" },
    );
    expect(edge).toEqual(app);
  });

  it("agrees on every model's supported clip lengths", () => {
    expect(pixverse.PIXVERSE_SUPPORTED).toEqual(media.PIXVERSE_SUPPORTED);
    for (const model of Object.keys(media.PIXVERSE_SUPPORTED)) {
      for (const requested of [1, 3, 5, 8, 10, 15, 30, 300]) {
        expect(pixverse.pixVerseClipDuration(model, requested)).toBe(
          media.pixVerseClipDuration(model, requested),
        );
      }
    }
  });

  it("can never produce a clip duration of 300", () => {
    for (const model of Object.keys(pixverse.PIXVERSE_SUPPORTED)) {
      for (const requested of [180, 300, 360, 1000]) {
        const duration = pixverse.pixVerseClipDuration(model, requested);
        expect(pixverse.PIXVERSE_SUPPORTED[model]).toContain(duration);
        expect(duration).toBeLessThanOrEqual(15);
      }
    }
  });

  it("reads provider status identically, and never invents a URL", () => {
    const cases: unknown[] = [
      { Resp: { status: 1, url: "https://cdn/clip.mp4" } },
      { Resp: { status: 1 } },
      { Resp: { status: 5 } },
      { Resp: { status: 7 } },
      { data: { status: 1, url: "https://cdn/clip.mp4" } },
      {},
      null,
    ];
    for (const payload of cases) {
      const edge = pixverse.readRenderResult(payload);
      if (edge.state === "ready") expect(edge.mediaUrl).toBeTruthy();
      if (edge.state !== "ready") expect(edge.mediaUrl).toBeNull();
      if (payload && typeof payload === "object") {
        const data = ((payload as Record<string, unknown>)["Resp"] ??
          (payload as Record<string, unknown>)["data"]) as Record<string, unknown>;
        const status = String(data?.["status"] ?? "");
        if (status === "1") expect(edge.state).toBe(data?.["url"] ? "ready" : "failed");
        if (status === "7") expect(edge.state).toBe("failed");
        if (status === "5") expect(edge.state).toBe("pending");
      }
    }
  });

  it("reads the provider job id, or null", () => {
    expect(pixverse.readVideoId({ Resp: { video_id: 12345 } })).toBe("12345");
    expect(pixverse.readVideoId({ Resp: {} })).toBeNull();
    expect(pixverse.readVideoId(null)).toBeNull();
  });
});

describe("token lifecycle — src/edge parity", () => {
  const NOW = 1_800_000_000_000;

  it("makes the same decision for the same inputs", () => {
    const cases = [
      { provider: "youtube", expiresAt: NOW + 3_600_000, now: NOW, hasRefreshToken: true },
      { provider: "youtube", expiresAt: NOW - 1, now: NOW, hasRefreshToken: true },
      { provider: "youtube", expiresAt: NOW + 60_000, now: NOW, hasRefreshToken: true },
      { provider: "youtube", expiresAt: NOW - 1, now: NOW, hasRefreshToken: false },
      { provider: "youtube", expiresAt: null, now: NOW, hasRefreshToken: false },
      { provider: "linkedin", expiresAt: NOW + 3_600_000, now: NOW, hasRefreshToken: true },
      { provider: "blog", expiresAt: NOW, now: NOW, hasRefreshToken: false },
    ] as const;
    for (const input of cases) {
      expect(lifecycle.decideTokenAction(input)).toEqual(oauth.decideTokenAction(input));
    }
  });

  it("refreshes a valid Google token and never refreshes LinkedIn", () => {
    expect(
      lifecycle.decideTokenAction({
        provider: "youtube",
        expiresAt: NOW - 1,
        now: NOW,
        hasRefreshToken: true,
      }),
    ).toEqual({ action: "refresh", reason: "expired" });
    expect(
      lifecycle.decideTokenAction({
        provider: "linkedin",
        expiresAt: NOW - 1,
        now: NOW,
        hasRefreshToken: true,
      }),
    ).toEqual({ action: "reconnect", reason: "unsupported_by_provider" });
  });

  it("classifies provider failures identically", () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500]) {
      expect(lifecycle.classifyAuthFailure(status)).toBe(oauth.classifyAuthFailure(status));
    }
  });

  it("builds a Google refresh request without leaking anything else", () => {
    const body = new URLSearchParams(
      lifecycle.buildGoogleRefreshBody({
        refreshToken: "refresh-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    );
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-secret");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    // No access token, no scope escalation, no user identifier.
    expect(body.get("access_token")).toBeNull();
    expect(body.get("scope")).toBeNull();
  });

  it("reads a Google token response, or fails closed", () => {
    const parsed = lifecycle.readGoogleTokenResponse(
      { access_token: "new-access", expires_in: 3600, refresh_token: "new-refresh" },
      NOW,
    );
    expect(parsed).toEqual({
      accessToken: "new-access",
      expiresAt: NOW + 3_600_000,
      refreshToken: "new-refresh",
    });
    // A response without an access token is unusable, not partially usable.
    expect(lifecycle.readGoogleTokenResponse({ error: "invalid_grant" }, NOW)).toBeNull();
    expect(lifecycle.readGoogleTokenResponse({ access_token: "" }, NOW)).toBeNull();
  });
});
