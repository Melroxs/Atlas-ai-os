// ---------------------------------------------------------------------------
// Atlas Integration Platform — Edge-side primitives
//
// The deployed Edge Functions cannot import from `src/` (the Freebuff bundler
// only packages files inside the function package, which is why this repo keeps
// `_shared/cors.ts` plus a local copy and a drift test). This is the same
// arrangement: the canonical implementation is
// `src/lib/integrations/primitives.ts`, and `primitives.parity.test.ts` executes
// BOTH copies against identical vectors so they cannot silently diverge.
//
// Keep the algorithms byte-for-byte equivalent to the src copy.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is unavailable in this runtime");
  return c;
}

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

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  const challenge = base64UrlEncode(
    new Uint8Array(await webCrypto().subtle.digest("SHA-256", encoder.encode(verifier))),
  );
  return { verifier, challenge, method: "S256" };
}

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

export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export type SignatureScheme = "stripe" | "github" | "slack" | "timestamped_sha256" | "plain_hex";

export interface ParsedSignature {
  timestampSeconds: number | null;
  signatures: string[];
}

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
  rawBody: string;
  header: string | null | undefined;
  secret: string;
  scheme: SignatureScheme;
  nowSeconds?: number;
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

export const MAX_WEBHOOK_BYTES = 512 * 1024;

export interface PayloadGuardResult {
  ok: boolean;
  reason?: "too_large" | "not_json" | "not_object";
}

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

export function webhookDedupeKey(provider: string, externalEventId: string): string {
  return `${provider}:${externalEventId}`;
}

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
    { name: "AES-GCM", iv: base64UrlDecode(parts[1]) as unknown as BufferSource },
    key,
    base64UrlDecode(parts[2]) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
