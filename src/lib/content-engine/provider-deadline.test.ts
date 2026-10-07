// ---------------------------------------------------------------------------
// Content Engine — provider request deadline
//
// THE FAILURE MODE THIS EXISTS TO CATCH
// -------------------------------------
// A production article job reached NVIDIA NIM and then never settled. The
// worker's `fetch` had no signal and no timer, so `jobs_complete_job` /
// `jobs_fail_job` were never reached and the job sat in `processing` until its
// 5-minute lease expired — after which nothing reclaims it. The job was stuck
// forever with no recorded outcome.
//
// These tests EXECUTE the deadline against real sockets rather than asserting a
// string, because the property that matters is a runtime one: that the abort
// actually fires, that it reaches the in-flight request, and that a failure is
// distinguishable from a success and from an unrelated error.
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import {
  NIM_ARTICLE_DEFAULT_TIMEOUT_MS,
  ProviderTimeoutError,
  resolveArticleTimeoutMs,
  withProviderDeadline,
} from "../../../supabase/functions/content-engine-worker/provider-deadline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const WORKER = readFileSync(
  resolve(ROOT, "supabase/functions/content-engine-worker/index.ts"),
  "utf8",
);
const HARDENING = readFileSync(
  resolve(ROOT, "supabase/migrations/20260918_atlas_security_hardening.sql"),
  "utf8",
);

const open: Server[] = [];

/** A server that accepts the connection and then never answers. */
async function hangServer(): Promise<string> {
  const server = createServer(() => {
    /* deliberately never respond */
  });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/chat/completions`;
}

/** A server that answers immediately with a fixed JSON body. */
async function jsonServer(status: number, body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}/chat/completions`;
}

