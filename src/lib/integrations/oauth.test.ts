import { describe, expect, it } from "vitest";
import {
  beginAuthorization,
  integrationRedirectUri,
  missingScopes,
  parseCallback,
  parseTokenResponse,
  tokenNeedsRefresh,
  validateCallback,
  type OAuthProviderConfig,
} from "./oauth";

const CONFIG: OAuthProviderConfig = {
  provider: "google_gmail",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  usePkce: true,
  authorizeParams: { access_type: "offline", prompt: "consent" },
};

describe("oauth — authorization start", () => {
  it("builds an authorization URL that binds state, redirect and PKCE", async () => {
    const start = await beginAuthorization({
      config: CONFIG,
      clientId: "client-123",
      redirectUri: "https://project.supabase.co/functions/v1/integrations-oauth/callback",
      now: 1_700_000_000_000,
    });

    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe(CONFIG.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("scope")).toBe(CONFIG.scopes.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("access_type")).toBe("offline");
    // The verifier is never in the URL — only its challenge.
    expect(start.authorizationUrl).not.toContain(start.codeVerifier!);
  });

  it("stores only the hash of the state, never the state itself", async () => {
    const start = await beginAuthorization({ config: CONFIG, clientId: "c", redirectUri: "https://x/cb" });
    expect(start.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(start.stateHash).not.toBe(start.state);
    expect(start.state.length).toBeGreaterThanOrEqual(32);
  });

  it("always produces a unique state (no reuse across flows)", async () => {
    const [a, b] = await Promise.all([
      beginAuthorization({ config: CONFIG, clientId: "c", redirectUri: "https://x/cb" }),
      beginAuthorization({ config: CONFIG, clientId: "c", redirectUri: "https://x/cb" }),
    ]);
    expect(a.state).not.toBe(b.state);
    expect(a.stateHash).not.toBe(b.stateHash);
  });

  it("omits PKCE for providers that do not support it", async () => {
    const start = await beginAuthorization({
      config: { ...CONFIG, usePkce: false },
      clientId: "c",
      redirectUri: "https://x/cb",
    });
    expect(start.codeVerifier).toBeNull();
    expect(start.authorizationUrl).not.toContain("code_challenge");
  });
});

describe("oauth — callback validation", () => {
  it("extracts code and state", () => {
    const parsed = parseCallback("https://x/cb?code=abc&state=def&scope=a+b");
    expect(validateCallback(parsed)).toEqual({ ok: true, state: "def", code: "abc" });
  });

  it("reports a provider-side error instead of a code", () => {
    const parsed = parseCallback("https://x/cb?error=access_denied&error_description=user%20denied");
    const validated = validateCallback(parsed);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.reason).toBe("provider_error");
      expect(validated.detail).toContain("access_denied");
    }
  });

  it("rejects a callback with no state (CSRF) or no code", () => {
    expect(validateCallback(parseCallback("https://x/cb?code=abc"))).toMatchObject({
      ok: false,
      reason: "missing_state",
    });
    expect(validateCallback(parseCallback("https://x/cb?state=def"))).toMatchObject({
      ok: false,
      reason: "missing_code",
    });
  });
});

describe("oauth — token lifecycle", () => {
  it("computes expiry from expires_in", () => {
    const result = parseTokenResponse(
      { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" },
      () => 1_000_000,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBe(1_000_000 + 3_600_000);
      expect(result.refreshToken).toBe("rt");
      expect(result.scopes).toEqual(["a", "b"]);
    }
  });

  it("treats a 200 body without an access token as an authentication failure", () => {
    const result = parseTokenResponse({ error: "invalid_grant" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("authentication_failed");
  });

  it("refreshes before expiry, and never for a provider with no expiry", () => {
    const now = 1_000_000;
    expect(
      tokenNeedsRefresh({ tokenExpiresAt: now + 60_000, refreshTokenSealed: "sealed" }, now),
    ).toBe(true);
    expect(
      tokenNeedsRefresh({ tokenExpiresAt: now + 3_600_000, refreshTokenSealed: "sealed" }, now),
    ).toBe(false);
    expect(
      tokenNeedsRefresh({ tokenExpiresAt: now + 1_000, refreshTokenSealed: null }, now),
    ).toBe(false);
    expect(tokenNeedsRefresh({ tokenExpiresAt: null, refreshTokenSealed: "sealed" }, now)).toBe(false);
  });
});

describe("oauth — scopes and redirect", () => {
  it("reports scopes the provider did not grant", () => {
    expect(missingScopes(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(missingScopes(["SCOPE"], ["scope"])).toEqual([]);
  });

  it("derives the registered redirect URI from the project url", () => {
    expect(integrationRedirectUri("https://p.supabase.co/")).toBe(
      "https://p.supabase.co/functions/v1/integrations-oauth/callback",
    );
  });
});
