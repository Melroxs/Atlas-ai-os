// ---------------------------------------------------------------------------
// Atlas auth email-link handling — one parser, one intent resolver, one
// open-redirect guard for every Supabase Auth link that reaches the browser.
//
// Supabase delivers an email link by redirecting the browser to the URL that
// was passed as `redirectTo` (or the project Site URL when no allow-listed
// redirect could be used), appending the auth payload. Depending on the
// project's flow type and the account of the link, the payload arrives as:
//
//   implicit (default, hash fragment)
//     /#access_token=…&refresh_token=…&expires_in=…&token_type=bearer&type=invite
//   PKCE / OAuth (query string)
//     /?code=…
//   token-hash (query string)
//     /?token_hash=…&type=recovery
//   failure (either)
//     /#error=access_denied&error_code=otp_expired&error_description=…
//
// Everything here is pure and unit-tested: it never touches the DOM, the
// Supabase client, or storage. The Supabase session is ALWAYS established
// through Supabase Auth (setSession / verifyOtp / exchangeCodeForSession) —
// this module only decides which route the user should land on.
// ---------------------------------------------------------------------------

/** The `type` values Supabase Auth sends with an email link. */
export type AuthLinkType =
  | "invite"
  | "recovery"
  | "magiclink"
  | "signup"
  | "email"
  | "email_change"
  | "reauthentication";

export interface AuthLinkPayload {
  /** `type` from the payload (fragment wins, query is the fallback). */
  type: AuthLinkType | null;
  /** Implicit flow tokens. */
  accessToken: string | null;
  refreshToken: string | null;
  /** PKCE authorization code (exchangeCodeForSession). */
  code: string | null;
  /** Email OTP token hash (verifyOtp). */
  tokenHash: string | null;
  /** Safe internal destination requested by the link, when present. */
  next: string | null;
  /** Failure details, when Supabase refused the link. */
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

const AUTH_TYPES: readonly string[] = [
  "invite",
  "recovery",
  "magiclink",
  "signup",
  "email",
  "email_change",
  "reauthentication",
];

function normalizeType(value: string | null): AuthLinkType | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  // Supabase sends `magiclink`; accept the spaced/hyphenated spellings too.
  const canonical = v === "magic-link" || v === "magic_link" ? "magiclink" : v;
  return (AUTH_TYPES as readonly string[]).includes(canonical)
    ? (canonical as AuthLinkType)
    : null;
}

