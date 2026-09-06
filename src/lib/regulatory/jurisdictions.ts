// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — 51-Jurisdiction Registry
//
// 50 U.S. states + District of Columbia. Each entry carries official
// insurance-department / legislature / administrative-code registry URLs.
//
// IMPORTANT: these URLs are REGISTRY METADATA. They are real, well-known
// official endpoints, but no URL has been fetched or verified by the
// acquisition pipeline yet — every source entry derived from this registry
// starts as REGISTERED/UNVERIFIED until a fetch succeeds. This file contains
// NO legal propositions.
// ---------------------------------------------------------------------------

import type { Jurisdiction } from "./types";

const NOW = Date.UTC(2026, 8, 6); // 2026-09-06 — registry creation

interface JurisdictionSeed {
  stateCode: string;
  name: string;
  type: "state" | "district";
  insuranceUrl?: string;
  legislatureUrl?: string;
  adminCodeUrl?: string;
}

const JURISDICTION_SEEDS: JurisdictionSeed[] = [
  { stateCode: "AL", name: "Alabama", type: "state", insuranceUrl: "https://www.aldoi.gov" },
  { stateCode: "AK", name: "Alaska", type: "state", insuranceUrl: "https://www.commerce.alaska.gov/web/ins/" },
  { stateCode: "AZ", name: "Arizona", type: "state", insuranceUrl: "https://insurance.az.gov", legislatureUrl: "https://www.azleg.gov/ars/", adminCodeUrl: "https://www.azsos.gov/rules" },
  { stateCode: "AR", name: "Arkansas", type: "state", insuranceUrl: "https://www.arkansas.gov/insurance/" },
  { stateCode: "CA", name: "California", type: "state", insuranceUrl: "https://www.insurance.ca.gov", legislatureUrl: "https://leginfo.legislature.ca.gov", adminCodeUrl: "https://oal.ca.gov" },
  { stateCode: "CO", name: "Colorado", type: "state", insuranceUrl: "https://doi.colorado.gov", legislatureUrl: "https://leg.colorado.gov/laws", adminCodeUrl: "https://www.sos.state.co.us/CCR/" },
  { stateCode: "CT", name: "Connecticut", type: "state", insuranceUrl: "https://portal.ct.gov/CID" },
  { stateCode: "DE", name: "Delaware", type: "state", insuranceUrl: "https://insurance.delaware.gov" },
  { stateCode: "FL", name: "Florida", type: "state", insuranceUrl: "https://www.floir.com", legislatureUrl: "https://www.leg.state.fl.us/statutes/", adminCodeUrl: "https://www.flrules.org" },
  { stateCode: "GA", name: "Georgia", type: "state", insuranceUrl: "https://oci.georgia.gov", legislatureUrl: "https://www.legis.ga.gov", adminCodeUrl: "https://rules.sos.ga.gov" },
  { stateCode: "HI", name: "Hawaii", type: "state", insuranceUrl: "https://cca.hawaii.gov/ins/" },
  { stateCode: "ID", name: "Idaho", type: "state", insuranceUrl: "https://doi.idaho.gov" },
  { stateCode: "IL", name: "Illinois", type: "state", insuranceUrl: "https://insurance.illinois.gov" },
  { stateCode: "IN", name: "Indiana", type: "state", insuranceUrl: "https://www.in.gov/idoi/" },
  { stateCode: "IA", name: "Iowa", type: "state", insuranceUrl: "https://iid.iowa.gov" },
  { stateCode: "KS", name: "Kansas", type: "state", insuranceUrl: "https://insurance.kansas.gov" },
  { stateCode: "KY", name: "Kentucky", type: "state", insuranceUrl: "https://insurance.ky.gov" },
  { stateCode: "LA", name: "Louisiana", type: "state", insuranceUrl: "https://www.ldi.la.gov", legislatureUrl: "https://www.legis.la.gov/legis/LawsToc.aspx", adminCodeUrl: "https://www.doa.la.gov/Pages/opr/LAC.aspx" },
  { stateCode: "ME", name: "Maine", type: "state", insuranceUrl: "https://www.maine.gov/pfr/insurance/" },
  { stateCode: "MD", name: "Maryland", type: "state", insuranceUrl: "https://insurance.maryland.gov", legislatureUrl: "https://mgaleg.maryland.gov/mgawebsite/Laws/Statutes", adminCodeUrl: "https://dsd.maryland.gov/Pages/COMARHome.aspx" },
  { stateCode: "MA", name: "Massachusetts", type: "state", insuranceUrl: "https://www.mass.gov/orgs/massachusetts-division-of-insurance" },
  { stateCode: "MI", name: "Michigan", type: "state", insuranceUrl: "https://www.michigan.gov/difs" },
  { stateCode: "MN", name: "Minnesota", type: "state", insuranceUrl: "https://mn.gov/commerce/industries/insurance/" },
  { stateCode: "MS", name: "Mississippi", type: "state", insuranceUrl: "https://www.mid.ms.gov" },
  { stateCode: "MO", name: "Missouri", type: "state", insuranceUrl: "https://insurance.mo.gov" },
  { stateCode: "MT", name: "Montana", type: "state", insuranceUrl: "https://csimt.gov/insurance/" },
  { stateCode: "NE", name: "Nebraska", type: "state", insuranceUrl: "https://doi.nebraska.gov" },
  { stateCode: "NV", name: "Nevada", type: "state", insuranceUrl: "https://doi.nv.gov" },
  { stateCode: "NH", name: "New Hampshire", type: "state", insuranceUrl: "https://www.nh.gov/insurance/" },
  { stateCode: "NJ", name: "New Jersey", type: "state", insuranceUrl: "https://www.nj.gov/dobi/" },
  { stateCode: "NM", name: "New Mexico", type: "state", insuranceUrl: "https://www.osi.state.nm.us" },
  { stateCode: "NY", name: "New York", type: "state", insuranceUrl: "https://www.dfs.ny.gov", legislatureUrl: "https://www.nysenate.gov/legislation/laws", adminCodeUrl: "https://dos.ny.gov/new-york-state-register" },
  { stateCode: "NC", name: "North Carolina", type: "state", insuranceUrl: "https://www.ncdoi.gov" },
  { stateCode: "ND", name: "North Dakota", type: "state", insuranceUrl: "https://www.nd.gov/ndins/" },
  { stateCode: "OH", name: "Ohio", type: "state", insuranceUrl: "https://insurance.ohio.gov" },
  { stateCode: "OK", name: "Oklahoma", type: "state", insuranceUrl: "https://www.oid.ok.gov" },
  { stateCode: "OR", name: "Oregon", type: "state", insuranceUrl: "https://dfr.oregon.gov/insurance/Pages/index.aspx" },
  { stateCode: "PA", name: "Pennsylvania", type: "state", insuranceUrl: "https://www.insurance.pa.gov" },
  { stateCode: "RI", name: "Rhode Island", type: "state", insuranceUrl: "https://dbr.ri.gov/divisions/insurance/" },
  { stateCode: "SC", name: "South Carolina", type: "state", insuranceUrl: "https://doi.sc.gov" },
  { stateCode: "SD", name: "South Dakota", type: "state", insuranceUrl: "https://dlr.sd.gov/insurance/" },
  { stateCode: "TN", name: "Tennessee", type: "state", insuranceUrl: "https://www.tn.gov/commerce/insurance.html" },
  { stateCode: "TX", name: "Texas", type: "state", insuranceUrl: "https://www.tdi.texas.gov", legislatureUrl: "https://statutes.capitol.texas.gov", adminCodeUrl: "https://texreg.sos.state.tx.us" },
  { stateCode: "UT", name: "Utah", type: "state", insuranceUrl: "https://insurance.utah.gov" },
  { stateCode: "VT", name: "Vermont", type: "state", insuranceUrl: "https://dfr.vermont.gov/insurance" },
  { stateCode: "VA", name: "Virginia", type: "state", insuranceUrl: "https://www.scc.virginia.gov/pages/Bureau-of-Insurance" },
  { stateCode: "WA", name: "Washington", type: "state", insuranceUrl: "https://www.insurance.wa.gov", legislatureUrl: "https://app.leg.wa.gov/RCW/", adminCodeUrl: "https://apps.leg.wa.gov/wac/" },
  { stateCode: "WV", name: "West Virginia", type: "state", insuranceUrl: "https://www.wvinsurance.gov" },
  { stateCode: "WI", name: "Wisconsin", type: "state", insuranceUrl: "https://oci.wi.gov" },
  { stateCode: "WY", name: "Wyoming", type: "state", insuranceUrl: "https://insurance.wy.gov" },
  { stateCode: "DC", name: "District of Columbia", type: "district", insuranceUrl: "https://disb.dc.gov" },
];

/** All 51 jurisdictions (50 states + DC). */
export const JURISDICTIONS: Jurisdiction[] = JURISDICTION_SEEDS.map((s) => ({
  jurisdictionId: s.stateCode.toLowerCase(),
  jurisdictionType: s.type,
  stateCode: s.stateCode,
  name: s.name,
  active: true,
  officialInsuranceDepartmentUrl: s.insuranceUrl,
  officialLegislatureUrl: s.legislatureUrl,
  officialAdminCodeUrl: s.adminCodeUrl,
  createdAt: NOW,
  updatedAt: NOW,
}));

/** Lookup by state code. */
export function getJurisdiction(stateCode: string): Jurisdiction | undefined {
  return JURISDICTIONS.find((j) => j.stateCode === stateCode.toUpperCase());
}

/** The 10 priority states used for regression testing. */
export const PRIORITY_STATES: string[] = [
  "FL",
  "TX",
  "CA",
  "NY",
  "CO",
  "LA",
  "MD",
  "WA",
  "AZ",
  "GA",
];

/** Federal jurisdiction sentinel (no postal code). */
export const FEDERAL_JURISDICTION_ID = "us";