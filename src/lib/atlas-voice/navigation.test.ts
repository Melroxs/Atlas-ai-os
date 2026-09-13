import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimIdFromPath,
  isAtlasNavigatorRegistered,
  navigateAtlas,
  pageLabelFromPath,
  registerAtlasNavigator,
  resetAtlasNavigator,
  resolveAtlasTarget,
  resolveDestinationId,
} from "./navigation";

afterEach(() => {
  resetAtlasNavigator();
});

describe("atlas-voice/navigation destinations", () => {
  it("resolves spoken page names to the real routes from main.tsx", () => {
    expect(resolveAtlasTarget({ destination: "claims" })).toEqual({
      ok: true,
      target: { destination: "claims", label: "Claims", path: "/dashboard/revenue-recovery" },
    });
    expect(resolveAtlasTarget({ destination: "workforce" }).ok).toBe(true);
    expect(resolveAtlasTarget({ destination: "tasks" })).toEqual({
      ok: true,
      target: { destination: "tasks", label: "Work queue", path: "/dashboard/work-queue" },
    });
  });

  it("requires a claim id for claim destinations", () => {
    const result = resolveAtlasTarget({ destination: "claim" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/which claim/i);
  });

  it("builds the claim route that ClaimDetail actually serves", () => {
    const result = resolveAtlasTarget({ destination: "claim", entityId: "abc 123" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.path).toBe("/dashboard/revenue-recovery/abc%20123");
      expect(result.target.claimId).toBe("abc 123");
    }
  });

  it("maps evidence/supplements onto the claim page and says so", () => {
    const result = resolveAtlasTarget({ destination: "evidence", entityId: "c1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.path).toBe("/dashboard/revenue-recovery/c1");
      expect(result.target.note).toMatch(/shown on the claim page/i);
    }
  });

  it("rejects unknown destinations instead of guessing", () => {
    const result = resolveAtlasTarget({ destination: "the moon" });
    expect(result.ok).toBe(false);
  });

  it("resolves aliases to canonical destinations", () => {
    expect(resolveDestinationId("revenue recovery")).toBe("claims");
    expect(resolveDestinationId("today's tasks")).toBe("tasks");
    expect(resolveDestinationId("home")).toBe("dashboard");
    expect(resolveDestinationId("nonsense")).toBeNull();
  });
});

describe("atlas-voice/navigation bridge", () => {
  it("reports failure (never success) when the router seam is not wired", () => {
    const result = navigateAtlas({ destination: "claims" });
    expect(result.success).toBe(false);
    expect(result.path).toBe("/dashboard/revenue-recovery");
    expect(result.message).toMatch(/couldn't reach Atlas's navigation/i);
  });

  it("drives the registered router and reports success", () => {
    const navigate = vi.fn();
    registerAtlasNavigator(navigate);
    expect(isAtlasNavigatorRegistered()).toBe(true);

    const result = navigateAtlas({ destination: "workforce" });
    expect(navigate).toHaveBeenCalledWith("/dashboard/workers");
    expect(result.success).toBe(true);
    expect(result.path).toBe("/dashboard/workers");
  });

  it("reports failure when the router throws", () => {
    registerAtlasNavigator(() => {
      throw new Error("router exploded");
    });
    const result = navigateAtlas({ destination: "claims" });
    expect(result.success).toBe(false);
  });

  it("unregisters cleanly", () => {
    const unsubscribe = registerAtlasNavigator(() => {});
    unsubscribe();
    expect(isAtlasNavigatorRegistered()).toBe(false);
  });
});

describe("atlas-voice/route context", () => {
  it("extracts the active claim id from a claim path", () => {
    expect(claimIdFromPath("/dashboard/revenue-recovery/abc%20123")).toBe("abc 123");
    expect(claimIdFromPath("/dashboard/revenue-recovery/claim-9?tab=evidence")).toBe("claim-9");
    expect(claimIdFromPath("/dashboard/revenue-recovery")).toBeNull();
    expect(claimIdFromPath("/dashboard/ask")).toBeNull();
  });

  it("labels the current page for voice context", () => {
    expect(pageLabelFromPath("/dashboard/revenue-recovery/claim-9")).toBe("Claim detail");
    expect(pageLabelFromPath("/dashboard/work-queue")).toBe("Work queue");
    expect(pageLabelFromPath("/somewhere-else")).toBeNull();
  });
});
