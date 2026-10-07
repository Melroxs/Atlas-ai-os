// ---------------------------------------------------------------------------
// Atlas Content Engine — worker tick
//
//   POST { action: "tick", limit?: number }   → run due content jobs
//   POST { action: "automation" }             → enqueue automated packages
//
// This function is the ONLY place the Content Engine's external calls happen,
// because it is the only place that may hold a provider credential:
//
//   * it runs with the service role (cron / scheduled invocation) or for a
//     platform admin, never for a customer session;
//   * the OAuth tokens in public.connectiontokens are SEALED and are unsealed
//     here, in memory, per request — they are never returned to a browser;
//   * a provider that is not configured fails CLOSED with an actionable message
//     and the job is failed, so nothing is ever reported as published when it
//     was not. There is no simulated success path.
//
// Orchestration lives in the database + the Atlas Content Engine's RPCs
// (supabase/migrations/20260935_atlas_content_engine.sql). This file executes
// the steps that genuinely require a server: AI writing, media rendering, and
// publishing to YouTube / LinkedIn.
// ---------------------------------------------------------------------------

import {
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
  requireAtlasCaller,
} from "../_shared/edge-auth.ts";
import { openCredential, sealCredential } from "../_shared/integration/primitives.ts";
import { credentialKey, log, rpc, select } from "../_shared/integration/service.ts";
import {
  DEFAULT_TARGET_VIDEO_SECONDS,
  isPlanComplete,
  markFailed,
  markReady,
  markSubmitted,
  nextRenderAction,
  planClips,
  planFromMetadata,
  planToMetadata,
  type ClipPlan,
} from "./clip-plan.ts";
import {
  PIXVERSE_API_KEY_HEADER,
  PIXVERSE_BASE_URL,
  PIXVERSE_CLIP_DURATION,
  PIXVERSE_DEFAULT_MODEL,
  PIXVERSE_TRACE_HEADER,
  buildRenderRequest,
  newTraceId,
  readRenderResult,
  readVideoId,
  renderUrl,
  resultUrl,
} from "./pixverse.ts";
import {
  GOOGLE_TOKEN_URL,
  buildGoogleRefreshBody,
  classifyAuthFailure,
  decideTokenAction,
  readGoogleTokenResponse,
  reconnectMessage,
  supportsRefresh,
} from "./token-lifecycle.ts";
import {
  ProviderTimeoutError,
  resolveArticleTimeoutMs,
  resolveImageTimeoutMs,
  withProviderDeadline,
} from "./provider-deadline.ts";
import {
  generateThumbnail,
  readThumbnailRenderer,
  THUMBNAIL_CONTENT_TYPE,
  type ThumbnailRenderer,
} from "./thumbnail.ts";
import {
  resolveThumbnailInputs,
  type ThumbnailInputAsset,
} from "./thumbnail-input.ts";

const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const ATLAS_BLOG_ORIGIN = (Deno.env.get("ATLAS_APP_URL") ?? Deno.env.get("SITE_URL") ??
  "https://atlas-ai-os.com").replace(/\/+$/, "");

const CONTENT_JOB_TYPES = [
  "content_generate_package",
  "content_generate_video",
  "content_poll_video",
  "content_generate_thumbnail",
  "content_automation_tick",
  "content_write_linkedin",
  "content_publish_blog",
  "content_publish_youtube",
  "content_publish_linkedin",
];

type Json = Record<string, unknown>;

interface JobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  payload: Json;
  attempt_count: number;
  max_attempts: number;
}

interface AssetsRow {
  _id: string;
  contentType: string;
  assetType: string | null;
  status: string;
  title: string;
  body: string | null;
  externalUrl: string | null;
  storagePath: string | null;
  externalId: string | null;
  provider: string | null;
  metadata: Json | null;
}

interface PackagePayload {
  package: Json;
  assets: AssetsRow[];
  publications: Json[];
}

type StepOutcome =
  | { ok: true; result: Json }
  | { ok: false; code: string; message: string; retryable: boolean };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assetOf(view: PackagePayload | null, contentType: string): AssetsRow | null {
  if (!view) return null;
  return view.assets.find((a) => a.contentType === contentType) ?? null;
}

function blogUrlForSlug(slug: string | null): string | null {
  return slug ? `${ATLAS_BLOG_ORIGIN}/blog/${slug}` : null;
}

function env(key: string): string | null {
  return Deno.env.get(key) ?? null;
}

/**
 * Write bytes into Atlas's own storage. Used for generated media so a
 * short-lived provider URL is never stored as the authoritative asset: the
 * bytes become an Atlas object that still resolves in a year, and the asset row
 * points at THAT. The service key is only ever a request header.
 */
async function uploadToStorage(input: {
  bucket: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error("Atlas storage is not configured in this deployment.");
  }
  const objectPath = input.path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(input.bucket)}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        authorization: `Bearer ${SERVICE_ROLE}`,
        "content-type": input.contentType,
      },
      // A Blob is the portable binary body across Deno and the DOM lib; a bare
      // Uint8Array is not an accepted BodyInit in every target. `slice()` copies
      // into a buffer owned solely by this Blob, so the ArrayBuffer cast is safe
      // and the request cannot alias a pooled/shared buffer.
      body: new Blob([input.bytes.slice().buffer as ArrayBuffer], { type: input.contentType }),
    },
  );
  if (!response.ok) {
    throw new Error(`Atlas storage rejected the upload (HTTP ${response.status}).`);
  }
}

