// ---------------------------------------------------------------------------
// Atlas Platform — Source change detection (pure, no I/O)
//
// The pipeline is deliberately narrow:
//
//   SOURCE -> FETCH -> NORMALIZE -> FINGERPRINT -> COMPARE
//          -> NO CHANGE  -> record the check and STOP (no reprocessing)
//          -> CHANGED    -> record the change and enqueue processing
//
// Fetching is injected (SourceFetcher) so this module is deterministic and can
// be tested without network access.
// ---------------------------------------------------------------------------

import type {
  ComparisonResult,
  FetchedSource,
  RegisteredSource,
  SourceCheckOutcome,
  SourceCheckStatus,
} from "./types";

/**
 * Normalize fetched source content before fingerprinting.
 *
 * Goals: ignore volatile markup (scripts/styles/timestamps/last-modified
 * banners) so a cosmetic page change does not spin up knowledge processing,
 * while never discarding the substantive text that would be a real change.
 */
export function normalizeSourceContent(raw: string): string {
  if (!raw) return "";
  let text = raw;

  // Strip non-content elements entirely.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Drop volatile rendering artifacts that are not content changes.
  text = text.replace(
    /<(meta|link)\b[^>]*(last-modified|etag|date-modified|generated)[^>]*>/gi,
    " ",
  );

  // Tags -> whitespace, then decode the few entities that matter.
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Collapse whitespace deterministically.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Deterministic 64-bit FNV-1a fingerprint (hex, zero-padded).
 *
 * Synchronous and dependency-free so it runs in the browser, in Node tests and
 * in a worker without importing a crypto polyfill. This is change detection,
 * not a security hash — collisions are not a threat model here, and a
 * length+content fingerprint makes accidental collisions vanishingly unlikely
 * for source pages.
 */
export function contentFingerprint(normalized: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;

  let hash = FNV_OFFSET;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Compare a fresh fingerprint against the stored one. */
export function compareFingerprints(
  normalized: string,
  previousFingerprint: string | null | undefined,
): ComparisonResult {
  const fingerprint = contentFingerprint(normalized);
  const previous = previousFingerprint ?? null;
  return {
    decision: previous !== null && previous === fingerprint ? "unchanged" : "changed",
    fingerprint,
    previousFingerprint: previous,
    normalizedLength: normalized.length,
  };
}

/**
 * Convert a fetch result into a check outcome.
 *
 * A page that could not be fetched is NEVER recorded as unchanged — it is
 * recorded as failed/unavailable so stale knowledge cannot masquerade as
 * freshly verified knowledge.
 */
export function outcomeFromFetch(
  fetched: FetchedSource,
  normalized: string | null,
  previousFingerprint: string | null | undefined,
): SourceCheckOutcome {
  if (!fetched.ok || normalized === null) {
    const status = classifyFetchFailure(fetched);
    return {
      status,
      contentHash: null,
      previousHash: previousFingerprint ?? null,
      changeType: null,
      httpStatus: fetched.httpStatus,
      latencyMs: fetched.latencyMs,
      normalizedLength: null,
      error: fetched.error ?? "Source could not be retrieved.",
      retryable: fetched.retryable,
    };
  }

  const comparison = compareFingerprints(normalized, previousFingerprint);
  return {
    status: comparison.decision,
    contentHash: comparison.fingerprint,
    previousHash: comparison.previousFingerprint,
    changeType: comparison.decision === "changed" ? "content_changed" : null,
    httpStatus: fetched.httpStatus,
    latencyMs: fetched.latencyMs,
    normalizedLength: comparison.normalizedLength,
    error: null,
    retryable: false,
  };
}

/**
 * Classify a failed fetch.
 *  - 404/410 (or an explicit non-retryable flag) => 'unavailable' (permanent)
 *  - everything else (timeout, network, 5xx)     => 'failed' (retryable)
 */
export function classifyFetchFailure(fetched: FetchedSource): SourceCheckStatus {
  if (!fetched.retryable) return "unavailable";
  const status = fetched.httpStatus;
  if (status === 404 || status === 410) return "unavailable";
  return "failed";
}

/** True when a check outcome should trigger knowledge processing. */
export function shouldProcessChange(outcome: SourceCheckOutcome): boolean {
  return outcome.status === "changed";
}

/**
 * Which follow-on work a check outcome implies.
 * Unchanged checks produce NO follow-on work — the single most important rule
 * of the change-detection pipeline.
 */
export function planFollowOnWork(outcome: SourceCheckOutcome): {
  kind: "none" | "detect_change";
  reason: string;
} {
  if (outcome.status === "changed") {
    return {
      kind: "detect_change",
      reason: `Source content changed (${outcome.changeType ?? "content_changed"}).`,
    };
  }
  if (outcome.status === "failed" || outcome.status === "unavailable") {
    return {
      kind: "none",
      reason: "Fetch did not succeed; the failure is recorded and retried by the source schedule.",
    };
  }
  if (outcome.status === "skipped") {
    return { kind: "none", reason: "Check skipped." };
  }
  return { kind: "none", reason: "No change detected; check recorded." };
}

/** Whether a source is due to be checked. */
export function isSourceDue(source: RegisteredSource, nowMs: number): boolean {
  if (source.enabled === false) return false;
  if (source.nextCheckAt == null) return true;
  if (source.nextCheckAt <= nowMs) return true;
  const freshness = String(source.freshness ?? "");
  return freshness === "stale" || freshness === "failed" || freshness === "changed";
}
