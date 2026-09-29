// ---------------------------------------------------------------------------
// Atlas Content Engine — provider token lifecycle (edge copy)
//
// Deployed Edge Functions cannot import from `src/`, so the worker's copy of the
// decisions that live canonically in `src/lib/content-engine/oauth.ts` lives
// here, under the same parity-test guarantee
// (`src/lib/content-engine/oauth-parity.test.ts`).
//
// The rules, in one place:
//   * a token that is still comfortably valid is used as-is — an unnecessary
//     refresh can invalidate a working token;
//   * Google/YouTube HAS a documented refresh grant, so an expired or
//     nearly-expired access token is refreshed server-side and written back
//     through the sanctioned `connections_register` path;
//   * LinkedIn's three-legged OAuth issues no usable refresh token for the
//     scopes Atlas requests, so there is nothing to refresh. Atlas reports
//     AUTHORIZATION_REVOKED and asks the user to reconnect instead of inventing
//     a refresh that cannot work.
//   * no token is ever logged, returned to a browser, or written to source.
// ---------------------------------------------------------------------------

export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type TokenDecision =
  | { action: "use"; reason: "no_expiry_known" | "not_expiring" }
  | { action: "refresh"; reason: "expired" | "expiring_soon" }
  | { action: "reconnect"; reason: "unsupported_by_provider" | "no_refresh_token" };

/** Can this provider's token be refreshed at all? */
export function supportsRefresh(provider: string): boolean {
  return provider === "youtube";
}

export function decideTokenAction(input: {
  provider: string;
  expiresAt: number | null;
  now: number;
  hasRefreshToken: boolean;
}): TokenDecision {
  if (!supportsRefresh(input.provider)) {
    return { action: "reconnect", reason: "unsupported_by_provider" };
  }
  if (input.expiresAt === null) {
    return { action: "use", reason: "no_expiry_known" };
  }
  if (input.expiresAt <= input.now) {
    return input.hasRefreshToken
      ? { action: "refresh", reason: "expired" }
      : { action: "reconnect", reason: "no_refresh_token" };
  }
  if (input.expiresAt - input.now <= REFRESH_SKEW_MS) {
    return input.hasRefreshToken
      ? { action: "refresh", reason: "expiring_soon" }
      : { action: "use", reason: "not_expiring" };
  }
  return { action: "use", reason: "not_expiring" };
}

export type AuthFailure = "expired" | "revoked" | "rate_limited" | "other";

export function classifyAuthFailure(status: number): AuthFailure {
  if (status === 401) return "expired";
  if (status === 403) return "revoked";
  if (status === 429) return "rate_limited";
  return "other";
}

/** The user-facing instruction. Never a raw provider body, never a token. */
export function reconnectMessage(provider: string): string {
  return provider === "youtube"
    ? "YouTube authorization expired or was revoked. Reconnect YouTube to continue publishing."
    : "LinkedIn authorization expired or was revoked. Reconnect LinkedIn to continue publishing.";
}

// ---------------------------------------------------------------------------
// The Google refresh grant
// ---------------------------------------------------------------------------

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The form body Atlas sends to exchange a stored refresh token. Pure. */
export function buildGoogleRefreshBody(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }).toString();
}

export interface RefreshedCredential {
  accessToken: string;
  /** Google's expiry is in seconds; Atlas stores milliseconds. */
  expiresAt: number | null;
  /** Google only returns a new refresh token when the old one is being replaced. */
  refreshToken: string | null;
}

/**
 * Read a Google token response. Returns null for anything that is not a usable
 * access token, so the caller can fail closed with AUTHORIZATION_REVOKED.
 */
export function readGoogleTokenResponse(payload: unknown, now: number): RefreshedCredential | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const accessToken = typeof body["access_token"] === "string" ? (body["access_token"] as string) : "";
  if (!accessToken) return null;
  const expiresIn = Number(body["expires_in"] ?? 0);
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    refreshToken: typeof body["refresh_token"] === "string" ? (body["refresh_token"] as string) : null,
  };
}