/** The durable, publicly readable URL for a stored object. */
function publicStorageUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${path}`;
}

async function loadPackage(packageId: string): Promise<PackagePayload | null> {
  const raw = await rpc<PackagePayload | null>("content_package_get", { p_package: packageId });
  if (!raw || !raw.package) return null;
  return { package: raw.package, assets: raw.assets ?? [], publications: raw.publications ?? [] };
}

async function upsertAsset(input: {
  packageId: string;
  contentType: string;
  assetType: string;
  title: string;
  body?: string | null;
  externalUrl?: string | null;
  externalId?: string | null;
  mimeType?: string | null;
  metadata?: Json;
  provider?: string | null;
  status?: string;
}): Promise<string> {
  const row = await rpc<Json>("content_asset_upsert", {
    p_package: input.packageId,
    p_content_type: input.contentType,
    p_asset_type: input.assetType,
    p_title: input.title,
    p_body: input.body ?? null,
    p_storage_path: null,
    p_external_url: input.externalUrl ?? null,
    p_external_id: input.externalId ?? null,
    p_mime_type: input.mimeType ?? null,
    p_metadata: input.metadata ?? {},
    p_provider: input.provider ?? null,
    p_status: input.status ?? "drafted",
  });
  return String(row?._id ?? "");
}

async function enqueue(input: {
  packageId: string;
  tenantId: string;
  jobType: string;
  payload: Json;
  idempotencyKey: string;
}): Promise<void> {
  await rpc("content_engine_enqueue", {
    p_package: input.packageId,
    p_job_type: input.jobType,
    p_payload: { ...input.payload, tenant_id: input.tenantId },
    p_idempotency_key: input.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Article generation (AI) — the only creative step, and it refuses to invent
// ---------------------------------------------------------------------------

const NIM_BASE = env("NVIDIA_NIM_BASE_URL") ?? "https://integrate.api.nvidia.com/v1";
// The fallback must stay a model that NVIDIA still SERVES at this endpoint.
//
// `deepseek-ai/deepseek-v4-pro` (and `-v4-pro-0813`) were retired and answer
// HTTP 410 Gone. `deepseek-ai/deepseek-v4.1-flash` is still LISTED by
// `GET /v1/models` but is not being SERVED: the gateway accepts the request and
// then returns no headers, no status and no body, in the Edge Function's 90s
// deadline and in local diagnostics out to 120s. That is proven to be specific
// to that model id, not to Atlas: the same endpoint, key and runtime answer a
// different model id in well under a second, and NVIDIA's own Playground fails
// the same way. So the fallback moves to a model that demonstrably answers.
//
// `NVIDIA_NIM_DEFAULT_MODEL` remains the single override and still wins when it
// is set. This is the ONE model-selection site for the Content Engine's article
// request; nothing else in the worker's request (endpoint, authorization,
// temperature, max_tokens, messages, streaming, deadline, abort) changes with it.
const NIM_MODEL = env("NVIDIA_NIM_DEFAULT_MODEL") ?? "nvidia/nemotron-3-super-120b-a12b";

// The article-completion deadline (and its derivation) lives in
// ./provider-deadline.ts, so the abort path can be executed by the test suite
// rather than only read.

const ARTICLE_SYSTEM_PROMPT = [
  "You are Atlas's content writer for a US insurance restoration and roofing software company.",
  "The audience is restoration contractors and roofing business owners: professional, practical, B2B.",
  "",
  "HARD RULES — violating these makes the article unusable:",
  "- Never invent statistics, percentages, dollar figures, study results, or survey data.",
  "- Never invent laws, regulations, codes, statutes, deadlines, or insurance requirements.",
  "- Never invent carrier policies, adjuster practices, manufacturer requirements, or pricing.",
  "- Never invent customer results, testimonials, case studies, awards, or client names.",
  "- Never create citations, footnotes, or source lists.",
  "- If a claim would need evidence you do not have, write about process, workflow and practice instead.",
  "- Do not promise or imply any legal, engineering, medical, or insurance determination.",
  "",
  "Write educational, specific, useful prose about how restoration businesses operate.",
  "Respond with JSON only, no code fence, in this exact shape:",
  '{"title": string, "summary": string, "body": string}',
  "body is markdown with ## section headings.",
].join("\n");

interface GeneratedArticle {
  title: string;
  summary: string;
  body: string;
}

/** Ask the configured AI provider for the article. Fails closed when absent. */
async function generateArticle(input: {
  topic: string;
  instructions: string;
  audience: string | null;
  tone: string | null;
  brandVoice: string | null;
  cta: string | null;
}): Promise<{ ok: true; article: GeneratedArticle } | { ok: false; message: string }> {
  const key = env("NVIDIA_NIM_API_KEY");
  if (!key) {
    return {
      ok: false,
      message:
        "No AI provider is configured for article generation. Set NVIDIA_NIM_API_KEY to enable it. Nothing was generated.",
    };
  }

  const brandLines = [
    input.audience ? `Audience: ${input.audience}` : null,
    input.tone ? `Tone: ${input.tone}` : null,
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : null,
    input.cta ? `Closing call to action (mention once, naturally): ${input.cta}` : null,
  ].filter(Boolean) as string[];

  const timeoutMs = resolveArticleTimeoutMs(env("NIM_ARTICLE_TIMEOUT_MS"));
  const timeoutFailure = (): { ok: false; message: string } => ({
    ok: false,
    message:
      `The AI provider did not respond within ${Math.round(timeoutMs / 1000)} seconds. ` +
      "The request was aborted and the article was not written.",
  });

  type ChatOutcome = { kind: "json"; payload: Json } | { kind: "http"; status: number };
  let outcome: ChatOutcome;
  try {
    // The whole exchange — headers AND body — is inside the deadline, and the
    // abort tears the socket down, so the provider stops generating instead of
    // Atlas merely walking away from a request it already gave up on.
    outcome = await withProviderDeadline(timeoutMs, async (signal) => {
      const res = await fetch(`${NIM_BASE.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: NIM_MODEL,
          temperature: 0.4,
          max_tokens: 4000,
          messages: [
            { role: "system", content: ARTICLE_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                `Topic: ${input.topic}`,
                ...brandLines,
                "",
                "Guidance for this article:",
                input.instructions,
              ].join("\n"),
            },
          ],
        }),
        signal,
      });
      // The rejection status is carried out as a value, not an exception, so
      // the existing "rejected the request (HTTP n)" outcome is unchanged.
      if (!res.ok) return { kind: "http", status: res.status } as const;
      return { kind: "json", payload: (await res.json()) as Json } as const;
    });
  } catch (error) {
    // A missed deadline is an ordinary, observable job outcome. Letting it
    // escape would be recorded as an INTERNAL, RETRYABLE failure, and every
    // retry would be another full timeout of provider work.
    if (error instanceof ProviderTimeoutError) return timeoutFailure();
    throw error;
  }

  if (outcome.kind === "http") {
    return {
      ok: false,
      message: `The AI provider rejected the request (HTTP ${outcome.status}). The article was not written.`,
    };
  }
  const payload = outcome.payload;
  const choices = Array.isArray(payload.choices) ? (payload.choices as Json[]) : [];
  const message = (choices[0]?.message ?? {}) as Json;
  const raw = typeof message.content === "string" ? message.content : "";
  const cleaned = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, message: "The AI provider returned no usable article." };
  }

  let parsed: Json;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Json;
  } catch {
    return { ok: false, message: "The AI provider returned malformed JSON; nothing was saved." };
  }

  const title = str(parsed.title);
  const body = str(parsed.body);
  if (!title || !body) {
    return { ok: false, message: "The AI provider returned an incomplete article." };
  }
  return {
    ok: true,
    article: { title, summary: str(parsed.summary) ?? title, body },
  };
}

// ---------------------------------------------------------------------------
// Deterministic copy derived from the ARTICLE (never from the topic alone)
// ---------------------------------------------------------------------------

