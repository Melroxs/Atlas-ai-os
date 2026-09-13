// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Regulatory Taxonomy
//
// Atlas-specific taxonomy: claims handling, restoration, contractor
// regulation, public adjusting, insurance regulation, time requirements.
// Every proposition maps to a topic (+ optional subtopic), an actor, and a
// claim phase. This is a closed vocabulary so retrieval and completeness
// scoring are deterministic.
// ---------------------------------------------------------------------------

import type { ActorType, DeadlineUnit } from "./types";

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export const TAXONOMY_GROUPS = {
  claims_handling: "Claims Handling",
  restoration: "Restoration",
  contractor_regulation: "Contractor Regulation",
  public_adjusting: "Public Adjusting",
  insurance_regulation: "Insurance Regulation",
  time_requirements: "Time Requirements",
} as const;

export type TaxonomyGroup = keyof typeof TAXONOMY_GROUPS;

export const TOPICS: Record<
  string,
  { group: TaxonomyGroup; label: string }
> = {
  // --- Claims Handling ---
  notice_of_loss: { group: "claims_handling", label: "Notice of Loss" },
  acknowledgment: { group: "claims_handling", label: "Acknowledgment of Claim" },
  investigation: { group: "claims_handling", label: "Investigation" },
  inspection: { group: "claims_handling", label: "Inspection" },
  coverage_determination: { group: "claims_handling", label: "Coverage Determination" },
  claim_decision: { group: "claims_handling", label: "Claim Decision" },
  payment: { group: "claims_handling", label: "Payment" },
  denial: { group: "claims_handling", label: "Denial" },
  partial_denial: { group: "claims_handling", label: "Partial Denial" },
  proof_of_loss: { group: "claims_handling", label: "Proof of Loss" },
  documentation: { group: "claims_handling", label: "Documentation Requirements" },
  communication: { group: "claims_handling", label: "Communication" },
  records: { group: "claims_handling", label: "Records & Recordkeeping" },
  supplemental_claim: { group: "claims_handling", label: "Supplemental Claims" },
  reopened_claim: { group: "claims_handling", label: "Reopened Claims" },
  dispute: { group: "claims_handling", label: "Dispute" },
  appraisal: { group: "claims_handling", label: "Appraisal" },
  mediation: { group: "claims_handling", label: "Mediation" },
  litigation: { group: "claims_handling", label: "Litigation" },
  pre_suit_notice: { group: "claims_handling", label: "Pre-Suit Notice" },
  statute_of_limitations: { group: "claims_handling", label: "Statute of Limitations" },
  bad_faith: { group: "claims_handling", label: "Bad Faith" },
  unfair_claims_practices: { group: "claims_handling", label: "Unfair Claims Practices" },

  // --- Restoration ---
  mitigation: { group: "restoration", label: "Mitigation" },
  emergency_services: { group: "restoration", label: "Emergency Services" },
  water_damage: { group: "restoration", label: "Water Damage" },
  mold: { group: "restoration", label: "Mold" },
  fire: { group: "restoration", label: "Fire" },
  smoke: { group: "restoration", label: "Smoke" },
  storm: { group: "restoration", label: "Storm" },
  wind: { group: "restoration", label: "Wind" },
  hail: { group: "restoration", label: "Hail" },
  hurricane: { group: "restoration", label: "Hurricane" },
  flood: { group: "restoration", label: "Flood" },
  roof: { group: "restoration", label: "Roof" },
  contents: { group: "restoration", label: "Contents" },
  reconstruction: { group: "restoration", label: "Reconstruction" },

  // --- Contractor Regulation ---
  licensing: { group: "contractor_regulation", label: "Licensing" },
  registration: { group: "contractor_regulation", label: "Registration" },
  contracting: { group: "contractor_regulation", label: "Contracting" },
  restoration_contracts: { group: "contractor_regulation", label: "Restoration Contracts" },
  solicitation: { group: "contractor_regulation", label: "Solicitation" },
  advertising: { group: "contractor_regulation", label: "Advertising" },
  cancellation: { group: "contractor_regulation", label: "Cancellation Rights" },
  disclosures: { group: "contractor_regulation", label: "Disclosures" },
  deductible: { group: "contractor_regulation", label: "Deductible Restrictions" },
  rebates: { group: "contractor_regulation", label: "Rebates & Inducements" },
  assignment_of_benefits: { group: "contractor_regulation", label: "Assignment of Benefits (AOB)" },
  direction_to_pay: { group: "contractor_regulation", label: "Direction to Pay" },
  contractor_representation: { group: "contractor_regulation", label: "Contractor Representation" },
  prohibited_conduct: { group: "contractor_regulation", label: "Prohibited Conduct" },

  // --- Public Adjusting ---
  pa_licensing: { group: "public_adjusting", label: "Public Adjuster Licensing" },
  pa_fees: { group: "public_adjusting", label: "Public Adjuster Fees" },
  pa_fee_caps: { group: "public_adjusting", label: "Fee Caps" },
  pa_contracts: { group: "public_adjusting", label: "Public Adjuster Contracts" },
  pa_solicitation: { group: "public_adjusting", label: "Public Adjuster Solicitation" },
  pa_cancellation: { group: "public_adjusting", label: "Public Adjuster Contract Cancellation" },
  pa_catastrophe: { group: "public_adjusting", label: "Catastrophe Restrictions" },
  pa_conflicts: { group: "public_adjusting", label: "Conflicts of Interest" },
  pa_recordkeeping: { group: "public_adjusting", label: "Public Adjuster Recordkeeping" },
  pa_disclosure: { group: "public_adjusting", label: "Public Adjuster Disclosures" },

  // --- Insurance Regulation ---
  unfair_claims_settlement: { group: "insurance_regulation", label: "Unfair Claims Settlement" },
  unfair_trade_practices: { group: "insurance_regulation", label: "Unfair Trade Practices" },
  consumer_protection: { group: "insurance_regulation", label: "Consumer Protection" },
  policyholder_rights: { group: "insurance_regulation", label: "Policyholder Rights" },
  insurer_duties: { group: "insurance_regulation", label: "Insurer Duties" },
  claims_practices: { group: "insurance_regulation", label: "Claims Practices" },
  complaint_procedures: { group: "insurance_regulation", label: "Complaint Procedures" },

  // --- Time Requirements (cross-cutting) ---
  response_deadlines: { group: "time_requirements", label: "Response Deadlines" },
  payment_deadlines: { group: "time_requirements", label: "Payment Deadlines" },
  filing_deadlines: { group: "time_requirements", label: "Filing Deadlines" },
  proof_of_loss_deadline: { group: "time_requirements", label: "Proof of Loss Deadline" },
  acknowledgment_deadline: { group: "time_requirements", label: "Acknowledgment Deadline" },
};

