// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — Christian Construction Insurance Education Manual
//
// WHY THIS FILE EXISTS WITHOUT THE DOCUMENT
// ---------------------------------------------------------------------------
//
// This module registers a *source* and the *vocabulary* needed to ingest that
// source safely. It deliberately contains ZERO statements of what the manual
// says.
//
// The manual was not present in the repository when this was authored, and
// paraphrasing a 114-page training document from a summary would fabricate
// every citation and page number attached to it. Fabricated provenance is
// worse than absent knowledge: a knowledge base that appears sourced and is
// not will be trusted exactly where it should not be.
//
// So the source is registered as AWAITING its document, and everything that
// protects the retrieval layer when the document does arrive is built now:
//
//   * a low authority tier that cannot outrank current authoritative sources
//   * a mandatory page/section locator
//   * a mandatory temporal scope, so 2020-2021 statistics are never
//     restated as current market conditions
//   * confirmed-vs-proposed separation
//   * a regulated-practice boundary the reasoning layer must surface
//   * a prohibited-practice denylist
//
// `CONTENT_INGESTED` is false and `MISSING_INPUT` names the blocker. Until a
// real document lands, the manual is retrievable as a citation source but
// contributes no claims. See ./training-manual-guardrails for enforcement.
// ---------------------------------------------------------------------------

import type { SourceClassification, TemporalScope } from "./types";

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

/** Stable identifier for the manual across the knowledge layer. */
export const TRAINING_MANUAL_SOURCE_ID = "src_christian_construction_insurance_manual";

/**
 * The ingestion state of this source.
 *
 * `awaiting_document` means: registered, categorised and guard-railed, but no
 * statement has been extracted because the document itself has not been
 * supplied. It is intentionally distinct from `indexed` so a partially
 * ingested source can never present as complete.
 */
export type TrainingManualIngestionState =
  | "awaiting_document"
  | "extracting"
  | "extracted_needs_review"
  | "indexed";

/** The one thing standing between this registration and real knowledge. */
export const MISSING_INPUT = {
  reason:
    "The 114-page source document was not present in the repository and no URL, attachment or text was supplied.",
  consequence:
    "No knowledge item in this source states what the manual teaches. Every concept in this prompt is modelled as structure and vocabulary only.",
  unblock:
    "Supply the PDF (or extracted text) into the workspace, then run the extraction pass to emit KnowledgeItem records carrying documentId + locator.page/locator.section.",
} as const;

/** Whether any statement has actually been extracted from the manual. */
export const CONTENT_INGESTED = false;

/**
 * Source record (provenance §1).
 *
 * authorityTier and sourceClassification pin this source below every current
 * authoritative source: it must never override a policy document, a building
 * code, manufacturer documentation, or verified claim evidence.
 */
export const TRAINING_MANUAL_SOURCE = {
  sourceId: TRAINING_MANUAL_SOURCE_ID,
  sourceTitle: "Christian Construction Insurance Education Manual",
  sourceType: "trade_training_manual",
  sourceClassification: "TRAINING_MANUAL" as SourceClassification,
  authorityTier: "tier3_training_reference",
  /** No canonical URL: this is a document, not a public web resource. */
  canonicalUrl: undefined,
  organization: "Christian Construction",
  /** ~114 pages. */
  approximatePageCount: 114,
  documentType: "insurance_restoration_training_manual",
  primaryIndustry: "Insurance restoration / roofing / construction",
  primaryClaimTypes: ["Wind", "Hail", "Broader property loss"],
  intendedAudience: [
    "Roofing contractors",
    "Restoration professionals",
    "Estimators",
    "Operations managers",
  ],
  knowledgeRole: [
    "Training",
    "Operational reference",
    "Claim-documentation guidance",
    "Estimating education",
    "Ethical guidance",
    "Homeowner education",
  ],
  /**
   * Statistics in this manual are primarily associated with 2020-2021 and
   * MUST carry `historical_context`. They are training context, never current
   * market conditions.
   */
  statisticalEra: { from: 2020, to: 2021 } as const,
  defaultTemporalScope: "historical_context" as TemporalScope,
  ingestionState: "awaiting_document" as TrainingManualIngestionState,
  contentIngested: CONTENT_INGESTED,
  missingInput: MISSING_INPUT,
  /**
   * The manual itself acknowledges that requirements vary by state, county,
   * municipality, licensing jurisdiction, policy, carrier and building code.
   * It is therefore never the current legal authority.
   */
  currentStatusRule:
    "Historical statistics must never be presented as current statistics unless independently verified against a current authoritative source. Never a legal, regulatory, coverage or carrier-requirement authority.",
  authoritativeAttribution: false,
} as const;

