// ---------------------------------------------------------------------------
// Atlas Integration Platform — canonical types
//
// One provider model, one adapter contract, one set of lifecycle states. The
// provider LIST lives in the existing connector registry
// (src/lib/atlas-data/connectors-registry.ts) — this module never duplicates it,
// it describes the shape and the runtime contract around it.
// ---------------------------------------------------------------------------

import type { ConnectorAuthType, ConnectorCapability } from "@/lib/atlas-data/connectors-registry";

/** Provider families. Open-ended by design: a new family is a registry edit. */
export type IntegrationCategory =
  | "communication"
  | "crm"
  | "estimating"
  | "field_evidence"
  | "property_intelligence"
  | "accounting"
  | "payments"
  | "storage"
  | "document_storage"
  | "email"
  | "project_management"
  | "productivity"
  | "development"
  | "uploads"
  | "other";

export type IntegrationAuthType = ConnectorAuthType;

/**
 * How far a provider has actually been taken. These are the ONLY labels the UI
 * or a report may use, and they are derived from real artifacts:
 *
 *   foundation_ready     — the platform contract exists; nothing provider-specific
 *   connector_scaffolded — provider entry + adapter stub exist; no live calls
 *   connector_implemented— real client code exists (auth/sync/webhook wired)
 *   connector_tested     — exercised against the provider's real API in test mode
 *   production_verified  — exercised against live provider accounts in production
 *
 * A provider is NEVER reported above its highest PROVEN state.
 */
export type ConnectorLifecycle =
  | "foundation_ready"
  | "connector_scaffolded"
  | "connector_implemented"
  | "connector_tested"
  | "production_verified";

export const CONNECTOR_LIFECYCLE_LABEL: Record<ConnectorLifecycle, string> = {
  foundation_ready: "Foundation ready",
  connector_scaffolded: "Connector scaffolded",
  connector_implemented: "Connector implemented",
  connector_tested: "Connector tested",
  production_verified: "Production verified",
};

/** Capability vocabulary used by the runtime (superset of the registry). */
export type IntegrationCapability =
  | ConnectorCapability
  | "oauth"
  | "api_key"
  | "inbound"
  | "outbound"
  | "attachments"
  | "threads"
  | "contacts"
  | "jobs"
  | "estimates"
  | "photos"
  | "measurements"
  | "webhook"
  | "polling";

export type ConnectionStatus =
  | "connected"
  | "syncing"
  | "degraded"
  | "error"
  | "disconnected"
  | "pending";

/** A connection as the browser is allowed to see it (never credentials). */
export interface IntegrationConnection {
  _id: string;
  name: string;
  provider: string;
  category: string;
  status: ConnectionStatus | string;
  connectionType: string | null;
  capabilities: string[];
  accountName: string | null;
  accountEmail: string | null;
  externalAccountId: string | null;
  scopes: string[];
  lastSyncAt: number | null;
  lastAttemptedSyncAt: number | null;
  lastError: string | null;
  healthStatus: string | null;
  lastTestedAt: number | null;
  disconnectedAt: number | null;
}

/** Server-side credential material. NEVER leaves the server. */
export interface SealedCredentials {
  accessTokenSealed: string | null;
  refreshTokenSealed: string | null;
  tokenExpiresAt: number | null;
  keyVersion: number;
  scopes: string[];
}

export type EventProcessingStatus =
  | "pending"
  | "processing"
  | "processed"
  | "ignored"
  | "failed";

export interface IntegrationEventRecord {
  id: string;
  organizationId: string;
  provider: string;
  connectionId: string | null;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureVerified: boolean;
  processingStatus: EventProcessingStatus;
  attemptCount: number;
  receivedAt: number;
  processedAt: number | null;
  lastError: string | null;
  errorClass: string | null;
}

export type SyncStatus = "idle" | "running" | "ok" | "error" | "rate_limited" | "backoff";

export interface SyncState {
  connectionId: string;
  provider: string;
  resourceType: string;
  cursor: string | null;
  lastSyncedAt: number | null;
  lastAttemptedAt: number | null;
  status: SyncStatus;
  itemsSynced: number;
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  errorClass: string | null;
}

/**
 * Canonical Atlas objects an external record may map to. This is a LOGICAL
 * namespace owned by the integration layer, not a foreign key: an external
 * record can legitimately arrive before its Atlas row exists (a new job, a new
 * email thread) and must still be tracked.
 */
export type AtlasObject =
  | "customer"
  | "contact"
  | "property"
  | "job"
  | "claim"
  | "estimate"
  | "estimate_line_item"
  | "document"
  | "photo"
  | "message"
  | "conversation"
  | "task"
  | "work_item"
  | "payment";

