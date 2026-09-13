import { describe, expect, it } from "vitest";
import {
  InMemoryRegulatoryStore,
  regulatoryFetchGuard,
  contentTypeAllowed,
  hashContent,
  runAcquisitionPipeline,
  runFreshnessMonitor,
  DEFAULT_FETCH_POLICY,
  type FetchPolicy,
} from "./pipeline";
import { SEED_ALL_SOURCES, buildFederalPropositions, listJurisdictions } from "./seed";
import type { RegulatorySource } from "./types";

const now = Date.now();

function registeredSource(overrides: Partial<RegulatorySource> = {}): RegulatorySource {
  return {
    sourceId: "fl-dept",
    jurisdictionId: "fl",
    sourceType: "regulator_guidance",
    authorityTier: 2,
    publisher: "Florida Department of Insurance",
    title: "FL DOI",
    canonicalUrl: "https://www.floir.com",
    status: "REGISTERED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("fetch guard (SSRF protection)", () => {
  it("allows allowlisted official domains", () => {
    expect(regulatoryFetchGuard("https://www.floir.com/claims").allowed).toBe(true);
    expect(regulatoryFetchGuard("https://insurance.az.gov").allowed).toBe(true);
    expect(regulatoryFetchGuard("https://www.tdi.texas.gov").allowed).toBe(true);
  });

  it("blocks non-allowlisted domains", () => {
    const r = regulatoryFetchGuard("https://evil.example.com/phish");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("not_allowlisted");
  });

  it("blocks non-http protocols and localhost", () => {
    expect(regulatoryFetchGuard("file:///etc/passwd").allowed).toBe(false);
    expect(regulatoryFetchGuard("http://localhost:5432/").allowed).toBe(false);
    expect(regulatoryFetchGuard("ftp://x.com/f").allowed).toBe(false);
  });

  it("respects a disabled fetch policy", () => {
    const policy: FetchPolicy = { ...DEFAULT_FETCH_POLICY, enabled: false };
    expect(regulatoryFetchGuard("https://www.floir.com", policy).allowed).toBe(false);
  });

  it("validates content types", () => {
    expect(contentTypeAllowed("text/html; charset=utf-8")).toBe(true);
    expect(contentTypeAllowed("application/pdf")).toBe(true);
    expect(contentTypeAllowed("application/octet-stream")).toBe(false);
    expect(contentTypeAllowed(null)).toBe(false);
  });
});

describe("content hashing", () => {
  it("is deterministic and change-sensitive", () => {
    expect(hashContent("same text")).toBe(hashContent("same text"));
    expect(hashContent("same text")).not.toBe(hashContent("same text!"));
  });
});