/** Every known topic id (deterministic vocabulary). */
export const TOPIC_IDS: string[] = Object.keys(TOPICS);

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export const ACTORS: Record<ActorType, string> = {
  insurer: "Insurer",
  insured: "Insured / Policyholder",
  contractor: "Contractor",
  restoration_contractor: "Restoration Contractor",
  public_adjuster: "Public Adjuster",
  independent_adjuster: "Independent Adjuster",
  attorney: "Attorney",
  mortgagee: "Mortgagee",
  third_party: "Third Party",
  regulator: "Regulator",
};

export const ACTOR_IDS: ActorType[] = Object.keys(ACTORS) as ActorType[];

// ---------------------------------------------------------------------------
// Claim phases (Atlas canonical lifecycle)
// ---------------------------------------------------------------------------

export const CLAIM_PHASES: string[] = [
  "intake",
  "notice",
  "triage",
  "coverage_review",
  "investigation",
  "inspection",
  "mitigation",
  "documentation",
  "estimation",
  "initial_submission",
  "carrier_review",
  "supplement_identification",
  "supplement_submission",
  "negotiation",
  "reinspection",
  "dispute",
  "appraisal_mediation",
  "payment",
  "reconstruction",
  "closeout",
  "reopening",
];

export const CLAIM_PHASE_LABELS: Record<string, string> = {
  intake: "Intake",
  notice: "Notice",
  triage: "Triage",
  coverage_review: "Coverage Review",
  investigation: "Investigation",
  inspection: "Inspection",
  mitigation: "Mitigation",
  documentation: "Documentation",
  estimation: "Estimation",
  initial_submission: "Initial Submission",
  carrier_review: "Carrier Review",
  supplement_identification: "Supplement Identification",
  supplement_submission: "Supplement Submission",
  negotiation: "Negotiation",
  reinspection: "Reinspection",
  dispute: "Dispute",
  appraisal_mediation: "Appraisal / Mediation",
  payment: "Payment",
  reconstruction: "Reconstruction",
  closeout: "Closeout",
  reopening: "Reopening",
};

// ---------------------------------------------------------------------------
// Deadline units
// ---------------------------------------------------------------------------

export const DEADLINE_UNIT_LABELS: Record<DeadlineUnit, string> = {
  hours: "hours",
  business_days: "business days",
  calendar_days: "calendar days",
  months: "months",
  years: "years",
  none: "",
};

// ---------------------------------------------------------------------------
// Topic → claim phase mapping (used for phase-scoped retrieval)
// ---------------------------------------------------------------------------

