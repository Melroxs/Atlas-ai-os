import type { JurisdictionRecord, ResearchTopic, SourceCandidate } from "./types";
import { WAVE_1_CODES } from "./types";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const REGULATORS: Record<string, string> = {
  FL: "Florida Office of Insurance Regulation",
  TX: "Texas Department of Insurance",
  CA: "California Department of Insurance",
  NY: "New York Department of Financial Services",
  CO: "Colorado Division of Insurance",
  MD: "Maryland Insurance Administration",
  GA: "Office of the Georgia Insurance Commissioner",
  LA: "Louisiana Department of Insurance",
  AZ: "Arizona Department of Insurance and Financial Institutions",
  WA: "Washington Office of the Insurance Commissioner",
};

const OFFICIAL_URLS: Record<string, Partial<Pick<JurisdictionRecord, "insuranceDepartmentUrl" | "legislatureUrl" | "administrativeCodeUrl">>> = {
  FL: {
    insuranceDepartmentUrl: "https://www.floir.com/",
    legislatureUrl: "https://www.leg.state.fl.us/",
    administrativeCodeUrl: "https://www.flrules.org/",
  },
  TX: {
    insuranceDepartmentUrl: "https://www.tdi.texas.gov/",
    legislatureUrl: "https://statutes.capitol.texas.gov/",
    administrativeCodeUrl: "https://texreg.sos.state.tx.us/",
  },
  CA: {
    insuranceDepartmentUrl: "https://www.insurance.ca.gov/",
    legislatureUrl: "https://leginfo.legislature.ca.gov/",
    administrativeCodeUrl: "https://oal.ca.gov/publications/ccr/",
  },
  NY: {
    insuranceDepartmentUrl: "https://www.dfs.ny.gov/",
    legislatureUrl: "https://www.nysenate.gov/legislation/laws/ISC",
    administrativeCodeUrl: "https://govt.westlaw.com/nycrr/",
  },
  CO: {
    insuranceDepartmentUrl: "https://doi.colorado.gov/",
    legislatureUrl: "https://leg.colorado.gov/",
    administrativeCodeUrl: "https://www.sos.state.co.us/CCR/",
  },
  MD: {
    insuranceDepartmentUrl: "https://insurance.maryland.gov/",
    legislatureUrl: "https://mgaleg.maryland.gov/",
    administrativeCodeUrl: "https://dsd.maryland.gov/Pages/COMARHome.aspx",
  },
  GA: {
    insuranceDepartmentUrl: "https://oci.georgia.gov/",
    legislatureUrl: "https://www.legis.ga.gov/",
    administrativeCodeUrl: "https://rules.sos.ga.gov/",
  },
  LA: {
    insuranceDepartmentUrl: "https://ldi.la.gov/",
    legislatureUrl: "https://legis.la.gov/",
    administrativeCodeUrl: "https://www.doa.la.gov/doa/osr/louisiana-administrative-code/",
  },
  AZ: {
    insuranceDepartmentUrl: "https://difi.az.gov/",
    legislatureUrl: "https://www.azleg.gov/",
    administrativeCodeUrl: "https://apps.azsos.gov/public_services/Title_20/20-04.pdf",
  },
  WA: {
    insuranceDepartmentUrl: "https://www.insurance.wa.gov/",
    legislatureUrl: "https://app.leg.wa.gov/rcw/",
    administrativeCodeUrl: "https://app.leg.wa.gov/wac/",
  },
};

export const JURISDICTIONS: JurisdictionRecord[] = Object.entries(STATE_NAMES).map(([code, name]) => {
  const waveCode = WAVE_1_CODES.find((candidate) => candidate === code);
  const waveGroup = waveCode && ["FL", "TX", "CA", "NY", "CO"].includes(code) ? "1A" : waveCode ? "1B" : undefined;
  return {
    code,
    name,
    country: "US",
    regulator: REGULATORS[code],
    wave: waveCode ? 1 : undefined,
    waveGroup,
    ...OFFICIAL_URLS[code],
  };
});

export const WAVE_1_JURISDICTIONS = WAVE_1_CODES.map((code) => JURISDICTIONS.find((jurisdiction) => jurisdiction.code === code)).filter((jurisdiction): jurisdiction is JurisdictionRecord => Boolean(jurisdiction));

const DISCOVERY_TOPICS: ResearchTopic[] = [
  "notice_of_loss",
  "acknowledgment",
  "investigation",
  "coverage_determination",
  "payment",
  "unfair_claims_practices",
  "bad_faith",
  "supplemental_claims",
  "supplemental_deadlines",
  "appraisal",
  "mediation",
  "contractor_licensing",
  "assignment_of_benefits",
  "deductible_restrictions",
  "public_adjuster_licensing",
  "public_adjuster_fee_limits",
  "cancellation_rights",
  "hurricane",
  "wind",
  "hail",
];

export function sourceCandidatesFor(jurisdiction: JurisdictionRecord): SourceCandidate[] {
  if (!jurisdiction.wave) return [];
  const candidates: SourceCandidate[] = [];
  const add = (
    url: string | undefined,
    kind: SourceCandidate["kind"],
    authorityTier: SourceCandidate["authorityTier"],
    title: string,
  ) => {
    if (!url) return;
    candidates.push({
      jurisdictionCode: jurisdiction.code,
      url,
      title,
      publisher: jurisdiction.regulator,
      kind,
      authorityTier,
      relationship: "CONTROLLING_AUTHORITY",
      topics: DISCOVERY_TOPICS,
    });
  };
  add(jurisdiction.legislatureUrl, "state_legislature", "current_enacted_statute", `${jurisdiction.name} statutory database`);
  add(jurisdiction.administrativeCodeUrl, "administrative_code", "current_administrative_regulation", `${jurisdiction.name} administrative code`);
  add(jurisdiction.insuranceDepartmentUrl, "state_insurance_department", "official_regulator_material", `${jurisdiction.name} insurance regulator`);
  return candidates;
}

export const WAVE_1_DISCOVERY_SOURCE_LABEL = "Secondary discovery sources are retained as DISCOVERY_SOURCE and can never directly verify a proposition.";
