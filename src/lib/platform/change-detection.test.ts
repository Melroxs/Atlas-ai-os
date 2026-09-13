import { describe, expect, it } from "vitest";
import {
  classifyFetchFailure,
  compareFingerprints,
  contentFingerprint,
  isSourceDue,
  normalizeSourceContent,
  outcomeFromFetch,
  planFollowOnWork,
  shouldProcessChange,
} from "./change-detection";
import { classifyHttpStatus, createHttpSourceFetcher, isAllowedSourceUrl } from "./fetcher";
import type { FetchedSource } from "./types";

const okFetch = (body: string, latencyMs = 12): FetchedSource => ({
  ok: true,
  httpStatus: 200,
  body,
  error: null,
  retryable: false,
  latencyMs,
});

const failFetch = (over: Partial<FetchedSource> = {}): FetchedSource => ({
  ok: false,
  httpStatus: null,
  body: null,
  error: "boom",
  retryable: true,
  latencyMs: 5,
  ...over,
});

describe("normalizeSourceContent", () => {
  it("strips scripts, styles and comments", () => {
    const raw = `<html><style>.a{color:red}</style><script>var x=1;</script><body><!-- c -->Regulation text</body></html>`;
    expect(normalizeSourceContent(raw)).toBe("Regulation text");
  });

  it("collapses whitespace deterministically", () => {
    expect(normalizeSourceContent("a\n\n   b\t c")).toBe("a b c");
  });

  it("decodes the entities that matter", () => {
    expect(normalizeSourceContent("<p>A &amp; B &lt;x&gt; &nbsp; C</p>")).toBe("A & B <x> C");
  });

  it("ignores volatile meta/link tags", () => {
    const withMeta = `<head><meta name="last-modified" content="2026-01-01"></head><body>Text</body>`;
    expect(normalizeSourceContent(withMeta)).toBe("Text");
  });

  it("handles empty input", () => {
    expect(normalizeSourceContent("")).toBe("");
  });
});

describe("contentFingerprint", () => {
  it("is deterministic and fixed-width", () => {
    const a = contentFingerprint("same content");
    expect(a).toBe(contentFingerprint("same content"));
    expect(a).toHaveLength(16);
  });

  it("changes when content changes", () => {
    expect(contentFingerprint("a")).not.toBe(contentFingerprint("b"));
  });
});

describe("compareFingerprints", () => {
  it("detects no change when the fingerprint matches", () => {
    const normalized = "requirement text";
    const previous = contentFingerprint(normalized);
    const result = compareFingerprints(normalized, previous);
    expect(result.decision).toBe("unchanged");
  });

  it("detects change when the fingerprint differs", () => {
    const result = compareFingerprints("new text", contentFingerprint("old text"));
    expect(result.decision).toBe("changed");
  });

  it("treats a missing previous fingerprint as changed (first observation)", () => {
    expect(compareFingerprints("text", null).decision).toBe("changed");
  });
});

describe("outcomeFromFetch", () => {
  it("records an unchanged check without a change type", () => {
    const previous = contentFingerprint("stable");
    const outcome = outcomeFromFetch(okFetch("<p>stable</p>"), normalizeSourceContent("<p>stable</p>"), previous);
    expect(outcome.status).toBe("unchanged");
    expect(outcome.changeType).toBeNull();
    expect(shouldProcessChange(outcome)).toBe(false);
    expect(planFollowOnWork(outcome).kind).toBe("none");
  });

  it("records a change and plans processing", () => {
    const outcome = outcomeFromFetch(
      okFetch("<p>updated</p>"),
      normalizeSourceContent("<p>updated</p>"),
      contentFingerprint("old"),
    );
    expect(outcome.status).toBe("changed");
    expect(outcome.changeType).toBe("content_changed");
    expect(shouldProcessChange(outcome)).toBe(true);
    expect(planFollowOnWork(outcome).kind).toBe("detect_change");
  });

  it("never records a failed fetch as unchanged", () => {
    const outcome = outcomeFromFetch(failFetch({ httpStatus: 503 }), null, "abc");
    expect(outcome.status).toBe("failed");
    expect(outcome.contentHash).toBeNull();
    expect(outcome.retryable).toBe(true);
    expect(planFollowOnWork(outcome).kind).toBe("none");
  });

  it("records a permanent 404 as unavailable", () => {
    const outcome = outcomeFromFetch(
      failFetch({ httpStatus: 404, retryable: false, error: "HTTP 404" }),
      null,
      "abc",
    );
    expect(outcome.status).toBe("unavailable");
    expect(outcome.retryable).toBe(false);
  });
});

