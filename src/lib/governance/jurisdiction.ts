// ---------------------------------------------------------------------------
// Atlas Governance Engine — Jurisdiction Resolution
//
// Resolves the applicable jurisdiction from claim, property, and policy data.
// Uses actual claim information — does not depend solely on user input.
//
// Resolution hierarchy:
//   1. Property address → state, county, municipality
//   2. Policy jurisdiction (if different from property)
//   3. Carrier jurisdiction (for carrier-specific rules)
//   4. Federal overlay (always applicable)
// ---------------------------------------------------------------------------

export interface ResolvedJurisdiction {
  /** Full jurisdiction string (e.g., "United States > Florida > Miami-Dade County"). */
  fullJurisdiction: string;
  /** Country. */
  country: string;
  /** State (2-letter code). */
  state: string;
  /** State full name. */
  stateName: string;
  /** County, if known. */
  county?: string;
  /** Municipality/city, if known. */
  municipality?: string;
  /** Property jurisdiction (may differ from policy). */
  propertyJurisdiction: string;
  /** Policy jurisdiction (may differ from property). */
  policyJurisdiction: string;
  /** Applicable state insurance regulator. */
  stateRegulator?: string;
  /** Applicable building authority. */
  buildingAuthority?: string;
  /** Federal overlay always applies. */
  federalApplies: boolean;
  /** Confidence in the resolution. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// State Abbreviation Map
// ---------------------------------------------------------------------------

const STATE_MAP: Record<string, { name: string; abbreviation: string }> = {
  AL: { name: "Alabama", abbreviation: "AL" },
  AK: { name: "Alaska", abbreviation: "AK" },
  AZ: { name: "Arizona", abbreviation: "AZ" },
  AR: { name: "Arkansas", abbreviation: "AR" },
  CA: { name: "California", abbreviation: "CA" },
  CO: { name: "Colorado", abbreviation: "CO" },
  CT: { name: "Connecticut", abbreviation: "CT" },
  DE: { name: "Delaware", abbreviation: "DE" },
  FL: { name: "Florida", abbreviation: "FL" },
  GA: { name: "Georgia", abbreviation: "GA" },
  HI: { name: "Hawaii", abbreviation: "HI" },
  ID: { name: "Idaho", abbreviation: "ID" },
  IL: { name: "Illinois", abbreviation: "IL" },
  IN: { name: "Indiana", abbreviation: "IN" },
  IA: { name: "Iowa", abbreviation: "IA" },
  KS: { name: "Kansas", abbreviation: "KS" },
  KY: { name: "Kentucky", abbreviation: "KY" },
  LA: { name: "Louisiana", abbreviation: "LA" },
  ME: { name: "Maine", abbreviation: "ME" },
  MD: { name: "Maryland", abbreviation: "MD" },
  MA: { name: "Massachusetts", abbreviation: "MA" },
  MI: { name: "Michigan", abbreviation: "MI" },
  MN: { name: "Minnesota", abbreviation: "MN" },
  MS: { name: "Mississippi", abbreviation: "MS" },
  MO: { name: "Missouri", abbreviation: "MO" },
  MT: { name: "Montana", abbreviation: "MT" },
  NE: { name: "Nebraska", abbreviation: "NE" },
  NV: { name: "Nevada", abbreviation: "NV" },
  NH: { name: "New Hampshire", abbreviation: "NH" },
  NJ: { name: "New Jersey", abbreviation: "NJ" },
  NM: { name: "New Mexico", abbreviation: "NM" },
  NY: { name: "New York", abbreviation: "NY" },
  NC: { name: "North Carolina", abbreviation: "NC" },
  ND: { name: "North Dakota", abbreviation: "ND" },
  OH: { name: "Ohio", abbreviation: "OH" },
  OK: { name: "Oklahoma", abbreviation: "OK" },
  OR: { name: "Oregon", abbreviation: "OR" },
  PA: { name: "Pennsylvania", abbreviation: "PA" },
  RI: { name: "Rhode Island", abbreviation: "RI" },
  SC: { name: "South Carolina", abbreviation: "SC" },
  SD: { name: "South Dakota", abbreviation: "SD" },
  TN: { name: "Tennessee", abbreviation: "TN" },
  TX: { name: "Texas", abbreviation: "TX" },
  UT: { name: "Utah", abbreviation: "UT" },
  VT: { name: "Vermont", abbreviation: "VT" },
  VA: { name: "Virginia", abbreviation: "VA" },
  WA: { name: "Washington", abbreviation: "WA" },
  WV: { name: "West Virginia", abbreviation: "WV" },
  WI: { name: "Wisconsin", abbreviation: "WI" },
  WY: { name: "Wyoming", abbreviation: "WY" },
  DC: { name: "District of Columbia", abbreviation: "DC" },
};

// ---------------------------------------------------------------------------
// State Insurance Regulators (simplified — major states)
// ---------------------------------------------------------------------------

const STATE_REGULATORS: Record<string, string> = {
  FL: "Florida Office of Insurance Regulation",
  TX: "Texas Department of Insurance",
  CA: "California Department of Insurance",
  NY: "New York Department of Financial Services",
  IL: "Illinois Department of Insurance",
  PA: "Pennsylvania Insurance Department",
  OH: "Ohio Department of Insurance",
  GA: "Georgia Office of Insurance and Safety Fire Commissioner",
  NC: "North Carolina Department of Insurance",
  MI: "Michigan Department of Insurance and Financial Services",
  NJ: "New Jersey Department of Banking and Insurance",
  VA: "Virginia Bureau of Insurance",
  WA: "Washington Office of the Insurance Commissioner",
  CO: "Colorado Division of Insurance",
  TN: "Tennessee Department of Commerce and Insurance",
};

// ---------------------------------------------------------------------------
// Jurisdiction Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full jurisdiction from available claim/property/policy data.
 */
export function resolveJurisdiction(data: {
  propertyState?: string;
  propertyCounty?: string;
  propertyCity?: string;
  propertyAddress?: string;
  policyState?: string;
  carrierState?: string;
}): ResolvedJurisdiction {
  // Normalize state code
  const stateCode = normalizeStateCode(
    data.propertyState || data.policyState || data.carrierState,
  );
  const stateInfo = stateCode ? STATE_MAP[stateCode] : null;

  const stateName = stateInfo?.name || "Unknown";
  const fullState = stateCode
    ? `United States > ${stateName}`
    : "United States";

  const county = data.propertyCounty;
  const municipality = data.propertyCity;

  // Build property jurisdiction
  let propertyJurisdiction = fullState;
  if (county) propertyJurisdiction += ` > ${county}`;
  if (municipality) propertyJurisdiction += ` > ${municipality}`;

  // Policy jurisdiction (may be different if policy was written in another state)
  const policyStateCode = normalizeStateCode(data.policyState);
  const policyStateInfo = policyStateCode ? STATE_MAP[policyStateCode] : null;
  const policyJurisdiction = policyStateInfo
    ? `United States > ${policyStateInfo.name}`
    : fullState;

  // Confidence based on data completeness
  let confidence = 0.3; // baseline
  if (stateCode) confidence += 0.3;
  if (county) confidence += 0.2;
  if (municipality) confidence += 0.1;
  if (data.propertyAddress) confidence += 0.1;

  return {
    fullJurisdiction: propertyJurisdiction,
    country: "United States",
    state: stateCode || "UNKNOWN",
    stateName,
    county,
    municipality,
    propertyJurisdiction,
    policyJurisdiction,
    stateRegulator: stateCode ? STATE_REGULATORS[stateCode] : undefined,
    buildingAuthority: county
      ? `${county} Building Department`
      : stateCode
        ? `${stateName} Building Code Authority`
        : undefined,
    federalApplies: true,
    confidence: Math.min(confidence, 1),
  };
}

/**
 * Normalize a state name or abbreviation to a 2-letter code.
 */
function normalizeStateCode(input?: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim().toUpperCase();

  // Already a 2-letter code
  if (STATE_MAP[trimmed]) return trimmed;

  // Full name lookup
  for (const [code, info] of Object.entries(STATE_MAP)) {
    if (info.name.toUpperCase() === trimmed) return code;
  }

  return undefined;
}

/**
 * Extract the 2-letter state code from a property address string.
 * Handles formats like "123 Main St, Miami, FL 33101" or
 * "Miami, Florida" by matching known state codes and full names.
 */
export function extractStateFromProperty(
  property?: string | null,
): string | undefined {
  if (!property) return undefined;
  const upper = property.toUpperCase();

  // Match standalone 2-letter state codes (word boundaries).
  for (const code of Object.keys(STATE_MAP)) {
    if (new RegExp(`\\b${code}\\b`).test(upper)) return code;
  }

  // Fall back to full state names.
  for (const [code, info] of Object.entries(STATE_MAP)) {
    if (upper.includes(info.name.toUpperCase())) return code;
  }

  return undefined;
}

/**
 * Get the state abbreviation from a jurisdiction string.
 */
export function extractStateFromJurisdiction(
  jurisdiction: string,
): string | undefined {
  // Match patterns like "United States > Florida" or "Florida"
  for (const [code, info] of Object.entries(STATE_MAP)) {
    if (jurisdiction.includes(info.name) || jurisdiction.includes(code)) {
      return code;
    }
  }
  return undefined;
}
