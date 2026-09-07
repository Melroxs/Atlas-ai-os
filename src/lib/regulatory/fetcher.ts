import { createHash } from "node:crypto";
import type {
  AcquiredSource,
  FetchPolicy,
  RegulatoryError,
  SourceCandidate,
} from "./legacy";

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  allowedDomains: [],
  allowedContentTypes: [
    "text/html",
    "text/plain",
    "application/pdf",
    "application/xhtml+xml",
    "application/json",
  ],
  maxBytes: 15 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 3,
  minIntervalMs: 250,
};

const lastRequestByDomain = new Map<string, number>();

function error(
  code: RegulatoryError["code"],
  message: string,
  retryable: boolean,
  url?: string,
  status?: number,
  details?: Record<string, unknown>,
): RegulatoryError {
  return { code, message, retryable, url, status, details };
}

function isRegulatoryError(value: unknown): value is RegulatoryError {
  return Boolean(value && typeof value === "object" && "code" in value && "message" in value && "retryable" in value);
}

function stableSourceId(url: string): string {
  return `src_${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (host === "0.0.0.0" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function hostnameAllowed(hostname: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const normalized = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const suffix = domain.toLowerCase().replace(/^\.+/, "");
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  });
}

function validateUrl(rawUrl: string, policy: FetchPolicy): URL | RegulatoryError {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return error("INVALID_URL", "Source URL is not a valid URL.", false, rawUrl);
  }
  if (url.protocol !== "https:") {
    return error("INVALID_URL", "Regulatory acquisition only permits HTTPS URLs.", false, rawUrl);
  }
  if (isPrivateHost(url.hostname)) {
    return error("SSRF_BLOCKED", "Private, loopback, and local hosts are blocked.", false, rawUrl);
  }
  if (!hostnameAllowed(url.hostname, policy.allowedDomains)) {
    return error("DOMAIN_NOT_ALLOWED", "Source domain is not on the acquisition allowlist.", false, rawUrl);
  }
  return url;
}

async function waitForRateLimit(hostname: string, minIntervalMs: number): Promise<void> {
  const previous = lastRequestByDomain.get(hostname) ?? 0;
  const waitMs = Math.max(0, minIntervalMs - (Date.now() - previous));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestByDomain.set(hostname, Date.now());
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array | RegulatoryError> {
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.byteLength > maxBytes
      ? error("DOCUMENT_TOO_LARGE", "Document exceeds the configured size limit.", false)
      : data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return error("DOCUMENT_TOO_LARGE", "Document exceeds the configured size limit.", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === base);
}

export async function fetchRegulatorySource(
  candidate: SourceCandidate,
  policy: FetchPolicy = DEFAULT_FETCH_POLICY,
  existingHashes: ReadonlySet<string> = new Set(),
  fetchImpl: typeof fetch = fetch,
): Promise<AcquiredSource> {
  const initial = validateUrl(candidate.url, policy);
  if (isRegulatoryError(initial)) {
    return {
      ...candidate,
      id: candidate.id ?? stableSourceId(candidate.url),
      canonicalUrl: candidate.url,
      contentType: "",
      contentHash: "",
      byteLength: 0,
      status: initial.code === "SSRF_BLOCKED" || initial.code === "DOMAIN_NOT_ALLOWED" ? "BLOCKED" : "FAILED",
      fetchError: initial,
      version: 1,
    };
  }
  let current = initial;
  let redirectCount = 0;
  let response: Response | undefined;
  try {
    while (true) {
      await waitForRateLimit(current.hostname, policy.minIntervalMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      try {
        response = await fetchImpl(current.toString(), {
          method: "GET",
          redirect: "manual",
          headers: { accept: policy.allowedContentTypes.join(", ") },
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === "AbortError";
        throw error(
          timedOut ? "TIMEOUT" : "NETWORK_ERROR",
          timedOut ? "Source request timed out." : cause instanceof Error ? cause.message : "Network request failed.",
          true,
          current.toString(),
        );
      } finally {
        clearTimeout(timer);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= policy.maxRedirects) throw error("REDIRECT_NOT_ALLOWED", "Maximum redirects exceeded.", false, current.toString(), response.status);
        const location = response.headers.get("location");
        if (!location) throw error("REDIRECT_NOT_ALLOWED", "Redirect response omitted a Location header.", false, current.toString(), response.status);
        const next = validateUrl(new URL(location, current).toString(), policy);
        if (isRegulatoryError(next)) throw next;
        current = next;
        redirectCount += 1;
        continue;
      }
      break;
    }
    if (!response) throw error("NETWORK_ERROR", "No response received.", true, current.toString());
    if (!response.ok) throw error("HTTP_ERROR", `Source returned HTTP ${response.status}.`, response.status >= 500 || response.status === 429, current.toString(), response.status);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!contentTypeAllowed(contentType, policy.allowedContentTypes)) throw error("CONTENT_TYPE_NOT_ALLOWED", `Content type ${contentType} is not allowed.`, false, current.toString(), response.status);
    const body = await readBodyWithLimit(response, policy.maxBytes);
    if (isRegulatoryError(body)) throw { ...body, url: current.toString() } satisfies RegulatoryError;
    const contentHash = createHash("sha256").update(body).digest("hex");
    if (existingHashes.has(contentHash)) throw error("DUPLICATE_DOCUMENT", "Document content hash already exists.", false, current.toString(), response.status, { contentHash });
    const rawContent = contentType.split(";", 1)[0].toLowerCase() === "application/pdf" ? undefined : new TextDecoder().decode(body);
    return {
      ...candidate,
      id: candidate.id ?? stableSourceId(current.toString()),
      canonicalUrl: current.toString(),
      contentType,
      contentHash,
      byteLength: body.byteLength,
      rawContent,
      status: "FETCHED",
      httpStatus: response.status,
      version: 1,
      lastFetchedAt: new Date().toISOString(),
    };
  } catch (cause) {
    const fetchError: RegulatoryError = isRegulatoryError(cause)
      ? cause
      : error("NETWORK_ERROR", cause instanceof Error ? cause.message : "Acquisition failed.", true, current.toString());
    return {
      ...candidate,
      id: candidate.id ?? stableSourceId(current.toString()),
      canonicalUrl: current.toString(),
      contentType: "",
      contentHash: "",
      byteLength: 0,
      status: fetchError.code === "DUPLICATE_DOCUMENT" ? "UNCHANGED" : fetchError.code === "SSRF_BLOCKED" || fetchError.code === "DOMAIN_NOT_ALLOWED" ? "BLOCKED" : "FAILED",
      httpStatus: fetchError.status,
      fetchError,
      version: 1,
    };
  }
}