describe("classifyFetchFailure / classifyHttpStatus", () => {
  it("treats 5xx and network failures as retryable", () => {
    expect(classifyHttpStatus(500)).toBe(true);
    expect(classifyHttpStatus(429)).toBe(true);
    expect(classifyHttpStatus(null)).toBe(true);
  });

  it("treats 404/410/401/403 as permanent", () => {
    expect(classifyHttpStatus(404)).toBe(false);
    expect(classifyHttpStatus(410)).toBe(false);
    expect(classifyHttpStatus(403)).toBe(false);
  });

  it("derives the check status from the fetch result", () => {
    expect(classifyFetchFailure(failFetch({ httpStatus: 500 }))).toBe("failed");
    expect(classifyFetchFailure(failFetch({ httpStatus: 404, retryable: false }))).toBe("unavailable");
    expect(classifyFetchFailure(failFetch({ retryable: false, httpStatus: null }))).toBe("unavailable");
  });
});

describe("isSourceDue", () => {
  const now = 1_000_000;

  it("is due when never checked", () => {
    expect(isSourceDue({ sourceId: "s", name: "n", organization: "o", authorityTier: "t", sourceType: "t" }, now)).toBe(true);
  });

  it("is due when nextCheckAt has elapsed", () => {
    expect(
      isSourceDue(
        { sourceId: "s", name: "n", organization: "o", authorityTier: "t", sourceType: "t", nextCheckAt: now - 1 },
        now,
      ),
    ).toBe(true);
  });

  it("is due when freshness is stale/failed/changed", () => {
    for (const freshness of ["stale", "failed", "changed"]) {
      expect(
        isSourceDue(
          { sourceId: "s", name: "n", organization: "o", authorityTier: "t", sourceType: "t", nextCheckAt: now + 1, freshness },
          now,
        ),
      ).toBe(true);
    }
  });

  it("is not due when disabled", () => {
    expect(
      isSourceDue(
        { sourceId: "s", name: "n", organization: "o", authorityTier: "t", sourceType: "t", enabled: false, nextCheckAt: now - 1 },
        now,
      ),
    ).toBe(false);
  });
});

describe("isAllowedSourceUrl (SSRF guard)", () => {
  it("allows public https sources", () => {
    expect(isAllowedSourceUrl("https://www.osha.gov/laws-regs").ok).toBe(true);
  });

  it("refuses http", () => {
    expect(isAllowedSourceUrl("http://www.osha.gov").ok).toBe(false);
  });

  it("refuses private and loopback hosts", () => {
    expect(isAllowedSourceUrl("https://localhost/x").ok).toBe(false);
    expect(isAllowedSourceUrl("https://127.0.0.1/x").ok).toBe(false);
    expect(isAllowedSourceUrl("https://10.0.0.5/x").ok).toBe(false);
    expect(isAllowedSourceUrl("https://192.168.1.3/x").ok).toBe(false);
    expect(isAllowedSourceUrl("https://172.16.0.9/x").ok).toBe(false);
    expect(isAllowedSourceUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(isAllowedSourceUrl("https://service.internal/x").ok).toBe(false);
  });

  it("refuses embedded credentials and malformed urls", () => {
    expect(isAllowedSourceUrl("https://user:pass@example.com").ok).toBe(false);
    expect(isAllowedSourceUrl("not a url").ok).toBe(false);
  });
});

describe("createHttpSourceFetcher", () => {
  it("returns the body and latency on success", async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response("<p>ok</p>", { status: 200 })) as unknown as typeof fetch,
    });
    const res = await fetcher.fetch("https://example.gov/page");
    expect(res.ok).toBe(true);
    expect(res.body).toContain("ok");
    expect(res.httpStatus).toBe(200);
  });

  it("marks a 500 as retryable and does not return a body", async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response("err", { status: 503 })) as unknown as typeof fetch,
    });
    const res = await fetcher.fetch("https://example.gov/page");
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.body).toBeNull();
  });

  it("marks a 404 as permanent", async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    const res = await fetcher.fetch("https://example.gov/gone");
    expect(res.retryable).toBe(false);
  });

  it("classifies a network error as a retryable failure", async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const res = await fetcher.fetch("https://example.gov/page");
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toContain("fetch failed");
  });

  it("refuses a private host without making a request", async () => {
    let called = false;
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => {
        called = true;
        return new Response("x", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await fetcher.fetch("https://127.0.0.1/x");
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
  });
});
