// ---------------------------------------------------------------------------
// Atlas Content Engine — Supabase client implementation
//
// This is the ONLY place that binds the engine's ports to the database. The
// handlers stay pure orchestration; this module does the I/O through the RPCs
// added in 20260935 and reuses the platform RPCs from 20260920 where they
// already exist (content_transition, content_review_decide, content_publish_blog).
//
// Security notes:
//   * No credential ever crosses this boundary. Connections are read through
//     public.connections, whose tokens are sealed server-side — the browser only
//     ever sees connection metadata.
//   * The organization is ALWAYS derived server-side by the RPCs; nothing here
//     sends an organization id taken from a URL.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import type {
  ContentAssetRecord,
  ContentAutomationSettings,
  ContentPackageView,
  ContentPublicationRecord,
  DestinationProvider,
  ProviderConnection,
  PublishTransport,
  PublishTransportInput,
  PublishTransportResponse,
} from "./types";
import type { ContentEnginePorts, GeneratedArticle, ArticleGenerationInput } from "./jobs";
import type { ProviderEnv } from "./media";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Load one package with its assets and publications (RLS applies). */
export async function loadContentPackage(
  supabase: SupabaseClient,
  packageId: string,
): Promise<ContentPackageView | null> {
  const raw = await rpcCall(supabase, "content_package_get", { p_package: packageId });
  if (!raw) return null;
  const data = asRecord(raw);
  const pkg = asRecord(data["package"]);
  if (Object.keys(pkg).length === 0) return null;

  const assets = asArray<Record<string, unknown>>(data["assets"]).map((a) => asRecord(a));

  return {
    packageId: String(pkg["_id"] ?? packageId),
    title: String(pkg["title"] ?? ""),
    slug: (pkg["slug"] as string | null) ?? null,
    status: (pkg["status"] as ContentPackageView["status"]) ?? "drafted",
    approvalStatus: (pkg["approvalStatus"] as ContentPackageView["approvalStatus"]) ?? "pending",
    organizationId: (pkg["organizationId"] as string | null) ?? null,
    youtubeUrl: (pkg["youtubeUrl"] as string | null) ?? null,
    youtubeVideoId: (pkg["youtubeVideoId"] as string | null) ?? null,
    youtubeThumbnailUrl: (pkg["youtubeThumbnailUrl"] as string | null) ?? null,
    blogUrl: pkg["slug"] ? `https://atlas-ai-os.com/blog/${String(pkg["slug"])}` : null,
    assets: assets.map(
      (a): ContentAssetRecord => ({
        _id: String(a["_id"]),
        contentType: String(a["contentType"] ?? ""),
        assetType: (a["assetType"] as string | null) ?? null,
        status: (a["status"] as ContentAssetRecord["status"]) ?? "drafted",
        title: String(a["title"] ?? ""),
        body: (a["body"] as string | null) ?? null,
        storagePath: (a["storagePath"] as string | null) ?? null,
        externalUrl: (a["externalUrl"] as string | null) ?? null,
        externalId: (a["externalId"] as string | null) ?? null,
        mimeType: (a["mimeType"] as string | null) ?? null,
        provider: (a["provider"] as string | null) ?? null,
        parentContentId: (a["parentContentId"] as string | null) ?? null,
        approvalStatus: (a["approvalStatus"] as ContentAssetRecord["approvalStatus"]) ?? "pending",
        metadata: asRecord(a["metadata"]),
      }),
    ),
    publications: asArray<Record<string, unknown>>(data["publications"]).map(
      (p): ContentPublicationRecord => {
        const row = asRecord(p);
        return {
          _id: String(row["_id"]),
          organizationId: (row["organizationId"] as string | null) ?? null,
          contentPackageId: String(row["contentPackageId"] ?? ""),
          assetId: (row["assetId"] as string | null) ?? null,
          provider: row["provider"] as DestinationProvider,
          status: (row["status"] as ContentPublicationRecord["status"]) ?? "queued",
          scheduledAt: num(row["scheduledAt"]),
          attemptCount: Number(row["attemptCount"] ?? 0),
          externalId: (row["externalId"] as string | null) ?? null,
          externalUrl: (row["externalUrl"] as string | null) ?? null,
          lastError: (row["lastError"] as string | null) ?? null,
          errorClass: (row["errorClass"] as ContentPublicationRecord["errorClass"]) ?? null,
          publishedAt: num(row["publishedAt"]),
          lockedAt: num(row["lockedAt"]),
          lockExpiresAt: num(row["lockExpiresAt"]),
          idempotencyKey: String(row["idempotencyKey"] ?? ""),
        };
      },
    ),
  };
}

