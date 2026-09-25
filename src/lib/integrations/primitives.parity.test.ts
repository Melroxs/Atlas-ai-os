/**
 * Parity tests for the integration primitives.
 *
 * The Edge Functions run a COPY of `src/lib/integrations/primitives.ts`
 * (../supabase/functions/_shared/integration/primitives.ts) because the bundler
 * cannot package files outside the function directory. A textual diff test would
 * be brittle; instead both copies are EXECUTED against identical vectors, which
 * is what actually matters: a webhook signature verified by the app-side module
 * must be accepted by the deployed function and vice versa.
 */
import { describe, expect, it } from "vitest";
import * as app from "./primitives";
import * as edge from "../../../supabase/functions/_shared/integration/primitives";

const SECRET = "whsec_parity_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
const NOW = 1_700_000_000;

async function bothFns() {
  return [
    { label: "src", mod: app },
    { label: "edge", mod: edge },
  ] as const;
}

describe("integration primitives — src/edge parity", () => {
  it("hashes and encodes identically", async () => {
    for (const { mod } of await bothFns()) {
      const digest = await mod.sha256Hex("atlas");
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).toBe(await app.sha256Hex("atlas"));
      expect(mod.base64UrlEncode(new Uint8Array([251, 255, 1]))).toBe(
        app.base64UrlEncode(new Uint8Array([251, 255, 1])),
      );
      expect(mod.base64UrlDecode(mod.base64UrlEncode(new Uint8Array([1, 2, 3])))).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    }
  });

  it("derives identical PKCE challenges for a shared verifier", async () => {
    const expected = app.base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("verifier-123"))),
    );
    expect(await edge.sha256Hex("verifier-123")).toBe(await app.sha256Hex("verifier-123"));
    expect(expected.length).toBeGreaterThan(40);
    const pair = await edge.createPkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it("verifies the same signatures with identical results", async () => {
    for (const scheme of ["stripe", "github", "slack", "timestamped_sha256", "plain_hex"] as const) {
      const timestamp = NOW;
      const signedPayload = scheme === "stripe" || scheme === "timestamped_sha256"
        ? `${timestamp}.${BODY}`
        : BODY;
      const signature = await app.signHmacSha256Hex(SECRET, signedPayload);
      expect(await edge.signHmacSha256Hex(SECRET, signedPayload)).toBe(signature);

      const header =
        scheme === "stripe" || scheme === "timestamped_sha256"
          ? `t=${timestamp},v1=${signature}`
          : scheme === "github"
            ? `sha256=${signature}`
            : scheme === "slack"
              ? `v0=${signature}`
              : signature;

      const input = { rawBody: BODY, header, secret: SECRET, scheme, nowSeconds: NOW };
      const appResult = await app.verifyWebhookSignature(input);
      const edgeResult = await edge.verifyWebhookSignature(input);
      expect(edgeResult).toEqual(appResult);
      expect(appResult.ok).toBe(true);
    }
  });

  it("rejects tampered bodies, wrong secrets and stale timestamps identically", async () => {
    const signature = await app.signHmacSha256Hex(SECRET, `${NOW}.${BODY}`);
    const header = `t=${NOW},v1=${signature}`;

    const cases = [
      { rawBody: `${BODY} `, header, secret: SECRET, scheme: "stripe" as const, nowSeconds: NOW },
      { rawBody: BODY, header, secret: "other", scheme: "stripe" as const, nowSeconds: NOW },
      { rawBody: BODY, header, secret: SECRET, scheme: "stripe" as const, nowSeconds: NOW + 3600 },
      { rawBody: BODY, header: "t=abc,v1=zz", secret: SECRET, scheme: "stripe" as const, nowSeconds: NOW },
      { rawBody: BODY, header: null, secret: SECRET, scheme: "stripe" as const, nowSeconds: NOW },
      { rawBody: BODY, header, secret: "", scheme: "stripe" as const, nowSeconds: NOW },
    ];

    for (const input of cases) {
      const appResult = await app.verifyWebhookSignature(input);
      expect(appResult.ok).toBe(false);
      expect(await edge.verifyWebhookSignature(input)).toEqual(appResult);
    }
  });

  it("guards payloads and derives dedupe keys identically", () => {
    const tooLarge = JSON.stringify({ pad: "x".repeat(app.MAX_WEBHOOK_BYTES + 10) });
    for (const body of [tooLarge, "", "not json", "[1,2,3]", '"str"']) {
      expect(edge.guardWebhookPayload(body)).toEqual(app.guardWebhookPayload(body));
      expect(app.guardWebhookPayload(body).ok).toBe(false);
    }
    expect(edge.guardWebhookPayload(BODY)).toEqual({ ok: true });
    expect(edge.webhookDedupeKey("jobnimbus", "evt_1")).toBe(app.webhookDedupeKey("jobnimbus", "evt_1"));
  });

  it("seals and opens credentials identically and detects tampering", async () => {
    const key = "integration-credential-key";
    const sealedByApp = await app.sealCredential("access-token-value", key, 3);
    expect(sealedByApp.sealed.startsWith("v3.")).toBe(true);
    // Cross-copy: sealed by the app, opened by the deployed copy.
    expect(await edge.openCredential(sealedByApp.sealed, key)).toBe("access-token-value");

    const sealedByEdge = await edge.sealCredential("refresh-token-value", key);
    expect(await app.openCredential(sealedByEdge.sealed, key)).toBe("refresh-token-value");

    const tampered = `${sealedByApp.sealed.slice(0, -4)}AAAA`;
    await expect(edge.openCredential(tampered, key)).rejects.toThrow();
    await expect(app.openCredential(sealedByApp.sealed, "wrong-key")).rejects.toThrow();
  });
});