/** True when a source id refers to this manual. */
export function isTrainingManualSource(sourceId: string | undefined | null): boolean {
  return sourceId === TRAINING_MANUAL_SOURCE_ID;
}

/** True when a classification refers to any trade training manual. */
export function isTrainingManualClassification(
  classification: SourceClassification | undefined | null,
): boolean {
  return classification === "TRAINING_MANUAL";
}

// ---------------------------------------------------------------------------
// §18 Searchable knowledge tags
// ---------------------------------------------------------------------------

/**
 * Controlled tag vocabulary for this source. Tags are lowercase, hyphenated
 * and stable so they remain searchable and aggregatable over time.
 */
export const TRAINING_MANUAL_TAGS = [
  "insurance-restoration",
  "roofing",
  "wind",
  "hail",
  "storm-damage",
  "property-claims",
  "claim-inspection",
  "damage-documentation",
  "photography",
  "measurements",
  "estimates",
  "xactimate",
  "ACV",
  "RCV",
  "depreciation",
  "deductible",
  "supplements",
  "denials",
  "reinspection",
  "adjuster",
  "scope-of-work",
  "code-upgrades",
  "manufacturer-requirements",
  "homeowner-education",
  "contractor-ethics",
  "fraud-prevention",
  "storm-chasers",
  "retail-roofing",
  "public-adjuster",
  "appraisal",
  "claim-process",
  "roofing-safety",
  "historical-2020-2021",
  "source-training-manual",
] as const;

export type TrainingManualTag = (typeof TRAINING_MANUAL_TAGS)[number];

/** Tags that must be applied to any item carrying a 2020-2021 statistic. */
export const HISTORICAL_TAGS: readonly string[] = ["historical-2020-2021"];

// ---------------------------------------------------------------------------
// §2 / §3 Knowledge domains
// ---------------------------------------------------------------------------

/** The conceptual domains this source is organised into. */
export type TrainingManualDomainId =
  | "industry"
  | "ethics"
  | "insurance-fundamentals"
  | "claim-workflow"
  | "inspection"
  | "documentation"
  | "estimating"
  | "condition-classification"
  | "adjuster-interaction"
  | "approvals-and-supplements"
  | "homeowner-education"
  | "business-models"
  | "legal-regulatory";

/**
 * Domain structure. `statement` is intentionally absent: the domain is a
 * container for ingested knowledge, not a claim about the manual.
 */
export interface TrainingManualDomain {
  id: TrainingManualDomainId;
  label: string;
  /** What this domain is allowed to be used for. */
  purpose: string;
  /** Hard boundary the reasoning layer must respect for this domain. */
  boundary: string;
  tags: readonly string[];
}

