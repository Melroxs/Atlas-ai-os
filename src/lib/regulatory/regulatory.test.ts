import { describe, expect, it } from "vitest";
import { WAVE_1_JURISDICTIONS, JURISDICTIONS } from "./catalog";
import { RegulatoryAcquisitionWorker } from "./acquisition";
import { extractCitations, extractPropositions } from "./extraction";
import { fetchRegulatorySource } from "./fetcher";
import { retrieveRegulatoryContext } from "./retrieval";
import { InMemoryRegulatoryStore } from "./store";
import type { AcquiredSource, SourceCandidate } from "./types";
import { detectContradiction, verifyProposition } from "./verification";

const fixtureSource = (overrides: Partial<AcquiredSource> = {}): AcquiredSource => ({
  id: "fl-fixture-source",
  jurisdictionCode: "FL",
  url: "https://example.gov/fixture",
  canonicalUrl: "https://example.gov/fixture",
  title: "Test fixture source",
  publisher: "Test fixture",
  kind: "state_legislature",
  authorityTier: "current_enacted_statute",
  relationship: "CONTROLLING_AUTHORITY",
  topics: ["supplemental_claims", "supplemental_deadlines"],
  contentType: "text/html",
  contentHash: "fixture-hash",
  byteLength: 100,
  status: "FETCHED",
  rawContent: "Section 1. A test fixture requires claim supplements within 30 calendar days. Effective January 1, 2026.",
  version: 1,
  effectiveFrom: "2026-01-01",
  ...overrides,
});

const fixtureCandidate = (overrides: Partial<SourceCandidate> = {}): SourceCandidate => ({
  jurisdictionCode: "FL",
  url: "https://example.gov/fixture",
  title: "Test fixture source",
  kind: "state_legislature",
  authorityTier: "current_enacted_statute",
  relationship: "CONTROLLING_AUTHORITY",
  topics: ["supplemental_claims", "supplemental_deadlines"],
  ...overrides,
});

describe("regulatory registry", () => {
  it("contains the 51-jurisdiction registry and the ten Wave 1 states", () => {
    expect(JURISDICTIONS).toHaveLength(51);
    expect(WAVE_1_JURISDICTIONS.map((item) => item.code)).toEqual(["FL", "TX", "CA", "NY", "CO", "MD", "GA", "LA", "AZ", "WA"]);
  });
});

describe("source safety and extraction", () => {
  it("blocks private hosts before network access", async () => {
    const result = await fetchRegulatorySource(fixtureCandidate({ url: "https://127.0.0.1/internal" }));
    expect(result.status).toBe("BLOCKED");
    expect(result.fetchError?.code).toBe("SSRF_BLOCKED");
  });

  it("enforces content type and maximum document size", async () => {
    const badType = await fetchRegulatorySource(fixtureCandidate(), { allowedDomains: ["example.gov"], allowedContentTypes: ["text/html"], maxBytes: 1000, timeoutMs: 1000, maxRedirects: 1, minIntervalMs: 0 }, new Set(), async () => new Response("ok", { status: 200, headers: { "content-type": "application/pdf" } }));
    expect(badType.fetchError?.code).toBe("CONTENT_TYPE_NOT_ALLOWED");
    const tooLarge = await fetchRegulatorySource(fixtureCandidate(), { allowedDomains: ["example.gov"], allowedContentTypes: ["text/html"], maxBytes: 2, timeoutMs: 1000, maxRedirects: 1, minIntervalMs: 0 }, new Set(), async () => new Response("too large", { status: 200, headers: { "content-type": "text/html" } }));
    expect(tooLarge.fetchError?.code).toBe("DOCUMENT_TOO_LARGE");
  });

  it("extracts citations and topics deterministically", () => {
    const text = "Florida Stat. § 626.9541 requires an insurer to acknowledge a claim.\nSupplemental claims require proof within 30 calendar days.";
    expect(extractCitations(text).some((citation) => citation.statuteNumber === "626.9541")).toBe(true);
    expect(extractPropositions(fixtureSource({ rawContent: text }))).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "acknowledgment" }), expect.objectContaining({ topic: "supplemental_deadlines" })]));
  });
});

