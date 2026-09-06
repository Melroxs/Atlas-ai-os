// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Initial Seed
//
// Seeds:
//   1. All 51 jurisdictions (50 states + DC) with official registry URLs.
//   2. A source registry entry per jurisdiction for its insurance department
//      (REGISTERED — never treated as fetched or verified until a fetch runs).
//   3. Insurance-code + administrative-code source entries for the 10
//      priority states (REGISTERED).
//   4. The 8 FEDERAL propositions already verified in the Atlas knowledge
//      corpus (OSHA / EPA / FEMA) — these carry real provenance from
//      `src/lib/knowledge/corpus/regulations.ts` and are the only VERIFIED
//      propositions in the initial state. Every state-level rule area is
//      honestly marked research-incomplete/insufficient-evidence.
//
// This file contains NO fabricated state law. State coverage starts at zero
// verified propositions, by design.
// ---------------------------------------------------------------------------

import type {
  Jurisdiction,
  RegulatoryProposition,
  RegulatorySource,
} from "./types";
import { JURISDICTIONS, PRIORITY_STATES, getJurisdiction } from "./jurisdictions";
import { FEDERAL_REGULATIONS } from "@/lib/knowledge/corpus/regulations";
import { buildRegulatoryProposition } from "./propositions";

const NOW = Date.UTC(2026, 8, 6); // registry creation — 2026-09-06

// ---------------------------------------------------------------------------
// Source registry seed
// ---------------------------------------------------------------------------