export const TRAINING_MANUAL_DOMAINS: readonly TrainingManualDomain[] = [
  {
    id: "industry",
    label: "Insurance Restoration Industry",
    purpose:
      "Restoration vs retail construction, storm restoration, wind/hail and other perils, industry growth drivers, contractor workflows.",
    boundary: "Descriptive industry context only; not a statement of current market size or conditions.",
    tags: ["insurance-restoration", "storm-damage", "claim-process"],
  },
  {
    id: "ethics",
    label: "Ethics and Professional Conduct",
    purpose:
      "Risk and ethics guidance: storm chasers, unqualified contractors, fabricated or exaggerated damage, manipulated documentation, inconsistent invoices, improper deductible arrangements, frivolous litigation, aggressive solicitation, misrepresentation, poor workmanship.",
    boundary:
      "Treated as risk and ethics guidance, not merely business advice. Atlas must never use this domain to model solicitation or claim-value maximization.",
    tags: ["contractor-ethics", "fraud-prevention", "storm-chasers"],
  },
  {
    id: "insurance-fundamentals",
    label: "Insurance Fundamentals",
    purpose:
      "ACV, RCV, guaranteed and extended replacement cost, deductible, depreciation (including recoverable depreciation), coverage, exclusions, limitations, endorsements, loss, proof of loss, scope of work, appraisal, claim documentation.",
    boundary:
      "Insurance generally addresses sudden covered loss rather than wear, deterioration, maintenance or pre-existing conditions, subject to the specific policy. This must NEVER be generalized into a coverage determination.",
    tags: ["ACV", "RCV", "depreciation", "deductible", "scope-of-work", "appraisal", "property-claims"],
  },
  {
    id: "claim-workflow",
    label: "Claim Workflow",
    purpose: "The reference restoration workflow, from responding to potential storm loss through recovering approved depreciation.",
    boundary:
      "Not permission for a contractor to act as an insurer, public adjuster, attorney or other regulated professional. Regulated claim representation must be flagged, not performed.",
    tags: ["claim-process", "property-claims", "supplements"],
  },
  {
    id: "inspection",
    label: "Inspection Intelligence",
    purpose:
      "Inspection areas and conditions: roofing materials, shingles, structure, decking, gutters, drainage, flashing, chimneys, vents, penetrations, attic, interior, moisture, mold, condensation, water intrusion, code-related, workmanship, siding, windows, vehicles, fences, HVAC and other collateral property.",
    boundary:
      "Observation, interpretation, claim relevance and coverage determination are four distinct categories and must never be collapsed into one.",
    tags: ["claim-inspection", "photography", "measurements", "roofing"],
  },
  {
    id: "documentation",
    label: "Documentation Principles",
    purpose:
      "Documentation as a foundational concept: accurate, specific, observable, photographic, measurable, traceable to the property, consistent across documents and with the actual scope, and supported by legitimate evidence.",
    boundary:
      "Favors evidence-backed statements over assumptions. Absence of evidence is recorded as a documentation gap, never filled by inference.",
    tags: ["damage-documentation", "photography", "measurements", "claim-inspection"],
  },
  {
    id: "estimating",
    label: "Estimating and Xactimate",
    purpose:
      "Line-item estimating, local pricing, depreciation, replacement cost, roof diagrams, claim photographs, claim documentation, estimate communication, and commonly overlooked scope items (waste, starter, ridge cap, steep/high roof, flashing, pipe jacks, dumpsters, debris removal, temporary tarping, ventilation, code upgrades, ice and water barriers, detach-and-reset).",
    boundary:
      "These are POTENTIAL scope considerations requiring evidence, applicability, policy support, code requirements or manufacturer requirements. They are NEVER automatic claim entitlements. A line item must never be fabricated because it commonly appears in restoration estimates, and coverage must never be inferred from its presence in this manual.",
    tags: ["estimates", "xactimate", "depreciation", "scope-of-work", "code-upgrades"],
  },
  {
    id: "condition-classification",
    label: "Condition Classification",
    purpose:
      "Distinguishing potential storm-related damage, pre-existing conditions, wear and tear/deterioration, workmanship/installation issues, code requirements, and unresolved conditions.",
    boundary:
      "When evidence is insufficient, the cause is explicitly unresolved. A causal conclusion is never invented.",
    tags: ["storm-damage", "damage-documentation", "property-claims"],
  },
  {
    id: "adjuster-interaction",
    label: "Adjuster Interaction",
    purpose:
      "Professional, evidence-based communication: photographs, measurements, inspection reports, estimates, identification of discrepancies, calm explanation of scope differences, separation of covered damage from unrelated conditions, documentation of unresolved issues, and justified requests for reinspection.",
    boundary:
      "Adjusters are not adversaries. No manipulative, deceptive, intimidating or improper-influence language is ever generated. The objective is accurate documentation and legitimate scope reconciliation.",
    tags: ["adjuster", "reinspection", "denials", "supplements"],
  },
  {
    id: "approvals-and-supplements",
    label: "Approvals, Denials and Supplements",
    purpose:
      "Reviewing approved scope, ACV, RCV, deductible, recoverable depreciation, code-related coverage, exclusions, limitations and policy conditions; and evidence-based review of denials and partial approvals.",
    boundary:
      "A supplement must rest on legitimate additional scope, omitted work, changed conditions or applicable requirements. Inflating quantities, inventing damage, code requirements, labor, materials, photographs or measurements is prohibited outright.",
    tags: ["supplements", "denials", "reinspection", "depreciation", "deductible"],
  },
  {
    id: "homeowner-education",
    label: "Homeowner Education",
    purpose:
      "Plain-language explanation of how a claim generally works, ACV vs RCV, deductibles, why documentation and timely reporting matter, contractor agreements, scope of work, evaluating contractors, common restoration scams, workmanship, ventilation, flashing, underlayment, proper installation and manufacturer requirements.",
    boundary:
      "Education must be plain and non-coercive, and must never be used to pressure a homeowner into a contract or mislead them about their coverage.",
    tags: ["homeowner-education", "roofing", "manufacturer-requirements", "fraud-prevention"],
  },
  {
    id: "business-models",
    label: "Alternative Claim and Business Models",
    purpose:
      "Retail roofing, insurance-restoration contracting, the supplement process, public adjuster, appraisal, and litigation as distinct roles and mechanisms.",
    boundary:
      "Roles must be kept distinct. Atlas must never tell a contractor to perform regulated activities they may not be licensed or authorized to perform.",
    tags: ["retail-roofing", "public-adjuster", "appraisal", "supplements", "claim-process"],
  },
  {
    id: "legal-regulatory",
    label: "Legal and Regulatory Safety Layer",
    purpose:
      "Requirement that anything touching contractor licensing, insurance law, deductible rules, public-adjuster licensing, claim representation, solicitation, contract requirements, building codes or current regulations is verified against a current authoritative source.",
    boundary:
      "This manual is NEVER the current legal authority. The manual is used for conceptual training only, never for final legal or regulatory conclusions.",
    tags: ["code-upgrades", "public-adjuster", "contractor-ethics", "deductible"],
  },
] as const;