/** Parse `a=1&b=2` (with or without a leading `?`/`#`). Never throws. */
export function parseAuthParams(raw: string): URLSearchParams {
  const cleaned = raw.replace(/^[?#]+/, "");
  return new URLSearchParams(cleaned);
}

/**
 * Read a Supabase Auth email-link payload out of a URL's query string and
 * hash fragment. The fragment wins for `type` (GoTrue always puts it there)
 * and the query string is used as a fallback.
 */
export function parseAuthLink(url: {
  search?: string;
  hash?: string;
}): AuthLinkPayload {
  const query = parseAuthParams(url.search ?? "");
  const hash = parseAuthParams(url.hash ?? "");

  // Both halves are attacker-controllable input, so read each value from the
  // fragment first and fall back to the query string.
  const pick = (key: string): string | null => {
    const value = hash.get(key) ?? query.get(key);
    return value === null || value === "" ? null : value;
  };

  return {
    type: normalizeType(pick("type")),
    accessToken: pick("access_token"),
    refreshToken: pick("refresh_token"),
    code: pick("code"),
    tokenHash: pick("token_hash"),
    next: pick("next"),
    error: pick("error"),
    errorCode: pick("error_code"),
    errorDescription: pick("error_description"),
  };
}

/** True when the URL carries anything this module knows how to act on. */
export function hasAuthLinkPayload(payload: AuthLinkPayload | null): boolean {
  if (!payload) return false;
  return Boolean(
    payload.accessToken ||
      payload.code ||
      payload.tokenHash ||
      payload.error ||
      payload.errorCode ||
      payload.type,
  );
}

/**
 * True when the payload carries something Supabase has to act on: implicit
 * tokens, a PKCE code, an email OTP token hash, or a refusal.
 *
 * Deliberately EXCLUDES `type` on its own — a bare `?type=invite` anchor is a
 * routing hint, not proof that an email link was opened, and must never pull a
 * public page into the auth flow.
 */
export function hasAuthCredentials(payload: AuthLinkPayload | null): boolean {
  if (!payload) return false;
  return Boolean(
    payload.accessToken ||
      payload.code ||
      payload.tokenHash ||
      payload.error ||
      payload.errorCode,
  );
}

/**
 * Pick the payload to act on, given what the live URL still carries and what
 * was captured at page load.
 *
 * The Supabase client is created with `detectSessionInUrl: true`, so it can
 * consume and strip the payload from the URL before the router gets a chance
 * to look at it. Preference order:
 *
 *   1. the live URL, when it still carries credentials (nothing was consumed);
 *   2. the payload captured at page load (the SDK already consumed the URL);
 *   3. the live payload, which may still carry only a routing hint;
 *   4. the captured payload, if there is nothing live at all.
 */
export function resolveAuthLinkSource(
  live: AuthLinkPayload | null,
  captured: AuthLinkPayload | null,
): AuthLinkPayload | null {
  if (hasAuthCredentials(live)) return live;
  if (hasAuthCredentials(captured)) return captured;
  return live ?? captured;
}

/**
 * True when the payload identifies a first-time account activation
 * (an invitation) that must end on the password setup page. The invited user
 * has no password yet, so they must never be dropped straight into Atlas.
 */
export function isInvitationPayload(payload: AuthLinkPayload | null): boolean {
  return payload?.type === "invite";
}

/** True when the payload is a password-recovery link. */
export function isRecoveryPayload(payload: AuthLinkPayload | null): boolean {
  return payload?.type === "recovery";
}

/** True when Supabase refused the link (expired, already used, malformed). */
export function isFailedLink(payload: AuthLinkPayload | null): boolean {
  if (!payload) return false;
  return Boolean(payload.error || payload.errorCode);
}

/**
 * Open-redirect guard for every `next` / `returnTo` destination in the auth
 * flow. Only same-application, absolute-path destinations are accepted:
 *
 *   "/dashboard"          → ok
 *   "/dashboard/team"     → ok
 *   "//evil.com"          → rejected (protocol-relative)
 *   "/\\evil.com"         → rejected (browsers treat \ as /)
 *   "https://evil.com"    → rejected (absolute URL)
 *   "javascript:alert(1)" → rejected (scheme)
 *   "dashboard"           → rejected (relative)
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith("/")) return false;
  // Protocol-relative ("//host") and backslash variants are not internal.
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  // Reject control characters (header/URL smuggling).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/** Resolve a requested destination, falling back to a known-safe default. */
export function resolveSafeNext(
  value: unknown,
  fallback = "/dashboard",
): string {
  return isSafeInternalPath(value) ? value : fallback;
}

/**
 * Where a callback should send the user for a given payload.
 *
 *   invite        → /auth/set-password   (first-time activation; no password yet)
 *   recovery      → /auth/reset-password (choose a new password)
 *   everything else → the requested safe `next`, else the app default
 *   no payload      → sign-in, preserving the requested destination
 */
export type AuthLinkDestination =
  | { kind: "set-password"; to: string }
  | { kind: "reset-password"; to: string }
  | { kind: "app"; to: string }
  | { kind: "sign-in"; to: string };

export function resolveAuthLinkDestination(
  payload: AuthLinkPayload | null,
  options: { authenticated: boolean; defaultNext?: string } = {
    authenticated: false,
  },
): AuthLinkDestination {
  const defaultNext = resolveSafeNext(options.defaultNext, "/dashboard");
  const next = resolveSafeNext(payload?.next, defaultNext);

  if (isInvitationPayload(payload)) {
    return { kind: "set-password", to: "/auth/set-password" };
  }
  if (isRecoveryPayload(payload)) {
    return { kind: "reset-password", to: "/auth/reset-password" };
  }
  if (options.authenticated) {
    return { kind: "app", to: next };
  }
  return {
    kind: "sign-in",
    to: `/auth?returnTo=${encodeURIComponent(next)}`,
  };
}

// ---------------------------------------------------------------------------
// One-shot capture of the auth payload from the live URL at page load.
//
// The Supabase client is created with `detectSessionInUrl: true`, which
// consumes and strips the payload from the URL asynchronously. Reading the
// payload synchronously at module-import time (before any client exists)
// guarantees the callback can still see what the email link delivered, and
// lets the app forward a payload that landed on the wrong route (the project
// Site URL root, for example) without racing the SDK.
// ---------------------------------------------------------------------------

let captured: AuthLinkPayload | null = null;
let capturedForLoad = false;

/**
 * Capture the auth payload from `window.location` exactly once per page load.
 * Safe to call more than once; only the first call reads the URL.
 */
export function captureAuthLink(
  location?: { search?: string; hash?: string },
): AuthLinkPayload | null {
  if (capturedForLoad) return captured;
  capturedForLoad = true;
  const target =
    location ?? (typeof window !== "undefined" ? window.location : undefined);
  if (!target) return null;
  const payload = parseAuthLink(target);
  captured = hasAuthLinkPayload(payload) ? payload : null;
  return captured;
}

/** The payload captured for this page load, or null. Never re-reads the URL. */
export function getCapturedAuthLink(): AuthLinkPayload | null {
  return captured;
}

/** Claim the captured payload once so it can never be replayed twice. */
export function consumeCapturedAuthLink(): AuthLinkPayload | null {
  const value = captured;
  captured = null;
  return value;
}

/** Test hook — resets the one-shot capture. */
export function resetCapturedAuthLink(): void {
  captured = null;
  capturedForLoad = false;
}
