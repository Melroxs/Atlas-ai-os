import { describe, expect, it } from "vitest";
import { extractClaimReference, isInterruptPhrase, routeAtlasIntent } from "./intent";

describe("atlas-voice/intent routing", () => {
  it("routes 'open the Carter claim' to navigate_atlas", () => {
    const intent = routeAtlasIntent("open the Carter claim");
    expect(intent?.name).toBe("navigate_atlas");
    expect(intent?.args.destination).toBe("claim");
    expect(intent?.args.claimRef).toBe("Carter");
  });

  it("routes page navigation without a claim", () => {
    expect(routeAtlasIntent("go to workforce")?.args.destination).toBe("workforce");
    expect(routeAtlasIntent("take me to today's tasks")?.args.destination).toBe("tasks");
    expect(routeAtlasIntent("Go to Claims.")?.args.destination).toBe("claims");
  });

  it("routes an explicit claim id reference", () => {
    const intent = routeAtlasIntent("open CLM-1042");
    expect(intent?.name).toBe("navigate_atlas");
    expect(intent?.args.claimRef).toBe("CLM-1042");
  });

  it("routes 'show me claims needing review' to search_claims(needsAttention)", () => {
    const intent = routeAtlasIntent("show me claims needing review");
    expect(intent?.name).toBe("search_claims");
    expect(intent?.args.needsAttention).toBe(true);
  });

  it("routes 'which claims are waiting for review' to search_claims", () => {
    const intent = routeAtlasIntent("which claims are waiting for review");
    expect(intent?.name).toBe("search_claims");
    expect(intent?.args.needsAttention).toBe(true);
  });

  it("routes 'find Carter' to a claims search", () => {
    const intent = routeAtlasIntent("find Carter");
    expect(intent?.name).toBe("search_claims");
    expect(intent?.args.query).toBe("Carter");
  });

  it("uses the active claim context for 'what's missing?'", () => {
    const intent = routeAtlasIntent("what's missing?", { claimId: "claim-123" });
    expect(intent?.name).toBe("get_missing_evidence");
    expect(intent?.args.claimRef).toBe("claim-123");
  });

  it("returns null for 'what's missing?' with no claim in context", () => {
    // No context and no explicit claim: Atlas must ask, not guess. The router
    // defers to the conversation engine which can ask a clarifying question.
    expect(routeAtlasIntent("what's missing?")).toBeNull();
  });

  it("prefers an explicit claim over the page context", () => {
    const intent = routeAtlasIntent("what's missing on CLM-9", { claimId: "claim-123" });
    expect(intent?.args.claimRef).toBe("CLM-9");
  });

  it("routes findings questions", () => {
    const intent = routeAtlasIntent("what did we find?", { claimId: "claim-123" });
    expect(intent?.name).toBe("get_claim_findings");
  });

  it("routes status questions for a named claim", () => {
    const intent = routeAtlasIntent("what's happening with Carter");
    expect(intent?.name).toBe("get_claim");
    expect(intent?.args.claimRef).toBe("Carter");
  });

  it("routes status questions for the active claim", () => {
    const intent = routeAtlasIntent("what's the status?", { claimId: "claim-123" });
    expect(intent?.name).toBe("get_claim");
    expect(intent?.args.claimRef).toBe("claim-123");
  });

  it("leaves ordinary questions to the conversation engine", () => {
    expect(routeAtlasIntent("how many claims did we close last month?")).toBeNull();
    expect(routeAtlasIntent("summarize the policy language")).toBeNull();
    expect(routeAtlasIntent("")).toBeNull();
  });
});

describe("atlas-voice/interrupt phrase", () => {
  it("recognizes stop-words", () => {
    expect(isInterruptPhrase("stop")).toBe(true);
    expect(isInterruptPhrase("Atlas, stop")).toBe(true);
    expect(isInterruptPhrase("never mind")).toBe(true);
    expect(isInterruptPhrase("hold on")).toBe(true);
  });

  it("does not treat ordinary requests as interrupts", () => {
    expect(isInterruptPhrase("open the Carter claim")).toBe(false);
    expect(isInterruptPhrase("what's missing?")).toBe(false);
  });
});

describe("atlas-voice/extractClaimReference", () => {
  it("strips filler to leave the meaningful reference", () => {
    expect(extractClaimReference("the Carter claim")).toBe("Carter");
    expect(extractClaimReference("CLM-1042")).toBe("CLM-1042");
    expect(extractClaimReference("details for the Carter Residence")).toBe(
      "Carter Residence",
    );
  });
});
