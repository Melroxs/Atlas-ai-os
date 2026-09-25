// ---------------------------------------------------------------------------
// Atlas Integration Platform — shared primitives
//
// Pure, dependency-free crypto/encoding helpers used by BOTH the browser-side
// integration modules and the Edge Functions. There is exactly one copy of the
// logic; `supabase/functions/_shared/integration/primitives.ts` must stay
// byte-identical and `primitives.drift.test.ts` fails the build if the two ever
// diverge. (Same convention the repo already uses for `_shared/cors.ts`.)
//
// Nothing here reads the environment and nothing here touches the network, so
// every function is deterministic and unit-testable. Secrets are always passed
// in by the caller — a secret never has a default.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error("Web Crypto is unavailable in this runtime");
  }
  return c;
}

/** URL-safe base64 without padding (OAuth state / PKCE / verifier encoding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Cryptographically strong random token, URL-safe. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  webCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await webCrypto().subtle.digest("SHA-256", input as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a secret value, hex. Used for one-way OAuth state storage. */
export function stateHash(state: string): Promise<string> {
  return sha256Hex(state);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — used when a provider supports it
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  // 43–128 characters per RFC; 32 random bytes → 43 base64url characters.
  const verifier = randomToken(32);
  const challenge = base64UrlEncode(
    new Uint8Array(await webCrypto().subtle.digest("SHA-256", encoder.encode(verifier))),
  );
  return { verifier, challenge, method: "S256" };
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 webhook signatures
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await webCrypto().subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await webCrypto().subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function signHmacSha256Hex(secret: string, payload: string): Promise<string> {
  return hmacSha256Hex(secret, payload);
}

/**
 * Constant-time comparison of two hexadecimal strings.
 *
 * Length is compared first (that is not secret), then every byte is folded into
 * an accumulator so a mismatching prefix cannot be detected by timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/** Signature header shapes Atlas accepts, by provider family. */
export type SignatureScheme = "stripe" | "github" | "slack" | "timestamped_sha256" | "plain_hex";

export interface ParsedSignature {
  /** Provider-declared timestamp, when the scheme carries one. */
  timestampSeconds: number | null;
  /** Candidate signature hex values to compare against the computed HMAC. */
  signatures: string[];
}

/**
 * Parse a provider signature header.
 *
 * Supported shapes (documented, not guessed — each maps to a provider that
 * really sends it):
 *   stripe / timestamped_sha256 : `t=<sec>,v1=<hex>[,v1=<hex>…]`
 *   github                      : `sha256=<hex>`
 *   slack                       : `v0=<hex>` (with `X-Slack-Request-Timestamp`)
 *   plain_hex                   : `<hex>`
 */
export function parseSignatureHeader(
  header: string | null | undefined,
  scheme: SignatureScheme,
): ParsedSignature {
  const value = (header ?? "").trim();
  if (!value) return { timestampSeconds: null, signatures: [] };

  if (scheme === "plain_hex") {
    return { timestampSeconds: null, signatures: /^[0-9a-f]{32,}$/i.test(value) ? [value] : [] };
  }

  if (scheme === "github") {
    const match = value.match(/sha256=([0-9a-f]+)/i);
    return { timestampSeconds: null, signatures: match ? [match[1]] : [] };
  }

  if (scheme === "slack") {
    const match = value.match(/v0=([0-9a-f]+)/i);
    return { timestampSeconds: null, signatures: match ? [match[1]] : [] };
  }

  // stripe / timestamped_sha256
  let timestampSeconds: number | null = null;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = (rawKey ?? "").trim();
    const val = (rawValue ?? "").trim();
    if (key === "t" && /^\d+$/.test(val)) timestampSeconds = Number(val);
    if ((key === "v1" || key === "sha256" || key === "v0") && /^[0-9a-f]+$/i.test(val)) {
      signatures.push(val);
    }
  }
  return { timestampSeconds, signatures };
}