export function buildVideoScript(article: { title: string; body: string; cta?: string | null }): string {
  const sections = article.body
    .split(/\n(?=##\s)/)
    .map((chunk) => chunk.replace(/^##\s*/, "").trim())
    .filter((chunk) => chunk.length > 0);
  const intro = sections.shift() ?? "";
  const points = sections.slice(0, 5).map((section) => {
    const [heading, ...rest] = section.split("\n");
    const firstSentence = rest.join(" ").replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0] ?? "";
    return `${heading}\n${firstSentence.trim()}`.trim();
  });
  return [
    `HOOK: ${article.title}`,
    "",
    "INTRODUCTION",
    intro.slice(0, 600),
    "",
    "MAIN POINTS",
    ...points.map((point, i) => `${i + 1}. ${point}`),
    "",
    "CONCLUSION",
    "Tie the points back to the workflow a restoration business actually runs.",
    article.cta ? `CTA: ${article.cta}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildLinkedInPost(input: {
  title: string;
  summary: string;
  body: string;
  blogUrl: string | null;
  youtubeUrl: string | null;
  cta: string | null;
}): string {
  const first = input.body
    .split(/\n(?=##\s)/)
    .slice(1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const insight = first
    .split(/(?<=[.!?])\s/)
    .slice(0, 2)
    .join(" ")
    .slice(0, 400);
  const closing = input.cta
    ? input.cta
    : "If your team runs into this, the workflow matters more than the tooling.";
  return [
    input.title,
    "",
    input.summary,
    "",
    insight,
    "",
    closing,
    "",
    input.blogUrl ? `Read the full article → ${input.blogUrl}` : "",
    input.youtubeUrl ? `Watch the video → ${input.youtubeUrl}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

async function resolveBrand(tenantId: string): Promise<{
  audience: string | null;
  tone: string | null;
  brandVoice: string | null;
  cta: string | null;
}> {
  try {
    const rows = await select<Json>(
      "atlasContentAutomation",
      `select=audience,%22defaultTone%22,%22brandVoice%22,%22primaryCta%22&%22organizationId%22=eq.${tenantId}&limit=1`,
    );
    const row = rows[0] ?? {};
    return {
      audience: str(row.audience),
      tone: str(row.defaultTone),
      brandVoice: str(row.brandVoice),
      cta: str(row.primaryCta),
    };
  } catch {
    // Settings are optional; generation continues with Atlas defaults rather
    // than failing because a settings row is missing.
    return { audience: null, tone: null, brandVoice: null, cta: null };
  }
}

// ---------------------------------------------------------------------------
// Connections — sealed tokens, unsealed in memory only
// ---------------------------------------------------------------------------

interface ConnectionTokenRow {
  connectionId: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  tokenExpiresAt: number | null;
  accountEmail: string | null;
  accountName: string | null;
}

type TokenOutcome =
  | { ok: true; token: string; connectionId: string }
  | { ok: false; code: "NOT_CONFIGURED" | "AUTHORIZATION_REVOKED"; message: string };

/**
 * Exchange the SEALED refresh token for a new access token and write it back
 * through the sanctioned server path (`connections_register`), which is the only
 * writer of public.connectiontokens. The plaintext token exists in this
 * function's memory for the duration of the call and is never logged, returned
 * to a browser, or written anywhere else.
 *
 * A refresh that fails is NOT retried and NOT papered over: the caller reports
 * AUTHORIZATION_REVOKED and the user is asked to reconnect.
 */
async function refreshAccessToken(input: {
  connectionId: string;
  organizationId: string;
  provider: string;
  refreshTokenEnc: string;
  accountEmail: string | null;
  accountName: string | null;
  key: string;
}): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const clientId = env(`${input.provider.toUpperCase()}_CLIENT_ID`);
  const clientSecret = env(`${input.provider.toUpperCase()}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      message:
        `${input.provider} token refresh is not configured on this deployment ` +
        `(${input.provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET are missing). ` +
        "Reconnect the account once the client credentials are set.",
    };
  }
  const refreshToken = await openCredential(input.refreshTokenEnc, input.key);
  if (!refreshToken) {
    return { ok: false, message: `${input.provider} refresh credential could not be opened.` };
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: buildGoogleRefreshBody({ refreshToken, clientId, clientSecret }),
  });
  if (!response.ok) {
    // The body is never surfaced: it can echo client credentials back.
    log("oauth.refresh_failed", { provider: input.provider, status: response.status });
    return { ok: false, message: reconnectMessage(input.provider) };
  }
  const refreshed = readGoogleTokenResponse(await response.json().catch(() => null), Date.now());
  if (!refreshed) {
    return { ok: false, message: reconnectMessage(input.provider) };
  }

  // Re-seal and persist. The new refresh token is used only when Google rotated
  // it; otherwise the sealed value already stored is kept as-is.
  const accessSealed = await sealCredential(refreshed.accessToken, input.key);
  const refreshPlaintext = refreshed.refreshToken ?? refreshToken;
  const refreshSealed = await sealCredential(refreshPlaintext, input.key);
  await rpc("connections_register", {
    p_organization_id: input.organizationId,
    p_provider: input.provider,
    p_account_email: input.accountEmail,
    p_account_name: input.accountName,
    p_access_token_enc: accessSealed.sealed,
    p_refresh_token_enc: refreshSealed.sealed,
    p_token_expires_at: refreshed.expiresAt,
    p_token_key_version: accessSealed.keyVersion,
  });
  return { ok: true, token: refreshed.accessToken };
}

/**
 * Resolve a usable access token for a tenant's provider, refreshing it when the
 * provider actually supports a refresh grant and the stored token has expired.
 */
async function accessTokenFor(tenantId: string, provider: string): Promise<TokenOutcome> {
  const connections = await select<Json>(
    "connections",
    `select=_id,status&%22tenantId%22=eq.${tenantId}&provider=eq.${provider}&limit=1`,
  );
  const connection = connections[0];
  if (!connection) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: `${provider} is not connected for this organization.`,
    };
  }
  if (!["connected", "healthy", "degraded", "syncing"].includes(String(connection.status))) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: `${provider} is not connected for this organization.`,
    };
  }

  const tokens = await select<ConnectionTokenRow>(
    "connectiontokens",
    `select=%22connectionId%22,access_token_enc,refresh_token_enc,%22tokenExpiresAt%22,%22accountEmail%22,%22accountName%22&%22connectionId%22=eq.${connection._id}&limit=1`,
  );
  const row = tokens[0];
  if (!row?.access_token_enc) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: `${provider} has no stored credential; reconnect it.`,
    };
  }
  const key = credentialKey();
  if (!key) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Integration credential key is not configured on this deployment.",
    };
  }

  const decision = decideTokenAction({
    provider,
    expiresAt: row.tokenExpiresAt === null || row.tokenExpiresAt === undefined
      ? null
      : Number(row.tokenExpiresAt),
    now: Date.now(),
    hasRefreshToken: Boolean(row.refresh_token_enc),
  });

  if (decision.action === "reconnect") {
    // Either the provider has no refresh grant (LinkedIn) or there is no stored
    // refresh token to use. Both are "ask the user to reconnect", never a retry
    // loop and never a fabricated success.
    return {
      ok: false,
      code: "AUTHORIZATION_REVOKED",
      message:
        decision.reason === "unsupported_by_provider"
          ? `${provider} does not support refreshing an expired token for this application. ` +
            reconnectMessage(provider)
          : `${provider} has no stored refresh token. ${reconnectMessage(provider)}`,
    };
  }

  if (decision.action === "refresh" && row.refresh_token_enc && supportsRefresh(provider)) {
    const refreshed = await refreshAccessToken({
      connectionId: String(connection._id),
      organizationId: tenantId,
      provider,
      refreshTokenEnc: row.refresh_token_enc,
      accountEmail: row.accountEmail ?? null,
      accountName: row.accountName ?? null,
      key,
    });
    if (!refreshed.ok) {
      return { ok: false, code: "AUTHORIZATION_REVOKED", message: refreshed.message };
    }
    return { ok: true, token: refreshed.token, connectionId: String(connection._id) };
  }

  const token = await openCredential(row.access_token_enc, key);
  if (!token) {
    return {
      ok: false,
      code: "AUTHORIZATION_REVOKED",
      message: `${provider} credential could not be opened; reconnect it.`,
    };
  }
  return { ok: true, token, connectionId: String(connection._id) };
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

async function uploadToYouTube(input: {
  tenantId: string;
  title: string;
  description: string;
  tags: string[];
  videoUrl: string | null;
  thumbnailUrl: string | null;
}): Promise<StepOutcome> {
  const auth = await accessTokenFor(input.tenantId, "youtube");
  if (!auth.ok) {
    // A revoked/expired authorization is the user's to fix, so the job fails
    // permanently with an instruction rather than retrying a dead credential.
    return { ok: false, code: auth.code, message: auth.message, retryable: false };
  }
  if (!input.videoUrl) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "The YouTube video has not been rendered yet, so there is nothing to upload.",
      retryable: false,
    };
  }

  // STREAM, do not buffer. A 3-6 minute video is tens to hundreds of megabytes;
  // `new Uint8Array(await media.arrayBuffer())` loaded all of it into the Edge
  // Function's memory and then uploaded it a second time from there.
  // YouTube's resumable session needs the total length up front, so the
  // upstream response must declare it (every object store does). When the
  // provider does not declare a length the upload is refused rather than
  // guessed at — an undeclared-length body cannot be streamed safely.
  const media = await fetch(input.videoUrl);
  if (!media.ok || !media.body) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: `The rendered video could not be read (HTTP ${media.status}).`,
      retryable: true,
    };
  }
  const declaredLength = Number(media.headers.get("content-length") ?? "");
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message:
        "The rendered video's storage did not report a content length, so it cannot be " +
        "streamed to YouTube. Re-upload the asset to storage with a known size.",
      retryable: true,
    };
  }

  // Resumable upload: initiate, then send the bytes to the returned session URL.
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": String(declaredLength),
      },
      body: JSON.stringify({
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description.slice(0, 5000),
          tags: input.tags.slice(0, 15),
          categoryId: "22",
        },
        // Uploaded private: a human flips visibility in YouTube. Atlas never
        // publishes a video publicly on its own.
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
      }),
    },
  );
  if (!init.ok) {
    const detail = await init.text();
    const failure = classifyAuthFailure(init.status);
    const authGone = failure === "expired" || failure === "revoked";
    return {
      ok: false,
      code: authGone ? "AUTHORIZATION_REVOKED" : failure === "rate_limited" ? "RATE_LIMITED" : "PROVIDER_ERROR",
      message: authGone
        ? reconnectMessage("youtube")
        : failure === "rate_limited"
          ? "YouTube rate-limited the upload. Atlas will retry."
          : `YouTube rejected the upload request (HTTP ${init.status}). ${detail.slice(0, 200)}`,
      retryable: !authGone,
    };
  }
  const session = init.headers.get("location");
  if (!session) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: "YouTube did not return an upload session.",
      retryable: true,
    };
  }

  // The body is the upstream stream itself: the bytes travel storage -> YouTube
  // without ever being held whole in this function.
  const upload = await fetch(session, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-length": String(declaredLength) },
    body: media.body,
    // @ts-expect-error Deno streams the request body when `duplex` is set.
    duplex: "half",
  });
  const uploaded = (await upload.json().catch(() => ({}))) as Json;
  const videoId = str(uploaded.id);
  if (!upload.ok || !videoId) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: `YouTube upload failed (HTTP ${upload.status}).`,
      retryable: true,
    };
  }

  // The shared thumbnail, set on the video that now exists.
  let thumbnailSet = false;
  if (input.thumbnailUrl) {
    const image = await fetch(input.thumbnailUrl);
    if (image.ok) {
      const imageBytes = new Uint8Array(await image.arrayBuffer());
      const thumb = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.token}`,
            "content-type": "image/jpeg",
            "content-length": String(imageBytes.byteLength),
          },
          body: imageBytes,
        },
      );
      thumbnailSet = thumb.ok;
    }
  }

  return {
    ok: true,
    result: {
      externalId: videoId,
      externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      metadata: { thumbnailSet, visibility: "private" },
    },
  };
}

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

async function authorUrn(token: string): Promise<string | null> {
  const response = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as Json;
  const sub = str(payload.sub);
  return sub ? `urn:li:person:${sub}` : null;
}

async function publishToLinkedIn(input: {
  tenantId: string;
  commentary: string;
  articleUrl: string | null;
  articleTitle: string;
}): Promise<StepOutcome> {
  const auth = await accessTokenFor(input.tenantId, "linkedin");
  if (!auth.ok) {
    return { ok: false, code: auth.code, message: auth.message, retryable: false };
  }

  const author = await authorUrn(auth.token);
  if (!author) {
    return {
      ok: false,
      code: "AUTHORIZATION_REVOKED",
      message: reconnectMessage("linkedin"),
      retryable: false,
    };
  }

  const body: Json = {
    author,
    commentary: input.commentary.slice(0, 2900),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.articleUrl) {
    body.content = { article: { source: input.articleUrl, title: input.articleTitle } };
  }

  // LinkedIn's versioned REST API. The created post's URN comes back in the
  // x-restli-id response header — there is no id in the body.
  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      "x-restli-protocol-version": "2.0.0",
      "linkedin-version": "202411",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    const failure = classifyAuthFailure(response.status);
    if (failure === "expired" || failure === "revoked") {
      return {
        ok: false,
        code: "AUTHORIZATION_REVOKED",
        message: reconnectMessage("linkedin"),
        retryable: false,
      };
    }
    if (failure === "rate_limited") {
      return {
        ok: false,
        code: "RATE_LIMITED",
        message: "LinkedIn rate-limited the request. Atlas will retry.",
        retryable: true,
      };
    }
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      message: `LinkedIn rejected the post (HTTP ${response.status}). ${detail.slice(0, 200)}`,
      retryable: true,
    };
  }

  const urn = response.headers.get("x-restli-id") ?? "";
  return {
    ok: true,
    result: {
      externalId: urn || `linkedin-${Date.now()}`,
      externalUrl: urn ? `https://www.linkedin.com/feed/update/${urn}` : null,
      metadata: { author },
    },
  };
}

