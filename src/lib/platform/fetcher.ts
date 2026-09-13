// ---------------------------------------------------------------------------
// Atlas Platform — Source fetcher
//
// Fetches a registered authoritative source and classifies the outcome so the
// change-detection pipeline can distinguish:
//   - a real content change
//   - a transient failure (retry + back off, mark 'failed')
//   - a permanent disappearance (mark 'unavailable', do NOT retry forever)
//
// Security: source fetching is an outbound SSRF surface. Only https URLs on
// public hosts are fetched, and private/loopback/link-local addresses are
// refused outright. Credentials are never attached.
// ---------------------------------------------------------------------------

import type { FetchedSource, SourceFetcher } from "./types";

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/** Guard against SSRF: https + public host only. */
export function isAllowedSourceUrl(url: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Malformed source URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Only https sources may be fetched." };
  }
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
    return { ok: false, reason: "Refusing to fetch a private or loopback host." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Source URLs must not embed credentials." };
  }
  return { ok: true };
}

/** Classify a fetch failure into retryable vs permanent. */
export function classifyHttpStatus(status: number | null): boolean {
  if (status == null) return true; // network/timeout — retryable
  if (status === 404 || status === 410) return false;
  if (status === 401 || status === 403) return false; // auth won't fix itself
  if (status === 429) return true; // rate limited — retry with backoff
  if (status >= 500) return true;
  if (status >= 400) return false;
  return true;
}

export interface HttpFetcherOptions {
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * Create the real HTTP source fetcher.
 * No credentials or cookies are ever sent; the request is anonymous and
 * identified by a descriptive User-Agent.
 */
export function createHttpSourceFetcher(
  options: HttpFetcherOptions = {},
): SourceFetcher {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const impl = options.fetchImpl ?? fetch;
  const userAgent =
    options.userAgent ?? "AtlasIntelligenceBot/1.0 (+source-verification)";

  return {
    async fetch(url: string): Promise<FetchedSource> {
      const allowed = isAllowedSourceUrl(url);
      if (!allowed.ok) {
        return {
          ok: false,
          httpStatus: null,
          body: null,
          error: allowed.reason ?? "Source URL refused.",
          retryable: false,
          latencyMs: 0,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();

      try {
        const res = await impl(url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          },
        });
        const latencyMs = Date.now() - started;
        const body = await res.text();
        return {
          ok: res.ok,
          httpStatus: res.status,
          body: res.ok ? body : null,
          error: res.ok ? null : `HTTP ${res.status}`,
          retryable: classifyHttpStatus(res.status),
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const aborted =
          controller.signal.aborted ||
          (err instanceof Error && /abort/i.test(err.message));
        return {
          ok: false,
          httpStatus: null,
          body: null,
          error: aborted
            ? `Source fetch timed out after ${timeoutMs}ms.`
            : `Source fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
          latencyMs,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
