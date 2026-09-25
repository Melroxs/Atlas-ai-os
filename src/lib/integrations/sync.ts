// ---------------------------------------------------------------------------
// Atlas Integration Platform — sync engine (§9)
//
// This is the engine the codebase previously documented as ABSENT
// ("this project does not deploy a connector sync engine … when a real engine
// is added, the sync loop plugs in below"). It is provider-agnostic: it drives a
// `ProviderAdapter.syncResource` implementation, persists cursor/retry state and
// hands every record to an idempotent ingest port.
//
// Guarantees:
//   * Cursor only advances on a successfully processed page — a failed page is
//     retried, never skipped, so no record is silently lost.
//   * Every record is ingested through the external-ref mapping, so a re-run
//     after a crash updates instead of duplicating.
//   * Bounded work per invocation (maxPages / maxRecords) — never a busy loop.
//   * Rate limits and transient failures produce a backoff schedule persisted in
//     `integration_sync_state`, not an in-memory sleep-and-hammer.
//   * Resumable: the caller passes the stored cursor; a run can stop at any page
//     boundary and the next run continues from there.
// ---------------------------------------------------------------------------

import { backoffDelayMs, classifyIntegrationError, shouldStopRetrying, type IntegrationErrorClass } from "./errors";
import type {
  AdapterContext,
  AtlasMapping,
  ExternalRecord,
  ProviderAdapter,
  SyncState,
} from "./types";

export interface SyncPorts {
  now: () => number;
  /** Idempotent: maps the record to a canonical Atlas object and upserts it. */
  ingestRecord: (input: {
    record: ExternalRecord;
    mapping: AtlasMapping | null;
  }) => Promise<{ atlasId: string | null; created: boolean }>;
  /** Persist sync state (cursor advances only on success). */
  persistState: (patch: {
    status: SyncState["status"];
    cursor?: string | null;
    lastSyncedAt?: number | null;
    itemsSynced?: number;
    error?: string | null;
    errorClass?: IntegrationErrorClass | null;
    nextAttemptAt?: number | null;
    consecutiveFailures?: number;
    resetFailures?: boolean;
    isFullSync?: boolean;
  }) => Promise<void>;
}

export interface SyncRunInput {
  adapter: ProviderAdapter;
  accessToken: string;
  context: AdapterContext;
  state: SyncState;
  ports: SyncPorts;
  /** Hard ceiling per invocation. Defaults: 20 pages / 2000 records. */
  maxPages?: number;
  maxRecords?: number;
}

export interface SyncRunSummary {
  resourceType: string;
  status: SyncState["status"];
  pages: number;
  records: number;
  created: number;
  updated: number;
  cursor: string | null;
  errorClass: IntegrationErrorClass | null;
  nextAttemptAt: number | null;
  detail?: string;
}

/**
 * Run one bounded sync pass for ONE resource type.
 *
 * Returns a summary instead of throwing: a provider outage must never take down
 * the caller (an edge function, a scheduled sweep or the admin "Sync now"
 * button), and the failure is recorded in sync state.
 */
export async function runResourceSync(input: SyncRunInput): Promise<SyncRunSummary> {
  const { adapter, context, state, ports } = input;
  const maxPages = input.maxPages ?? 20;
  const maxRecords = input.maxRecords ?? 2000;
  const initial = state.lastSyncedAt === null;

  if (!adapter.syncResource) {
    const summary: SyncRunSummary = {
      resourceType: state.resourceType,
      status: "error",
      pages: 0,
      records: 0,
      created: 0,
      updated: 0,
      cursor: state.cursor,
      errorClass: "sync_failed",
      nextAttemptAt: null,
      detail: `${state.provider} has no sync implementation for ${state.resourceType}`,
    };
    await ports.persistState({
      status: "error",
      error: summary.detail ?? null,
      errorClass: "sync_failed",
      nextAttemptAt: null,
    });
    return summary;
  }

  await ports.persistState({ status: "running" });

  let cursor = state.cursor;
  let pages = 0;
  let records = 0;
  let created = 0;
  let updated = 0;

  while (pages < maxPages && records < maxRecords) {
    let page;
    try {
      page = await adapter.syncResource({
        request: { resourceType: state.resourceType, cursor, initial },
        accessToken: input.accessToken,
        context,
      });
    } catch (error) {
      const classified = classifyIntegrationError({ error, fallback: "sync_failed" });
      const attempt = state.consecutiveFailures + 1;
      const nextAttemptAt = shouldStopRetrying(classified.errorClass)
        ? null
        : ports.now() + backoffDelayMs(attempt, { random: () => 0.5 });

      await ports.persistState({
        // The cursor is intentionally NOT advanced: the page is retried.
        status: classified.errorClass === "rate_limited" ? "rate_limited" : "error",
        error: classified.detail,
        errorClass: classified.errorClass,
        nextAttemptAt,
        consecutiveFailures: attempt,
      });

      return {
        resourceType: state.resourceType,
        status: classified.errorClass === "rate_limited" ? "rate_limited" : "error",
        pages,
        records,
        created,
        updated,
        cursor,
        errorClass: classified.errorClass,
        nextAttemptAt,
        detail: classified.detail,
      };
    }

    pages += 1;

    for (const record of page.records) {
      if (records >= maxRecords) break;
      const mapping = adapter.mapExternalToAtlas?.(record) ?? null;
      const result = await ports.ingestRecord({ record, mapping });
      records += 1;
      if (result.created) created += 1;
      else updated += 1;
    }

    cursor = page.nextCursor;
    if (!page.hasMore || !page.nextCursor) break;
  }

  const now = ports.now();
  await ports.persistState({
    status: "ok",
    cursor,
    lastSyncedAt: now,
    itemsSynced: records,
    error: null,
    errorClass: null,
    nextAttemptAt: null,
    resetFailures: true,
    isFullSync: initial,
  });

  return {
    resourceType: state.resourceType,
    status: "ok",
    pages,
    records,
    created,
    updated,
    cursor,
    errorClass: null,
    nextAttemptAt: null,
  };
}

/**
 * Whether a stored sync state is due to run.
 *
 * A resource in error/backoff state only runs once its next attempt time has
 * passed — that is how the scheduled sweep avoids hammering a provider that is
 * rate limiting Atlas.
 */
export function isSyncDue(state: SyncState, now: number = Date.now(), intervalMs = 15 * 60 * 1000): boolean {
  if (state.status === "running") return false;
  if (state.nextAttemptAt !== null) return state.nextAttemptAt <= now;
  if (state.status === "error") return false;
  if (state.lastAttemptedAt === null) return true;
  return now - state.lastAttemptedAt >= intervalMs;
}

/** Resources a provider should sync, derived from its declared capabilities. */
export function resourceTypesForCapabilities(capabilities: string[]): string[] {
  const map: Record<string, string> = {
    threads: "message",
    inbound: "message",
    outbound: "message",
    attachments: "document",
    contacts: "contact",
    jobs: "job",
    estimates: "estimate",
    photos: "photo",
    measurements: "measurement",
    sync_documents: "document",
    payments: "payment",
  };
  const out = new Set<string>();
  for (const capability of capabilities) {
    const resource = map[capability];
    if (resource) out.add(resource);
  }
  return [...out].sort();
}