describe("authority, persistence, and retrieval", () => {
  it("never verifies a secondary discovery source", () => {
    const proposition = {
      jurisdictionCode: "FL",
      topic: "supplemental_claims" as const,
      statement: "Test fixture statement",
      citation: { citation: "§ 1" },
      sourceId: "secondary",
      authorityTier: "secondary_reference" as const,
      verificationState: "UNVERIFIED" as const,
      evidenceText: "Test fixture evidence",
      effectiveFrom: "2026-01-01",
    };
    const secondary = fixtureSource({ id: "secondary", kind: "secondary", authorityTier: "secondary_reference", relationship: "DISCOVERY_SOURCE" });
    expect(verifyProposition(proposition, secondary).state).not.toBe("VERIFIED");
  });

  it("preserves a historical proposition and returns the applicable version by claim date", async () => {
    const store = new InMemoryRegulatoryStore();
    await store.upsertJurisdiction({ code: "FL", name: "Florida", country: "US", wave: 1, waveGroup: "1A" });
    const source = await store.upsertSource(fixtureSource());
    await store.upsertProposition({ id: "old", jurisdictionCode: "FL", topic: "supplemental_deadlines", statement: "Old fixture rule", normalizedValue: { amount: 60, unit: "calendar_days" }, citation: { citation: "§ old" }, sourceId: source.id, authorityTier: "current_enacted_statute", verificationState: "VERIFIED", effectiveFrom: "2020-01-01", effectiveTo: "2025-01-01", evidenceText: "Old fixture evidence" });
    await store.upsertProposition({ id: "new", jurisdictionCode: "FL", topic: "supplemental_deadlines", statement: "New fixture rule", normalizedValue: { amount: 30, unit: "calendar_days" }, citation: { citation: "§ new" }, sourceId: source.id, authorityTier: "current_enacted_statute", verificationState: "VERIFIED", effectiveFrom: "2025-01-01", evidenceText: "New fixture evidence" });
    const historical = await retrieveRegulatoryContext(store, { jurisdictionCode: "FL", claimDate: "2024-05-01", actor: "restoration_contractor", claimType: "residential property", activity: "supplement", topics: ["supplemental_deadlines"] });
    expect(historical.map((item) => item.id)).toEqual(["old"]);
  });

  it("records conflicts rather than silently choosing a deadline", () => {
    const left = { ...fixtureSource(), id: "a" };
    const right = { ...fixtureSource(), id: "b", authorityTier: "official_regulator_material" as const };
    const leftProp = { jurisdictionCode: "FL", topic: "supplemental_deadlines" as const, statement: "30 days", normalizedValue: { amount: 30, unit: "calendar_days" }, citation: { citation: "§ 1" }, sourceId: left.id, authorityTier: "current_enacted_statute" as const, verificationState: "UNVERIFIED" as const, evidenceText: "30 days", effectiveFrom: "2026-01-01" };
    const rightProp = { ...leftProp, statement: "60 days", normalizedValue: { amount: 60, unit: "calendar_days" }, sourceId: right.id, authorityTier: right.authorityTier };
    expect(detectContradiction(leftProp, rightProp)?.conflictType).toBe("DEADLINE");
  });
});

describe("acquisition worker", () => {
  it("runs discover, fetch, persist, extract, verify, version, and coverage", async () => {
    const store = new InMemoryRegulatoryStore();
    const worker = new RegulatoryAcquisitionWorker(store, { discover: async () => [fixtureCandidate()] }, { policy: { allowedDomains: ["example.gov"], allowedContentTypes: ["text/html"], maxBytes: 10_000, timeoutMs: 1000, maxRedirects: 1, minIntervalMs: 0 }, sleep: async () => undefined, now: () => "2026-01-02T00:00:00.000Z", fetchImpl: async () => new Response(fixtureSource().rawContent, { status: 200, headers: { "content-type": "text/html" } }) });
    const result = await worker.acquire({ code: "FL", name: "Florida", country: "US", wave: 1, waveGroup: "1A" });
    expect(result.sources[0].status).toBe("FETCHED");
    expect(result.propositions).toBeGreaterThan(0);
    expect(result.coverage.sourcesFetched).toBe(1);
    expect((await store.listPropositions({ jurisdictionCode: "FL" })).every((item) => item.sourceId === result.sources[0].id)).toBe(true);
  });
});