/** Provenance attached to every imported object (§12). */
export interface IntegrationProvenance {
  provider: string;
  externalId: string;
  externalParentId?: string | null;
  connectionId?: string | null;
  accountName?: string | null;
  /** When the provider says the record was created/changed. */
  externalCreatedAt?: number | null;
  externalUpdatedAt?: number | null;
  /** When Atlas imported/last saw it. */
  importedAt: number;
  lastSeenAt: number;
  importedBy: "integration";
}

export interface AtlasMapping {
  atlasObject: AtlasObject;
  atlasId: string | null;
  provenance: IntegrationProvenance;
}

// ---------------------------------------------------------------------------
// Adapter contract (§3, §19)
// ---------------------------------------------------------------------------

/**
 * Every provider adapter receives its context explicitly. It never reads
 * environment variables itself, never reads the database itself and never
 * receives a Supabase client — persistence is the engine's job, which keeps
 * adapters pure enough to test and impossible to use as an isolation bypass.
 */
export interface AdapterContext {
  organizationId: string;
  connectionId: string;
  provider: string;
  /** Injected clock (deterministic tests). */
  now: () => number;
  /** Structured log; the engine adds request/tenant ids. */
  log: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ExternalRecord {
  externalId: string;
  resourceType: string;
  externalParentId?: string | null;
  externalCreatedAt?: number | null;
  externalUpdatedAt?: number | null;
  externalDeleted?: boolean;
  payload: Record<string, unknown>;
}

export interface SyncPage {
  records: ExternalRecord[];
  /** Opaque continuation cursor; null means "no more pages right now". */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SyncRequest {
  resourceType: string;
  cursor: string | null;
  /** True for the first sync of a resource (full history). */
  initial: boolean;
  limit?: number;
}

export interface WebhookNormalization {
  /** Stable provider event id — required for idempotency. */
  externalEventId: string;
  /** Atlas event type, e.g. "message.received", "job.updated". */
  eventType: string;
  /** External account/tenant the event belongs to, when the provider sends one. */
  externalAccountId?: string | null;
  /** Resource the event concerns, when known. */
  resourceType?: string | null;
  externalResourceId?: string | null;
  occurredAt?: number | null;
  /** Normalized body stored as the event payload. */
  payload: Record<string, unknown>;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/**
 * Capability-driven adapter contract. Only the capabilities an adapter declares
 * in the registry are required from it — `assertAdapterCapabilities` enforces
 * that at registration time, so a provider is never credited with a capability
 * it does not implement.
 */
export interface ProviderAdapter {
  provider: string;
  capabilities: IntegrationCapability[];
  /** Required when the provider's auth is OAuth. */
  buildAuthorizationUrl?: (params: AuthorizationUrlParams) => string;
  exchangeAuthorizationCode?: (params: ExchangeCodeParams) => Promise<SealedCredentials>;
  refreshCredentials?: (params: RefreshParams) => Promise<SealedCredentials>;
  validateConnection?: (params: { accessToken: string; now: () => number }) => Promise<HealthCheckResult>;
  revokeConnection?: (params: { accessToken: string }) => Promise<void>;
  /** Required when the provider can push events. */
  verifyWebhook?: (params: WebhookVerificationParams) => Promise<WebhookVerificationResult>;
  normalizeWebhookEvent?: (body: Record<string, unknown>) => WebhookNormalization | null;
  /** Required when the provider can be polled. */
  syncResource?: (params: { request: SyncRequest; accessToken: string; context: AdapterContext }) => Promise<SyncPage>;
  /** Optional: map one external record onto a canonical Atlas object. */
  mapExternalToAtlas?: (record: ExternalRecord) => AtlasMapping | null;
  /** Optional: map an Atlas action onto the provider's request shape. */
  mapAtlasToExternal?: (input: { action: string; atlasId: string; payload: Record<string, unknown> }) => Record<string, unknown>;
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  /** Provider-specific extras (access_type, prompt, audience…). */
  extra?: Record<string, string>;
}

export interface ExchangeCodeParams {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier?: string;
  now: () => number;
}

export interface RefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  now: () => number;
}

export interface WebhookVerificationParams {
  rawBody: string;
  headers: Record<string, string>;
  secret: string;
  now: () => number;
}

export type WebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

/** A provider's registry entry + adapter, when one exists. */
export interface ResolvedProvider {
  provider: string;
  lifecycle: ConnectorLifecycle;
  adapter: ProviderAdapter | null;
}