// ---------------------------------------------------------------------------
// §4 The four categories that must never collapse
// ---------------------------------------------------------------------------

/**
 * An observation passes through four distinct categories. Conflating any of
 * them is the single most dangerous failure in claim analysis, so the order is
 * modelled explicitly and the guardrails enforce the transitions.
 */
export const OBSERVATION_LAYERS = [
  {
    id: "observed_evidence",
    label: "Observed Evidence",
    definition:
      "What was actually seen, measured, photographed or documented.",
    mayConclude: "Facts about the physical condition of the property.",
    mustNotConclude: "Cause, coverage, or entitlement.",
  },
  {
    id: "interpretation",
    label: "Interpretation",
    definition: "What the evidence may indicate.",
    mayConclude: "Hypotheses about mechanism or origin, explicitly labelled as such.",
    mustNotConclude: "A settled cause, or that a policy responds.",
  },
  {
    id: "claim_relevance",
    label: "Claim Relevance",
    definition: "Whether the evidence may be relevant to a covered loss.",
    mayConclude: "That a question is worth asking of the claim file.",
    mustNotConclude: "That the loss is in fact covered.",
  },
  {
    id: "coverage_determination",
    label: "Coverage Determination",
    definition:
      "A decision belonging to the applicable policy, insurer, authorized claims professional or other appropriate authority.",
    mayConclude: "Nothing on Atlas's own authority.",
    mustNotConclude:
      "Never produced by Atlas. Atlas escalates this; it does not decide it.",
  },
] as const;

export type ObservationLayerId = (typeof OBSERVATION_LAYERS)[number]["id"];

// ---------------------------------------------------------------------------
// §7 Condition classification
// ---------------------------------------------------------------------------

/** Cause classification vocabulary for an observed condition. */
export const CONDITION_CLASSIFICATIONS = [
  {
    id: "storm_related",
    label: "Potentially Storm-Related",
    definition:
      "Observable conditions that may plausibly correspond to the reported wind, hail or other covered event.",
  },
  {
    id: "pre_existing",
    label: "Pre-Existing Condition",
    definition: "Conditions that appear to have existed before the reported loss.",
  },
  {
    id: "wear_and_tear",
    label: "Wear and Tear / Deterioration",
    definition:
      "Conditions associated with aging, weathering, maintenance, installation defects or ordinary deterioration.",
  },
  {
    id: "maintenance",
    label: "Maintenance",
    definition: "Conditions attributable to deferred or absent maintenance rather than a covered event.",
  },
  {
    id: "workmanship",
    label: "Workmanship / Installation Issue",
    definition: "Conditions potentially associated with improper installation or construction.",
  },
  {
    id: "code_related",
    label: "Code Requirement",
    definition:
      "Requirements that may apply to the restoration but must be validated against the applicable jurisdiction and current code.",
  },
  {
    id: "unresolved",
    label: "Unresolved",
    definition:
      "Evidence is insufficient to determine the cause. This is a legitimate terminal classification, not a failure to analyze.",
  },
] as const;

