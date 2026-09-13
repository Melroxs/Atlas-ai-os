import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAtlasNavigator, resetAtlasNavigator } from "./navigation";

// ---------------------------------------------------------------------------
// Supabase stub — returns RAW RPC payloads so the REAL transform
// (normalizeClaimListResponse / normalizeClaimPackageResponse) runs, exactly
// as it does in the app.
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  getSupabaseClient: () => ({ rpc: rpcMock }),
  resolvedSupabaseUrl: "https://example.supabase.co",
}));

import {
  getClaim,
  getClaimFindings,
  getMissingEvidence,
  navigateAtlasTool,
  resolveClaim,
  searchClaims,
} from "./tools";

const CARTER_ID = "claim-aaaaaaaa-0001";
const MILLER_ID = "claim-bbbbbbbb-0002";

const LIST_ROWS = [
  {
    claim: {
      _id: CARTER_ID,
      customer: "Carter Residence",
      claimNumber: "CLM-1001",
      status: "open",
      carrier: "Everest Insurance",
      property: "Carter Residence",
    },
    findings: [{ title: "Missed line item", status: "open" }],
    supplements: [],
  },
  {
    claim: {
      _id: MILLER_ID,
      customer: "Miller Residence",
      claimNumber: "CLM-1002",
      status: "open",
      carrier: "Everest Insurance",
      property: "Miller Residence",
    },
    findings: [],
    supplements: [],
  },
];

function packageFor(claim: Record<string, unknown>) {
  return {
    claim,
    supplements: [],
    findings: [{ title: "Missed line item", status: "open", description: "Scope gap" }],
    evidenceDocs: [{ _id: "doc-1", title: "Estimate" }],
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === "insurance_list_claims") return { data: LIST_ROWS, error: null };
    if (name === "insurance_get_claim_package") {
      const claimId = String(args?.p_claimid ?? args?.claimId ?? "");
      const row = LIST_ROWS.find((r) => r.claim._id === claimId);
      if (!row) return { data: null, error: null };
      return { data: packageFor(row.claim), error: null };
    }
    return { data: null, error: null };
  });
});

afterEach(() => {
  resetAtlasNavigator();
});

describe("atlas-voice/search_claims", () => {
  it("finds a claim by customer name", async () => {
    const result = await searchClaims({ query: "Carter" });
    expect(result.success).toBe(true);
    expect(result.data?.claims).toHaveLength(1);
    expect(result.data?.claims[0].id).toBe(CARTER_ID);
    expect(result.message).toContain("Carter Residence");
  });

  it("returns an honest no-match message", async () => {
    const result = await searchClaims({ query: "Nonexistent Holdings" });
    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(0);
    expect(result.message).toMatch(/couldn't find/i);
  });

  it("never returns another organization's claims (RPC is RLS-scoped)", async () => {
    // The stub only ever returns the caller's rows; the assertion here is that
    // the tool passes NO tenant argument — isolation comes from the session.
    await searchClaims({ query: "Carter" });
    const [, args] = rpcMock.mock.calls[0];
    const keys = Object.keys(args ?? {});
    expect(keys.some((k) => /tenant|organization/i.test(k))).toBe(false);
  });

  it("filters to claims Atlas flags as needing attention", async () => {
    const result = await searchClaims({ needsAttention: true });
    expect(result.success).toBe(true);
    expect(result.data?.claims.map((c) => c.id)).toContain(CARTER_ID);
    // Whatever is returned must actually be flagged by the real normalizer —
    // the filter must not be cosmetic.
    for (const claim of result.data?.claims ?? []) {
      expect(claim.needsAttention || claim.openFindings > 0).toBe(true);
    }
  });
});

describe("atlas-voice/resolve_claim", () => {
  it("resolves a direct claim id", async () => {
    const resolution = await resolveClaim(CARTER_ID);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.claim.id).toBe(CARTER_ID);
  });

  it("asks for clarification instead of guessing when several match", async () => {
    const resolution = await resolveClaim("Residence");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.ambiguous).toHaveLength(2);
      expect(resolution.message).toMatch(/which one/i);
    }
  });

  it("reports an honest not-found", async () => {
    const resolution = await resolveClaim("Nobody");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.message).toMatch(/couldn't find/i);
  });
});

describe("atlas-voice/get_claim", () => {
  it("summarizes the claim from real Atlas data", async () => {
    const result = await getClaim("Carter");
    expect(result.success).toBe(true);
    expect(result.message).toContain("Carter Residence");
    expect(result.data?.claim.id).toBe(CARTER_ID);
  });
});

describe("atlas-voice/get_claim_findings", () => {
  it("returns the claim's findings", async () => {
    const result = await getClaimFindings(CARTER_ID);
    expect(result.success).toBe(true);
    expect(result.data?.findings.length).toBeGreaterThan(0);
  });
});

describe("atlas-voice/get_missing_evidence", () => {
  it("derives gaps from Atlas completeness, never inventing them", async () => {
    const result = await getMissingEvidence(CARTER_ID);
    expect(result.success).toBe(true);
    expect(result.data?.claim.id).toBe(CARTER_ID);
    // Every reported gap must carry a real completeness category key.
    for (const item of result.data?.missing ?? []) {
      expect(item.key).toBeTruthy();
      expect(["missing", "needs_review", "conflicted", "stale"]).toContain(item.status);
    }
  });
});

describe("atlas-voice/navigate_atlas", () => {
  it("opens the claim through the real router", async () => {
    const navigate = vi.fn();
    registerAtlasNavigator(navigate);

    const result = await navigateAtlasTool({
      destination: "claim",
      claimRef: "Carter",
    });

    expect(result.success).toBe(true);
    expect(navigate).toHaveBeenCalledWith(`/dashboard/revenue-recovery/${CARTER_ID}`);
    expect(result.message).toMatch(/Carter Residence/);
  });

  it("asks which claim rather than navigating blind", async () => {
    const navigate = vi.fn();
    registerAtlasNavigator(navigate);

    const result = await navigateAtlasTool({ destination: "claim" });

    expect(result.success).toBe(false);
    expect(result.clarification).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never claims success for an unknown destination", async () => {
    const navigate = vi.fn();
    registerAtlasNavigator(navigate);

    const result = await navigateAtlasTool({ destination: "the moon" });

    expect(result.success).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates a plain page without needing a claim", async () => {
    const navigate = vi.fn();
    registerAtlasNavigator(navigate);

    const result = await navigateAtlasTool({ destination: "workforce" });

    expect(result.success).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/dashboard/workers");
  });
});
