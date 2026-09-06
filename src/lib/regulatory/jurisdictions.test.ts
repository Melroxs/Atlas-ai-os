import { describe, expect, it } from "vitest";
import { JURISDICTIONS, PRIORITY_STATES, getJurisdiction } from "./jurisdictions";

describe("jurisdiction registry", () => {
  it("contains exactly 51 jurisdictions (50 states + DC)", () => {
    expect(JURISDICTIONS).toHaveLength(51);
    const states = JURISDICTIONS.filter((j) => j.jurisdictionType === "state");
    expect(states).toHaveLength(50);
    const dc = JURISDICTIONS.find((j) => j.stateCode === "DC");
    expect(dc).toBeDefined();
    expect(dc?.jurisdictionType).toBe("district");
  });

  it("includes every required postal code exactly once", () => {
    const required = [
      "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
      "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
      "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
      "VA","WA","WV","WI","WY","DC",
    ];
    expect(required).toHaveLength(51);
    const codes = JURISDICTIONS.map((j) => j.stateCode).sort();
    expect(codes).toEqual([...required].sort());
  });

  it("every jurisdiction has an official insurance department URL", () => {
    for (const j of JURISDICTIONS) {
      expect(j.officialInsuranceDepartmentUrl, j.stateCode).toBeTruthy();
      expect(j.officialInsuranceDepartmentUrl!.startsWith("https://"), j.stateCode).toBe(true);
    }
  });

  it("every jurisdiction is active and has timestamps", () => {
    for (const j of JURISDICTIONS) {
      expect(j.active).toBe(true);
      expect(j.createdAt).toBeGreaterThan(0);
      expect(j.updatedAt).toBeGreaterThan(0);
      expect(j.jurisdictionId).toBe(j.stateCode.toLowerCase());
    }
  });

  it("the 10 priority states are all present", () => {
    expect(PRIORITY_STATES).toHaveLength(10);
    for (const code of PRIORITY_STATES) {
      expect(getJurisdiction(code), code).toBeDefined();
    }
  });

  it("priority states carry legislature + admin code registry URLs", () => {
    for (const code of PRIORITY_STATES) {
      const j = getJurisdiction(code)!;
      expect(j.officialLegislatureUrl, code).toBeTruthy();
      expect(j.officialAdminCodeUrl, code).toBeTruthy();
    }
  });

  it("getJurisdiction is case-insensitive and returns undefined for unknown codes", () => {
    expect(getJurisdiction("fl")?.stateCode).toBe("FL");
    expect(getJurisdiction("XX")).toBeUndefined();
  });
});