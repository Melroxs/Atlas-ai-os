// ---------------------------------------------------------------------------
// Atlas Content Engine — provider token lifecycle
//
// Atlas stores sealed OAuth credentials in public.connectiontokens and only the
// edge worker may open them. This module holds the DECISIONS (pure, testable);
// the worker performs the network call and the sealed write.
//
// It also records the one place a provider genuinely differs:
//   * Google/YouTube issues a refresh token and supports token refresh;
//   * LinkedIn's three-legged OAuth does NOT issue a usable refresh token for
//     the member scopes Atlas requests, so there is nothing to refresh. Atlas
//     treats an expired LinkedIn authorization as revoked and tells the user to
//     reconnect, rather than inventing a refresh that cannot work.
// ---------------------------------------------------------------------------

import type { DestinationProvider } from "./types";

/** Refresh a little before expiry so a long upload cannot fail mid-flight. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type TokenDecision =
  | { action: "use"; reason: "no_expiry_known" | "not_expiring" }
  | { action: "refresh"; reason: "expired" | "expiring_soon" }
  | { action: "reconnect"; reason: "unsupported_by_provider" | "no_refresh_token" };

/** Can this provider's token be refreshed at all? */
export function supportsRefresh(provider: DestinationProvider): boolean {
  // Google (YouTube) is the only Atlas publishing provider with a documented,
  // supported refresh-token grant. LinkedIn is not — see the module comment.
  return provider === "youtube";
}

/**
 * Decide what to do with a stored access token.
 *
 * `expiresAt` is Atlas's own millisecond timestamp. An unknown expiry is used
 * as-is (never proactively refreshed), because an unnecessary refresh can
 * invalidate a working token.
 */
export function decideTokenAction(input: {
  provider: DestinationProvider;
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

/** Map a provider HTTP status onto the failure classes the UI can act on. */
export function classifyAuthFailure(status: number): AuthFailure {
  if (status === 401) return "expired";
  if (status === 403) return "revoked";
  if (status === 429) return "rate_limited";
  return "other";
}

/** The user-facing instruction. Never a raw provider body, never a token. */
export function reconnectMessage(provider: DestinationProvider): string {
  return provider === "youtube"
    ? "YouTube authorization expired or was revoked. Reconnect YouTube to continue publishing."
    : "LinkedIn authorization expired or was revoked. Reconnect LinkedIn to continue publishing.";
}