// ---------------------------------------------------------------------------
// Step execution — one function per job type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Automation — the scheduled path
// ---------------------------------------------------------------------------
//
// `content_automation_list_due` is the EXISTING Atlas scheduler surface: it walks
// every enabled automation whose interval has elapsed. There is no second cron
// and no second queue. The tick is reachable two ways, and both run the SAME
// function so a manual run and a scheduled run cannot diverge:
//
//   * POST { action: "automation" }              — an operator, immediately
//   * a dequeued `content_automation_tick` job  — created durably by
//                                               content_automation_upsert
interface AutomationTickResult {
  due: number;
  enqueued: string[];
  exhausted: string[];
}

async function runAutomationTick(limit = 25): Promise<AutomationTickResult> {
  const due = await rpc<Json[]>("content_automation_list_due", { p_limit: limit });
  const enqueued: string[] = [];
  const exhausted: string[] = [];
  for (const automation of due ?? []) {
    const organizationId = str(automation.organizationId);
    if (!organizationId || automation.enabled !== true) continue;

    // Topic selection is the DATABASE's job (content_next_topic): it reads THIS
    // organization's coveredTopics from the curated bank and returns the first
    // uncovered topic, or NULL when everything is covered. The worker never
    // invents a topic and never accepts one from the request body, so an
    // automated article can only be about something the audience has not
    // already been sent.
    const topic = str(await rpc("content_next_topic", { p_organization: organizationId }));
    if (!topic) {
      log("automation.exhausted", { organizationId });
      exhausted.push(organizationId);
      continue;
    }

    await rpc("jobs_create_job", {
      p_tenant_id: organizationId,
      p_job_type: "content_generate_package",
      // One package per organization per scheduled occurrence, so a retried
      // tick cannot generate the same article twice.
      p_idempotency_key: `content:auto:${organizationId}:${Math.floor(Date.now() / 600_000)}`,
      p_priority: 4,
      p_payload: { topic, tenant_id: organizationId, automated: true },
      p_max_attempts: 3,
      p_tags: ["content-engine"],
    });
    enqueued.push(organizationId);
  }
  return { due: (due ?? []).length, enqueued, exhausted };
}

