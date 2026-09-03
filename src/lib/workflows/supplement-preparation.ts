// ---------------------------------------------------------------------------
// Atlas Supplement Preparation Workflow
//
// Takes a claim through the complete supplement preparation process:
//   1. CLAIM ANALYSIS — analyze current claim state
//   2. OPPORTUNITY IDENTIFICATION — identify supplement opportunities
//   3. EVIDENCE MATCHING — match evidence to opportunities
//   4. AMOUNT CALCULATION — calculate requested amounts
//   5. NARRATIVE DRAFTING — draft supplement narrative
//   6. VALIDATION — validate completeness and accuracy
//   7. DOCUMENT GENERATION — generate supplement document
//   8. HUMAN REVIEW PREPARATION — prepare for human review
//
// CRITICAL: This workflow never:
//   - Submits the supplement automatically
//   - Makes external commitments
//   - Fabricates amounts or evidence
//   - Ignores missing information
//
// All outputs require human review before any action is taken.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
  buildSupplementDocument,
  type ClaimCompleteness,
  type ClaimFindingDraft,
  type ClaimReconciliation,
  type SupplementDocument,
} from "../insurance/logic";

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

export type SupplementWorkflowStage =
  | "claim_analysis"
  | "opportunity_identification"
  | "evidence_matching"
  | "amount_calculation"
  | "narrative_drafting"
  | "validation"
  | "document_generation"
  | "human_review_preparation";

export type SupplementWorkflowStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "failed"
  | "awaiting_human_review";

export interface SupplementWorkflowResult {
  workflowId: string;
  claimId: string;
  status: SupplementWorkflowStatus;
  stages: SupplementStageResult[];
  output: SupplementWorkflowOutput;
  generatedAt: number;
}

export interface SupplementStageResult {
  stage: SupplementWorkflowStage;
  status: SupplementWorkflowStatus;
  startedAt: number;
  completedAt: number | null;
  output: Record<string, unknown>;
  errors: string[];
}

export interface SupplementWorkflowOutput {
  claimSummary: {
    claimNumber: string | null;
    customer: string | null;
    property: string | null;
    carrier: string | null;
    estimateAmount: number | null;
    paymentAmount: number | null;
    outstanding: number;
  };
  opportunities: SupplementOpportunity[];
  totalRequestedAmount: number;
  supplementDocument: SupplementDocument | null;
  validationResults: SupplementValidation;
  humanReviewItems: HumanReviewItem[];
  readyForReview: boolean;
}

export interface SupplementOpportunity {
  id: string;
  title: string;
  description: string;
  amount: number | null;
  amountSource: string;
  evidence: string[];
  confidence: number;
  justification: string;
  affectedLineItems: string[];
  recommendedAction: string;
}

export interface SupplementValidation {
  passed: boolean;
  checks: Array<{
    check: string;
    passed: boolean;
    details: string;
  }>;
  issues: Array<{
    severity: "critical" | "warning" | "info";
    description: string;
    recommendation: string;
  }>;
}

export interface HumanReviewItem {
  category: string;
  description: string;
  whatToCheck: string;
  whyItMatters: string;
}

// ---------------------------------------------------------------------------
// Main workflow executor
// ---------------------------------------------------------------------------

