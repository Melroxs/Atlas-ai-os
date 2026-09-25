import { describe, expect, it } from "vitest";
import {
  atlasObjectForResourceType,
  buildProvenance,
  externalRefKey,
  mapRecordToAtlas,
  shouldProcessRecord,
  validateExternalRef,
} from "./mapping";
import type { ExternalRecord } from "./types";

const NOW = 1_700_000_000_000;

function record(overrides: Partial<ExternalRecord> = {}): ExternalRecord {
  return {
    externalId: "job-12345",
    resourceType: "job",
    externalUpdatedAt: NOW - 5000,
    payload: { id: "job-12345" },
    ...overrides,
  };
}

describe("external identity", () => {
  it("derives a stable key from provider + resource + external id", () => {
    expect(externalRefKey({ provider: "jobnimbus", resourceType: "job", externalId: "12345" })).toBe(
      "jobnimbus:job:12345",
    );
    // Same record, different sync run → same key (this is what prevents duplicates).
    expect(externalRefKey({ provider: "jobnimbus", resourceType: "job", externalId: "12345" })).toBe(
      externalRefKey({ provider: "jobnimbus", resourceType: "job", externalId: "12345" }),
    );
  });

  it("refuses a record that cannot be addressed stably", () => {
    expect(validateExternalRef({ provider: "x", resourceType: "job", externalId: null })).toMatchObject({
      ok: false,
      reason: "missing_external_id",
    });
    expect(validateExternalRef({ provider: "x", resourceType: null, externalId: "1" })).toMatchObject({
      ok: false,
      reason: "missing_resource_type",
    });
    expect(
      validateExternalRef({ provider: "x", resourceType: "job", externalId: "a\u0000b" }),
    ).toMatchObject({ ok: false, reason: "unsafe_external_id" });
    expect(
      validateExternalRef({ provider: "x", resourceType: "job", externalId: "y".repeat(513) }),
    ).toMatchObject({ ok: false, reason: "unsafe_external_id" });
    expect(validateExternalRef({ provider: "x", resourceType: "job", externalId: "ok" })).toEqual({
      ok: true,
    });
  });

  it("never identifies a record by name or email (only a stable external id maps)", () => {
    const named = mapRecordToAtlas({
      provider: "jobnimbus",
      record: record({ externalId: "" }),
    });
    expect(named).toBeNull();
  });
});

describe("provenance", () => {
  it("records provider, external id, import time and provider timestamps", () => {
    const provenance = buildProvenance({
      provider: "companycam",
      externalId: "photo-9",
      connectionId: "conn-1",
      accountName: "Everest Roofing",
      externalCreatedAt: NOW - 10_000,
      externalUpdatedAt: NOW - 5_000,
      now: NOW,
    });

    expect(provenance).toMatchObject({
      provider: "companycam",
      externalId: "photo-9",
      importedBy: "integration",
      importedAt: NOW,
      lastSeenAt: NOW,
      externalCreatedAt: NOW - 10_000,
      externalUpdatedAt: NOW - 5_000,
    });
  });

  it("maps only resource families Atlas actually models", () => {
    expect(atlasObjectForResourceType("photo")).toBe("photo");
    expect(atlasObjectForResourceType("estimate")).toBe("estimate");
    expect(atlasObjectForResourceType("quantum_widget")).toBeNull();
  });

  it("builds a full mapping for a known resource family", () => {
    const mapping = mapRecordToAtlas({
      provider: "jobnimbus",
      record: record(),
      connectionId: "conn-1",
      now: NOW,
    });
    expect(mapping).not.toBeNull();
    expect(mapping!.atlasObject).toBe("job");
    expect(mapping!.provenance.externalId).toBe("job-12345");
    expect(mapping!.provenance.provider).toBe("jobnimbus");
  });

  it("returns null (never a guess) for an unmappable resource family", () => {
    expect(
      mapRecordToAtlas({ provider: "jobnimbus", record: record({ resourceType: "glorp" }) }),
    ).toBeNull();
  });
});

describe("watermark", () => {
  it("processes a record Atlas has never seen", () => {
    expect(shouldProcessRecord({ record: record(), existing: null })).toBe(true);
  });

  it("skips an older provider version (never overwrites something newer)", () => {
    expect(
      shouldProcessRecord({
        record: record({ externalUpdatedAt: NOW - 60_000 }),
        existing: { externalUpdatedAt: NOW },
      }),
    ).toBe(false);
  });

  it("processes an equal or newer provider version", () => {
    expect(
      shouldProcessRecord({ record: record(), existing: { externalUpdatedAt: NOW - 5000 } }),
    ).toBe(true);
    expect(
      shouldProcessRecord({ record: record(), existing: { externalUpdatedAt: NOW - 5000 } }),
    ).toBe(true);
  });

  it("always processes a deletion", () => {
    expect(
      shouldProcessRecord({
        record: record({ externalDeleted: true, externalUpdatedAt: NOW - 999_999 }),
        existing: { externalUpdatedAt: NOW },
      }),
    ).toBe(true);
  });
});
