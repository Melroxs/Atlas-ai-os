// ---------------------------------------------------------------------------
// Atlas integrations-webhook — the generic, signature-verified inbound pipeline
//
//   POST /functions/v1/integrations-webhook/<provider>?connectionId=<uuid>
//
// This is the deployed form of src/lib/integrations/webhook.ts:
//
//   receive → size guard → verify signature → identify provider (path)
//           → identify organization (OUR connection row) → normalize event
//           → deduplicate (integration_events unique index) → enqueue
//             the EXISTING atlas_jobs queue → record result
//
// Security contract:
//   * A missing/invalid signature is a 401 and does NO work. Never 200 — that
//     would tell a forger the delivery succeeded.
//   * The organization comes from the connection row the webhook URL was issued
//     for. A provider (or attacker) cannot choose the tenant.
//   * Duplicate deliveries return 200 and enqueue nothing (double idempotency:
//     the event ledger AND the job idempotency key).
//   * Signature-verified but Atlas-side failures are 500 so the provider retries.
//   * Signature scheme is per-provider (see PROVIDER_POLICIES). Providers whose
//     signing scheme is not publicly documented use the generic
//     `t=<sec>,v1=<hmac-sha256>` contract and MUST be confirmed against the
//     provider's real signature header when their connector is implemented —
//     this file never guesses one.
// ---------------------------------------------------------------------------

import {
  atlasEdgeCorsHeaders,
  atlasEdgeError,
  atlasEdgeJson,
  atlasEdgePreflight,
} from "../_shared/edge-auth.ts";
import {
  guardWebhookPayload,
  verifyWebhookSignature,
  webhookDedupeKey,
  type SignatureScheme,
} from "../_shared/integration/primitives.ts";
import { loadConnection, log, rpc, webhookSecretFor } from "../_shared/integration/service.ts";

interface ProviderPolicy {
  scheme: SignatureScheme;
  /** Header that carries the provider's signature. */
  signatureHeader: string;
  jobType: string;
}

/**
 * Signature policies per provider.
 *
 * `timestamped_sha256` is Atlas's own generic contract (HMAC-SHA256 over
 * `<timestamp>.<rawBody>` with a 5-minute replay window). It is what a provider
 * uses until its connector replaces it with the provider's documented scheme.
 */
const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  stripe: { scheme: "stripe", signatureHeader: "stripe-signature", jobType: "integration.process_event" },
  github: { scheme: "github", signatureHeader: "x-hub-signature-256", jobType: "integration.process_event" },
  slack: { scheme: "slack", signatureHeader: "x-slack-signature", jobType: "integration.process_event" },
  jobnimbus: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
  companycam: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
  whatsapp: { scheme: "timestamped_sha256", signatureHeader: "x-hub-signature-256", jobType: "integration.process_event" },
  acculynx: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
  eagleview: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
  hover: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
  xactimate: { scheme: "timestamped_sha256", signatureHeader: "x-atlas-signature", jobType: "integration.process_event" },
};

const TOLERANCE_SECONDS = 300;

