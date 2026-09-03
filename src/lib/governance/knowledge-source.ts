// ---------------------------------------------------------------------------
// Atlas Governance Engine — Corpus-Backed Knowledge Source
//
// Bridges the existing Atlas knowledge layers into the governance engine's
// normalized KnowledgeObject model so the Governance Gate can evaluate
// material actions against real, machine-queryable rules.
//
// Sources:
//   1. `src/lib/knowledge/corpus` — 112+ record insurance-restoration corpus
//      (federal regulations, standards, jurisdiction profiles, evidence docs).
//   2. `src/lib/atlas-data/authority` — authoritative source registry + seed
//      knowledge with explicit authority tiers.
//
// Authority is NEVER inferred from wording. Each record maps to an explicit
// `AuthorityLevel` from its structured metadata:
//   - REGULATORY source classification  → binding_regulation
//   - INDUSTRY_STANDARD / PROFESSIONAL_GUIDANCE → industry_standard
//   - CARRIER_OR_INSURANCE             → insurance_policy_language
//   - ATLAS_CURATED (verified)         → company_sop
//   - ATLAS_CURATED / placeholder      → general_ai_knowledge (never authoritative)
//   - tier1_primary source tier        → binding_regulation
//   - tier2_standard / tier3_industry  → industry_standard
//   - tier4_secondary                  → company_sop
//   - tier5_general                    → general_ai_knowledge
// ---------------------------------------------------------------------------

import type {
  AuthorityBasis,
  AuthorityLevel,
  KnowledgeObject,
} from "./types";
import type { KnowledgeSource } from "./compliance";

import { CORPUS_SOURCES, FEDERAL_REGULATIONS } from "../knowledge/corpus";
import type { CorpusKnowledgeRecord } from "../knowledge/corpus";
import {
  AUTHORITATIVE_KNOWLEDGE_SEEDS,
  AUTHORITATIVE_SOURCE_SEEDS,
  type AuthoritativeKnowledgeSeed,
} from "../atlas-data/authority";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Corpus release date (epoch ms) — used as the default effective date for
 *  records that carry no explicit date. */
const CORPUS_RELEASE_EPOCH = new Date("2026-08-27T00:00:00Z").getTime();

// ---------------------------------------------------------------------------
// Source registry lookup
// ---------------------------------------------------------------------------

const SOURCE_LOOKUP = new Map(
  CORPUS_SOURCES.map((s) => [s.sourceId, s]),
);

const AUTHORITATIVE_SOURCE_LOOKUP = new Map(
  AUTHORITATIVE_SOURCE_SEEDS.map((s) => [s.sourceId, s]),
);

// ---------------------------------------------------------------------------
// Classification → Authority Level mapping
// ---------------------------------------------------------------------------

/** Corpus source classification → governance authority level. */
function authorityLevelFromClassification(
  record: CorpusKnowledgeRecord,
): AuthorityLevel {
  // Placeholder/unverified jurisdiction records must never rank as
  // authoritative — they are general knowledge until officially verified.
  if (record.verificationStatus === "placeholder") {
    return "general_ai_knowledge";
  }

  switch (record.sourceClassification) {
    case "REGULATORY":
      return "binding_regulation";
    case "INDUSTRY_STANDARD":
    case "PROFESSIONAL_GUIDANCE":
      return "industry_standard";
    case "CARRIER_OR_INSURANCE":
      return "insurance_policy_language";
    case "ATLAS_CURATED":
      return "company_sop";
    default:
      return "general_ai_knowledge";
  }
}

function authorityBasisFromClassification(
  record: CorpusKnowledgeRecord,
): AuthorityBasis {
  switch (record.sourceClassification) {
    case "REGULATORY":
      return "regulation";
    case "INDUSTRY_STANDARD":
    case "PROFESSIONAL_GUIDANCE":
      return "standard promulgated";
    case "CARRIER_OR_INSURANCE":
      return "policy_document";
    case "ATLAS_CURATED":
      return "company_policy";
    default:
      return "model_inference";
  }
}

/** Atlas-data source tier → governance authority level. */
function authorityLevelFromTier(tier: string): AuthorityLevel {
  switch (tier) {
    case "tier1_primary":
      return "binding_regulation";
    case "tier2_standard":
    case "tier3_industry":
      return "industry_standard";
    case "tier4_secondary":
      return "company_sop";
    default:
      return "general_ai_knowledge";
  }
}

function authorityBasisFromSourceType(sourceType: string): AuthorityBasis {
  switch (sourceType) {
    case "regulation":
      return "regulation";
    case "standard":
      return "standard promulgated";
    case "official_licensing":
      return "regulation";
    case "guidance":
      return "agency_guidance";
    case "industry_body":
      return "standard promulgated";
    default:
      return "model_inference";
  }
}

