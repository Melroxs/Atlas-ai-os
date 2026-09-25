import { describe, expect, it, vi } from "vitest";
import { signHmacSha256Hex } from "./primitives";
import { handleInboundWebhook, type WebhookPorts } from "./webhook";
import type { WebhookNormalization } from "./types";

const SECRET = "whsec_integration_test";
const NOW = 1_700_000_000_000;
const BODY = JSON.stringify({ event: "task.created", data: { id: "task-1" } });

function createPorts(overrides: Partial<WebhookPorts> = {}) {
  const calls = {
    ingest: [] as Array<Record<string, unknown>>,
    jobs: [] as Array<Record<string, unknown>>,
    finished: [] as Array<Record<string, unknown>>,
    logs: [] as Array<{ event: string; detail?: Record<string, unknown> }>,
  };
  const ports: WebhookPorts = {
    now: () => NOW,
    log: (event, detail) => calls.logs.push({ event, detail }),
    resolveOrganization: async () => ({ organizationId: "org-1", connectionId: "conn-1" }),
    ingestEvent: async (input) => {
      calls.ingest.push(input);
      return { eventId: "evt-1", duplicate: calls.ingest.length > 1 };
    },
    enqueueJob: async (input) => {
      calls.jobs.push(input);
      return { jobId: "job-1" };
    },
    finishEvent: async (input) => {
      calls.finished.push(input);
    },
    ...overrides,
  };
  return { ports, calls };
}

function normalize(body: Record<string, unknown>): WebhookNormalization | null {
  const data = body.data as { id?: string } | undefined;
  if (!data?.id) return null;
  return {
    externalEventId: `task.created:${data.id}`,
    eventType: "task.created",
    resourceType: "task",
    externalResourceId: data.id,
    payload: { id: data.id },
  };
}

async function signedHeader(body = BODY, timestamp = Math.floor(NOW / 1000)) {
  const signature = await signHmacSha256Hex(SECRET, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${signature}`;
}

describe("webhook — authentication", () => {
  it("accepts a correctly signed delivery and enqueues exactly one work item", async () => {
    const { ports, calls } = createPorts();
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "JOBNIMBUS_WEBHOOK_SECRET" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: SECRET,
      normalize,
      ports,
    });

    expect(result).toMatchObject({ outcome: "accepted", status: 202, duplicate: false, jobId: "job-1" });
    expect(calls.ingest).toHaveLength(1);
    expect(calls.jobs).toHaveLength(1);
    expect(calls.jobs[0].idempotencyKey).toBe("jobnimbus:task.created:task-1");
    expect(calls.finished[0]).toMatchObject({ status: "processed", jobId: "job-1" });
  });

  it("rejects a forged signature with 401 and does no work", async () => {
    const { ports, calls } = createPorts();
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: `t=${Math.floor(NOW / 1000)},v1=deadbeef`,
      secret: SECRET,
      normalize,
      ports,
    });

    expect(result.status).toBe(401);
    expect(result.outcome).toBe("signature_invalid");
    expect(calls.ingest).toHaveLength(0);
    expect(calls.jobs).toHaveLength(0);
  });

  it("rejects a replayed delivery that is older than the tolerance window", async () => {
    const { ports } = createPorts();
    const stale = await signedHeader(BODY, Math.floor(NOW / 1000) - 3600);
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: stale,
      secret: SECRET,
      normalize,
      ports,
    });
    expect(result).toMatchObject({ outcome: "signature_invalid", status: 401 });
  });

  it("rejects a missing secret (provider not configured) rather than trusting the body", async () => {
    const { ports } = createPorts();
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: "",
      normalize,
      ports,
    });
    expect(result.status).toBe(401);
  });

  it("rejects an oversized or non-object payload before parsing", async () => {
    for (const rawBody of ["x".repeat(600_000), "not-json", "[1,2]"]) {
      const { ports } = createPorts();
      const result = await handleInboundWebhook({
        policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
        rawBody,
        signatureHeader: "t=1,v1=ab",
        secret: SECRET,
        normalize,
        ports,
      });
      expect(result.status).toBe(400);
      expect(result.outcome).toBe("payload_invalid");
    }
  });
});

describe("webhook — idempotency", () => {
  it("a duplicate delivery enqueues nothing and returns 200", async () => {
    const { ports, calls } = createPorts();
    const input = {
      policy: { provider: "jobnimbus" as const, scheme: "stripe" as const, secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: SECRET,
      normalize,
      ports,
    };

    const first = await handleInboundWebhook(input);
    const second = await handleInboundWebhook(input);

    expect(first.outcome).toBe("accepted");
    expect(second).toMatchObject({ outcome: "duplicate", status: 200, duplicate: true });
    // Two ingests, ONE job: the duplicate never reaches the queue.
    expect(calls.ingest).toHaveLength(2);
    expect(calls.jobs).toHaveLength(1);
    expect(calls.finished).toHaveLength(1);
  });

  it("derives a stable dedupe key from provider + provider event id", async () => {
    const { ports, calls } = createPorts();
    await handleInboundWebhook({
      policy: { provider: "whatsapp", scheme: "github", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: `sha256=${await signHmacSha256Hex(SECRET, BODY)}`,
      secret: SECRET,
      normalize,
      ports,
    });
    expect(calls.jobs[0].idempotencyKey).toBe("whatsapp:task.created:task-1");
  });
});

describe("webhook — unattributable and failing events", () => {
  it("answers 202 without enqueueing when the organization cannot be resolved", async () => {
    const { ports, calls } = createPorts({
      resolveOrganization: async () => ({ organizationId: null, connectionId: null }),
    });
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: SECRET,
      normalize,
      ports,
    });
    expect(result).toMatchObject({ outcome: "organization_unresolved", status: 202 });
    expect(calls.jobs).toHaveLength(0);
    expect(calls.logs.some((l) => l.event === "webhook.organization_unresolved")).toBe(true);
  });

  it("reports an unnormalizable event without importing anything", async () => {
    const { ports, calls } = createPorts();
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: JSON.stringify({ event: "unknown.shape" }),
      signatureHeader: await signedHeader(JSON.stringify({ event: "unknown.shape" })),
      secret: SECRET,
      normalize,
      ports,
    });
    expect(result).toMatchObject({ outcome: "normalization_failed", status: 202 });
    expect(calls.jobs).toHaveLength(0);
  });

  it("returns 500 when Atlas-side processing fails so the provider retries", async () => {
    const { ports } = createPorts({
      ingestEvent: async () => {
        throw new Error("database unavailable");
      },
    });
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: SECRET,
      normalize,
      ports,
    });
    expect(result).toMatchObject({ outcome: "processing_failed", status: 500 });
  });

  it("turns an exploding ingest port into a 500 the provider can retry", async () => {
    const { ports } = createPorts({
      enqueueJob: async () => {
        throw new Error("queue unavailable");
      },
    });
    const result = await handleInboundWebhook({
      policy: { provider: "jobnimbus", scheme: "stripe", secretEnvVar: "S" },
      rawBody: BODY,
      signatureHeader: await signedHeader(),
      secret: SECRET,
      normalize,
      ports,
    });
    expect(result).toMatchObject({ outcome: "processing_failed", status: 500 });
  });
});