function jsonResponse(body: unknown, status: number, request: Request): Response {
  const headers = atlasEdgeCorsHeaders(request);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (req) => {
  const preflight = atlasEdgePreflight(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  // <provider> from /integrations-webhook/<provider>
  const provider = (url.pathname.split("/").pop() ?? "").toLowerCase();

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, req);
  }
  if (!provider) {
    return atlasEdgeError("Provider is required in the URL path.", 400, atlasEdgeCorsHeaders(req));
  }
  const policy = PROVIDER_POLICIES[provider];
  if (!policy) {
    return atlasEdgeError(`Unknown integration provider "${provider}".`, 404, atlasEdgeCorsHeaders(req));
  }

  const rawBody = await req.text();
  const now = Date.now();

  // 1. Payload guard: reject before parsing anything.
  const guard = guardWebhookPayload(rawBody);
  if (!guard.ok) {
    log("webhook.payload_rejected", { provider, reason: guard.reason });
    return jsonResponse({ error: "Invalid webhook payload.", reason: guard.reason }, 400, req);
  }

  // 2. Signature: the gate. No secret configured => every delivery is rejected.
  const secret = webhookSecretFor(provider);
  const verification = await verifyWebhookSignature({
    rawBody,
    header: req.headers.get(policy.signatureHeader),
    secret,
    scheme: policy.scheme,
    nowSeconds: Math.floor(now / 1000),
    toleranceSeconds: TOLERANCE_SECONDS,
  });
  if (!verification.ok) {
    log("webhook.signature_rejected", { provider, reason: verification.reason });
    return jsonResponse(
      { error: "Webhook signature verification failed.", reason: verification.reason },
      401,
      req,
    );
  }

  // 3. Organization binding from OUR connection row.
  const connectionId = url.searchParams.get("connectionId") ?? "";
  if (!connectionId) {
    log("webhook.connection_missing", { provider });
    return jsonResponse({ error: "This webhook URL is not bound to a connection." }, 400, req);
  }
  const connection = await loadConnection(connectionId);
  if (!connection || connection.provider !== provider) {
    log("webhook.connection_unknown", { provider, connectionIdProvided: true });
    // 202: the signature was valid, so retrying cannot help Atlas resolve it.
    return jsonResponse({ received: true, processed: false, reason: "organization_unresolved" }, 202, req);
  }

  const body = JSON.parse(rawBody) as Record<string, unknown>;

  // 4. Event identity. Providers without a documented event id get a
  //    content-derived identity — flagged so the connector author MUST replace
  //    it with the provider's real event id when the connector is implemented.
  const providerEventId =
    typeof body.event_id === "string" && body.event_id
      ? body.event_id
      : typeof body.id === "string" && body.id
        ? body.id
        : `content:${await sha256Hex(rawBody)}`;
  const eventType =
    typeof body.event === "string" && body.event
      ? body.event
      : typeof body.type === "string" && body.type
        ? body.type
        : "unknown";

  try {
    // 5. Durable, idempotent intake.
    const ingested = await rpc<{ duplicate: boolean; event_id: string; job_id: string | null }>(
      "integration_event_ingest",
      {
        p_organization_id: connection.tenantId,
        p_provider: provider,
        p_external_event_id: providerEventId,
        p_event_type: eventType,
        p_payload: body,
        p_payload_sha256: await sha256Hex(rawBody),
        p_connection_id: connection._id,
        p_signature_verified: true,
        p_received_at: now,
      },
    );

    if (ingested.duplicate) {
      log("webhook.duplicate_ignored", { provider, eventId: ingested.event_id });
      await rpc("integration_event_finish", {
        p_event_id: ingested.event_id,
        p_status: "ignored",
        p_job_id: null,
        p_error: null,
        p_error_class: null,
      }).catch(() => {});
      return jsonResponse({ received: true, duplicate: true, event_id: ingested.event_id }, 200, req);
    }

    // 6. Feed the EXISTING durable queue (no second work system).
    const job = await rpc<{ job_id: string | null }>("jobs_create_job", {
      p_tenant_id: connection.tenantId,
      p_job_type: policy.jobType,
      p_idempotency_key: webhookDedupeKey(provider, providerEventId),
      p_priority: 3,
      p_payload: {
        provider,
        event_id: ingested.event_id,
        event_type: eventType,
        connection_id: connection._id,
      },
      p_tags: ["integration", provider],
    });

    await rpc("integration_event_finish", {
      p_event_id: ingested.event_id,
      p_status: "processed",
      p_job_id: job?.job_id ?? null,
      p_error: null,
      p_error_class: null,
    });

    log("webhook.accepted", { provider, eventId: ingested.event_id, jobId: job?.job_id ?? null });
    return jsonResponse({ received: true, event_id: ingested.event_id, job_id: job?.job_id ?? null }, 202, req);
  } catch (error) {
    log("webhook.processing_failed", {
      provider,
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return jsonResponse({ error: "Webhook processing failed." }, 500, req);
  }
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