async function stepGeneratePackage(job: JobRow): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id);
  const topic = str(job.payload.topic);
  if (!packageId || !topic) {
    return { ok: false, code: "VALIDATION", message: "package_id and topic are required.", retryable: false };
  }

  const brand = await resolveBrand(job.tenant_id);
  const generated = await generateArticle({
    topic,
    instructions:
      "Open with the problem the reader actually faces, then the workflow that fixes it. " +
      "Use concrete process detail. No statistics, no regulation numbers, no citations.",
    ...brand,
  });
  if (!generated.ok) {
    return { ok: false, code: "NOT_CONFIGURED", message: generated.message, retryable: false };
  }

  const { article } = generated;
  await upsertAsset({
    packageId,
    contentType: "blog",
    assetType: "blog_article",
    title: article.title,
    body: article.body,
    metadata: { summary: article.summary },
    status: "drafted",
  });

  const script = buildVideoScript({
    title: article.title,
    body: article.body,
    cta: brand.cta,
  });
  await upsertAsset({
    packageId,
    contentType: "video_script",
    assetType: "video_script",
    title: `${article.title} — video script`,
    body: script,
    status: "drafted",
  });

  // Each derivative on its own job: a missing video provider must not stop the
  // LinkedIn draft, and a LinkedIn failure must not invalidate the article.
  await enqueue({
    packageId,
    tenantId: job.tenant_id,
    jobType: "content_generate_thumbnail",
    payload: { package_id: packageId },
    idempotencyKey: `content:thumbnail:${packageId}`,
  });
  await enqueue({
    packageId,
    tenantId: job.tenant_id,
    jobType: "content_generate_video",
    payload: { package_id: packageId },
    idempotencyKey: `content:video:${packageId}`,
  });
  await enqueue({
    packageId,
    tenantId: job.tenant_id,
    jobType: "content_write_linkedin",
    payload: { package_id: packageId },
    idempotencyKey: `content:linkedin-draft:${packageId}`,
  });

  await rpc("content_automation_note_topic", { p_topic: topic, p_package: packageId });

  return { ok: true, result: { package_id: packageId, title: article.title } };
}

/** Read a stored object as bytes. Throws when it is absent or unreadable. */
async function downloadFromStorage(storagePath: string): Promise<Uint8Array> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error("Atlas storage is not configured in this deployment.");
  }
  const objectPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${objectPath}`, {
    headers: { apikey: SERVICE_ROLE, authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!response.ok) {
    throw new Error(`Atlas storage rejected the download (HTTP ${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function stepGenerateThumbnail(job: JobRow): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id);
  if (!packageId) {
    return { ok: false, code: "VALIDATION", message: "package_id is required.", retryable: false };
  }

  // WHICH RENDERER, read from the job payload and validated before anything is
  // generated. A payload with no `renderer` names no renderer at all, so the
  // generative provider remains the default and this is a no-op for every job
  // that exists today. An unrecognised or malformed renderer FAILS here rather
  // than falling through to the provider, because silently substituting a paid
  // model for a requested deterministic render is exactly the substitution this
  // system must never make.
  const renderer = readThumbnailRenderer(job.payload);
  if (!renderer.ok) {
    return { ok: false, code: renderer.code, message: renderer.message, retryable: renderer.retryable };
  }

  const view = await loadPackage(packageId);

  // A compositor job names its two approved inputs BY REFERENCE. They are
  // resolved here, against the package this job is already rendering for and
  // the assets `content_package_get` just returned — never from the payload
  // itself, so no image bytes ever live in a durable job row and a job cannot
  // point at another package's inputs.
  let resolvedRenderer = renderer.renderer;
  if (resolvedRenderer && resolvedRenderer.kind === "compositor" && "backgroundAssetId" in resolvedRenderer) {
    const resolved = await resolveThumbnailInputs(
      {
        packageId,
        packageOrganizationId: str(view?.package.organizationId),
        assets: (view?.assets ?? []) as unknown as ThumbnailInputAsset[],
        backgroundAssetId: resolvedRenderer.backgroundAssetId,
        overlayAssetId: resolvedRenderer.overlayAssetId,
      },
      { download: downloadFromStorage },
    );
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, message: resolved.message, retryable: false };
    }
    resolvedRenderer = {
      kind: "compositor",
      backgroundDataUri: resolved.backgroundDataUri,
      overlayLines: resolved.overlayLines,
      provenance: { ...resolved.provenance },
    };
  }

  const existing = assetOf(view, THUMBNAIL_CONTENT_TYPE);
  const brand = await resolveBrand(job.tenant_id);
  const article = assetOf(view, "blog");

  // The whole render — prompt, provider request, durable storage and the
  // canonical presentation reference — lives in ./thumbnail.ts so it can be
  // executed and asserted by the test suite. This step is only its wiring.
  return generateThumbnail(
    {
      packageId,
      tenantId: job.tenant_id,
      packageOrganizationId: str(view?.package.organizationId),
      packageTitle: String(view?.package.title ?? "Atlas"),
      packageSlug: str(view?.package.slug),
      imagePrompt: str(view?.package.imagePrompt),
      articleTitle: article ? str(article.title) : null,
      brandVoice: brand.brandVoice,
      existing: existing
        ? { storagePath: existing.storagePath ?? null, externalUrl: existing.externalUrl ?? null }
        : null,
      regenerate: job.payload.regenerate === true,
      // Replacement consent is separate from `regenerate`, and both are
      // required before an existing canonical thumbnail may be overwritten.
      replaceExistingThumbnail: job.payload.replaceExistingThumbnail === true,
      supersedes: existing
        ? {
            assetId: existing._id,
            provider: existing.provider ?? null,
            source:
              typeof existing.metadata?.externalSource === "string"
                ? (existing.metadata.externalSource as string)
                : null,
          }
        : null,
      renderer: resolvedRenderer as ThumbnailRenderer | undefined,
    },
    {
      env: { get: (key: string) => env(key) },
      transport: async ({ url, method, headers, body, signal, wantBytes }) => {
        const res = await fetch(url, { method, headers, body, signal });
        // A provider that answers with a short-lived image URL has to be read
        // as BINARY. `res.text()` would corrupt those bytes, so the byte read is
        // explicit and only happens when the caller asked for it.
        if (wantBytes) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          return { ok: res.ok, status: res.status, text: "", bytes };
        }
        return { ok: res.ok, status: res.status, text: await res.text() };
      },
      upload: uploadToStorage,
      publicUrl: publicStorageUrl,
      rpc: (name, args) => rpc(name, args),
      timeoutMs: resolveImageTimeoutMs(env("IMAGE_TIMEOUT_MS")),
    },
  );
}

// ---------------------------------------------------------------------------
// Video — the real PixVerse lifecycle
// ---------------------------------------------------------------------------
//
// A text-to-video provider renders SHORT clips. The 3-6 minute requirement is
// therefore met by a PLAN of clips, not by one impossible request:
//
//   script -> clip plan -> submit clip -> poll clip -> next clip -> ... -> assemble
//
// The plan is persisted on the `youtube_video` asset, so the lifecycle survives a
// crash, a retry or a redeploy: a resumed job polls the SAME provider renders
// instead of paying for them twice. The Edge Function never sits in a polling
// loop — it performs one action per job and requeues through atlas_jobs.

interface VideoProviderConfig {
  key: string;
  baseUrl: string;
  model: string;
}

function videoProviderConfig(): VideoProviderConfig | null {
  const key = env("VIDEO_PROVIDER_API_KEY");
  if (!key) return null;
  return {
    key,
    baseUrl: (env("VIDEO_PROVIDER_BASE_URL") ?? PIXVERSE_BASE_URL).replace(/\/+$/, ""),
    model: env("VIDEO_PROVIDER_MODEL") ?? PIXVERSE_DEFAULT_MODEL,
  };
}

