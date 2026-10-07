// ---------------------------------------------------------------------------
// Atlas Content Engine — provider error diagnostics (Studio-facing copy)
//
// This is the SAME pure logic as
// supabase/functions/content-engine-worker/provider-error.ts, duplicated for one
// unavoidable reason: a Supabase Edge Function is bundled from its own directory
// and cannot import application code from `src/`, so the deployed worker and the
// Studio-facing provider cannot share one module.
//
// Because two copies of a security control is a real risk, they are not left to
// convention: src/lib/content-engine/provider-error.test.ts executes BOTH
// implementations over the same fixtures and asserts identical output, including
// every redaction. Change one and the test fails until the other matches.
//
// The safety argument is unchanged: structure first (only error.message/code/
// type/param are read), then redaction of bearer tokens and provider key shapes,
// then hard bounds. It never throws.
// ---------------------------------------------------------------------------

/** Hard cap on the stored provider detail. Phase brief: 1,000 characters. */
export const MAX_PROVIDER_DIAGNOSTIC_CHARS = 1_000;
/** Hard cap on each individual structured field, so one huge field cannot dominate. */
export const MAX_PROVIDER_FIELD_CHARS = 200;

export interface ProviderDiagnostic {
  provider: string;
  provider_status: number;
  provider_code: string | null;
  provider_type: string | null;
  provider_param: string | null;
  detail: string;
}

function scrub(input: string): string {
  let out = input;
  // Order matters: the most specific shapes are removed before the generic
  // `key=value` rule, so a real token is reported as one redaction rather than
  // being partially rewritten and left readable.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer [redacted]");
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9._\-]{8,}/g, "[redacted]");
  out = out.replace(/\bnvapi-[A-Za-z0-9._\-]{8,}/g, "[redacted]");
  out = out.replace(/\bAIza[A-Za-z0-9_\-]{10,}/g, "[redacted]");
  out = out.replace(/\bAKIA[0-9A-Z]{12,}/g, "[redacted]");
  // JWT-shaped triples.
  out = out.replace(/\bey[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,}/g, "[redacted]");
  // `…API_KEY=value`, `api_key: "value"`, `token=…`, `password=…` and friends.
  // No leading \b: `OPENAI_API_KEY` has no word boundary before `API_KEY`.
  out = out.replace(
    /([A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|token|password|authorization))\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
    "$1=[redacted]",
  );
  return out;
}

function bound(input: string, max: number): string {
  const text = scrub(input).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? bound(trimmed, MAX_PROVIDER_FIELD_CHARS) : null;
}

/**
 * Turn a rejected provider response into a safe, bounded, redacted fact.
 *
 * `body` is the raw response text. It is treated as hostile: it may be JSON, it
 * may be an HTML error page from a proxy, and it may quote a credential back.
 */
export function describeProviderError(input: {
  provider: string;
  status: number;
  body: string;
}): ProviderDiagnostic {
  const base: ProviderDiagnostic = {
    provider: input.provider,
    provider_status: input.status,
    provider_code: null,
    provider_type: null,
    provider_param: null,
    detail: "",
  };
  try {
    const raw = typeof input.body === "string" ? input.body : "";
    let code: string | null = null;
    let type: string | null = null;
    let param: string | null = null;
    let detail: string | null = null;
    let message: string | null = null;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const errorNode =
        parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : null;
      if (errorNode) {
        message = asString(errorNode.message);
        code = asString(errorNode.code);
        type = asString(errorNode.type);
        param = asString(errorNode.param);
      } else {
        detail = asString(parsed?.message);
      }
    } catch {
      // Not JSON (an HTML error page, a proxy body, a truncated response).
      detail = bound(raw, MAX_PROVIDER_DIAGNOSTIC_CHARS);
    }

    const resolved = detail ?? message;
    return {
      ...base,
      provider_code: code,
      provider_type: type,
      provider_param: param,
      detail: resolved ? bound(resolved, MAX_PROVIDER_DIAGNOSTIC_CHARS) : "",
    };
  } catch {
    // Diagnostics must never be the reason a job fails differently.
    return { ...base, detail: "" };
  }
}

/**
 * The single human-readable line stored on the job.
 *
 * Atlas's existing job-error convention is `{ code, message }` (see
 * the worker's own fail call and `execute()`), and that convention is kept: the
 * structured fields are folded into the message so no lifecycle change is
 * needed to make the rejection observable.
 */
export function formatProviderError(diagnostic: ProviderDiagnostic): string {
  const { provider, provider_status, provider_code, provider_type, provider_param, detail } =
    diagnostic;
  const tags = [
    provider_type ? `type=${provider_type}` : null,
    provider_code ? `code=${provider_code}` : null,
    provider_param ? `param=${provider_param}` : null,
  ].filter(Boolean);
  const head = `${provider} rejected the request (HTTP ${provider_status})`;
  const suffix = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  const body = detail ? `: ${detail}` : ".";
  return `${head}${suffix}${body}`;
}