export async function executeSupplementPreparationWorkflow(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>> = [],
  existingFindings: Array<Record<string, unknown>> = [],
): Promise<SupplementWorkflowResult> {
  const workflowId = `wf-supplement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stages: SupplementStageResult[] = [];

  // Stage 1: Claim Analysis
  const analysisResult = await stageClaimAnalysis(claim, documents);
  stages.push(analysisResult);

  // Stage 2: Opportunity Identification
  const opportunityResult = await stageOpportunityIdentification(claim, existingFindings);
  stages.push(opportunityResult);

  // Stage 3: Evidence Matching
  const evidenceResult = await stageEvidenceMatching(claim, documents, opportunityResult);
  stages.push(evidenceResult);

  // Stage 4: Amount Calculation
  const calculationResult = await stageAmountCalculation(claim, opportunityResult);
  stages.push(calculationResult);

  // Stage 5: Narrative Drafting
  const narrativeResult = await stageNarrativeDrafting(claim, opportunityResult, calculationResult);
  stages.push(narrativeResult);

  // Stage 6: Validation
  const validationResult = await stageValidation(claim, opportunityResult, calculationResult);
  stages.push(validationResult);

  // Stage 7: Document Generation
  const documentResult = await stageDocumentGeneration(claim, opportunityResult, calculationResult, narrativeResult);
  stages.push(documentResult);

  // Stage 8: Human Review Preparation
  const reviewResult = await stageHumanReviewPreparation(claim, opportunityResult, validationResult);
  stages.push(reviewResult);

  // Build output
  const output = buildSupplementWorkflowOutput(claim, opportunityResult, calculationResult, documentResult, validationResult, reviewResult);

  return {
    workflowId,
    claimId: String(claim._id ?? ""),
    status: "completed",
    stages,
    output,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

async function stageClaimAnalysis(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>>,
): Promise<SupplementStageResult> {
  const startTime = Date.now();

  const completeness = analyzeClaimCompleteness(claim);
  const reconciliation = reconcileClaim(claim, []);

  return {
    stage: "claim_analysis",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      completeness,
      reconciliation,
      documentCount: documents.length,
      claimStatus: claim.status,
    },
    errors: [],
  };
}

async function stageOpportunityIdentification(
  claim: ClaimSnapshot,
  existingFindings: Array<Record<string, unknown>>,
): Promise<SupplementStageResult> {
  const startTime = Date.now();

  // Get deterministic findings
  const findings = buildClaimFindings(claim);

  // Add existing persisted findings
  for (const f of existingFindings) {
    const recovery = (f.potentialRecovery as number) ?? (f.potential_recovery as number) ?? 0;
    if (recovery > 0) {
      findings.push({
        findingKey: `persisted:${f._id ?? "unknown"}`,
        category: (f.type as string) ?? "existing_finding",
        title: (f.title as string) ?? (f.description as string) ?? "Existing finding",
        description: (f.description as string) ?? "",
        evidence: f._id ? [String(f._id)] : [],
        source: "persisted_finding",
        confidence: (f.confidence as number) ?? 0.6,
        estimatedAmount: recovery,
        limitation: "Previously identified — verify current relevance",
        recommendedNextStep: "Review for current supplement potential",
      });
    }
  }

  // Convert to supplement opportunities
  const opportunities: SupplementOpportunity[] = findings.map((f) => ({
    id: f.findingKey,
    title: f.title,
    description: f.description,
    amount: f.estimatedAmount ?? null,
    amountSource: f.estimatedAmount
      ? "Calculated from claim data"
      : "Amount not determined",
    evidence: f.evidence,
    confidence: f.confidence,
    justification: f.limitation,
    affectedLineItems: f.affectedEstimateItem ? [f.affectedEstimateItem] : [],
    recommendedAction: f.recommendedNextStep,
  }));

  return {
    stage: "opportunity_identification",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      opportunities,
      totalOpportunities: opportunities.length,
    },
    errors: [],
  };
}

async function stageEvidenceMatching(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>>,
  opportunityResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];

  // Match evidence to opportunities
  const matchedOpportunities = opportunities.map((opp) => {
    const matchedEvidence = opp.evidence.filter((e) => {
      // Check if evidence exists in documents
      return documents.some(
        (d) =>
          String(d._id) === e ||
          (d.title as string)?.toLowerCase().includes(e.toLowerCase()),
      );
    });

    return {
      ...opp,
      matchedEvidenceCount: matchedEvidence.length,
      evidenceCoverage: opp.evidence.length > 0
        ? matchedEvidence.length / opp.evidence.length
        : 0,
    };
  });

  const avgCoverage = matchedOpportunities.length > 0
    ? matchedOpportunities.reduce((s, o) => s + o.evidenceCoverage, 0) / matchedOpportunities.length
    : 0;

  return {
    stage: "evidence_matching",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      matchedOpportunities,
      averageEvidenceCoverage: avgCoverage,
      totalMatched: matchedOpportunities.filter((o) => o.evidenceCoverage > 0).length,
    },
    errors: [],
  };
}

async function stageAmountCalculation(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];

  // Calculate amounts deterministically
  const calculations = opportunities.map((opp) => {
    let amount = opp.amount;
    let calculationMethod = opp.amountSource;

    if (amount === null) {
      // Try to derive from claim data
      if (typeof claim.estimateAmount === "number" && typeof claim.paymentAmount === "number") {
        const outstanding = claim.estimateAmount - claim.paymentAmount;
        if (outstanding > 0) {
          amount = outstanding;
          calculationMethod = "Derived from estimate - payment";
        }
      }
    }

    return {
      opportunityId: opp.id,
      amount: amount ?? 0,
      calculationMethod,
      confidence: opp.confidence,
      verified: amount !== null && amount > 0,
    };
  });

  const totalRequested = calculations.reduce((s, c) => s + c.amount, 0);

  return {
    stage: "amount_calculation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      calculations,
      totalRequestedAmount: totalRequested,
    },
    errors: [],
  };
}

async function stageNarrativeDrafting(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
  calculationResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];
  const calculations = calculationResult.output.calculations as Array<{
    opportunityId: string;
    amount: number;
    calculationMethod: string;
  }>;

  // Build narrative sections
  const sections: Array<{ title: string; body: string[] }> = [];

  // Introduction
  sections.push({
    title: "Introduction",
    body: [
      `This supplement is submitted for Claim ${claim.claimNumber ?? "N/A"} at ${claim.property ?? "the insured property"}.`,
      `The original insurance estimate was ${typeof claim.estimateAmount === "number" ? `$${claim.estimateAmount.toLocaleString()}` : "not available"}.`,
    ],
  });

  // Items requested
  sections.push({
    title: "Items Requested",
    body: opportunities.map((opp) => {
      const calc = calculations.find((c) => c.opportunityId === opp.id);
      const amount = calc?.amount ?? opp.amount ?? 0;
      return `• ${opp.title}${amount > 0 ? ` — $${amount.toLocaleString()}` : ""}${opp.description ? `: ${opp.description}` : ""}`;
    }),
  });

  // Evidence
  sections.push({
    title: "Supporting Evidence",
    body: [
      "The following evidence supports this supplement request:",
      ...opportunities.flatMap((opp) =>
        opp.evidence.map((e) => `  • ${e}`)
      ),
    ],
  });

  // Limitations
  sections.push({
    title: "Limitations and Assumptions",
    body: [
      "This supplement is based on available claim data and documentation.",
      "All amounts are derived from recorded claim figures — verify against actual estimate and supporting documents.",
      "Coverage terms, policy provisions, and carrier requirements are not asserted here.",
      "This document requires human review before submission.",
    ],
  });

  return {
    stage: "narrative_drafting",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      sections,
      narrativePrepared: true,
    },
    errors: [],
  };
}

async function stageValidation(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
  calculationResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];
  const calculations = calculationResult.output.calculations as Array<{
    opportunityId: string;
    amount: number;
    verified: boolean;
  }>;

  const checks: Array<{
    check: string;
    passed: boolean;
    details: string;
  }> = [];
  const issues: Array<{
    severity: "critical" | "warning" | "info";
    description: string;
    recommendation: string;
  }> = [];

  // Check 1: Has opportunities
  checks.push({
    check: "has_opportunities",
    passed: opportunities.length > 0,
    details: opportunities.length > 0
      ? `${opportunities.length} supplement opportunities identified`
      : "No supplement opportunities identified",
  });

  // Check 2: Amounts calculated
  const calculatedAmounts = calculations.filter((c) => c.verified);
  checks.push({
    check: "amounts_calculated",
    passed: calculatedAmounts.length > 0,
    details: `${calculatedAmounts.length}/${calculations.length} amounts calculated`,
  });

  // Check 3: Evidence present
  const withEvidence = opportunities.filter((o) => o.evidence.length > 0);
  checks.push({
    check: "evidence_present",
    passed: withEvidence.length > 0,
    details: `${withEvidence.length}/${opportunities.length} opportunities have supporting evidence`,
  });

  // Check 4: No negative amounts
  const negativeAmounts = calculations.filter((c) => c.amount < 0);
  checks.push({
    check: "non_negative_amounts",
    passed: negativeAmounts.length === 0,
    details: negativeAmounts.length === 0
      ? "All amounts are non-negative"
      : `${negativeAmounts.length} negative amounts detected`,
  });

  // Check 5: Total is reasonable
  const total = calculations.reduce((s, c) => s + c.amount, 0);
  checks.push({
    check: "reasonable_total",
    passed: total >= 0 && total < 10_000_000,
    details: `Total requested: $${total.toLocaleString()}`,
  });

  // Build issues from failed checks
  for (const check of checks) {
    if (!check.passed) {
      issues.push({
        severity: check.check === "has_opportunities" ? "critical" : "warning",
        description: check.details,
        recommendation: suggestValidationFix(check.check),
      });
    }
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const passed = passedChecks >= 3; // At least 3 of 5 checks must pass

  return {
    stage: "validation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      passed,
      checks,
      issues,
      passedChecks,
      totalChecks: checks.length,
    },
    errors: passed ? [] : ["Validation did not pass minimum threshold"],
  };
}

async function stageDocumentGeneration(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
  calculationResult: SupplementStageResult,
  narrativeResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];
  const calculations = calculationResult.output.calculations as Array<{
    opportunityId: string;
    amount: number;
  }>;
  const totalRequested = calculations.reduce((s, c) => s + c.amount, 0);

  // Build supplement document
  const supplementDoc = buildSupplementDocument(claim, {
    reason: opportunities.map((o) => o.title).join("; "),
    amount: totalRequested,
    affectedLineItems: opportunities.flatMap((o) => o.affectedLineItems),
    requestedItems: opportunities.map((o) => o.title),
    evidence: opportunities.flatMap((o) => o.evidence),
    justification: opportunities.map((o) => o.justification).join("; "),
    status: "draft",
  });

  return {
    stage: "document_generation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      supplementDocument: supplementDoc,
      documentReady: true,
    },
    errors: [],
  };
}

async function stageHumanReviewPreparation(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
  validationResult: SupplementStageResult,
): Promise<SupplementStageResult> {
  const startTime = Date.now();
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];
  const validation = validationResult.output as { passed: boolean; issues: Array<{ severity: string; description: string }> };

  const reviewItems: HumanReviewItem[] = [];

  // Add review items for each opportunity
  for (const opp of opportunities) {
    reviewItems.push({
      category: "opportunity_review",
      description: `Review supplement opportunity: ${opp.title}`,
      whatToCheck: `Verify that "${opp.title}" is a valid supplement item with supporting evidence.`,
      whyItMatters: `This item requests $${(opp.amount ?? 0).toLocaleString()} — ensure it's justified before submission.`,
    });
  }

  // Add review items for validation issues
  if (!validation.passed) {
    for (const issue of validation.issues) {
      reviewItems.push({
        category: "validation_issue",
        description: issue.description,
        whatToCheck: "Review and resolve this validation issue before proceeding.",
        whyItMatters: "Unresolved issues may weaken the supplement submission.",
      });
    }
  }

  // Always add final review item
  reviewItems.push({
    category: "final_review",
    description: "Final review before submission",
    whatToCheck: "Review the complete supplement document, verify all amounts, and confirm evidence is attached.",
    whyItMatters: "This is the last checkpoint before the supplement is submitted to the carrier.",
  });

  return {
    stage: "human_review_preparation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      reviewItems,
      totalReviewItems: reviewItems.length,
    },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSupplementWorkflowOutput(
  claim: ClaimSnapshot,
  opportunityResult: SupplementStageResult,
  calculationResult: SupplementStageResult,
  documentResult: SupplementStageResult,
  validationResult: SupplementStageResult,
  reviewResult: SupplementStageResult,
): SupplementWorkflowOutput {
  const opportunities = opportunityResult.output.opportunities as SupplementOpportunity[];
  const calculations = calculationResult.output.calculations as Array<{
    amount: number;
  }>;
  const totalRequested = calculations.reduce((s, c) => s + c.amount, 0);
  const supplementDoc = documentResult.output.supplementDocument as SupplementDocument | null;
  const validation = validationResult.output as { passed: boolean; checks: Array<{ check: string; passed: boolean; details: string }>; issues: Array<{ severity: "critical" | "warning" | "info"; description: string; recommendation: string }> };
  const reviewItems = reviewResult.output.reviewItems as HumanReviewItem[];

  return {
    claimSummary: {
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      carrier: claim.carrier ?? null,
      estimateAmount: claim.estimateAmount ?? null,
      paymentAmount: claim.paymentAmount ?? null,
      outstanding: typeof claim.estimateAmount === "number" && typeof claim.paymentAmount === "number"
        ? claim.estimateAmount - claim.paymentAmount
        : 0,
    },
    opportunities,
    totalRequestedAmount: totalRequested,
    supplementDocument: supplementDoc,
    validationResults: validation,
    humanReviewItems: reviewItems,
    readyForReview: validation.passed && reviewItems.length > 0,
  };
}

function suggestValidationFix(checkName: string): string {
  switch (checkName) {
    case "has_opportunities":
      return "Review claim data and evidence for potential supplement items";
    case "amounts_calculated":
      return "Verify estimate and payment amounts are recorded";
    case "evidence_present":
      return "Attach supporting evidence documents to the claim";
    case "non_negative_amounts":
      return "Review calculations for errors";
    case "reasonable_total":
      return "Review individual amounts for accuracy";
    default:
      return "Review and correct the issue";
  }
}
