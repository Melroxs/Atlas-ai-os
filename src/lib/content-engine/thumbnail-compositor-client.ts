// ---------------------------------------------------------------------------
// Atlas Content Engine — authenticated transport for the compositor adapter
//
// HOW THE DEPLOYED FUNCTION IS INVOKED, SECURELY
//   `content-thumbnail-compose` is deployed with `verify_jwt = true` and calls
//   `requireAtlasCaller`, so it accepts a **caller's Supabase session JWT** —
//   exactly like the already-shipped `content-media-upload` function. This
//   transport reuses that SAME mechanism: it takes the current session's access
//   token and calls the function over the project URL.
//
//   What this deliberately does NOT do:
//     * no credential is hardcoded, and nothing is read from a secret store;
//     * the service-role key is never used (it is not a user JWT, so it could
//       not authorize `requireAtlasCaller` anyway);
//     * JWT verification is not disabled, and no second auth system is created.
//
// WHY A RAW FETCH RATHER THAN `functions.invoke`
//   The success payload is a PNG, not JSON. A raw fetch is the only way to read
//   the exact bytes AND the `X-Compositor-Version` header the adapter must
//   verify, so a binary response can never be mis-parsed into a false success.
// ---------------------------------------------------------------------------

import {
  getSupabaseSession,
  resolvedSupabaseAnonKey,
  resolvedSupabaseUrl,
} from "@/lib/supabase";
import {
  COMPOSITOR_FUNCTION,
  ThumbnailCompositorError,
  type CompositorRequest,
  type CompositorTransport,
  type CompositorTransportResponse,
} from "./thumbnail-compositor";

/** A bounds on the whole exchange, so a silent function cannot hang a caller. */
export const COMPOSITOR_TIMEOUT_MS = 30_000;

export interface CompositorTransportOptions {
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number;
  /**
   * An already-resolved access token. When omitted the current Supabase session
   * is used. Tests pass one so no session is required.
   */
  accessToken?: string;
  /** Defaults to the resolved Supabase project URL. */
  baseUrl?: string;
  /** Defaults to the resolved public anon key. */
  anonKey?: string;
}

/**
 * Build the authenticated transport.
 *
 * The token is resolved per call so a refreshed session is always used, and it
 * is only ever sent in the Authorization header — never logged, returned or
 * persisted.
 */
export function createCompositorTransport(
  options: CompositorTransportOptions = {},
): CompositorTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? COMPOSITOR_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? resolvedSupabaseUrl).replace(/\/+$/, "");
  const anonKey = options.anonKey ?? resolvedSupabaseAnonKey;

  return async (request: CompositorRequest): Promise<CompositorTransportResponse> => {
    const accessToken =
      options.accessToken ?? (await getSupabaseSession())?.access_token ?? null;
    if (!accessToken) {
      throw new ThumbnailCompositorError(
        "UNAUTHENTICATED",
        "No Atlas session is available to invoke the thumbnail compositor.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/functions/v1/${COMPOSITOR_FUNCTION}`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ThumbnailCompositorError(
          "TIMEOUT",
          `The thumbnail compositor did not respond within ${timeoutMs} ms.`,
          { retryable: true, cause: error },
        );
      }
      throw new ThumbnailCompositorError(
        "NETWORK_ERROR",
        "The thumbnail compositor could not be reached.",
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      compositorVersion: response.headers.get("x-compositor-version"),
      bytes,
    };
  };
}