describe("acquisition pipeline", () => {
  it("runs offline extraction from provided text with observable jobs", async () => {
    const store = new InMemoryRegulatoryStore();
    const source = registeredSource();
    store.upsertSource(source);

    const result = await runAcquisitionPipeline(
      {
        source,
        jurisdictionId: "fl",
        topic: "acknowledgment",
        text: "Each insurer must acknowledge receipt of a claim within 14 days after receiving notice of loss.",
        initiatedBy: "test",
      },
      store,
    );

    expect(result.fetched).toBe(false);
    expect(result.propositions).toHaveLength(1);
    const p = result.propositions[0];
    expect(p.deadline).toBe(14);
    expect(p.verificationStatus).toBe("UNVERIFIED"); // never auto-verified
    expect(store.getPropositions()).toHaveLength(1);

    const stages = store.getJobs().map((j) => j.stage);
    expect(stages).toContain("DISCOVERY");
    expect(stages).toContain("FETCH");
    expect(stages).toContain("EXTRACT");
    expect(stages).toContain("VERIFY");
    expect(stages).toContain("PUBLISH");
  });

  it("does not extract when fetching is blocked and no text is provided", async () => {
    const store = new InMemoryRegulatoryStore();
    const source = registeredSource({ canonicalUrl: "https://evil.example.com/x" });
    store.upsertSource(source);

    const result = await runAcquisitionPipeline(
      { source, jurisdictionId: "fl", topic: "acknowledgment" },
      store,
    );
    expect(result.fetched).toBe(false);
    expect(result.propositions).toHaveLength(0);
    expect(store.getSources().find((s) => s.sourceId === source.sourceId)?.status).toBe("FAILED");
  });

  it("supersedes instead of duplicating when content changes", async () => {
    const store = new InMemoryRegulatoryStore();
    const source = registeredSource();
    store.upsertSource(source);

    const text1 = "Each insurer must acknowledge receipt of a claim within 14 days.";
    const text2 = "Each insurer must acknowledge receipt of a claim within 10 days.";

    await runAcquisitionPipeline(
      { source: { ...source, contentHash: hashContent(text1) }, jurisdictionId: "fl", topic: "acknowledgment", text: text1 },
      store,
    );
    await runAcquisitionPipeline(
      { source: { ...source, contentHash: hashContent(text1) }, jurisdictionId: "fl", topic: "acknowledgment", text: text2 },
      store,
    );

    const props = store.getPropositions();
    // Second run sees changeDetected → creates version 2, closes version 1.
    const versions = props.filter((p) => p.topic === "acknowledgment");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.some((p) => p.version === 2)).toBe(true);
    expect(versions.filter((p) => p.version === 2)).toHaveLength(1);
  });

  it("caps an industry/standards source below VERIFIED even with a full checklist", async () => {
    const store = new InMemoryRegulatoryStore();
    const source = registeredSource({
      sourceType: "industry_standard",
      authorityTier: 3,
      publisher: "IICRC",
      title: "IICRC S500",
      canonicalUrl: "https://www.iicrc.org/standards/",
    });
    store.upsertSource(source);

    await runAcquisitionPipeline(
      {
        source,
        jurisdictionId: "fl",
        topic: "water_damage",
        text: "Professional water damage restoration follows the IICRC S500 standard.",
        verificationChecklist: {
          sourceExists: true,
          urlResolves: true,
          authorityMatches: true,
          citationExists: true,
          textSupported: true,
          jurisdictionMatches: true,
          effectiveDateConsidered: true,
          notSuperseded: true,
          noContradictions: true,
        },
      },
      store,
    );
    const p = store.getPropositions()[0];
    // Tier-3 standards can never claim VERIFIED — capped to PARTIALLY_VERIFIED.
    expect(p.verificationStatus).toBe("PARTIALLY_VERIFIED");
  });
});

describe("freshness monitor", () => {
  it("flags stale sources and returns review tasks", () => {
    const old = registeredSource({
      sourceId: "old",
      lastVerifiedAt: now - 400 * 86_400_000,
    });
    const current = registeredSource({
      sourceId: "current",
      lastVerifiedAt: now,
    });
    const result = runFreshnessMonitor([old, current], now);
    expect(result.staleSources.map((s) => s.sourceId)).toContain("old");
    expect(result.staleSources.map((s) => s.sourceId)).not.toContain("current");
    expect(result.reviewTasks[0].reason).toContain("freshness");
  });
});

describe("seed integrity", () => {
  it("seeds sources for all 51 jurisdictions", () => {
    const deptSources = SEED_ALL_SOURCES.filter(
      (s) => s.sourceType === "regulator_guidance" && s.jurisdictionId !== "us",
    );
    expect(deptSources).toHaveLength(51);
    expect(listJurisdictions()).toHaveLength(51);
  });

  it("seeds insurance-code + admin-code sources for the 10 priority states", () => {
    const codes = SEED_ALL_SOURCES.filter((s) => s.sourceType === "statute" && s.jurisdictionId !== "us");
    const admins = SEED_ALL_SOURCES.filter((s) => s.sourceType === "administrative_code");
    expect(codes).toHaveLength(10);
    expect(admins).toHaveLength(10);
  });

  it("seeds exactly the verified federal propositions — no state law invented", () => {
    const federal = buildFederalPropositions();
    expect(federal.length).toBeGreaterThan(0);
    expect(federal.every((p) => p.jurisdictionId === "us")).toBe(true);
    expect(federal.every((p) => p.verificationStatus === "VERIFIED")).toBe(true);
    expect(federal.every((p) => p.sourceId.startsWith("us-"))).toBe(true);
    // State-level propositions: none seeded — honest insufficient-evidence state.
    const stateProps = SEED_ALL_SOURCES.filter((s) => s.jurisdictionId !== "us");
    expect(stateProps.every((s) => s.status === "REGISTERED")).toBe(true);
  });
});