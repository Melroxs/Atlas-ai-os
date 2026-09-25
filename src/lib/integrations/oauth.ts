// ---------------------------------------------------------------------------
// Atlas Integration Platform — OAuth foundation (§7)
//
// Provider-agnostic. Nothing here knows about Google, Microsoft or any specific
// vendor: a provider supplies its authorize/token endpoints and scopes, and this
// module builds the flow, validates the callback and manages token lifecycle.
//
// Security properties enforced here (not in the UI):
//   * state is 32 random bytes, stored server-side as a SHA-256 hash only
//   * state is bound to (organization, user, provider, redirect_uri)
//   * state is single-use and time-limited (the DB function enforces both)
//   * PKCE S256 when the provider supports it
//   * client_secret never leaves the server
//   * a token response is validated (shape + expiry) before it is sealed
// ---------------------------------------------------------------------------

import { createPkcePair, randomToken, stateHash } from "./primitives";
import { classifyIntegrationError, type ClassifiedIntegrationError } from "./errors";
import type { SealedCredentials } from "./types";

export interface OAuthProviderConfig {
  /** Registry provider key, e.g. "google_gmail". */
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Whether the provider implements PKCE. */
  usePkce: boolean;
  /** Extra authorize parameters (access_type=offline, prompt=consent, …). */
  authorizeParams?: Record<string, string>;
}

export interface OAuthStartInput {
  config: OAuthProviderConfig;
  clientId: string;
  redirectUri: string;
  returnTo?: string | null;
  /** Defaults to now; injectable for tests. */
  now?: number;
}

export interface OAuthStartResult {
  /** The value placed in the redirect. Never persisted in plaintext. */
  state: string;
  /** What the database stores. */
  stateHash: string;
  codeVerifier: string | null;
  authorizationUrl: string;
  scopes: string[];
  createdAt: number;
}

/**
 * Begin an authorization flow. The caller persists `stateHash` (and
 * `codeVerifier`) server-side before redirecting the user.
 */
export async function beginAuthorization(input: OAuthStartInput): Promise<OAuthStartResult> {
  const state = randomToken(32);
  const pkce = input.config.usePkce ? await createPkcePair() : null;
  const url = new URL(input.config.authorizeUrl);

  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (input.config.scopes.length > 0) {
    url.searchParams.set("scope", input.config.scopes.join(" "));
  }
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
  }
  for (const [key, value] of Object.entries(input.config.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return {
    state,
    stateHash: await stateHash(state),
    codeVerifier: pkce?.verifier ?? null,
    authorizationUrl: url.toString(),
    scopes: input.config.scopes,
    createdAt: input.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface OAuthCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/** Parse a provider callback query string without trusting any field. */
export function parseCallback(url: string): OAuthCallbackParams {
  const params = new URL(url).searchParams;
  return {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

export type CallbackValidation =
  | { ok: true; state: string; code: string }
  | { ok: false; reason: "provider_error" | "missing_state" | "missing_code"; detail: string };

export function validateCallback(params: OAuthCallbackParams): CallbackValidation {
  if (params.error) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `${params.error}${params.errorDescription ? `: ${params.errorDescription}` : ""}`.slice(0, 300),
    };
  }
  if (!params.state) return { ok: false, reason: "missing_state", detail: "no state parameter" };
  if (!params.code) return { ok: false, reason: "missing_code", detail: "no authorization code" };
  return { ok: true, state: params.state, code: params.code };
}

// ---------------------------------------------------------------------------
// Token response
// ---------------------------------------------------------------------------

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  scope?: string | null;
  token_type?: string | null;
}

export type TokenParseResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresAt: number | null; scopes: string[] }
  | { ok: false; error: ClassifiedIntegrationError };

/**
 * Validate a provider token response. A response without an access token is an
 * error even when the HTTP status was 200 — some providers return 200 with an
 * error body.
 */
export function parseTokenResponse(
  body: unknown,
  now: () => number = () => Date.now(),
): TokenParseResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";

  if (!accessToken) {
    return {
      ok: false,
      error: classifyIntegrationError({ body, fallback: "authentication_failed" }),
    };
  }

  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : null;
  const scope = typeof record.scope === "string" ? record.scope : "";

  return {
    ok: true,
    accessToken,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : null,
    expiresAt: expiresIn === null ? null : now() + expiresIn * 1000,
    scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}

/** Refresh this many milliseconds before the provider's expiry. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether credentials must be refreshed before use.
 *
 * A provider that returns no expiry at all (some API-key style tokens) is never
 * proactively refreshed — Atlas refreshes only on an explicit authentication
 * failure, so it never hammers a provider that does not need it.
 */
export function tokenNeedsRefresh(
  credentials: Pick<SealedCredentials, "tokenExpiresAt" | "refreshTokenSealed">,
  now: number = Date.now(),
): boolean {
  if (!credentials.refreshTokenSealed) return false;
  if (credentials.tokenExpiresAt === null) return false;
  return credentials.tokenExpiresAt - now <= TOKEN_REFRESH_SKEW_MS;
}

/**
 * Scopes Atlas requested but the provider did not grant. A missing scope is
 * reported (and the capability it powers is disabled), never silently assumed.
 */
export function missingScopes(granted: string[], required: string[]): string[] {
  const normalized = new Set(granted.map((s) => s.trim().toLowerCase()));
  return required.filter((scope) => !normalized.has(scope.trim().toLowerCase()));
}

/** The redirect URI registered with the provider for an Atlas project. */
export function integrationRedirectUri(supabaseUrl: string, functionName = "integrations-oauth"): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/${functionName}/callback`;
}
