// ---------------------------------------------------------------------------
// Atlas Integration Platform — external identity mapping & provenance (§11, §12)
//
// External systems never become the Atlas data model. Every imported record is
// addressed by a STABLE external key and carries provenance back to the provider
// it came from. Nothing here matches on a name, an email address or a fuzzy
// heuristic: if a stable external id is missing, the record is rejected rather
// than guessed at.
// ---------------------------------------------------------------------------

import type { AtlasMapping, AtlasObject, ExternalRecord, IntegrationProvenance } from "./types";

/** Canonical external key: (provider, resourceType, externalId). */
export function externalRefKey(input: {
  provider: string;
  resourceType: string;
  externalId: string;
}): string {
  return `${input.provider}:${input.resourceType}:${input.externalId}`;
}

export type RefValidation =
  | { ok: true }
  | { ok: false; reason: "missing_provider" | "missing_resource_type" | "missing_external_id" | "unsafe_external_id" };

/** Reject ids that could be used to smuggle a path, query or control character. */
export function validateExternalRef(input: {
  provider?: string | null;
  resourceType?: string | null;
  externalId?: string | null;
}): RefValidation {
  if (!input.provider) return { ok: false, reason: "missing_provider" };
  if (!input.resourceType) return { ok: false, reason: "missing_resource_type" };
  if (!input.externalId) return { ok: false, reason: "missing_external_id" };
  if (input.externalId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.externalId)) {
    return { ok: false, reason: "unsafe_external_id" };
  }
  return { ok: true };
}

export function buildProvenance(input: {
  provider: string;
  externalId: string;
  connectionId?: string | null;
  accountName?: string | null;
  externalParentId?: string | null;
  externalCreatedAt?: number | null;
  externalUpdatedAt?: number | null;
  now?: number;
}): IntegrationProvenance {
  const now = input.now ?? Date.now();
  return {
    provider: input.provider,
    externalId: input.externalId,
    externalParentId: input.externalParentId ?? null,
    connectionId: input.connectionId ?? null,
    accountName: input.accountName ?? null,
    externalCreatedAt: input.externalCreatedAt ?? null,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    importedAt: now,
    lastSeenAt: now,
    importedBy: "integration",
  };
}

/** Default canonical object for a provider resource family. */
export function atlasObjectForResourceType(resourceType: string): AtlasObject | null {
  const map: Record<string, AtlasObject> = {
    message: "message",
    thread: "conversation",
    conversation: "conversation",
    contact: "contact",
    customer: "customer",
    job: "job",
    claim: "claim",
    estimate: "estimate",
    estimate_line_item: "estimate_line_item",
    document: "document",
    attachment: "document",
    photo: "photo",
    task: "task",
    payment: "payment",
    property: "property",
  };
  return map[resourceType] ?? null;
}

/**
 * Build the Atlas mapping for one external record.
 *
 * Returns null (rather than a best guess) when the record cannot be addressed
 * stably or its resource family has no canonical counterpart — the engine then
 * records it as a failed mapping for an operator instead of importing garbage.
 */
export function mapRecordToAtlas(input: {
  provider: string;
  record: ExternalRecord;
  connectionId?: string | null;
  accountName?: string | null;
  /** Resolved Atlas id for an already-mapped external record, when known. */
  existingAtlasId?: string | null;
  now?: number;
}): AtlasMapping | null {
  const { provider, record } = input;
  const validation = validateExternalRef({
    provider,
    resourceType: record.resourceType,
    externalId: record.externalId,
  });
  if (!validation.ok) return null;

  const atlasObject = atlasObjectForResourceType(record.resourceType);
  if (!atlasObject) return null;

  return {
    atlasObject,
    atlasId: input.existingAtlasId ?? null,
    provenance: buildProvenance({
      provider,
      externalId: record.externalId,
      connectionId: input.connectionId,
      accountName: input.accountName,
      externalParentId: record.externalParentId,
      externalCreatedAt: record.externalCreatedAt,
      externalUpdatedAt: record.externalUpdatedAt,
      now: input.now,
    }),
  };
}

/**
 * Decide whether a record needs to be (re)processed.
 *
 * A record is skipped only when Atlas has already seen an equal-or-newer
 * provider version of it — an older provider payload never overwrites something
 * newer (the same watermark rule the billing webhook uses).
 */
export function shouldProcessRecord(input: {
  record: ExternalRecord;
  existing?: { externalUpdatedAt?: number | null } | null;
}): boolean {
  if (input.record.externalDeleted) return true;
  const seen = input.existing?.externalUpdatedAt ?? null;
  const incoming = input.record.externalUpdatedAt ?? null;
  if (seen === null || incoming === null) return true;
  return incoming >= seen;
}
