// ---------------------------------------------------------------------------
// Atlas Integration Platform — inbound webhook pipeline (§8)
//
//   receive → authenticate → validate signature → identify provider
//           → identify organization → identify event → deduplicate
//           → persist → enqueue work → record result
//
// The pipeline is written against injected PORTS so the exact production logic is
// unit-testable without a database, and so the Edge Function that runs it in
// production is a thin adapter over these steps.
//
// Idempotency is enforced at TWO levels:
//   1. `integration_event_ingest` (unique provider+external_event_id) — a replay
//      returns the same event id and enqueues nothing.
//   2. the job idempotency key derived from that same event key — even if two
//      duplicate deliveries race past the ingest, `jobs_create_job` collapses
//      them into one work item.
// ---------------------------------------------------------------------------

import {
  guardWebhookPayload,
  verifyWebhookSignature,
  webhookDedupeKey,
  type SignatureScheme,
} from "./primitives";
import { classifyIntegrationError, type IntegrationErrorClass } from "./errors";
import type { WebhookNormalization } from "./types";

export type WebhookOutcome =
  | "accepted"
  | "duplicate"
  | "signature_invalid"
  | "payload_invalid"
  | "provider_unknown"
  | "normalization_failed"
  | "organization_unresolved"
  | "processing_failed";

export interface WebhookResult {
  outcome: WebhookOutcome;
  /** HTTP status the caller should return to the provider. */
  status: number;
  provider: string;
  eventId: string | null;
  duplicate: boolean;
  jobId: string | null;
  errorClass: IntegrationErrorClass | null;
  detail?: string;
}

export interface WebhookProviderPolicy {
  provider: string;
  scheme: SignatureScheme;
  /** Env var name holding the signing secret (never the secret itself). */
  secretEnvVar: string;
}

export interface WebhookPorts {
  now: () => number;
  log: (event: string, detail?: Record<string, unknown>) => void;
  /** Resolve the Atlas organization + connection for this provider event. */
  resolveOrganization: (input: {
    provider: string;
    externalAccountId: string | null;
    normalization: WebhookNormalization;
  }) => Promise<{ organizationId: string | null; connectionId: string | null }>;
  /** Durable, idempotent event intake. Returns duplicate=true on replay. */
  ingestEvent: (input: {
    organizationId: string;
    provider: string;
    connectionId: string | null;
    externalEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    payloadSha256: string | null;
    signatureVerified: boolean;
    receivedAt: number;
  }) => Promise<{ eventId: string; duplicate: boolean }>;
  /** Enqueue the existing Atlas job queue. Must be idempotent on the key. */
  enqueueJob: (input: {
    organizationId: string;
    jobType: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }) => Promise<{ jobId: string | null }>;
  finishEvent: (input: {
    eventId: string;
    status: "processed" | "ignored" | "failed";
    jobId: string | null;
    error: string | null;
    errorClass: IntegrationErrorClass | null;
  }) => Promise<void>;
}

export interface InboundWebhookInput {
  policy: WebhookProviderPolicy;
  /** Raw body exactly as received. Never a re-serialized object. */
  rawBody: string;
  signatureHeader: string | null;
  /** The provider's signing secret, resolved server-side from the environment. */
  secret: string;
  headers?: Record<string, string>;
  /** Atlas job type enqueued for accepted events. */
  jobType?: string;
  /** Normalize the provider body. Supplied by the provider adapter. */
  normalize: (body: Record<string, unknown>) => WebhookNormalization | null;
  ports: WebhookPorts;
}

/**
 * Run the inbound pipeline. Always returns a WebhookResult — it never throws, so
 * the edge function cannot accidentally 500 in a way that makes a provider
 * retry a permanently invalid request.
 */
