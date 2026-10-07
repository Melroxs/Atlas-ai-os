// ---------------------------------------------------------------------------
// Atlas Content Engine — provider request deadline
//
// WHY THIS EXISTS
// ---------------
// Every provider call in this worker was previously unbounded: `fetch` with no
// signal and no timer anywhere in the file. A completion that never settles
// therefore held the whole tick invocation open, the worker's own
// complete/fail calls were never reached, and the production job sat in
// `processing` until its 5-minute lease expired — after which NOTHING reclaims
// it, because the queue claims only `pending`/`queued` rows. The result was a
// job stuck forever with no recorded outcome: the failure Atlas could not see.
//
// A deadline is what turns that into an ordinary, observable job failure. The
// abort is also a real cancellation: passing the signal to `fetch` tears the
// socket down, so the provider stops working on a request Atlas has abandoned
// instead of Atlas merely walking away from it.
//
// The same mechanism now bounds EVERY provider call in this worker, not just
// the article: `withProviderDeadline` is provider-agnostic and is shared by the
// thumbnail render, with its own size because the work that FOLLOWS a render is
// different from the work that follows a text completion.
//
// This is deliberately a pure module with no `Deno` dependency and an injected
// `call`, so the suite in src/lib/content-engine can EXECUTE the deadline
// against a real socket and prove the abort fires, rather than asserting a
// string. It follows the same shape as the other worker-local pure modules
// (clip-plan.ts, pixverse.ts, token-lifecycle.ts), which the tests import
// directly.
// ---------------------------------------------------------------------------

/**
 * How long ONE article completion may run before Atlas gives up on it.
 *
 * Derived from the three hard constraints around it, not picked by feel:
 *
 *   * it must fire BEFORE the edge-function WALL-CLOCK LIMIT, which Supabase
 *     fixes at 150s on the Free plan (400s on paid). Phase 6 production
 *     evidence proved why: a request that outlived the platform ceiling never
 *     reached this module's timer at all — the isolate was terminated with the
 *     request in flight, so neither the deadline nor the worker's complete/fail
 *     calls ran, and the job hung in `processing` with no recorded outcome. A
 *     deadline only helps if the platform is still listening when it fires, so
 *     it has to sit under the 150s floor with real margin;
 *   * it must be strictly SHORTER than the queue lease, which the dequeue RPC
 *     fixes at `interval '5 minutes'` (300s), so the worker is still holding
 *     the lease while it records complete/fail instead of losing the lease with
 *     the request still open;
 *   * it must clear every LEGITIMATE generation, or a slow-but-working provider
 *     would be aborted and the article silently lost. The request asks for
 *     `max_tokens: 4000`; a served flash model returns that well inside a
 *     minute, and Phase 6 measured the observed behaviour as a HANG (no bytes
 *     for 9m30s), not lethargic-but-progressing generation.
 *
 * 90s satisfies all three: it leaves 60s of the smallest possible wall clock
 * for the worker's follow-up writes, and 210s of the 300s lease.
 * Overridable per environment without a redeploy, the same way
 * ELEVENLABS_TIMEOUT_MS is (see _shared/elevenlabs.ts).
 */
export const NIM_ARTICLE_DEFAULT_TIMEOUT_MS = 90_000;

/** Resolve the configured deadline; anything invalid falls back to the default. */
export function resolveArticleTimeoutMs(raw: string | null | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : NIM_ARTICLE_DEFAULT_TIMEOUT_MS;
}

/**
 * How long ONE image generation may run before Atlas gives up on it.
 *
 * Deliberately NOT the article's 180s/90s figure: image rendering is a
 * different operation with a different cost profile, and the number that matters
 * is not "how long might a render take" but "how much of the invocation is left
 * for everything that happens AFTER the image arrives".
 *
 * A thumbnail has to be decoded, sniffed for its real MIME type, uploaded to the
 * `blog-media` bucket, upserted as an asset and written into the canonical
 * presentation reference. A deadline that consumed nearly the whole wall clock
 * would leave none of that room and would turn a slow render into a job that is
 * killed mid-persistence — the same class of failure as an over-long article
 * deadline, one step further from the provider.
 *
 * 75s is therefore derived, not chosen: it clears a normal render with a wide
 * margin, keeps 75s of the 150s Free-plan wall-clock floor for the decode +
 * upload + writes that follow, and still leaves 225s of the 300s queue lease.
 */
export const IMAGE_DEFAULT_TIMEOUT_MS = 75_000;

/** Resolve the configured image deadline; anything invalid falls back to the default. */
export function resolveImageTimeoutMs(raw: string | null | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : IMAGE_DEFAULT_TIMEOUT_MS;
}

/** Thrown once the deadline elapses and the request has been aborted. */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The provider did not respond within ${timeoutMs}ms; the request was aborted.`);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run one provider exchange under a hard deadline, handing it the abort signal
 * to pass to `fetch`.
 *
 * `call` is wrapped rather than only the `fetch` because reading the response
 * body belongs to the same deadline: headers that arrive and a body that never
 * completes is the same hang from the worker's point of view.
 *
 * TWO mechanisms, because one is not enough:
 *
 *   1. the signal is ABORTED, which is what actually cancels the in-flight
 *      request (the socket is torn down, the provider stops generating) and
 *      is the only thing that satisfies the requirement that Atlas must not
 *      "stop awaiting" while the provider keeps working;
 *   2. the exchange is RACED against the clock, so the caller is released even
 *      if the exchange ignores the signal — an await that never settles is the
 *      exact hang this module exists to remove, and it must not be able to
 *      outlive the deadline by failing to cooperate.
 *
 * Any failure that lost to the clock is reported as a deadline, however it
 * surfaced; every other failure keeps its own identity so existing callers'
 * handling is unchanged.
 */
export async function withProviderDeadline<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Abort first: cancellation is the point, the rejection only reports it.
      controller.abort();
      reject(new ProviderTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    // `Promise.race` subscribes to both sides, so a late rejection from the
    // exchange is handled rather than surfacing as an unhandled rejection.
    return await Promise.race([call(controller.signal), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
