import { describe, expect, it } from "vitest";
import { isSyncDue, resourceTypesForCapabilities, runResourceSync, type SyncPorts } from "./sync";
import type { AdapterContext, ExternalRecord, ProviderAdapter, SyncPage, SyncState } from "./types";

const NOW = 1_700_000_000_000;

const context: AdapterContext = {
  organizationId: "org-1",
  connectionId: "conn-1",
  provider: "jobnimbus",
  now: () => NOW,
  log: () => {},
};

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    connectionId: "conn-1",
    provider: "jobnimbus",
    resourceType: "job",
    cursor: null,
    lastSyncedAt: null,
    lastAttemptedAt: null,
    status: "idle",
    itemsSynced: 0,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastError: null,
    errorClass: null,
    ...overrides,
  };
}

function record(id: string, updatedAt = NOW): ExternalRecord {
  return {
    externalId: id,
    resourceType: "job",
    externalUpdatedAt: updatedAt,
    payload: { id },
  };
}

function createPorts() {
  const persisted: Array<Record<string, unknown>> = [];
  const ingested: Array<{ id: string; mapping: unknown }> = [];
  const ports: SyncPorts = {
    now: () => NOW,
    ingestRecord: async ({ record: r, mapping }) => {
      ingested.push({ id: r.externalId, mapping });
      return { atlasId: `atlas-${r.externalId}`, created: true };
    },
    persistState: async (patch) => {
      persisted.push(patch);
    },
  };
  return { ports, persisted, ingested };
}

function adapter(pages: SyncPage[] | (() => Promise<SyncPage>)): ProviderAdapter {
  let index = 0;
  return {
    provider: "jobnimbus",
    capabilities: ["read", "polling"],
    syncResource: async () => {
      if (typeof pages === "function") return pages();
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    },
    mapExternalToAtlas: (r) => ({
      atlasObject: "job",
      atlasId: null,
      provenance: {
        provider: "jobnimbus",
        externalId: r.externalId,
        importedAt: NOW,
        lastSeenAt: NOW,
        importedBy: "integration",
      },
    }),
  };
}

describe("sync engine — happy paths", () => {
  it("runs an initial sync, ingests every record and persists the cursor", async () => {
    const { ports, persisted, ingested } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter([
        { records: [record("j1"), record("j2")], nextCursor: "c1", hasMore: true },
        { records: [record("j3")], nextCursor: "c2", hasMore: false },
      ]),
      accessToken: "token",
      context,
      state: state(),
      ports,
    });

    expect(summary).toMatchObject({ status: "ok", pages: 2, records: 3, cursor: "c2" });
    expect(ingested.map((i) => i.id)).toEqual(["j1", "j2", "j3"]);
    // Every record carries a mapping (external identity), never a bare payload.
    expect(ingested.every((i) => i.mapping !== null)).toBe(true);
    const final = persisted.at(-1)!;
    expect(final).toMatchObject({ status: "ok", cursor: "c2", isFullSync: true, resetFailures: true });
  });

  it("passes the stored cursor for an incremental sync and marks it as such", async () => {
    const { ports, persisted } = createPorts();
    const seen: Array<string | null> = [];
    const base = adapter([{ records: [], nextCursor: null, hasMore: false }]);
    const summary = await runResourceSync({
      adapter: {
        ...base,
        syncResource: async ({ request }) => {
          seen.push(request.cursor);
          expect(request.initial).toBe(false);
          return { records: [], nextCursor: null, hasMore: false };
        },
      },
      accessToken: "token",
      context,
      state: state({ cursor: "cursor-9", lastSyncedAt: NOW - 60_000 }),
      ports,
    });

    expect(seen).toEqual(["cursor-9"]);
    expect(summary.status).toBe("ok");
    expect(persisted.at(-1)!.isFullSync).toBe(false);
  });

  it("stops at the configured page ceiling instead of looping forever", async () => {
    const { ports, persisted } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter([{ records: [record("x")], nextCursor: "always-more", hasMore: true }]),
      accessToken: "token",
      context,
      state: state(),
      ports,
      maxPages: 3,
    });

    expect(summary.pages).toBe(3);
    expect(persisted.at(-1)!.cursor).toBe("always-more");
  });

  it("respects the record ceiling", async () => {
    const { ports } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter([
        {
          records: [record("a"), record("b"), record("c"), record("d")],
          nextCursor: "c1",
          hasMore: true,
        },
      ]),
      accessToken: "token",
      context,
      state: state(),
      ports,
      maxRecords: 2,
    });
    expect(summary.records).toBe(2);
  });
});

