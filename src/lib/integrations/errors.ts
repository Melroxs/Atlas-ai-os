// ---------------------------------------------------------------------------
// Atlas Integration Platform — error taxonomy & retry policy
//
// One classification for every failure mode across every provider, so the UI,
// the audit log and the retry engine all speak the same language (§20).
//
// Provider error bodies are NEVER surfaced to users: `classifyIntegrationError`
// keeps the raw detail for the operator log while `safeIntegrationMessage`
// produces the sentence a human is allowed to see.
// ---------------------------------------------------------------------------

export type IntegrationErrorClass =
  | "authentication_failed"
  | "authorization_failed"
  | "permission_denied"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_request"
  | "validation_failed"
  | "mapping_failed"
  | "webhook_invalid"
  | "sync_failed"
  | "unknown";

export interface ClassifiedIntegrationError {
  errorClass: IntegrationErrorClass;
  /** True when retrying the same operation can plausibly succeed later. */
  retryable: boolean;
  /** Milliseconds to wait before the next attempt (0 = retry immediately). */
  retryAfterMs: number;
  /** Operator-facing detail. Includes the provider's own message. */
  detail: string;
  /** HTTP status the edge function should return to the provider. */
  httpStatus: number;
}

/** HTTP statuses that mean "try again", per provider reality. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function classifyHttpStatus(status: number, detail = ""): ClassifiedIntegrationError {
  const errorClass: IntegrationErrorClass =
    status === 401
      ? "authentication_failed"
      : status === 403
        ? "permission_denied"
        : status === 429
          ? "rate_limited"
          : status === 400 || status === 422
            ? "invalid_request"
            : status === 404
              ? "invalid_request"
              : status >= 500
                ? "provider_unavailable"
                : "unknown";

  return {
    errorClass,
    retryable: isRetryableStatus(status),
    retryAfterMs: status === 429 ? 60_000 : 0,
    detail: detail.slice(0, 600),
    httpStatus: status,
  };
}

/**
 * Classify a thrown/failed provider call. Accepts the provider's own error body
 * (already parsed) plus an optional HTTP status and `Retry-After` header.
 */
export function classifyIntegrationError(input: {
  status?: number | null;
  retryAfterSeconds?: number | null;
  body?: unknown;
  error?: unknown;
  fallback?: IntegrationErrorClass;
}): ClassifiedIntegrationError {
  const fallback = input.fallback ?? "unknown";
  const rawDetail =
    typeof input.error === "string"
      ? input.error
      : input.error instanceof Error
        ? input.error.message
        : typeof input.body === "string"
          ? input.body
          : input.body
            ? JSON.stringify(input.body)
            : "";

  if (input.status) {
    const classified = classifyHttpStatus(input.status, rawDetail);
    if (input.retryAfterSeconds && input.retryAfterSeconds > 0) {
      return { ...classified, retryAfterMs: input.retryAfterSeconds * 1000 };
    }
    return classified;
  }

  const message = rawDetail.toLowerCase();
  if (message.includes("unauthorized") || message.includes("invalid_grant")) {
    return { errorClass: "authentication_failed", retryable: false, retryAfterMs: 0, detail: rawDetail, httpStatus: 401 };
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return { errorClass: "rate_limited", retryable: true, retryAfterMs: 60_000, detail: rawDetail, httpStatus: 429 };
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("econnreset")) {
    return { errorClass: "provider_unavailable", retryable: true, retryAfterMs: 0, detail: rawDetail, httpStatus: 504 };
  }

  return { errorClass: fallback, retryable: false, retryAfterMs: 0, detail: rawDetail, httpStatus: 500 };
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * `attempt` is 1-based. Jitter is drawn from an injected random source so tests
 * are deterministic.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 5_000;
  const max = options.maxMs ?? 3_600_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter: uniform between base and the exponential ceiling.
  const floor = Math.min(base, exponential);
  return Math.round(floor + random() * (exponential - floor));
}

/**
 * Whether a sync should stop retrying. Rate limits are never permanent; auth
 * failures are, and retrying them just burns quota.
 */
export function shouldStopRetrying(errorClass: IntegrationErrorClass): boolean {
  return (
    errorClass === "authentication_failed" ||
    errorClass === "permission_denied" ||
    errorClass === "authorization_failed"
  );
}

/** The sentence a human is allowed to see. Never contains provider internals. */
export function safeIntegrationMessage(errorClass: IntegrationErrorClass, providerName: string): string {
  switch (errorClass) {
    case "authentication_failed":
      return `${providerName} needs to be reconnected — the authorization expired.`;
    case "authorization_failed":
      return `Atlas is not authorized for that ${providerName} action.`;
    case "permission_denied":
      return `${providerName} denied access to that data. Check the account's permissions.`;
    case "rate_limited":
      return `${providerName} is limiting how fast Atlas can sync. Atlas will retry automatically.`;
    case "provider_unavailable":
      return `${providerName} is not responding right now. Atlas will retry automatically.`;
    case "invalid_request":
      return `Atlas sent ${providerName} something it did not accept. This has been logged for an operator.`;
    case "validation_failed":
      return `The ${providerName} data did not pass Atlas validation, so nothing was imported.`;
    case "mapping_failed":
      return `Atlas could not match that ${providerName} record to an Atlas record.`;
    case "webhook_invalid":
      return `A ${providerName} update was rejected because it could not be verified.`;
    case "sync_failed":
      return `The ${providerName} sync did not finish. Atlas will retry automatically.`;
    default:
      return `Something went wrong talking to ${providerName}. This has been logged for an operator.`;
  }
}