/** Start ONE clip render. Returns the provider job id, never a media URL. */
async function submitClip(
  config: VideoProviderConfig,
  input: { title: string; prompt: string; durationSeconds: number },
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  // A unique Ai-trace-id per request is REQUIRED by the provider.
  const traceId = newTraceId();
  const response = await fetch(renderUrl(config.baseUrl), {
    method: "POST",
    headers: {
      [PIXVERSE_API_KEY_HEADER]: config.key,
      "content-type": "application/json",
      [PIXVERSE_TRACE_HEADER]: traceId,
    },
    body: JSON.stringify(
      buildRenderRequest(
        {
          aspectRatio: "16:9",
          durationSeconds: input.durationSeconds,
          title: input.title,
          style: "clean B2B explainer, Atlas brand, restrained palette, documentary look",
          script: input.prompt,
        },
        { model: config.model },
      ),
    ),
  });
  if (!response.ok) {
    return {
      ok: false,
      message: `The video provider rejected the render request (HTTP ${response.status}).`,
    };
  }
  const jobId = readVideoId(await response.json().catch(() => null));
  return jobId
    ? { ok: true, jobId }
    : { ok: false, message: "The video provider returned no render id." };
}

async function pollClip(
  config: VideoProviderConfig,
  jobId: string,
): Promise<{ ok: true; state: "pending" | "ready" | "failed"; mediaUrl: string | null; message: string | null }> {
  const response = await fetch(resultUrl(config.baseUrl, jobId), {
    method: "GET",
    headers: { [PIXVERSE_API_KEY_HEADER]: config.key, [PIXVERSE_TRACE_HEADER]: newTraceId() },
  });
  if (!response.ok) {
    return {
      ok: true,
      state: "failed",
      mediaUrl: null,
      message: `Could not read the render status (HTTP ${response.status}).`,
    };
  }
  const result = readRenderResult(await response.json().catch(() => null));
  return { ok: true, state: result.state, mediaUrl: result.mediaUrl, message: result.error };
}

async function persistPlan(
  packageId: string,
  title: string,
  plan: ClipPlan,
  providerId = "pixverse",
): Promise<void> {
  await upsertAsset({
    packageId,
    contentType: "youtube_video",
    assetType: "youtube_video",
    title: `${title} — video`,
    externalId: plan.clips.find((c) => c.providerJobId)?.providerJobId ?? null,
    mimeType: "video/mp4",
    provider: providerId,
    metadata: planToMetadata(plan),
    // 'drafted' only once every clip is ready. A provider job id on its own is
    // never a finished video, and no media URL is recorded until one exists.
    status: isPlanComplete(plan) ? "drafted" : "researching",
  });
}

async function stepGenerateVideo(job: JobRow): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id);
  if (!packageId) {
    return { ok: false, code: "VALIDATION", message: "package_id is required.", retryable: false };
  }
  const view = await loadPackage(packageId);
  const script = assetOf(view, "video_script");
  if (!script?.body) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "The package has no video script; generate the article first.",
      retryable: false,
    };
  }

  const config = videoProviderConfig();
  if (!config) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "No video provider is configured. Set VIDEO_PROVIDER_API_KEY to enable video generation.",
      retryable: false,
    };
  }

  // A resumed package already carries its plan; do not restart the renders.
  const existing = planFromMetadata(assetOf(view, "youtube_video")?.metadata);
  const plan =
    existing ??
    planClips({
      script: script.body,
      title: String(view?.package.title ?? "Atlas"),
      targetDurationSeconds: DEFAULT_TARGET_VIDEO_SECONDS,
      clipDurationSeconds: PIXVERSE_CLIP_DURATION,
    });

  const action = nextRenderAction(plan);
  if (action.kind === "poll") {
    await persistPlan(packageId, String(view?.package.title ?? "Atlas"), plan);
    await enqueue({
      packageId,
      tenantId: job.tenant_id,
      jobType: "content_poll_video",
      payload: { package_id: packageId },
      idempotencyKey: `content:video-poll:${packageId}:${action.clip.index}`,
    });
    return { ok: true, result: { package_id: packageId, resumed: true } };
  }
  if (action.kind !== "submit") {
    await persistPlan(packageId, String(view?.package.title ?? "Atlas"), plan);
    return {
      ok: true,
      result: { package_id: packageId, status: action.kind === "assemble" ? "clips_complete" : "waiting" },
    };
  }

  const submitted = await submitClip(config, {
    title: String(view?.package.title ?? "Atlas"),
    prompt: action.clip.prompt,
    durationSeconds: action.clip.durationSeconds,
  });
  if (!submitted.ok) {
    return { ok: false, code: "PROVIDER_ERROR", message: submitted.message, retryable: true };
  }

  const next = markSubmitted(plan, action.clip.index, submitted.jobId);
  await persistPlan(packageId, String(view?.package.title ?? "Atlas"), next);
  await enqueue({
    packageId,
    tenantId: job.tenant_id,
    jobType: "content_poll_video",
    payload: { package_id: packageId },
    idempotencyKey: `content:video-poll:${packageId}:${action.clip.index}`,
  });

  return {
    ok: true,
    result: {
      package_id: packageId,
      provider: "pixverse",
      external_id: submitted.jobId,
      status: "pending",
      clips: next.clips.length,
      target_duration_seconds: next.targetDurationSeconds,
      clip_duration_seconds: next.clipDurationSeconds,
    },
  };
}

/** Advance the durable plan by exactly one step, then requeue if more remains. */
async function stepPollVideo(job: JobRow): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id);
  if (!packageId) {
    return { ok: false, code: "VALIDATION", message: "package_id is required.", retryable: false };
  }
  const view = await loadPackage(packageId);
  const plan = planFromMetadata(assetOf(view, "youtube_video")?.metadata);
  if (!plan) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "This package has no video render plan; run content_generate_video first.",
      retryable: false,
    };
  }
  const config = videoProviderConfig();
  if (!config) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "No video provider is configured; the render cannot be resumed.",
      retryable: false,
    };
  }

  const title = String(view?.package.title ?? "Atlas");
  const action = nextRenderAction(plan);
  const requeue = (index: number, suffix: string) =>
    enqueue({
      packageId,
      tenantId: job.tenant_id,
      jobType: "content_poll_video",
      payload: { package_id: packageId },
      idempotencyKey: `content:video-poll:${packageId}:${index}:${suffix}`,
    });

  if (action.kind === "submit") {
    const submitted = await submitClip(config, {
      title,
      prompt: action.clip.prompt,
      durationSeconds: action.clip.durationSeconds,
    });
    if (!submitted.ok) {
      await persistPlan(packageId, title, markFailed(plan, action.clip.index, submitted.message));
      return { ok: false, code: "PROVIDER_ERROR", message: submitted.message, retryable: true };
    }
    await persistPlan(packageId, title, markSubmitted(plan, action.clip.index, submitted.jobId));
    await requeue(action.clip.index, "next");
    return { ok: true, result: { package_id: packageId, submitted_clip: action.clip.index } };
  }

  if (action.kind === "poll") {
    const polled = await pollClip(config, action.jobId);
    if (polled.state === "failed") {
      const message = polled.message ?? "The video provider reported a failed render.";
      await persistPlan(packageId, title, markFailed(plan, action.clip.index, message));
      return { ok: false, code: "PROVIDER_ERROR", message, retryable: true };
    }
    if (polled.state === "pending") {
      // Still rendering. Requeue on a minute-scoped key rather than sleeping:
      // the Edge Function must not block on a provider.
      await requeue(action.clip.index, String(Math.floor(Date.now() / 60_000)));
      return { ok: true, result: { package_id: packageId, polling_clip: action.clip.index } };
    }
    if (!polled.mediaUrl) {
      // Success without a file is a failure, never a fabricated URL.
      const message = "The video provider reported success without a media file.";
      await persistPlan(packageId, title, markFailed(plan, action.clip.index, message));
      return { ok: false, code: "PROVIDER_ERROR", message, retryable: true };
    }
    await persistPlan(packageId, title, markReady(plan, action.clip.index, polled.mediaUrl));
    await requeue(action.clip.index + 1, "next");
    return { ok: true, result: { package_id: packageId, ready_clip: action.clip.index } };
  }

  if (action.kind === "assemble") {
    // Every clip is rendered. Atlas has no media concatenator configured (no
    // ffmpeg worker, no media bucket), so the engine stops HERE, honestly:
    // the clips are recorded, the package is NOT marked ready, and no media URL
    // is invented. This is the seam a VideoAssembler plugs into.
    await persistPlan(packageId, title, plan);
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message:
        `All ${plan.clips.length} clips are rendered, but no video assembler is configured, so no ` +
        "single video file exists yet. Concatenate the clips (or configure an assembler) before " +
        "publishing. No media URL was recorded.",
      retryable: false,
    };
  }

  return { ok: true, result: { package_id: packageId, waiting: action.reason } };
}