function verificationStatusFromRecord(
  record: CorpusKnowledgeRecord,
): KnowledgeObject["verificationStatus"] {
  switch (record.verificationStatus) {
    case "official":
      return "verified";
    case "secondary":
      return "stale";
    case "derived":
      return "unverified";
    case "placeholder":
      return "unverified";
    default:
      return "unverified";
  }
}

function jurisdictionTypeFrom(jurisdiction?: string): KnowledgeObject["jurisdictionType"] {
  if (!jurisdiction || jurisdiction === "United States") return "federal";
  return "state";
}

// ---------------------------------------------------------------------------
// Corpus → KnowledgeObject conversion
// ---------------------------------------------------------------------------

/**
 * Convert corpus records into normalized, machine-queryable KnowledgeObjects.
 * The KnowledgeObject carries structured authority metadata (level + basis),
 * jurisdiction, temporal validity, verification status, and citations so the
 * LLM never decides authority by wording.
 */
export function corpusToKnowledgeObjects(
  records: CorpusKnowledgeRecord[],
): KnowledgeObject[] {
  return records.map((record) => {
    const source = SOURCE_LOOKUP.get(record.sourceId);
    return {
      id: `governance:${record.id}`,
      title: record.title,
      domain: record.knowledgeType,
      subdomain: record.industry,
      authorityLevel: authorityLevelFromClassification(record),
      authorityBasis: authorityBasisFromClassification(record),
      sourceType: record.sourceClassification,
      sourceName: source?.sourceName ?? record.sourceId,
      sourceUrl: source?.canonicalUrl,
      citation: `${source?.sourceName ?? record.sourceId}${record.corpusVersion ? ` (v${record.corpusVersion})` : ""}`,
      jurisdiction: record.jurisdiction ?? "United States",
      jurisdictionType: jurisdictionTypeFrom(record.jurisdiction),
      effectiveFrom: CORPUS_RELEASE_EPOCH,
      effectiveTo: undefined,
      version: record.corpusVersion ?? "1.0.0",
      applicability: [
        record.industry ?? "insurance restoration",
        record.knowledgeType,
      ],
      requirement: record.statement,
      exceptions: undefined,
      prohibitedActions: undefined,
      requiredEvidence:
        record.knowledgeType === "documentation_evidence"
          ? [record.statement]
          : undefined,
      relatedWorkflows:
        record.knowledgeType === "workflow_stage" ? [record.id] : undefined,
      relatedRoles: undefined,
      supersedes: undefined,
      supersededBy: undefined,
      verificationStatus: verificationStatusFromRecord(record),
      retrievedAt: CORPUS_RELEASE_EPOCH,
      verifiedAt:
        record.verificationStatus === "official" ? CORPUS_RELEASE_EPOCH : undefined,
      confidence: record.confidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Atlas-data seed → KnowledgeObject conversion
// ---------------------------------------------------------------------------

/**
 * Convert the authoritative source seeds (OSHA, EPA, IRS, FTC, licensing
 * bodies, IICRC standards) into KnowledgeObjects with explicit authority
 * levels derived from the source registry tier.
 */
export function seedToKnowledgeObjects(
  seeds: AuthoritativeKnowledgeSeed[],
): KnowledgeObject[] {
  return seeds.map((seed) => {
    const source = AUTHORITATIVE_SOURCE_LOOKUP.get(seed.sourceId);
    return {
      id: `governance:${seed.knowledgeId}`,
      title: seed.title,
      domain: seed.knowledgeType,
      subdomain: seed.industry,
      authorityLevel: source
        ? authorityLevelFromTier(source.authorityTier)
        : "general_ai_knowledge",
      authorityBasis: source
        ? authorityBasisFromSourceType(source.sourceType)
        : "model_inference",
      sourceType: source?.sourceType ?? "seed",
      sourceName: source?.name ?? seed.sourceId,
      sourceUrl: source?.canonicalUrl,
      citation: `${source?.name ?? seed.sourceId}${seed.version ? `, ${seed.version}` : ""}`,
      jurisdiction: seed.jurisdiction ?? "United States",
      jurisdictionType: jurisdictionTypeFrom(seed.jurisdiction),
      effectiveFrom: CORPUS_RELEASE_EPOCH,
      effectiveTo: undefined,
      version: seed.version ?? "1.0.0",
      applicability: [
        seed.industry ?? "insurance restoration",
        seed.knowledgeType,
      ],
      requirement: seed.statement,
      exceptions: undefined,
      prohibitedActions: undefined,
      requiredEvidence: undefined,
      relatedWorkflows: undefined,
      relatedRoles: undefined,
      supersedes: undefined,
      supersededBy: undefined,
      // Seeds are written conservatively and marked for review before being
      // treated as authoritative — honest default is "unverified".
      verificationStatus: "unverified",
      retrievedAt: CORPUS_RELEASE_EPOCH,
      verifiedAt: undefined,
      confidence: seed.confidence,
    };
  });
}

// ---------------------------------------------------------------------------
// Action-type → keyword relevance mapping
// ---------------------------------------------------------------------------

/** Keywords used to surface the most relevant rules for each material action.
 *  Used only as a secondary relevance hint — never as an authority signal. */
const ACTION_KEYWORDS: Record<string, string[]> = {
  claim_analysis: ["claim", "workflow", "evidence", "requirement"],
  policy_interpretation: ["policy", "coverage", "insurance"],
  coverage_determination: ["policy", "coverage", "insurance"],
  estimate_calculation: ["standard", "requirement", "documentation"],
  supplement_preparation: ["supplement", "revenue", "finding", "documentation_evidence"],
  communication_drafting: ["communication", "correspondence", "evidence"],
  communication_sending: ["communication", "carrier", "insurance"],
  carrier_submission: ["carrier", "regulation", "requirement", "submission"],
  financial_calculation: ["revenue", "financial", "documentation_evidence"],
  financial_commitment: ["financial", "contract", "requirement"],
  deadline_management: ["workflow", "requirement", "deadline"],
  evidence_analysis: ["evidence", "documentation_evidence", "claim"],
  gap_identification: ["documentation_evidence", "evidence", "claim"],
  revenue_recovery_calculation: ["revenue", "financial", "documentation_evidence"],
  compliance_check: ["regulation", "requirement", "standard"],
  jurisdiction_analysis: ["jurisdiction", "regulation", "requirement"],
  regulatory_lookup: ["regulation", "requirement", "standard"],
  customer_notification: ["communication", "customer", "evidence"],
  adjuster_coordination: ["communication", "carrier", "insurance"],
  project_scheduling: ["workflow", "requirement", "deadline"],
  quality_assurance: ["standard", "requirement", "documentation"],
  escalation: ["communication", "workflow", "requirement"],
  legal_conclusion: ["regulation", "policy", "requirement"],
  medical_determination: ["requirement", "standard", "evidence"],
  engineering_determination: ["standard", "requirement", "code"],
  contract_execution: ["contract", "requirement", "financial"],
};

// ---------------------------------------------------------------------------
// KnowledgeSource implementation
// ---------------------------------------------------------------------------

const DEFAULT_CORPUS_RECORDS: CorpusKnowledgeRecord[] = [
  ...FEDERAL_REGULATIONS,
];

/**
 * Build the production governance knowledge source from the existing corpus
 * and authoritative seeds.
 *
 * The source guarantees a non-empty jurisdiction-filtered baseline so a
 * legitimate action is never falsely BLOCKED for "no knowledge"; authority
 * resolution and gap detection remain the gate's job.
 */
export function createCorpusKnowledgeSource(): KnowledgeSource {
  const objects: KnowledgeObject[] = [
    ...corpusToKnowledgeObjects(DEFAULT_CORPUS_RECORDS),
    ...seedToKnowledgeObjects(AUTHORITATIVE_KNOWLEDGE_SEEDS),
  ];

  return {
    async getKnowledgeObjects(opts) {
      let candidates = objects;

      // Jurisdiction filter (mirrors resolveApplicableKnowledge semantics:
      // federal rules always apply).
      if (opts.jurisdiction) {
        candidates = candidates.filter(
          (obj) =>
            obj.jurisdiction === opts.jurisdiction ||
            obj.jurisdiction === "United States" ||
            obj.jurisdictionType === "federal",
        );
      }

      // Domain/relevance hint — secondary only; never empties the result.
      if (opts.domain) {
        const keywords = ACTION_KEYWORDS[opts.domain] ?? [];
        if (keywords.length > 0) {
          const relevant = candidates.filter((obj) =>
            keywords.some(
              (k) =>
                obj.applicability?.includes(k) ??
                obj.requirement.toLowerCase().includes(k) ??
                obj.title.toLowerCase().includes(k),
            ),
          );
          if (relevant.length > 0) candidates = relevant;
        }
      }

      return candidates;
    },
  };
}

/**
 * Singleton default knowledge source for production use.
 */
let _defaultSource: KnowledgeSource | null = null;

export function buildDefaultGovernanceKnowledgeSource(): KnowledgeSource {
  if (!_defaultSource) {
    _defaultSource = createCorpusKnowledgeSource();
  }
  return _defaultSource;
}