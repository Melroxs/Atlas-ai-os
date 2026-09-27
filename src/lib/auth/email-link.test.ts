import { beforeEach, describe, expect, it } from "vitest";
import {
  captureAuthLink,
  getCapturedAuthLink,
  consumeCapturedAuthLink,
  hasAuthCredentials,
  hasAuthLinkPayload,
  isFailedLink,
  isInvitationPayload,
  isRecoveryPayload,
  isSafeInternalPath,
  parseAuthLink,
  resolveAuthLinkDestination,
  resolveAuthLinkSource,
  resolveSafeNext,
  resetCapturedAuthLink,
} from "./email-link";

/**
 * Regression tests for the Atlas auth email-link layer.
 *
 * These cover the production failure where invited / recovery / magic-link
 * links were being handled as ordinary sign-ins (dropped on the public landing
 * page, or straight into the dashboard with no password ever set).
 */

const INVITE_HASH =
  "#access_token=at.123&expires_in=3600&refresh_token=rt.456&token_type=bearer&type=invite";
const RECOVERY_HASH =
  "#access_token=at.123&expires_in=3600&refresh_token=rt.456&token_type=bearer&type=recovery";
const MAGICLINK_HASH =
  "#access_token=at.123&expires_in=3600&refresh_token=rt.456&token_type=bearer&type=magiclink";
const EXPIRED_HASH =
  "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

describe("parseAuthLink", () => {
  it("reads an implicit-flow invitation payload from the fragment", () => {
    const payload = parseAuthLink({ search: "", hash: INVITE_HASH });
    expect(payload.type).toBe("invite");
    expect(payload.accessToken).toBe("at.123");
    expect(payload.refreshToken).toBe("rt.456");
    expect(payload.code).toBeNull();
    expect(payload.tokenHash).toBeNull();
    expect(isInvitationPayload(payload)).toBe(true);
    expect(isRecoveryPayload(payload)).toBe(false);
    expect(isFailedLink(payload)).toBe(false);
  });

  it("distinguishes recovery and magic-link payloads", () => {
    expect(
      isRecoveryPayload(parseAuthLink({ hash: RECOVERY_HASH })),
    ).toBe(true);
    const magic = parseAuthLink({ hash: MAGICLINK_HASH });
    expect(magic.type).toBe("magiclink");
    expect(isInvitationPayload(magic)).toBe(false);
    expect(isRecoveryPayload(magic)).toBe(false);
  });

  it("reads a PKCE authorization code from the query string", () => {
    const payload = parseAuthLink({ search: "?code=abc-123", hash: "" });
    expect(payload.code).toBe("abc-123");
    expect(payload.accessToken).toBeNull();
    expect(hasAuthLinkPayload(payload)).toBe(true);
  });

  it("reads a token_hash payload (verifyOtp style templates)", () => {
    const payload = parseAuthLink({
      search: "?token_hash=th_1&type=recovery&next=%2Fdashboard",
      hash: "",
    });
    expect(payload.tokenHash).toBe("th_1");
    expect(payload.type).toBe("recovery");
    expect(payload.next).toBe("/dashboard");
  });

  it("surfaces a refused link as a failure payload", () => {
    const payload = parseAuthLink({ hash: EXPIRED_HASH });
    expect(isFailedLink(payload)).toBe(true);
    expect(payload.error).toBe("access_denied");
    expect(payload.errorCode).toBe("otp_expired");
    expect(payload.type).toBeNull();
  });

  it("returns an empty payload for an ordinary URL", () => {
    const payload = parseAuthLink({ search: "", hash: "" });
    expect(payload.type).toBeNull();
    expect(hasAuthLinkPayload(payload)).toBe(false);
  });

  it("normalizes unknown types to null instead of trusting them", () => {
    expect(parseAuthLink({ hash: "#type=superuser" }).type).toBeNull();
    expect(parseAuthLink({ hash: "#type=MAGIC_LINK" }).type).toBe("magiclink");
  });

  it("prefers the fragment over the query string for the same key", () => {
    const payload = parseAuthLink({
      search: "?type=recovery",
      hash: "#type=invite",
    });
    expect(payload.type).toBe("invite");
  });
});

describe("isSafeInternalPath / resolveSafeNext", () => {
  it("accepts internal absolute paths", () => {
    expect(isSafeInternalPath("/dashboard")).toBe(true);
    expect(isSafeInternalPath("/dashboard/team?tab=1")).toBe(true);
  });

  it("rejects open-redirect and malformed destinations", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "http://evil.com",
      "javascript:alert(1)",
      "dashboard",
      "",
      "   ",
      "/\n/x",
    ]) {
      expect(isSafeInternalPath(bad)).toBe(false);
    }
    expect(isSafeInternalPath(null)).toBe(false);
    expect(isSafeInternalPath(undefined)).toBe(false);
  });

  it("falls back to a known-safe default", () => {
    expect(resolveSafeNext("//evil.com")).toBe("/dashboard");
    expect(resolveSafeNext("/dashboard/ask")).toBe("/dashboard/ask");
    expect(resolveSafeNext(undefined, "/auth")).toBe("/auth");
  });
});