export async function loadStudioSummary(supabase: SupabaseClient): Promise<Record<string, number>> {
  const raw = asRecord(await rpcCall(supabase, "content_studio_summary"));
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) out[key] = Number(value ?? 0);
  return out;
}

export async function loadAutomation(
  supabase: SupabaseClient,
): Promise<ContentAutomationSettings> {
  const raw = asRecord(await rpcCall(supabase, "content_automation_get"));
  return {
    organizationId: (raw["organizationId"] as string | null) ?? null,
    enabled: Boolean(raw["enabled"]),
    intervalSeconds: num(raw["intervalSeconds"]),
    // Fail closed: an unreadable value means approval is still required.
    requireApproval: raw["requireApproval"] === undefined ? true : Boolean(raw["requireApproval"]),
    autoPublish: Boolean(raw["autoPublish"]),
    brandVoice: (raw["brandVoice"] as string | null) ?? null,
    audience: (raw["audience"] as string | null) ?? null,
    primaryCta: (raw["primaryCta"] as string | null) ?? null,
    defaultTone: (raw["defaultTone"] as string | null) ?? null,
    coveredTopics: Array.isArray(raw["coveredTopics"]) ? (raw["coveredTopics"] as string[]) : [],
    lastGeneratedAt: num(raw["lastGeneratedAt"]),
    lastPackageId: (raw["lastPackageId"] as string | null) ?? null,
  };
}

/** One Studio row: the package, its assets and its per-channel publications. */
export interface StudioPackageRow {
  package: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
  publications: Array<Record<string, unknown>>;
}

/** The organization's content packages, newest first (RLS-scoped). */
export async function listPackages(
  supabase: SupabaseClient,
  limit = 40,
): Promise<StudioPackageRow[]> {
  const raw = asArray<Record<string, unknown>>(
    await rpcCall(supabase, "content_studio_list", { limit, offset: 0 }),
  );
  return raw.map((row) => ({
    package: asRecord(row["package"]),
    assets: asArray<Record<string, unknown>>(row["assets"]).map(asRecord),
    publications: asArray<Record<string, unknown>>(row["publications"]).map(asRecord),
  }));
}

/**
 * Connections for the two distribution channels. The browser only ever sees
 * connection metadata — the access/refresh tokens are sealed server-side and are
 * never returned by this read.
 */
export async function listContentConnections(
  supabase: SupabaseClient,
): Promise<
  Array<{
    provider: string;
    id: string;
    status: string;
    accountName: string | null;
    scopes: string[];
    lastError: string | null;
    connectedAt: number | null;
  }>
