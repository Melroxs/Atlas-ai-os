/**
 * Tests for the Paddle webhook sender-IP allowlist
 * (supabase/functions/_shared/paddle.ts).
 *
 * The module reads secrets via Deno.env at call time and fetches the current
 * IP list from https://api.paddle.com/ips, so we stub a minimal Deno global
 * and mock globalThis.fetch — the same way the Supabase Edge Runtime provides
 * them. The list itself is never hard-coded in the source; these tests pin the
 * matching/parsing/enforcement logic only.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  ipToBytes,
  ipMatchesCidr,
  webhookClientIp,
  isPaddleWebhookSource,
  enforcePaddleWebhookIpAllowlist,
} from "./paddle.ts";

const LIVE_IP_CIDRS = [
  "34.237.3.244/32",
  "34.195.105.136/32",
  "34.232.58.13/32",
  "35.155.119.135/32",
  "34.212.5.7/32",
  "52.11.166.252/32",
];

function stubDeno(env: Record<string, string> = {}) {
  (globalThis as Record<string, unknown>).Deno = {
    env: {
      get: (k: string) => env[k] ?? "",
    },
  };
}

function stubFetch(cidrs: string[] = LIVE_IP_CIDRS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(JSON.stringify({ data: { ipv4_cidrs: cidrs } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function clearIpCache() {
  delete (globalThis as Record<string, unknown>)["atlas_paddle_ips_cache"];
}

beforeEach(() => {
  stubDeno();
  clearIpCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearIpCache();
});

describe("ipMatchesCidr", () => {
  it("matches an exact /32 IPv4", () => {
    expect(ipMatchesCidr("34.237.3.244", "34.237.3.244/32")).toBe(true);
  });

  it("rejects a neighboring /32", () => {
    expect(ipMatchesCidr("34.237.3.245", "34.237.3.244/32")).toBe(false);
  });

  it("matches a network prefix", () => {
    expect(ipMatchesCidr("10.0.1.9", "10.0.1.0/24")).toBe(true);
    expect(ipMatchesCidr("10.0.2.1", "10.0.1.0/24")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(ipMatchesCidr("not-an-ip", "34.237.3.244/32")).toBe(false);
    expect(ipMatchesCidr("34.237.3.244", "34.237.3.244/999")).toBe(false);
    expect(ipMatchesCidr("34.237.3.244", "garbage")).toBe(false);
  });

  it("handles IPv4/IPv6 family mismatch", () => {
    expect(ipMatchesCidr("34.237.3.244", "2001:db8::1/128")).toBe(false);
  });
});

describe("webhookClientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const req = new Request("https://x/fn", {
      headers: {
        "x-forwarded-for": "34.237.3.244, 10.0.0.1",
        "x-real-ip": "10.0.0.1",
      },
    });
    expect(webhookClientIp(req)).toBe("34.237.3.244");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://x/fn", {
      headers: { "x-real-ip": "34.195.105.136" },
    });
    expect(webhookClientIp(req)).toBe("34.195.105.136");
  });

  it("returns null when no header is present", () => {
    const req = new Request("https://x/fn");
    expect(webhookClientIp(req)).toBeNull();
  });
});

describe("isPaddleWebhookSource", () => {
  it("accepts a current Paddle webhook IP", async () => {
    stubFetch();
    expect(await isPaddleWebhookSource("34.237.3.244")).toBe(true);
  });

  it("rejects an IP not on the list", async () => {
    stubFetch();
    expect(await isPaddleWebhookSource("203.0.113.7")).toBe(false);
  });

  it("rejects when the caller IP is unknown", async () => {
    stubFetch();
    expect(await isPaddleWebhookSource(null)).toBe(false);
  });

  it("caches the fetched list", async () => {
    stubFetch();
    const fetchMock = vi.mocked(fetch);
    await isPaddleWebhookSource("34.237.3.244");
    await isPaddleWebhookSource("34.237.3.244");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("enforcePaddleWebhookIpAllowlist", () => {
  it("is off by default", async () => {
    stubFetch();
    stubDeno({}); // no PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST
    const req = new Request("https://x/fn", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(await enforcePaddleWebhookIpAllowlist(req)).toEqual({ allowed: true });
  });

  it("rejects a disallowed IP when enabled", async () => {
    stubFetch();
    stubDeno({ PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST: "1" });
    const req = new Request("https://x/fn", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    const result = await enforcePaddleWebhookIpAllowlist(req);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in Paddle webhook allowlist");
  });

  it("accepts a Paddle IP when enabled", async () => {
    stubFetch();
    stubDeno({ PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST: "1" });
    const req = new Request("https://x/fn", {
      headers: { "x-forwarded-for": "34.232.58.13" },
    });
    expect(await enforcePaddleWebhookIpAllowlist(req)).toEqual({ allowed: true });
  });

  it("fails open when the IP list fetch fails (signature remains mandatory)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    stubDeno({ PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST: "1" });
    const req = new Request("https://x/fn", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(await enforcePaddleWebhookIpAllowlist(req)).toEqual({ allowed: true });
  });

  it("fails open when the caller IP is unavailable (signature remains mandatory)", async () => {
    stubFetch();
    stubDeno({ PADDLE_WEBHOOK_ENFORCE_IP_ALLOWLIST: "1" });
    const req = new Request("https://x/fn");
    expect(await enforcePaddleWebhookIpAllowlist(req)).toEqual({ allowed: true });
  });
});