const TOPIC_PHASE_MAP: Record<string, string[]> = {
  notice_of_loss: ["notice", "intake"],
  acknowledgment: ["notice", "intake"],
  investigation: ["investigation", "carrier_review"],
  inspection: ["inspection", "reinspection"],
  coverage_determination: ["coverage_review"],
  claim_decision: ["carrier_review"],
  payment: ["payment"],
  denial: ["carrier_review", "dispute"],
  partial_denial: ["carrier_review", "dispute"],
  proof_of_loss: ["documentation", "initial_submission"],
  documentation: ["documentation"],
  communication: ["notice", "negotiation"],
  records: ["documentation", "closeout"],
  supplemental_claim: ["supplement_identification", "supplement_submission", "reopening"],
  reopened_claim: ["reopening"],
  dispute: ["dispute"],
  appraisal: ["appraisal_mediation"],
  mediation: ["appraisal_mediation"],
  litigation: ["dispute"],
  pre_suit_notice: ["dispute"],
  statute_of_limitations: ["dispute", "reopening"],
  bad_faith: ["dispute"],
  unfair_claims_practices: ["carrier_review", "dispute"],
  mitigation: ["mitigation"],
  emergency_services: ["mitigation", "triage"],
  water_damage: ["mitigation", "reconstruction"],
  mold: ["mitigation", "reconstruction"],
  fire: ["mitigation", "reconstruction"],
  smoke: ["mitigation", "reconstruction"],
  storm: ["inspection", "reconstruction"],
  wind: ["inspection", "reconstruction"],
  hail: ["inspection", "reconstruction"],
  hurricane: ["inspection", "reconstruction"],
  flood: ["inspection", "reconstruction"],
  roof: ["estimation", "reconstruction"],
  contents: ["estimation", "reconstruction"],
  reconstruction: ["reconstruction"],
  licensing: ["intake", "mitigation"],
  registration: ["intake", "mitigation"],
  contracting: ["intake"],
  restoration_contracts: ["intake", "mitigation"],
  solicitation: ["intake", "mitigation"],
  advertising: ["intake"],
  cancellation: ["intake", "mitigation"],
  disclosures: ["intake", "contracting", "negotiation"],
  deductible: ["payment", "negotiation"],
  rebates: ["intake", "mitigation"],
  assignment_of_benefits: ["intake", "mitigation", "negotiation"],
  direction_to_pay: ["payment", "negotiation"],
  contractor_representation: ["intake", "negotiation"],
  prohibited_conduct: ["intake", "mitigation"],
  pa_licensing: ["intake", "dispute"],
  pa_fees: ["intake", "negotiation"],
  pa_fee_caps: ["intake", "negotiation"],
  pa_contracts: ["intake", "dispute"],
  pa_solicitation: ["intake", "dispute"],
  pa_cancellation: ["intake", "dispute"],
  pa_catastrophe: ["intake", "dispute"],
  pa_conflicts: ["intake", "dispute"],
  pa_recordkeeping: ["documentation", "dispute"],
  pa_disclosure: ["intake", "dispute"],
  unfair_claims_settlement: ["carrier_review", "dispute"],
  unfair_trade_practices: ["carrier_review", "dispute"],
  consumer_protection: ["carrier_review", "dispute"],
  policyholder_rights: ["carrier_review", "dispute"],
  insurer_duties: ["carrier_review"],
  claims_practices: ["carrier_review", "dispute"],
  complaint_procedures: ["dispute"],
  response_deadlines: ["notice", "investigation", "carrier_review"],
  payment_deadlines: ["payment"],
  filing_deadlines: ["notice", "documentation", "dispute"],
  proof_of_loss_deadline: ["documentation", "initial_submission"],
  acknowledgment_deadline: ["notice"],
};

/** Claim phases a topic applies to (defaults to all phases). */
export function phasesForTopic(topic: string): string[] {
  return TOPIC_PHASE_MAP[topic] ?? CLAIM_PHASES;
}

// ---------------------------------------------------------------------------
// Peril vocabulary
// ---------------------------------------------------------------------------

export const PERILS: string[] = [
  "water",
  "fire",
  "smoke",
  "wind",
  "hail",
  "storm",
  "hurricane",
  "flood",
  "mold",
  "roof",
  "contents",
];

/** Supplement-relevant topics — the intelligence core of Atlas. */
export const SUPPLEMENT_TOPICS: string[] = [
  "supplemental_claim",
  "reopened_claim",
  "proof_of_loss",
  "documentation",
  "dispute",
  "appraisal",
  "acknowledgment",
  "response_deadlines",
  "payment_deadlines",
  "statute_of_limitations",
  "assignment_of_benefits",
  "direction_to_pay",
  "deductible",
  "restoration_contracts",
];