export type ConditionClassificationId = (typeof CONDITION_CLASSIFICATIONS)[number]["id"];

// ---------------------------------------------------------------------------
// §14 Claim-analysis reasoning sequence
// ---------------------------------------------------------------------------

/** The ordered reasoning steps Atlas applies to a claim. */
export const CLAIM_ANALYSIS_SEQUENCE = [
  {
    step: 1,
    id: "identify_reported_loss",
    label: "Identify the reported loss",
    question: "What happened, when, where, and what property is allegedly affected?",
  },
  {
    step: 2,
    id: "identify_evidence",
    label: "Identify available evidence",
    question:
      "What photographs, measurements, documents, estimates, reports, invoices, policy information or inspection records exist?",
  },
  {
    step: 3,
    id: "identify_observed_conditions",
    label: "Identify observed conditions",
    question: "What can actually be established from the evidence?",
  },
  {
    step: 4,
    id: "classify_conditions",
    label: "Classify conditions",
    question:
      "Storm-related, pre-existing, wear/deterioration, maintenance, workmanship, code-related, or unknown/unresolved?",
  },
  {
    step: 5,
    id: "identify_documentation_gaps",
    label: "Identify documentation gaps",
    question: "What evidence is missing?",
  },
  {
    step: 6,
    id: "compare_scope",
    label: "Compare scope",
    question:
      "How do observed conditions compare to the contractor estimate, carrier estimate, approved scope and supporting documentation?",
  },
  {
    step: 7,
    id: "identify_discrepancies",
    label: "Identify potential discrepancies",
    question:
      "Documented damage omitted from the estimate, scope item lacking evidence, quantity mismatch, missing photograph or measurement, material specification difference, missing applicable restoration item, or a potentially relevant code/manufacturer requirement?",
  },
  {
    step: 8,
    id: "determine_further_investigation",
    label: "Determine whether further investigation is warranted",
    question:
      "Is this a confirmed finding, a supported potential opportunity, a documentation gap, an unresolved issue, or not supported by the available evidence?",
  },
  {
    step: 9,
    id: "evidence_backed_recommendation",
    label: "Produce an evidence-backed recommendation",
    question:
      "Any proposed supplement or scope change must identify the evidence supporting it.",
  },
] as const;

/**
 * §15 / §14-step-8 controlled vocabulary. A discrepancy is NEVER
 * automatically a recoverable supplement.
 */
export const EVIDENCE_STATUSES = [
  {
    id: "confirmed_finding",
    label: "Confirmed Finding",
    definition: "A fact supported by the available evidence.",
    mayBePresentedAs: "fact",
  },
  {
    id: "supported_potential",
    label: "Supported Potential Opportunity",
    definition:
      "May warrant investigation, documentation or review, but is not yet established.",
    mayBePresentedAs: "proposal",
  },
  {
    id: "documentation_gap",
    label: "Documentation Gap",
    definition: "Evidence needed to support a statement does not currently exist.",
    mayBePresentedAs: "proposal",
  },
  {
    id: "unresolved",
    label: "Unresolved Issue",
    definition: "The evidence is insufficient to determine the cause or the answer.",
    mayBePresentedAs: "unresolved",
  },
  {
    id: "not_supported",
    label: "Not Supported by Available Evidence",
    definition: "The available evidence does not support the claim being made.",
    mayBePresentedAs: "finding",
  },
] as const;

export type EvidenceStatusId = (typeof EVIDENCE_STATUSES)[number]["id"];

/** Statuses that may be presented to a user as established fact. */
export const FACT_PRESENTING_STATUSES: readonly EvidenceStatusId[] = ["confirmed_finding"];

// ---------------------------------------------------------------------------
// §12 Regulated-practice boundary
// ---------------------------------------------------------------------------