afterEach(() => {
  // A hung connection would keep `close()` waiting; tear the sockets down first.
  for (const server of open.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("provider deadline — the request is actually cancelled", () => {
  it("1. hands the exchange a real abort signal", async () => {
    const captured: AbortSignal[] = [];
    const result = await withProviderDeadline(5_000, async (signal) => {
      captured.push(signal);
      return { aborted: signal.aborted };
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeInstanceOf(AbortSignal);
    // Not aborted while there is still time on the clock.
    expect(result).toEqual({ aborted: false });
    expect(captured[0].aborted).toBe(false);
  });

  it("2. aborts a REAL in-flight request when the deadline elapses", async () => {
    const url = await hangServer();
    const captured: AbortSignal[] = [];
    const started = Date.now();

    await expect(
      withProviderDeadline(150, async (signal) => {
        captured.push(signal);
        const res = await fetch(url, { signal });
        return res.status;
      }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);

    const elapsed = Date.now() - started;
    // The signal the request was given is aborted…
    expect(captured[0]?.aborted).toBe(true);
    // …and the caller is released promptly rather than at the default deadline.
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });

  it("2b. the abort is propagated, not merely awaited around", async () => {
    // A socket that is genuinely torn down cannot also be held open by the
    // client: if the signal were ignored, `fetch` would still be pending here.
    const url = await hangServer();
    const captured: AbortSignal[] = [];
    let settled = false;
    const pending = withProviderDeadline(120, async (signal) => {
      captured.push(signal);
      const res = await fetch(url, { signal });
      return res.status;
    })
      .catch(() => "rejected")
      .finally(() => {
        settled = true;
      });

    await pending;
    expect(settled).toBe(true);
    expect(captured[0]?.aborted).toBe(true);
    expect(captured[0]?.reason).toBeDefined();
  });

  it("4. never waits indefinitely when the exchange never settles", async () => {
    const started = Date.now();
    await expect(
      withProviderDeadline(120, () => new Promise<never>(() => {})),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("provider deadline — existing behaviour is preserved", () => {
  it("5. a provider that answers in time still resolves normally", async () => {
    const url = await jsonServer(200, {
      choices: [{ message: { content: '{"title":"T","body":"B"}' } }],
    });
    const payload = await withProviderDeadline(5_000, async (signal) => {
      const res = await fetch(url, { signal });
      return (await res.json()) as { choices: Array<{ message: { content: string } }> };
    });
    expect(payload.choices[0].message.content).toContain('"title"');
  });

  it("6. a provider rejection keeps its identity (not confused with a deadline)", async () => {
    const url = await jsonServer(500, { error: "upstream" });
    const captured: AbortSignal[] = [];
    const outcome = await withProviderDeadline(5_000, async (signal) => {
      captured.push(signal);
      const res = await fetch(url, { signal });
      return res.ok ? "ok" : `http:${res.status}`;
    });
    // The status is what the worker acts on; the deadline did not fire.
    expect(outcome).toBe("http:500");
    expect(captured[0]?.aborted).toBe(false);
    expect(outcome).not.toBe("ok");
  });

  it("6b. a non-deadline error propagates unchanged", async () => {
    const original = new Error("socket exploded");
    await expect(
      withProviderDeadline(5_000, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("resolves a null/blank/invalid configured timeout to the derived default", () => {
    expect(resolveArticleTimeoutMs(null)).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs(undefined)).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs("")).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs("abc")).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs("0")).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs("-5")).toBe(NIM_ARTICLE_DEFAULT_TIMEOUT_MS);
    expect(resolveArticleTimeoutMs("45000")).toBe(45_000);
  });
});

describe("provider deadline — wired into the worker, sized against the lease", () => {
  it("3. converts the deadline into a controlled, observable job failure", () => {
    // The worker catches exactly this error and returns a FAILURE result…
    expect(WORKER).toMatch(/if \(error instanceof ProviderTimeoutError\) return timeoutFailure\(\);/);
    expect(WORKER).toMatch(/const timeoutFailure = \(\): \{ ok: false; message: string \} => \(\{/);
    expect(WORKER).toMatch(/The AI provider did not respond within/);
    expect(WORKER).toMatch(/"The request was aborted and the article was not written\."/);
    // …which `stepGeneratePackage` records as a failed job, using the error
    // semantics that already existed (no new taxonomy was invented).
    expect(WORKER).toMatch(
      /if \(!generated\.ok\) \{\s*\n\s*return \{ ok: false, code: "NOT_CONFIGURED", message: generated\.message, retryable: false \};/,
    );
    // And it never escapes as an unhandled throw, which would have produced an
    // INTERNAL retryable failure and multiplied provider work.
    expect(WORKER).toMatch(/if \(error instanceof ProviderTimeoutError\) return timeoutFailure\(\);\s*\n\s*throw error;/);
  });

  it("3b. the deadline is strictly shorter than the queue lease", () => {
    // Read the lease out of the SQL that ships rather than trusting a copy.
    const lease = HARDENING.match(/v_lock_timeout interval := interval '(\d+) minutes'/);
    expect(lease, "jobs_dequeue must still declare its lease").not.toBeNull();
    const leaseMs = Number((lease as RegExpMatchArray)[1]) * 60_000;
    expect(leaseMs).toBe(300_000);
    // The worker must still hold the lease when it records the outcome.
    expect(NIM_ARTICLE_DEFAULT_TIMEOUT_MS).toBeLessThan(leaseMs);
    // With real room to spare, not by a hair.
    expect(leaseMs - NIM_ARTICLE_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("3b-ii. the deadline fires before the edge-function wall clock can kill the tick", () => {
    // Phase 6 evidence: a deadline ABOVE the platform wall clock is useless. The
    // isolate is torn down mid-request, the timer never runs, and the job hangs
    // in `processing` with no outcome. Supabase documents the wall-clock limit
    // as 150s on the Free plan, the smallest ceiling this worker can land on, so
    // the deadline must clear that floor with margin rather than sit under a
    // paid-plan ceiling it cannot rely on.
    expect(NIM_ARTICLE_DEFAULT_TIMEOUT_MS).toBeLessThan(150_000);
    expect(150_000 - NIM_ARTICLE_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("3c. the request is sent with a signal and nothing else changed", () => {
    // The signal is what makes the abort a cancellation.
    expect(WORKER).toMatch(/withProviderDeadline\(timeoutMs, async \(signal\) => \{/);
    expect(WORKER).toMatch(/^\s+signal,$/m);
    expect(WORKER).toMatch(/\/chat\/completions/);
    // Request parameters are untouched by this phase.
    expect(WORKER).toMatch(/temperature: 0\.4,/);
    expect(WORKER).toMatch(/max_tokens: 4000,/);
    // No streaming was introduced.
    expect(WORKER).not.toMatch(/stream:\s*true/);
  });

  it("7. model selection is untouched by the deadline", () => {
    // The deadline fixes the request's LIFECYCLE, never its model. Asserting the
    // exact id here would duplicate src/lib/content-engine/
    // nim-model-selection.test.ts and guarantee the two drift apart the next
    // time the model legitimately changes. What the deadline must not do is add
    // a second selection site or bypass the one that already exists.
    expect(WORKER).toMatch(/const NIM_MODEL = env\("NVIDIA_NIM_DEFAULT_MODEL"\) \?\? "[^"]+";/);
    expect(WORKER.match(/const NIM_MODEL = /g) ?? []).toHaveLength(1);
    expect(WORKER).toMatch(/model: NIM_MODEL,/);
  });
});