async function stepWriteLinkedIn(job: JobRow): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id) ?? str(job.payload.content_id);
  if (!packageId) {
    return { ok: false, code: "VALIDATION", message: "package_id is required.", retryable: false };
  }
  const view = await loadPackage(packageId);
  const article = assetOf(view, "blog_article");
  if (!article?.body) {
    return {
      ok: false,
      code: "VALIDATION",
      message: "The package has no article yet, so a LinkedIn post cannot be derived.",
      retryable: false,
    };
  }
  const brand = await resolveBrand(job.tenant_id);
  const body = buildLinkedInPost({
    title: String(view?.package.title ?? ""),
    summary:
      str((article.metadata ?? {}).summary) ??
      article.body.replace(/\s+/g, " ").trim().slice(0, 240),
    body: article.body,
    blogUrl: blogUrlForSlug(str(view?.package.slug)),
    youtubeUrl: str(view?.package.youtubeUrl),
    cta: brand.cta,
  });

  await upsertAsset({
    packageId,
    contentType: "linkedin_post",
    assetType: "linkedin_post",
    title: `${String(view?.package.title ?? "Atlas")} — LinkedIn`,
    body,
    status: "drafted",
  });

  return { ok: true, result: { package_id: packageId } };
}

/** Publish one destination, idempotently, through its publication row. */
async function stepPublish(job: JobRow, provider: "blog" | "youtube" | "linkedin"): Promise<StepOutcome> {
  const packageId = str(job.payload.package_id);
  if (!packageId) {
    return { ok: false, code: "VALIDATION", message: "package_id is required.", retryable: false };
  }

  const view = await loadPackage(packageId);
  if (!view) {
    return { ok: false, code: "NOT_FOUND", message: "Content package not found.", retryable: false };
  }

  // Human approval is a precondition, checked again here: authentication is not
  // authorization, and a worker must not publish an unapproved package.
  const approval = str(view.package.approvalStatus);
  const automations = await select<Json>(
    "atlasContentAutomation",
    `select=%22autoPublish%22&%22organizationId%22=eq.${job.tenant_id}&limit=1`,
  );
  const autoPublish = automations[0]?.autoPublish === true;
  if (approval !== "approved" && !autoPublish) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "The package is not approved for publishing.",
      retryable: false,
    };
  }

  const asset =
    provider === "youtube"
      ? assetOf(view, "youtube_video")
      : provider === "linkedin"
        ? assetOf(view, "linkedin_post")
        : assetOf(view, "blog_article");

  const publication = await rpc<Json>("content_publication_upsert", {
    p_package: packageId,
    p_provider: provider,
    p_asset: asset?._id ?? null,
    p_status: "queued",
    p_scheduled_at: null,
  });
  const publicationId = str(publication?._id);
  if (!publicationId) {
    return { ok: false, code: "INTERNAL", message: "The publication row could not be created.", retryable: true };
  }

  const claimed = await rpc<Json | null>("content_publication_claim", { p_publication: publicationId });
  if (!claimed) {
    // Someone else holds it, or it is already published. Not an error, and
    // critically not a second post.
    return { ok: true, result: { package_id: packageId, provider, skipped: "already_claimed" } };
  }
  // A published row with an external id means the provider already has it. This
  // is the second half of the idempotency guarantee.
  if (str(claimed.externalId) && String(claimed.status) === "published") {
    return { ok: true, result: { package_id: packageId, provider, skipped: "already_published" } };
  }

  if (provider === "blog") {
    const result = await rpc<Json>("content_publish_blog", {
      p_content_id: packageId,
      p_slug: str(view.package.slug),
      p_base_url: ATLAS_BLOG_ORIGIN,
      p_actor: null,
    });
    if (result?.ok === false) {
      await rpc("content_publication_fail", {
        p_publication: publicationId,
        p_error: str(result.error) ?? "The article could not be published.",
        p_error_class: "invalid_content",
      });
      return {
        ok: false,
        code: "VALIDATION",
        message: str(result.error) ?? "The article could not be published.",
        retryable: false,
      };
    }
    const slug = str(result?.slug) ?? str(view.package.slug);
    await rpc("content_publication_complete", {
      p_publication: publicationId,
      p_external_id: slug,
      p_external_url: blogUrlForSlug(slug),
      p_metadata: {},
    });
    return {
      ok: true,
      result: { package_id: packageId, provider, external_url: blogUrlForSlug(slug) },
    };
  }

  // The canonical owned URL. Present only once the article is published, so a
  // YouTube description or a LinkedIn post can never carry a broken link.
  const blogUrl = blogUrlForSlug(str(view.package.slug));
  const outcome =
    provider === "youtube"
      ? await uploadToYouTube({
          tenantId: job.tenant_id,
          title: String(view.package.title ?? "Atlas"),
          description: [
            str((assetOf(view, "blog_article")?.metadata ?? {}).summary) ??
              String(view.package.title ?? ""),
            "",
            blogUrl ? `Read the full article on Atlas → ${blogUrl}` : "",
            "",
            "Atlas is the AI operating system for insurance restoration companies.",
          ]
            .filter(Boolean)
            .join("\n"),
          tags: [],
          videoUrl: asset?.externalUrl ?? null,
          thumbnailUrl: assetOf(view, "youtube_thumbnail")?.externalUrl ?? null,
        })
      : await publishToLinkedIn({
          tenantId: job.tenant_id,
          commentary: asset?.body ?? "",
          articleUrl: blogUrl,
          articleTitle: String(view.package.title ?? "Atlas"),
        });

  if (!outcome.ok) {
    await rpc("content_publication_fail", {
      p_publication: publicationId,
      p_error: outcome.message,
      p_error_class: outcome.code.toLowerCase(),
    });
    return outcome;
  }

  await rpc("content_publication_complete", {
    p_publication: publicationId,
    p_external_id: outcome.result.externalId,
    p_external_url: outcome.result.externalUrl ?? null,
    p_metadata: (outcome.result.metadata as Json) ?? {},
  });

  if (provider === "youtube") {
    // The two-way relationship: the article records the canonical video, the
    // video description carries the canonical article URL.
    await upsertAsset({
      packageId,
      contentType: "youtube_video",
      assetType: "youtube_video",
      title: String(view.package.title ?? "Atlas") + " — video",
      externalId: String(outcome.result.externalId),
      externalUrl: str(outcome.result.externalUrl),
      metadata: { publishedAt: Date.now() },
      status: "published",
    });
    await rpc("content_set_youtube_presentation", {
      p_package: packageId,
      p_youtube_url: str(outcome.result.externalUrl),
      p_youtube_video_id: String(outcome.result.externalId),
      p_thumbnail_url: assetOf(view, "youtube_thumbnail")?.externalUrl ?? null,
      p_seo: {},
    });
  }

  return { ok: true, result: { package_id: packageId, provider, ...outcome.result } };
}