/** Per-jurisdiction insurance department source entry. */
function departmentSource(j: Jurisdiction): RegulatorySource {
  return {
    sourceId: `${j.stateCode.toLowerCase()}-insurance-department`,
    jurisdictionId: j.jurisdictionId,
    sourceType: "regulator_guidance",
    authorityTier: 2,
    publisher: `${j.name} Department of Insurance`,
    title: `${j.name} Insurance Department — Official Registry`,
    canonicalUrl: j.officialInsuranceDepartmentUrl,
    status: "REGISTERED",
    reliabilityScore: 0.9,
    accessibilityStatus: "unknown",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Insurance code source entry (priority states only). */
function insuranceCodeSource(j: Jurisdiction): RegulatorySource | undefined {
  if (!j.officialLegislatureUrl) return undefined;
  return {
    sourceId: `${j.stateCode.toLowerCase()}-insurance-code`,
    jurisdictionId: j.jurisdictionId,
    sourceType: "statute",
    authorityTier: 1,
    publisher: `${j.name} Legislature`,
    title: `${j.name} Insurance Code / Statutes — Official Portal`,
    canonicalUrl: j.officialLegislatureUrl,
    status: "REGISTERED",
    reliabilityScore: 0.95,
    accessibilityStatus: "unknown",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Administrative code source entry (priority states only). */
function adminCodeSource(j: Jurisdiction): RegulatorySource | undefined {
  if (!j.officialAdminCodeUrl) return undefined;
  return {
    sourceId: `${j.stateCode.toLowerCase()}-admin-code`,
    jurisdictionId: j.jurisdictionId,
    sourceType: "administrative_code",
    authorityTier: 1,
    publisher: `${j.name} (official administrative code)`,
    title: `${j.name} Administrative Code — Official Portal`,
    canonicalUrl: j.officialAdminCodeUrl,
    status: "REGISTERED",
    reliabilityScore: 0.95,
    accessibilityStatus: "unknown",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** All seeded source-registry entries. */
export const SEED_SOURCES: RegulatorySource[] = [
  ...JURISDICTIONS.flatMap((j) => {
    const entries = [departmentSource(j)];
    if (PRIORITY_STATES.includes(j.stateCode)) {
      const code = insuranceCodeSource(j);
      if (code) entries.push(code);
      const admin = adminCodeSource(j);
      if (admin) entries.push(admin);
    }
    return entries;
  }),
];

// ---------------------------------------------------------------------------
// Federal propositions (verified via the existing corpus provenance)
// ---------------------------------------------------------------------------

/** Map corpus federal-regulation source ids to registry source entries. */
const FEDERAL_SOURCE_META: Record<
  string,
  { publisher: string; title: string; canonicalUrl?: string; sourceId: string }
> = {
  "osha-construction": {
    sourceId: "us-osha-construction",
    publisher: "US Occupational Safety and Health Administration (OSHA)",
    title: "OSHA Construction Standards (29 CFR 1926)",
    canonicalUrl: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926",
  },
  "epa-regulations": {
    sourceId: "us-epa-regulations",
    publisher: "US Environmental Protection Agency (EPA)",
    title: "EPA Lead RRP Rule & Asbestos Regulations (40 CFR)",
    canonicalUrl: "https://www.epa.gov/lead",
  },
  "fema-flood-insurance": {
    sourceId: "us-fema-flood-insurance",
    publisher: "US Federal Emergency Management Agency (FEMA)",
    title: "FEMA National Flood Insurance Program (NFIP)",
    canonicalUrl: "https://www.fema.gov/flood-insurance",
  },
};

const FEDERAL_TOPIC: Record<string, string> = {
  fed_osha_fall_protection: "reconstruction",
  fed_osha_hazard_communication: "mitigation",
  fed_osha_respiratory_protection: "mold",
  fed_epa_lead_rrp: "reconstruction",
  fed_epa_asbestos: "reconstruction",
  fed_fema_flood_insurance: "flood",
  fed_osha_scaffolding: "reconstruction",
  fed_osha_electrical_safety: "mitigation",
};

/** Federal source registry entries (verified provenance from the corpus). */
export const SEED_FEDERAL_SOURCES: RegulatorySource[] = Object.values(
  FEDERAL_SOURCE_META,
).map((meta) => ({
  sourceId: meta.sourceId,
  jurisdictionId: "us",
  sourceType: "federal_regulation" as const,
  authorityTier: 1,
  publisher: meta.publisher,
  title: meta.title,
  canonicalUrl: meta.canonicalUrl,
  status: "VERIFIED" as const,
  reliabilityScore: 0.95,
  accessibilityStatus: "unknown",
  retrievedAt: NOW,
  lastVerifiedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
}));

/**
 * Federal propositions derived from the existing verified corpus. Each keeps
 * the corpus's provenance (real source, real regulation) and is VERIFIED —
 * these are the only VERIFIED propositions in the initial state.
 */
export function buildFederalPropositions(): RegulatoryProposition[] {
  const sourceById = new Map(SEED_FEDERAL_SOURCES.map((s) => [s.sourceId, s]));
  const out: RegulatoryProposition[] = [];

  for (const rec of FEDERAL_REGULATIONS) {
    const meta = FEDERAL_SOURCE_META[rec.sourceId];
    if (!meta) continue; // unknown corpus source — skip, never guess
    const source = sourceById.get(meta.sourceId);
    if (!source) continue;

    const ruleText = `${rec.statement} ${rec.interpretation ?? ""}`.trim();
    const topic = FEDERAL_TOPIC[rec.id];
    if (!topic) continue;

    out.push(
      buildRegulatoryProposition({
        jurisdictionId: "us",
        source,
        topic,
        ruleText,
        citation: rec.title,
        confidence: rec.confidence,
        verificationStatus: "VERIFIED",
        supplementState:
          rec.id === "fed_fema_flood_insurance" ? "indirectly_regulated" : undefined,
      }),
    );
  }
  return out;
}

/** All seeded sources: 51 department entries + priority-state codes + federal. */
export const SEED_ALL_SOURCES: RegulatorySource[] = [
  ...SEED_SOURCES,
  ...SEED_FEDERAL_SOURCES,
];

/** Initial proposition set (federal only — state coverage is zero by design). */
export const SEED_PROPOSITIONS: RegulatoryProposition[] = buildFederalPropositions();

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/** The full 51-jurisdiction registry. */
export function listJurisdictions(): Jurisdiction[] {
  return JURISDICTIONS;
}

/** Sources for a jurisdiction (or federal). */
export function sourcesForJurisdiction(
  jurisdictionId: string,
  sources: RegulatorySource[] = SEED_ALL_SOURCES,
): RegulatorySource[] {
  return sources.filter((s) => s.jurisdictionId === jurisdictionId);
}

/** Honest per-jurisdiction source summary for the dashboard/report. */
export function jurisdictionSourceSummary(
  stateCode: string,
  sources: RegulatorySource[] = SEED_ALL_SOURCES,
): { registered: number; verified: number; failed: number; fetched: number } {
  const j = getJurisdiction(stateCode);
  if (!j) return { registered: 0, verified: 0, failed: 0, fetched: 0 };
  const list = sourcesForJurisdiction(j.jurisdictionId, sources);
  return {
    registered: list.filter((s) => s.status === "REGISTERED").length,
    verified: list.filter((s) => s.status === "VERIFIED").length,
    failed: list.filter((s) => s.status === "FAILED").length,
    fetched: list.filter((s) => s.status !== "REGISTERED" && s.status !== "FAILED").length,
  };
}