describe("resolveAuthLinkDestination", () => {
  it("sends an invitation to password setup, never into the app", () => {
    const decision = resolveAuthLinkDestination(
      parseAuthLink({ hash: INVITE_HASH }),
      { authenticated: true },
    );
    expect(decision).toEqual({
      kind: "set-password",
      to: "/auth/set-password",
    });
  });

  it("sends a recovery link to the password reset page", () => {
    const decision = resolveAuthLinkDestination(
      parseAuthLink({ hash: RECOVERY_HASH, search: "?next=%2Fsettings" }),
      { authenticated: true },
    );
    expect(decision.kind).toBe("reset-password");
  });

  it("sends a magic link into the app at the requested destination", () => {
    const decision = resolveAuthLinkDestination(
      parseAuthLink({ hash: MAGICLINK_HASH, search: "?next=%2Fdashboard%2Fask" }),
      { authenticated: true },
    );
    expect(decision).toEqual({ kind: "app", to: "/dashboard/ask" });
  });

  it("ignores an open-redirect next on a magic link", () => {
    const decision = resolveAuthLinkDestination(
      parseAuthLink({ hash: MAGICLINK_HASH, search: "?next=https%3A%2F%2Fevil.com" }),
      { authenticated: true },
    );
    expect(decision).toEqual({ kind: "app", to: "/dashboard" });
  });

  it("falls back to sign-in when no session could be established", () => {
    const decision = resolveAuthLinkDestination(parseAuthLink({ hash: "" }), {
      authenticated: false,
    });
    expect(decision).toEqual({
      kind: "sign-in",
      to: "/auth?returnTo=%2Fdashboard",
    });
  });

  it("passes through to the app when a session already exists", () => {
    const decision = resolveAuthLinkDestination(parseAuthLink({ hash: "" }), {
      authenticated: true,
      defaultNext: "/dashboard/team",
    });
    expect(decision).toEqual({ kind: "app", to: "/dashboard/team" });
  });
});

describe("hasAuthCredentials / resolveAuthLinkSource", () => {
  it("never treats a bare routing hint as an auth link", () => {
    const hint = parseAuthLink({ search: "?type=invite", hash: "" });
    expect(hint.type).toBe("invite");
    expect(hasAuthLinkPayload(hint)).toBe(true);
    expect(hasAuthCredentials(hint)).toBe(false);
  });

  it("recognises every credential and refusal form", () => {
    expect(hasAuthCredentials(parseAuthLink({ hash: INVITE_HASH }))).toBe(
      true,
    );
    expect(hasAuthCredentials(parseAuthLink({ search: "?code=abc" }))).toBe(
      true,
    );
    expect(
      hasAuthCredentials(parseAuthLink({ search: "?token_hash=th&type=invite" })),
    ).toBe(true);
    expect(hasAuthCredentials(parseAuthLink({ hash: EXPIRED_HASH }))).toBe(
      true,
    );
    expect(hasAuthCredentials(null)).toBe(false);
  });

  it("prefers the live URL while it still carries the credentials", () => {
    const live = parseAuthLink({ hash: RECOVERY_HASH });
    const captured = parseAuthLink({ hash: INVITE_HASH });
    expect(resolveAuthLinkSource(live, captured)).toBe(live);
  });

  it("falls back to the captured payload once the SDK has stripped the URL", () => {
    // This is the production race: /auth/callback is reached with the payload
    // already consumed out of the location, so the live URL looks empty.
    const strippedLive = parseAuthLink({ search: "", hash: "" });
    const captured = parseAuthLink({ hash: INVITE_HASH });
    expect(hasAuthCredentials(strippedLive)).toBe(false);
    const source = resolveAuthLinkSource(strippedLive, captured);
    expect(source).toBe(captured);
    expect(source?.accessToken).toBe("at.123");
  });

  it("keeps a routing-only live payload when nothing was captured", () => {
    const live = parseAuthLink({ search: "?type=invite", hash: "" });
    expect(resolveAuthLinkSource(live, null)).toBe(live);
    expect(resolveAuthLinkSource(null, live)).toBe(live);
    expect(resolveAuthLinkSource(null, null)).toBeNull();
  });
});

describe("captureAuthLink", () => {
  beforeEach(() => {
    resetCapturedAuthLink();
  });

  it("captures the payload exactly once per page load", () => {
    const first = captureAuthLink({ hash: INVITE_HASH });
    expect(first?.type).toBe("invite");
    // A later call must not re-read the (by then stripped) URL.
    const second = captureAuthLink({ hash: "" });
    expect(second?.type).toBe("invite");
    expect(getCapturedAuthLink()?.type).toBe("invite");
  });

  it("captures nothing for an ordinary page load", () => {
    expect(captureAuthLink({ search: "", hash: "" })).toBeNull();
    expect(getCapturedAuthLink()).toBeNull();
  });

  it("can be claimed once and is then gone", () => {
    captureAuthLink({ hash: RECOVERY_HASH });
    expect(consumeCapturedAuthLink()?.type).toBe("recovery");
    expect(consumeCapturedAuthLink()).toBeNull();
    expect(getCapturedAuthLink()).toBeNull();
  });
});