export async function handleInboundWebhook(input: InboundWebhookInput): Promise<WebhookResult> {
  const { policy, ports } = input;
  const now = ports.now();

  const guard = guardWebhookPayload(input.rawBody);
  if (!guard.ok) {
    ports.log("webhook.payload_rejected", { provider: policy.provider, reason: guard.reason });
    return {
      outcome: "payload_invalid",
      status: 400,
      provider: policy.provider,
      eventId: null,
      duplicate: false,
      jobId: null,
      errorClass: "webhook_invalid",
      detail: guard.reason,
    };
  }

  const signature = await verifyWebhookSignature({
    rawBody: input.rawBody,
    header: input.signatureHeader,
    secret: input.secret,
    scheme: policy.scheme,
    nowSeconds: Math.floor(now / 1000),
  });
  if (!signature.ok) {
    ports.log("webhook.signature_rejected", { provider: policy.provider, reason: signature.reason });
    return {
      outcome: "signature_invalid",
      // 401: the caller is not the provider. Never 200 — a 200 would tell a
      // forger the delivery succeeded.
      status: 401,
      provider: policy.provider,
      eventId: null,
      duplicate: false,
      jobId: null,
      errorClass: "webhook_invalid",
      detail: signature.reason,
    };
  }

  const body = JSON.parse(input.rawBody) as Record<string, unknown>;
  const normalization = input.normalize(body);
  if (!normalization) {
    ports.log("webhook.normalization_failed", { provider: policy.provider });
    return {
      outcome: "normalization_failed",
      status: 202,
      provider: policy.provider,
      eventId: null,
      duplicate: false,
      jobId: null,
      errorClass: "invalid_request",
    };
  }

  const resolved = await ports.resolveOrganization({
    provider: policy.provider,
    externalAccountId: normalization.externalAccountId ?? null,
    normalization,
  });
  if (!resolved.organizationId) {
    // Signature is valid but Atlas cannot attribute the event: record it loudly
    // and answer 202 so the provider stops retrying a request Atlas can never
    // resolve on its own.
    ports.log("webhook.organization_unresolved", {
      provider: policy.provider,
      externalEventId: normalization.externalEventId,
    });
    return {
      outcome: "organization_unresolved",
      status: 202,
      provider: policy.provider,
      eventId: null,
      duplicate: false,
      jobId: null,
      errorClass: "mapping_failed",
    };
  }

  try {
    const ingested = await ports.ingestEvent({
      organizationId: resolved.organizationId,
      provider: policy.provider,
      connectionId: resolved.connectionId,
      externalEventId: normalization.externalEventId,
      eventType: normalization.eventType,
      payload: normalization.payload,
      payloadSha256: null,
      signatureVerified: true,
      receivedAt: now,
    });

    if (ingested.duplicate) {
      ports.log("webhook.duplicate_ignored", {
        provider: policy.provider,
        externalEventId: normalization.externalEventId,
        eventId: ingested.eventId,
      });
      return {
        outcome: "duplicate",
        status: 200,
        provider: policy.provider,
        eventId: ingested.eventId,
        duplicate: true,
        jobId: null,
        errorClass: null,
      };
    }

    const job = await ports.enqueueJob({
      organizationId: resolved.organizationId,
      jobType: input.jobType ?? "integration.process_event",
      idempotencyKey: webhookDedupeKey(policy.provider, normalization.externalEventId),
      payload: {
        provider: policy.provider,
        event_id: ingested.eventId,
        event_type: normalization.eventType,
        resource_type: normalization.resourceType ?? null,
        external_resource_id: normalization.externalResourceId ?? null,
        connection_id: resolved.connectionId,
      },
    });

    await ports.finishEvent({
      eventId: ingested.eventId,
      status: "processed",
      jobId: job.jobId,
      error: null,
      errorClass: null,
    });

    return {
      outcome: "accepted",
      status: 202,
      provider: policy.provider,
      eventId: ingested.eventId,
      duplicate: false,
      jobId: job.jobId,
      errorClass: null,
    };
  } catch (error) {
    const classified = classifyIntegrationError({ error, fallback: "unknown" });
    ports.log("webhook.processing_failed", {
      provider: policy.provider,
      errorClass: classified.errorClass,
    });
    return {
      outcome: "processing_failed",
      // 500 so the provider retries: the signature was valid and the failure was
      // Atlas-side, i.e. genuinely transient.
      status: 500,
      provider: policy.provider,
      eventId: null,
      duplicate: false,
      jobId: null,
      errorClass: classified.errorClass,
      detail: classified.detail,
    };
  }
}