/**
 * Topics where the manual is explicitly NOT the authority. Encountering any
 * of these means: flag for verification against a current authoritative
 * source, and do not answer from this manual alone.
 */
export const REGULATED_BOUNDARY_TOPICS = [
  "contractor licensing",
  "insurance law",
  "deductible rules",
  "public adjuster licensing",
  "claim representation",
  "solicitation",
  "contract requirements",
  "building codes",
  "current regulations",
  "current carrier requirements",
] as const;

/** Roles Atlas must not let a contractor assume. */
export const REGULATED_ROLES = [
  {
    role: "insurer",
    note: "Coverage decisions belong to the insurer and the policy.",
  },
  {
    role: "public adjuster",
    note: "Representation of the policyholder in claim matters is licensed and jurisdiction-specific.",
  },
  {
    role: "attorney",
    note: "Legal interpretation and dispute representation are not contractor activities.",
  },
  {
    role: "licensed engineer or building official",
    note: "Code determinations are made against the applicable jurisdiction and current code.",
  },
] as const;

// ---------------------------------------------------------------------------
// §16 Retrieval priority
// ---------------------------------------------------------------------------

/**
 * Source ordering, most authoritative first. This source is deliberately
 * second-to-last: it informs but never overrides.
 */
export const RETRIEVAL_PRIORITY = [
  { rank: 1, source: "current policy / carrier documentation" },
  { rank: 2, source: "relevant current building code / regulatory authority" },
  { rank: 3, source: "manufacturer documentation" },
  { rank: 4, source: "verified claim evidence" },
  { rank: 5, source: "current authoritative industry source" },
  { rank: 6, source: "Atlas customer-provided documentation" },
  { rank: 7, source: "this training manual", sourceId: TRAINING_MANUAL_SOURCE_ID },
  { rank: 8, source: "general inference" },
] as const;

/** Highest rank any item from this source may occupy. */
export const TRAINING_MANUAL_MAX_PRIORITY_RANK = 7;

// ---------------------------------------------------------------------------
// §19 Prohibited practices
// ---------------------------------------------------------------------------

/**
 * The manual must strengthen evidence and integrity controls. It is never a
 * fraud-optimization system. These are hard prohibitions; a knowledge item
 * that models any of them is rejected at ingestion.
 */
export const PROHIBITED_PRACTICES = [
  "manufacture claim value",
  "exploit insurer processes",
  "generate unsupported supplements",
  "encourage deductible manipulation",
  "fabricate evidence",
  "create false damage narratives",
  "coach misrepresentation of damage",
  "manufacture code requirements",
  "create misleading invoices",
  "hide discrepancies",
  "circumvent policy exclusions",
  "mislead homeowners",
  "mislead insurers",
  "mislead adjusters",
  "inflate quantities",
  "invent damage",
  "invent labor",
  "invent materials",
  "fabricate photographs",
  "fabricate measurements",
  "manipulate invoices",
  "misrepresent conditions",
  "add items solely to increase claim value",
  "pressure, deceive or intimidate an adjuster",
] as const;

/** The operating principle this source exists to support. */
export const OPERATIONAL_PRINCIPLE = [
  "Inspect accurately.",
  "Document thoroughly.",
  "Separate facts from assumptions.",
  "Estimate realistically.",
  "Communicate professionally.",
  "Identify legitimate scope gaps.",
  "Educate the homeowner.",
  "Respect policy and regulatory boundaries.",
  "Never fabricate or manipulate evidence.",
] as const;

/** The objective is not claim maximization. */
export const OPTIMIZATION_OBJECTIVE =
  "Help Atlas determine what is actually documented, what is missing, what may be relevant, what is supportable, what requires verification, and what should be escalated for human review — not maximize claim value regardless of evidence.";

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Required attribution forms when a statement from this source is surfaced.
 * These keep a training reference visibly distinct from a current authority.
 */
export const ATTRIBUTION_FORMS = [
  "The manual states...",
  "The training guide recommends...",
  "According to the manual...",
  "This is a training principle rather than a current legal requirement.",
] as const;

/** The single question Atlas must never answer from this source alone. */
export const COVERAGE_DETERMINATION_REFUSAL =
  "This training manual cannot establish whether a loss is covered. That determination belongs to the applicable policy, the insurer, or an authorized claims professional.";