describe("sync engine — retry safety", () => {
  it("does NOT advance the cursor when a page fails (the page is retried, never skipped)", async () => {
    const { ports, persisted } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter(() => Promise.reject(new Error("timeout"))),
      accessToken: "token",
      context,
      state: state({ cursor: "cursor-3", lastSyncedAt: NOW - 1000 }),
      ports,
    });

    expect(summary.status).toBe("error");
    expect(summary.cursor).toBe("cursor-3");
    expect(summary.errorClass).toBe("provider_unavailable");
    const final = persisted.at(-1)!;
    expect(final.cursor).toBeUndefined();
    expect(final.nextAttemptAt).toBeGreaterThan(NOW);
    expect(final.consecutiveFailures).toBe(1);
  });

  it("schedules a backoff for a rate limit instead of hammering the provider", async () => {
    const { ports, persisted } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter(() =>
        Promise.reject(Object.assign(new Error("too many requests"), { status: 429 })),
      ),
      accessToken: "token",
      context,
      state: state(),
      ports,
    });

    expect(summary.status).toBe("rate_limited");
    expect(summary.errorClass).toBe("rate_limited");
    expect(persisted.at(-1)!.nextAttemptAt).toBeGreaterThan(NOW);
  });

  it("stops retrying an expired authorization instead of burning quota", async () => {
    const { ports, persisted } = createPorts();
    const summary = await runResourceSync({
      adapter: adapter(() => Promise.reject(Object.assign(new Error("unauthorized"), { status: 401 }))),
      accessToken: "token",
      context,
      state: state(),
      ports,
    });

    expect(summary.errorClass).toBe("authentication_failed");
    expect(summary.nextAttemptAt).toBeNull();
    expect(persisted.at(-1)!.nextAttemptAt).toBeNull();
  });

  it("records an unimplemented resource honestly instead of pretending to sync", async () => {
    const { ports } = createPorts();
    const summary = await runResourceSync({
      adapter: { provider: "jobnimbus", capabilities: ["read"] },
      accessToken: "token",
      context,
      state: state({ resourceType: "photo" }),
      ports,
    });
    expect(summary.status).toBe("error");
    expect(summary.detail).toContain("photo");
    expect(summary.records).toBe(0);
  });

  it("increments failure counts across runs and resets them on success", async () => {
    const { ports, persisted } = createPorts();
    await runResourceSync({
      adapter: adapter(() => Promise.reject(new Error("boom"))),
      accessToken: "token",
      context,
      state: state({ consecutiveFailures: 4 }),
      ports,
    });
    expect(persisted.at(-1)!.consecutiveFailures).toBe(5);

    await runResourceSync({
      adapter: adapter([{ records: [], nextCursor: null, hasMore: false }]),
      accessToken: "token",
      context,
      state: state({ consecutiveFailures: 4 }),
      ports,
    });
    expect(persisted.at(-1)!.resetFailures).toBe(true);
  });
});

describe("sync scheduling", () => {
  it("skips a resource that is still running", () => {
    expect(isSyncDue(state({ status: "running" }), NOW)).toBe(false);
  });

  it("respects a backoff window before retrying a failed resource", () => {
    expect(isSyncDue(state({ status: "error", nextAttemptAt: NOW + 60_000 }), NOW)).toBe(false);
    expect(isSyncDue(state({ status: "error", nextAttemptAt: NOW - 1 }), NOW)).toBe(true);
  });

  it("does not auto-retry a permanent failure with no next attempt", () => {
    expect(isSyncDue(state({ status: "error", nextAttemptAt: null }), NOW)).toBe(false);
  });

  it("is due immediately when it has never run", () => {
    expect(isSyncDue(state({ lastAttemptedAt: null }), NOW)).toBe(true);
  });

  it("waits for the interval after a successful run", () => {
    expect(isSyncDue(state({ status: "ok", lastAttemptedAt: NOW - 1000 }), NOW, 900_000)).toBe(false);
    expect(isSyncDue(state({ status: "ok", lastAttemptedAt: NOW - 1_000_000 }), NOW, 900_000)).toBe(true);
  });

  it("maps declared capabilities onto concrete resource types", () => {
    expect(resourceTypesForCapabilities(["threads", "attachments", "jobs"])).toEqual([
      "document",
      "job",
      "message",
    ]);
    expect(resourceTypesForCapabilities([])).toEqual([]);
  });
});