export interface SignatureCheckInput {
  /** Raw request body, exactly as received (never a re-serialized JSON). */
  rawBody: string;
  header: string | null | undefined;
  secret: string;
  scheme: SignatureScheme;
  /** Unix seconds; injectable for deterministic tests. */
  nowSeconds?: number;
  /** Replay window in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
}

export interface SignatureCheckResult {
  ok: boolean;
  reason?:
    | "missing_header"
    | "malformed_header"
    | "missing_secret"
    | "timestamp_out_of_tolerance"
    | "signature_mismatch";
  timestampSeconds?: number | null;
}

/**
 * Verify a provider webhook signature.
 *
 * The signed payload follows the provider's own contract:
 *   * stripe / timestamped_sha256 → `${timestamp}.${rawBody}` (replay-protected)
 *   * github / slack / plain_hex → the raw body
 *
 * A missing timestamp, or one outside the tolerance window, is rejected — that
 * is what makes a captured request non-replayable.
 */
export async function verifyWebhookSignature(
  input: SignatureCheckInput,
): Promise<SignatureCheckResult> {
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  if (!input.header) return { ok: false, reason: "missing_header" };

  const parsed = parseSignatureHeader(input.header, input.scheme);
  if (parsed.signatures.length === 0) return { ok: false, reason: "malformed_header" };

  const signedPayload =
    parsed.timestampSeconds === null ? input.rawBody : `${parsed.timestampSeconds}.${input.rawBody}`;

  if (input.scheme === "stripe" || input.scheme === "timestamped_sha256") {
    if (parsed.timestampSeconds === null) {
      return { ok: false, reason: "malformed_header", timestampSeconds: null };
    }
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = input.toleranceSeconds ?? 300;
    if (Math.abs(now - parsed.timestampSeconds) > tolerance) {
      return {
        ok: false,
        reason: "timestamp_out_of_tolerance",
        timestampSeconds: parsed.timestampSeconds,
      };
    }
  }

  const expected = await hmacSha256Hex(input.secret, signedPayload);
  const ok = parsed.signatures.some((candidate) => timingSafeEqualHex(candidate, expected));
  return ok
    ? { ok: true, timestampSeconds: parsed.timestampSeconds }
    : { ok: false, reason: "signature_mismatch", timestampSeconds: parsed.timestampSeconds };
}

// ---------------------------------------------------------------------------
// Payload safety
// ---------------------------------------------------------------------------

/** Provider webhooks larger than this are rejected before parsing. */
export const MAX_WEBHOOK_BYTES = 512 * 1024;

export interface PayloadGuardResult {
  ok: boolean;
  reason?: "too_large" | "not_json" | "not_object";
}

/** Enforce a size ceiling and an object shape before any field is trusted. */
export function guardWebhookPayload(rawBody: string, maxBytes = MAX_WEBHOOK_BYTES): PayloadGuardResult {
  const byteLength = encoder.encode(rawBody).length;
  if (byteLength === 0) return { ok: false, reason: "not_json" };
  if (byteLength > maxBytes) return { ok: false, reason: "too_large" };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "not_object" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_json" };
  }
}

/**
 * Stable idempotency key for an inbound provider event.
 *
 * Provider + provider event id is the only combination that is guaranteed
 * stable across redelivery; a hash of the payload is NOT used, because providers
 * legitimately resend identical payloads for different events and re-deliver the
 * same event with a different body.
 */
export function webhookDedupeKey(provider: string, externalEventId: string): string {
  return `${provider}:${externalEventId}`;
}

// ---------------------------------------------------------------------------
// Credential sealing (AES-256-GCM)
//
// Provider access/refresh tokens are never stored as plaintext. The sealed blob
// is `v<keyVersion>.<iv>.<ciphertext>` in base64url, and the key lives only in
// the Edge Function environment (INTEGRATION_CREDENTIAL_KEY). The browser never
// holds the key and never receives a decrypted token.
// ---------------------------------------------------------------------------

export interface SealedValue {
  sealed: string;
  keyVersion: number;
}

async function importAesKey(rawKey: string): Promise<CryptoKey> {
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    encoder.encode(rawKey) as unknown as BufferSource,
  );
  return webCrypto().subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealCredential(
  plaintext: string,
  rawKey: string,
  keyVersion = 1,
): Promise<SealedValue> {
  if (!rawKey) throw new Error("credential key is not configured");
  const key = await importAesKey(rawKey);
  const iv = new Uint8Array(12);
  webCrypto().getRandomValues(iv);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encoder.encode(plaintext) as unknown as BufferSource,
  );
  return {
    sealed: `v${keyVersion}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`,
    keyVersion,
  };
}

export async function openCredential(sealed: string, rawKey: string): Promise<string> {
  if (!rawKey) throw new Error("credential key is not configured");
  const parts = sealed.split(".");
  if (parts.length !== 3 || !parts[0].startsWith("v")) {
    throw new Error("malformed sealed credential");
  }
  const key = await importAesKey(rawKey);
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(parts[1]) as unknown as BufferSource,
    },
    key,
    base64UrlDecode(parts[2]) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