> {
  const { data, error } = await supabase
    .from("connections")
    .select('_id,provider,status,"accountName",scopes,"lastError","_creationTime"')
    .in("provider", ["youtube", "linkedin"]);
  if (error) throw error;
  return asArray<Record<string, unknown>>(data).map((row) => ({
    provider: String(row["provider"]),
    id: String(row["_id"]),
    status: String(row["status"] ?? "pending"),
    accountName: (row["accountName"] as string | null) ?? null,
    scopes: Array.isArray(row["scopes"]) ? (row["scopes"] as string[]) : [],
    lastError: (row["lastError"] as string | null) ?? null,
    connectedAt: num(row["_creationTime"]),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createContentPackage(
  supabase: SupabaseClient,
  input: { topic: string; title: string; slug: string; tags: string[] },
): Promise<{ ok: boolean; content_id?: string; error?: string }> {
  return rpcCall(supabase, "content_create", {
    content_type: "blog",
    title: input.title,
    slug: input.slug,
    summary: null,
    body: null,
    seo: { tags: input.tags, topic: input.topic },
    jurisdiction: null,
    industry: null,
    effective_date: null,
    knowledge_ids: [],
    source_ids: [],
    parent_content_id: null,
    research_job_id: null,
    status: "opportunity",
  }) as Promise<{ ok: boolean; content_id?: string; error?: string }>;
}

export function upsertContentAsset(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    contentType: string;
    assetType: string;
    title: string;
    body?: string | null;
    storagePath?: string | null;
    externalUrl?: string | null;
    externalId?: string | null;
    mimeType?: string | null;
    metadata?: Record<string, unknown>;
    provider?: string | null;
    status?: string;
  },
): Promise<Record<string, unknown>> {
  return rpcCall(supabase, "content_asset_upsert", {
    p_package: input.packageId,
    p_content_type: input.contentType,
    p_asset_type: input.assetType,
    p_title: input.title,
    p_body: input.body ?? null,
    p_storage_path: input.storagePath ?? null,
    p_external_url: input.externalUrl ?? null,
    p_external_id: input.externalId ?? null,
    p_mime_type: input.mimeType ?? null,
    p_metadata: input.metadata ?? {},
    p_provider: input.provider ?? null,
    p_status: input.status ?? "drafted",
  }) as Promise<Record<string, unknown>>;
}

export function upsertPublication(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    provider: DestinationProvider;
    assetId: string | null;
    scheduledAt?: number | null;
  },
): Promise<Record<string, unknown>> {
  return rpcCall(supabase, "content_publication_upsert", {
    p_package: input.packageId,
    p_provider: input.provider,
    p_asset: input.assetId,
    p_status: "queued",
    p_scheduled_at: input.scheduledAt ?? null,
  }) as Promise<Record<string, unknown>>;
}

export function reviewPackage(
  supabase: SupabaseClient,
  input: {
    packageId: string;
    decision: "approved" | "rejected" | "needs_changes" | "in_review";
    note?: string | null;
  },
): Promise<{ ok: boolean; status?: string; approvalStatus?: string; error?: string }> {
  return rpcCall(supabase, "content_review_decide", {
    p_content_id: input.packageId,
    p_decision: input.decision,
    p_note: input.note ?? null,
  }) as Promise<{ ok: boolean; status?: string; approvalStatus?: string; error?: string }>;
}

export function publishBlogPackage(
  supabase: SupabaseClient,
  input: { packageId: string; slug?: string | null; baseUrl?: string | null },
): Promise<{ ok: boolean; slug?: string; canonicalUrl?: string | null; error?: string }> {
  return rpcCall(supabase, "content_publish_blog", {
    p_content_id: input.packageId,
    p_slug: input.slug ?? null,
    p_base_url: input.baseUrl ?? null,
    p_actor: null,
  }) as Promise<{ ok: boolean; slug?: string; canonicalUrl?: string | null; error?: string }>;
}

export function saveAutomation(
  supabase: SupabaseClient,
  input: Partial<{
    enabled: boolean;
    intervalSeconds: number | null;
    requireApproval: boolean;
    autoPublish: boolean;
    brandVoice: string | null;
    audience: string | null;
    primaryCta: string | null;
    defaultTone: string | null;
  }>,
): Promise<Record<string, unknown>> {
  return rpcCall(supabase, "content_automation_upsert", {
    p_enabled: input.enabled ?? null,
    p_interval_seconds: input.intervalSeconds ?? null,
    p_require_approval: input.requireApproval ?? null,
    p_auto_publish: input.autoPublish ?? null,
    p_brand_voice: input.brandVoice ?? null,
    p_audience: input.audience ?? null,
    p_primary_cta: input.primaryCta ?? null,
    p_default_tone: input.defaultTone ?? null,
  }) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The worker's transport
//
// Publishing and media generation are server-side. This transport is the edge
// function's, not the browser's: it exists so the engine's publishers have a
// single, auditable place where a provider request is actually sent.
// ---------------------------------------------------------------------------

export function createFetchTransport(
  fetchImpl: typeof fetch = fetch,
): PublishTransport {
  return async (input: PublishTransportInput): Promise<PublishTransportResponse> => {
    let body: BodyInit | undefined;
    if (input.media) {
      const media = await fetchImpl(input.media.url);
      if (!media.ok) {
        return {
          status: media.status,
          ok: false,
          json: null,
          text: "provider_media_unavailable",
        };
      }
      body = await media.arrayBuffer();
    } else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
    }

    const response = await fetchImpl(input.url, {
      method: input.method,
      headers: {
        ...input.headers,
        ...(input.media?.contentType ? { "content-type": input.media.contentType } : {}),
      },
      body,
    });

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      ok: response.ok,
      json,
      text,
      headers,
      // LinkedIn returns the created post's URN in this header.
      externalId: headers["x-restli-id"],
    };
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Build the engine's ports against a Supabase client.
 *
 * The article writer is a port too. Atlas already has an AI runtime
 * (@/lib/ai-runtime) and the conversation-converse edge function; the caller
 * injects whichever of those is appropriate, so the engine never talks to a
 * model vendor itself.
 */
export function createContentEnginePorts(
  supabase: SupabaseClient,
  options: {
    env: ProviderEnv;
    generateArticle: (input: ArticleGenerationInput) => Promise<GeneratedArticle>;
    transport?: PublishTransport;
    now?: () => number;
    getConnection?: (provider: DestinationProvider) => Promise<ProviderConnection | null>;
    enqueue?: ContentEnginePorts["enqueue"];
  },
): ContentEnginePorts {
  const now = options.now ?? (() => Date.now());

  const missingConnection = async () => null;

  return {
    now,
    env: options.env,
    transport: options.transport ?? createFetchTransport(),
    loadPackage: (packageId) => loadContentPackage(supabase, packageId),

  // The browser never receives a token; only the worker (service role) can
  // resolve a connection, which is why this stays an injected port.
  // It deliberately FAILS CLOSED: with no resolver there is no connection, so
  // publishing reports "not connected" instead of silently succeeding.
  getConnection: options.getConnection ?? missingConnection,

    createPackage: async (input) => {
      const result = await createContentPackage(supabase, {
        topic: input.topic,
        title: input.title,
        slug: input.slug,
        tags: input.tags,
      });
      if (!result.ok || !result.content_id) {
        throw new Error(result.error ?? "The content package could not be created.");
      }
      return { packageId: result.content_id };
    },

    generateArticle: options.generateArticle,

    upsertAsset: async (input) => {
      const row = await upsertContentAsset(supabase, input);
      return { assetId: String(asRecord(row)["_id"] ?? "") };
    },

    setBlogPresentation: async (input) => {
      await rpcCall(supabase, "content_set_youtube_presentation", {
        p_package: input.packageId,
        p_youtube_url: input.youtubeUrl,
        p_youtube_video_id: input.youtubeVideoId,
        p_thumbnail_url: input.heroImageUrl,
        p_seo: input.seo ?? {},
      });
    },

    upsertPublication: async (input) => {
      const row = await upsertPublication(supabase, input);
      return { publicationId: String(asRecord(row)["_id"] ?? "") };
    },

    claimPublication: async (publicationId) => {
      const raw = await rpcCall(supabase, "content_publication_claim", {
        p_publication: publicationId,
      });
      if (!raw) return null;
      const row = asRecord(raw);
      return {
        _id: String(row["_id"]),
        organizationId: (row["organizationId"] as string | null) ?? null,
        contentPackageId: String(row["contentPackageId"] ?? ""),
        assetId: (row["assetId"] as string | null) ?? null,
        provider: row["provider"] as DestinationProvider,
        status: (row["status"] as ContentPublicationRecord["status"]) ?? "processing",
        scheduledAt: num(row["scheduledAt"]),
        attemptCount: Number(row["attemptCount"] ?? 0),
        externalId: (row["externalId"] as string | null) ?? null,
        externalUrl: (row["externalUrl"] as string | null) ?? null,
        lastError: (row["lastError"] as string | null) ?? null,
        errorClass: (row["errorClass"] as ContentPublicationRecord["errorClass"]) ?? null,
        publishedAt: num(row["publishedAt"]),
        lockedAt: num(row["lockedAt"]),
        lockExpiresAt: num(row["lockExpiresAt"]),
        idempotencyKey: String(row["idempotencyKey"] ?? ""),
      };
    },

    completePublication: async (input) => {
      await rpcCall(supabase, "content_publication_complete", {
        p_publication: input.publicationId,
        p_external_id: input.externalId,
        p_external_url: input.externalUrl,
        p_metadata: input.metadata ?? {},
      });
    },

    failPublication: async (input) => {
      await rpcCall(supabase, "content_publication_fail", {
        p_publication: input.publicationId,
        p_error: input.error,
        p_error_class: input.errorClass,
      });
    },

    requestReview: async (input) => {
      await reviewPackage(supabase, {
        packageId: input.packageId,
        decision: "in_review",
        note: input.note,
      });
    },

    enqueue:
      options.enqueue ??
      (async (input) => {
        const packageId = str(input.payload["package_id"]) ?? str(input.payload["content_id"]);
        if (packageId) {
          // The organization is derived from the package server-side; the
          // caller never supplies one.
          await rpcCall(supabase, "content_engine_enqueue", {
            p_package: packageId,
            p_job_type: input.jobType,
            p_payload: input.payload,
            p_idempotency_key: input.idempotencyKey,
          });
          return;
        }
        // Organization-level work (the automation tick) carries its tenant
        // explicitly; jobs_create_job re-verifies membership itself.
        await rpcCall(supabase, "jobs_create_job", {
          p_tenant_id: input.tenantId ?? null,
          p_job_type: input.jobType,
          p_idempotency_key: input.idempotencyKey,
          p_priority: 4,
          p_payload: input.payload,
          p_max_attempts: 3,
          p_tags: ["content-engine"],
        });
      }),

    nextTopic: async (organizationId) => {
      // Selection lives in the database so it is tenant-scoped, deterministic
      // and testable. The organization id is only honoured server-side for the
      // trusted server / platform admin; an ordinary member is resolved to
      // their own tenant and a foreign id is rejected with 42501.
      const raw = await rpcCall(supabase, "content_next_topic", {
        p_organization: organizationId,
      });
      const topic = typeof raw === "string" ? raw.trim() : "";
      return topic ? topic : null;
    },

    listDueAutomations: async () => {
      const rows = asArray<Record<string, unknown>>(
        await rpcCall(supabase, "content_automation_list_due", { limit: 25 }),
      );
      return rows.map((raw) => ({
        organizationId: (raw["organizationId"] as string | null) ?? null,
        enabled: Boolean(raw["enabled"]),
        intervalSeconds: num(raw["intervalSeconds"]),
        requireApproval: raw["requireApproval"] === undefined ? true : Boolean(raw["requireApproval"]),
        autoPublish: Boolean(raw["autoPublish"]),
        brandVoice: (raw["brandVoice"] as string | null) ?? null,
        audience: (raw["audience"] as string | null) ?? null,
        primaryCta: (raw["primaryCta"] as string | null) ?? null,
        defaultTone: (raw["defaultTone"] as string | null) ?? null,
        coveredTopics: Array.isArray(raw["coveredTopics"]) ? (raw["coveredTopics"] as string[]) : [],
        lastGeneratedAt: num(raw["lastGeneratedAt"]),
        lastPackageId: (raw["lastPackageId"] as string | null) ?? null,
      }));
    },

    noteTopic: async (input) => {
      await rpcCall(supabase, "content_automation_note_topic", {
        p_topic: input.topic,
        p_package: input.packageId,
      });
    },

    getAutomation: async (organizationId) => {
      void organizationId;
      // content_automation_get already resolves the caller's organization
      // server-side, so a caller cannot read another organization's settings.
      return loadAutomation(supabase);
    },
  };
}