// ---------------------------------------------------------------------------
// Crash recovery for publications
// ---------------------------------------------------------------------------
//
// The publication lease exists because a worker can die between the provider
// succeeding and `content_publication_complete` being recorded. A row stuck in
// `processing` with an EXPIRED lease is therefore not lost work: it is
// re-queued, and because the re-queued job goes through `content_publication_claim`
// — which refuses a row that is already `published`, or that still holds a live
// lease — a reclaimed row cannot produce a second post by accident.
const PUBLISH_JOB_FOR: Record<string, string> = {
  blog: "content_publish_blog",
  youtube: "content_publish_youtube",
  linkedin: "content_publish_linkedin",
};

async function reclaimStalePublications(limit = 10): Promise<number> {
  const rows = await rpc<Json[]>("content_publications_reclaimable", { p_limit: limit });
  let requeued = 0;
  for (const row of rows ?? []) {
    const publicationId = str(row._id);
    const packageId = str(row.contentPackageId);
    const provider = str(row.provider);
    const jobType = provider ? PUBLISH_JOB_FOR[provider] : undefined;
    if (!publicationId || !packageId || !jobType) continue;
    await rpc("jobs_create_job", {
      p_tenant_id: row.organizationId ?? null,
      p_job_type: jobType,
      // One reclaim attempt per publication per lease expiry window.
      p_idempotency_key: `content:reclaim:${publicationId}:${Math.floor(Date.now() / 300_000)}`,
      p_priority: 2,
      p_payload: { package_id: packageId, publication_id: publicationId, reclaimed: true },
      p_max_attempts: 3,
      p_tags: ["content-engine"],
    });
    requeued += 1;
  }
  if (requeued > 0) log("publications.reclaimed", { count: requeued });
  return requeued;
}

async function execute(job: JobRow): Promise<StepOutcome> {
  switch (job.job_type) {
    case "content_generate_package":
      return stepGeneratePackage(job);
    case "content_generate_thumbnail":
      return stepGenerateThumbnail(job);
    case "content_generate_video":
      return stepGenerateVideo(job);
    case "content_poll_video":
      return stepPollVideo(job);
    case "content_automation_tick": {
      const result = await runAutomationTick();
      return {
        ok: true,
        result: {
          due: result.due,
          enqueued: result.enqueued.length,
          organizations: result.enqueued,
          exhausted: result.exhausted,
        },
      };
    }
    case "content_write_linkedin":
      return stepWriteLinkedIn(job);
    case "content_publish_blog":
      return stepPublish(job, "blog");
    case "content_publish_youtube":
      return stepPublish(job, "youtube");
    case "content_publish_linkedin":
      return stepPublish(job, "linkedin");
    default:
      return {
        ok: false,
        code: "UNSUPPORTED",
        message: `No content handler for job type ${job.job_type}.`,
        retryable: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function isServiceCall(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token && SERVICE_ROLE && token === SERVICE_ROLE);
}

async function authorize(request: Request): Promise<{ ok: true; mode: "service" | "admin" } | { ok: false; response: Response }> {
  const cors = atlasEdgeCorsHeaders(request);
  if (isServiceCall(request)) return { ok: true, mode: "service" };
  try {
    const caller = await requireAtlasCaller(request);
    if (!["super_admin", "atlas_admin"].includes(caller.role ?? "")) {
      return { ok: false, response: atlasEdgeError("Platform administrator access required.", 403, cors) };
    }
    return { ok: true, mode: "admin" };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 401;
    const message = error instanceof Error ? error.message : "Unauthorized";
    return { ok: false, response: atlasEdgeError(message, status, cors) };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const preflight = atlasEdgePreflight(req);
  if (preflight) return preflight;
  const cors = atlasEdgeCorsHeaders(req);

  const authorized = await authorize(req);
  if (!authorized.ok) return authorized.response;

  try {
    const body = (await req.json().catch(() => ({}))) as Json;
    const action = str(body.action) ?? "tick";
    const workerId = `content-engine-${Math.random().toString(36).slice(2, 10)}`;

    if (action === "automation") {
      // The same function the durable `content_automation_tick` job runs, so an
      // operator's manual run and the scheduled run cannot diverge.
      const result = await runAutomationTick();
      return atlasEdgeJson(
        {
          ok: true,
          action,
          due: result.due,
          enqueued: result.enqueued.length,
          organizations: result.enqueued,
          exhausted: result.exhausted,
          note:
            "Generation is enqueued only. requireApproval stays true by default, so nothing is " +
            "published without a human approving the package.",
        },
        200,
        cors,
      );
    }

    const limit = typeof body.limit === "number" ? Math.min(Math.max(body.limit, 1), 10) : 5;
    // Crash recovery runs first: a publication whose worker died is the work
    // that is actually at risk of being lost.
    const reclaimed = await reclaimStalePublications();
    // `jobs_dequeue` returns jsonb shaped `{ jobs: [id...], count }`, not a row
    // set, so the claimed ids have to be resolved to their rows before dispatch.
    const dequeued = await rpc<{ jobs?: string[]; count?: number }>("jobs_dequeue", {
      p_worker_id: workerId,
      p_job_types: CONTENT_JOB_TYPES,
      p_max_jobs: limit,
    });
    const claimedIds = (dequeued?.jobs ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const claimedRows = claimedIds.length
      ? await select<JobRow>(
          "atlas_jobs",
          "select=id,tenant_id,job_type,payload,attempt_count,max_attempts&id=in.(" +
            claimedIds.map((id) => encodeURIComponent(id)).join(",") +
            ")",
        )
      : [];
    // `in.()` does not preserve order; dequeue order (priority, then
    // scheduled_at, then created_at) is the order the jobs were claimed in.
    const rowsById = new Map(claimedRows.map((row) => [row.id, row]));
    const jobs = claimedIds
      .map((id) => rowsById.get(id))
      .filter((row): row is JobRow => Boolean(row));
    if (jobs.length !== claimedIds.length) {
      log("jobs.unresolved", { claimed: claimedIds.length, resolved: jobs.length });
    }

    const results: Json[] = [];
    for (const job of jobs) {
      let outcome: StepOutcome;
      try {
        outcome = await execute(job);
      } catch (error) {
        outcome = {
          ok: false,
          code: "INTERNAL",
          message: error instanceof Error ? error.message : "Unexpected worker error.",
          retryable: true,
        };
      }

      if (outcome.ok) {
        await rpc("jobs_complete_job", { p_job_id: job.id, p_result: outcome.result, p_ai_metadata: null });
      } else {
        // A failed destination is recorded as failed and never as published.
        await rpc("jobs_fail_job", {
          p_job_id: job.id,
          p_error: { code: outcome.code, message: outcome.message },
          p_retryable: outcome.retryable,
        });
      }
      results.push({
        job_id: job.id,
        job_type: job.job_type,
        ok: outcome.ok,
        detail: outcome.ok ? outcome.result : { code: outcome.code, message: outcome.message },
      });
    }

    log("tick.completed", { mode: authorized.mode, processed: results.length, reclaimed });
    return atlasEdgeJson({ ok: true, processed: results.length, reclaimed, results }, 200, cors);
  } catch (error) {
    log("tick.failed", {
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return atlasEdgeError("The content worker could not complete this tick.", 500, cors);
  }
});
