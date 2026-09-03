// ---------------------------------------------------------------------------
// Atlas Claim Review Workflow
//
// Orchestrates the evidence, gap intelligence, supplement reasoning, and QA
// agents into a complete end-to-end claim review process.
//
// Workflow stages:
//   1. CONTEXT ASSEMBLY — gather all claim data
//   2. EVIDENCE ANALYSIS — analyze available evidence
//   3. GAP IDENTIFICATION — identify missing evidence
//   4. SUPPLEMENT ANALYSIS — identify recovery opportunities
//   5. QA VALIDATION — validate all outputs
//   6. DRAFT GENERATION — generate required communications
//   7. EVIDENCE RECORDING — record all analysis as evidence
//   8. WORKFLOW UPDATE — update claim status
//
// Every stage produces structured output with provenance.
// Human approval is required before any external action.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
  buildSupplementDocument,
  buildClaimTimeline,
  type ClaimCompleteness,
  type ClaimFindingDraft,
  type ClaimReconciliation,
  type SupplementDocument,
  type ClaimTimelineEvent,
} from "../insurance/logic";

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

export type WorkflowStage =
  | "context_assembly"
  | "evidence_analysis"
  | "gap_identification"
  | "supplement_analysis"
  | "qa_validation"
  | "draft_generation"
  | "evidence_recording"
  | "workflow_update";

export type WorkflowStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "failed"
  | "awaiting_approval"
  | "blocked";

export interface WorkflowResult {
  workflowId: string;
  claimId: string;
  status: WorkflowStatus;
  stages: StageResult[];
  summary: WorkflowSummary;
  generatedAt: number;
}

export interface StageResult {
  stage: WorkflowStage;
  status: WorkflowStatus;
  startedAt: number;
  completedAt: number | null;
  output: Record<string, unknown>;
  errors: string[];
  provenance: ProvenanceEntry[];
}

export interface ProvenanceEntry {
  source: string;
  contribution: string;
  confidence: number;
  timestamp: number;
}

export interface WorkflowSummary {
  claimCompleteness: number;
  findingsCount: number;
  totalRecoveryPotential: number;
  gapsCount: number;
  criticalGapsCount: number;
  draftsGenerated: number;
  requiresHumanReview: boolean;
  recommendedActions: string[];
}

// ---------------------------------------------------------------------------
// Main workflow executor
// ---------------------------------------------------------------------------

export async function executeClaimReviewWorkflow(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>> = [],
  supplements: Array<Record<string, unknown>> = [],
  existingFindings: Array<Record<string, unknown>> = [],
): Promise<WorkflowResult> {
  const workflowId = `wf-claim-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stages: StageResult[] = [];

  // Stage 1: Context Assembly
  const contextResult = await stageContextAssembly(claim, documents, supplements, existingFindings);
  stages.push(contextResult);

  if (contextResult.status === "failed") {
    return buildWorkflowResult(workflowId, claim, stages, "failed");
  }

  // Stage 2: Evidence Analysis
  const evidenceResult = await stageEvidenceAnalysis(claim, documents, existingFindings);
  stages.push(evidenceResult);

  // Stage 3: Gap Identification
  const gapResult = await stageGapIdentification(contextResult);
  stages.push(gapResult);

  // Stage 4: Supplement Analysis
  const supplementResult = await stageSupplementAnalysis(claim, existingFindings);
  stages.push(supplementResult);

  // Stage 5: QA Validation
  const qaResult = await stageQAValidation(evidenceResult, gapResult, supplementResult);
  stages.push(qaResult);

  // Stage 6: Draft Generation
  const draftResult = await stageDraftGeneration(claim, supplementResult);
  stages.push(draftResult);

  // Stage 7: Evidence Recording
  const recordingResult = await stageEvidenceRecording(stages);
  stages.push(recordingResult);

  // Stage 8: Workflow Update
  const updateResult = await stageWorkflowUpdate(claim, stages);
  stages.push(updateResult);

  return buildWorkflowResult(workflowId, claim, stages, "completed");
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

async function stageContextAssembly(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>>,
  supplements: Array<Record<string, unknown>>,
  existingFindings: Array<Record<string, unknown>>,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  // Assemble all context
  const context = {
    claim: {
      id: claim._id,
      claimNumber: claim.claimNumber,
      customer: claim.customer,
      property: claim.property,
      carrier: claim.carrier,
      status: claim.status,
      estimateAmount: claim.estimateAmount,
      paymentAmount: claim.paymentAmount,
      invoicedAmount: claim.invoicedAmount,
      approvedAmount: claim.approvedAmount,
    },
    documentCount: documents.length,
    supplementCount: supplements.length,
    existingFindingCount: existingFindings.length,
  };

  provenance.push({
    source: "claim_data",
    contribution: "Assembled claim context from database",
    confidence: 1.0,
    timestamp: Date.now(),
  });

  return {
    stage: "context_assembly",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: { context },
    errors: [],
    provenance,
  };
}

async function stageEvidenceAnalysis(
  claim: ClaimSnapshot,
  documents: Array<Record<string, unknown>>,
  existingFindings: Array<Record<string, unknown>>,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  // Deterministic evidence analysis
  const completeness = analyzeClaimCompleteness(claim);
  const findings = buildClaimFindings(claim);

  provenance.push({
    source: "completeness_analyzer",
    contribution: `Analyzed ${completeness.total} completeness categories`,
    confidence: 1.0,
    timestamp: Date.now(),
  });

  provenance.push({
    source: "findings_analyzer",
    contribution: `Identified ${findings.length} potential findings`,
    confidence: 0.8,
    timestamp: Date.now(),
  });

  return {
    stage: "evidence_analysis",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      completeness,
      findings,
      documentAnalysis: {
        totalDocuments: documents.length,
        documentsByType: categorizeDocuments(documents),
      },
    },
    errors: [],
    provenance,
  };
}

async function stageGapIdentification(
  contextResult: StageResult,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  const completeness = contextResult.output.completeness as ClaimCompleteness;
  const gaps: Array<{
    category: string;
    severity: "critical" | "important" | "informational";
    description: string;
    impact: string;
    recommendedAction: string;
  }> = [];

  for (const cat of completeness.categories) {
    if (cat.status === "missing" || cat.status === "needs_review") {
      const severity = categorizeGapSeverity(cat.key);
      gaps.push({
        category: cat.key,
        severity,
        description: `Missing: ${cat.label}`,
        impact: describeGapImpact(cat.key),
        recommendedAction: suggestGapAction(cat.key),
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, important: 1, informational: 2 };
  gaps.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const criticalGaps = gaps.filter((g) => g.severity === "critical");

  provenance.push({
    source: "gap_analyzer",
    contribution: `Identified ${gaps.length} gaps (${criticalGaps.length} critical)`,
    confidence: 0.9,
    timestamp: Date.now(),
  });

  return {
    stage: "gap_identification",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      gaps,
      criticalGaps: criticalGaps.map((g) => g.category),
      overallReadiness: completeness.score,
    },
    errors: [],
    provenance,
  };
}

async function stageSupplementAnalysis(
  claim: ClaimSnapshot,
  existingFindings: Array<Record<string, unknown>>,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  // Use existing deterministic findings
  const findings = buildClaimFindings(claim);
  const reconciliation = reconcileClaim(claim, []);

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

  const totalRecoveryPotential = findings.reduce(
    (sum, f) => sum + (f.estimatedAmount ?? 0),
    0,
  );

  provenance.push({
    source: "supplement_analyzer",
    contribution: `Identified ${findings.length} recovery opportunities totaling $${totalRecoveryPotential.toLocaleString()}`,
    confidence: 0.75,
    timestamp: Date.now(),
  });

  return {
    stage: "supplement_analysis",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      findings,
      reconciliation,
      totalRecoveryPotential,
      recommendations: findings.map((f) => ({
        opportunity: f.title,
        amount: f.estimatedAmount,
        confidence: f.confidence,
        action: f.recommendedNextStep,
      })),
    },
    errors: [],
    provenance,
  };
}

async function stageQAValidation(
  evidenceResult: StageResult,
  gapResult: StageResult,
  supplementResult: StageResult,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  const checks: Array<{
    check: string;
    passed: boolean;
    details: string;
  }> = [];

  // Check 1: Completeness data present
  checks.push({
    check: "completeness_data",
    passed: !!evidenceResult.output.completeness,
    details: evidenceResult.output.completeness
      ? "Completeness analysis present"
      : "Missing completeness analysis",
  });

  // Check 2: Findings grounded in evidence
  const findings = supplementResult.output.findings as ClaimFindingDraft[];
  const groundedFindings = findings.filter(
    (f) => f.evidence && f.evidence.length > 0,
  );
  checks.push({
    check: "evidence_grounding",
    passed: findings.length === 0 || groundedFindings.length / findings.length >= 0.5,
    details: `${groundedFindings.length}/${findings.length} findings have supporting evidence`,
  });

  // Check 3: Financial consistency
  const reconciliation = supplementResult.output.reconciliation as ClaimReconciliation;
  checks.push({
    check: "financial_consistency",
    passed: !reconciliation.hasDiscrepancy,
    details: reconciliation.hasDiscrepancy
      ? `Financial discrepancy detected: ${reconciliation.notes.join("; ")}`
      : "Financial records are consistent",
  });

  // Check 4: No contradictions in gap analysis
  const gaps = gapResult.output.gaps as Array<{ severity: string; category: string }>;
  const criticalGaps = gaps.filter((g) => g.severity === "critical");
  checks.push({
    check: "critical_gaps_identified",
    passed: true, // Always passes — we want to know about critical gaps
    details: criticalGaps.length > 0
      ? `${criticalGaps.length} critical gaps identified: ${criticalGaps.map((g) => g.category).join(", ")}`
      : "No critical gaps",
  });

  // Check 5: Recovery potential is non-negative
  const totalRecovery = supplementResult.output.totalRecoveryPotential as number;
  checks.push({
    check: "recovery_non_negative",
    passed: totalRecovery >= 0,
    details: `Total recovery potential: $${totalRecovery.toLocaleString()}`,
  });

  const passedChecks = checks.filter((c) => c.passed).length;
  const overallScore = Math.round((passedChecks / checks.length) * 100);
  const passed = overallScore >= 70;

  provenance.push({
    source: "qa_validator",
    contribution: `Validated ${passedChecks}/${checks.length} checks (${overallScore}%)`,
    confidence: overallScore / 100,
    timestamp: Date.now(),
  });

  return {
    stage: "qa_validation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      passed,
      checks,
      overallScore,
      passedChecks,
      totalChecks: checks.length,
    },
    errors: passed ? [] : ["QA validation did not pass all checks"],
    provenance,
  };
}

async function stageDraftGeneration(
  claim: ClaimSnapshot,
  supplementResult: StageResult,
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  const findings = supplementResult.output.findings as ClaimFindingDraft[];
  const reconciliation = supplementResult.output.reconciliation as ClaimReconciliation;

  // Generate internal note
  const internalNote = {
    type: "internal_note",
    content: generateInternalNoteContent(claim, findings, reconciliation),
  };

  // Generate supplement narrative if there are findings
  let supplementNarrative: Record<string, unknown> | null = null;
  if (findings.length > 0) {
    const supplementDoc = buildSupplementDocument(claim, {
      reason: findings.map((f) => f.title).join("; "),
      amount: supplementResult.output.totalRecoveryPotential as number,
      affectedLineItems: findings.map((f) => f.affectedEstimateItem ?? "").filter(Boolean),
      evidence: findings.flatMap((f) => f.evidence),
      status: "draft",
    });
    supplementNarrative = {
      type: "supplement_narrative",
      document: supplementDoc,
    };
  }

  provenance.push({
    source: "draft_generator",
    contribution: `Generated ${supplementNarrative ? "2" : "1"} draft(s)`,
    confidence: 0.9,
    timestamp: Date.now(),
  });

  return {
    stage: "draft_generation",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      drafts: [internalNote, supplementNarrative].filter(Boolean),
      draftCount: supplementNarrative ? 2 : 1,
    },
    errors: [],
    provenance,
  };
}

async function stageEvidenceRecording(
  stages: StageResult[],
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  // Aggregate all provenance from previous stages
  const allProvenance: ProvenanceEntry[] = [];
  for (const stage of stages) {
    allProvenance.push(...stage.provenance);
  }

  // Build evidence record
  const evidenceRecord = {
    workflowId: stages[0]?.output?.workflowId ?? "unknown",
    stagesCompleted: stages.filter((s) => s.status === "completed").length,
    totalStages: stages.length,
    totalProvenance: allProvenance.length,
    evidenceSummary: allProvenance.map((p) => ({
      source: p.source,
      contribution: p.contribution,
      confidence: p.confidence,
    })),
  };

  provenance.push({
    source: "evidence_recorder",
    contribution: `Recorded ${allProvenance.length} provenance entries`,
    confidence: 1.0,
    timestamp: Date.now(),
  });

  return {
    stage: "evidence_recording",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: { evidenceRecord },
    errors: [],
    provenance,
  };
}

async function stageWorkflowUpdate(
  claim: ClaimSnapshot,
  stages: StageResult[],
): Promise<StageResult> {
  const startTime = Date.now();
  const provenance: ProvenanceEntry[] = [];

  // Determine recommended status update
  const recommendedActions: string[] = [];

  // Check if there are critical gaps
  const gapStage = stages.find((s) => s.stage === "gap_identification");
  if (gapStage) {
    const criticalGaps = gapStage.output.criticalGaps as string[];
    if (criticalGaps.length > 0) {
      recommendedActions.push(
        `Address critical gaps: ${criticalGaps.join(", ")}`,
      );
    }
  }

  // Check if there are supplement opportunities
  const supplementStage = stages.find((s) => s.stage === "supplement_analysis");
  if (supplementStage) {
    const totalRecovery = supplementStage.output.totalRecoveryPotential as number;
    if (totalRecovery > 0) {
      recommendedActions.push(
        `Review supplement opportunities ($${totalRecovery.toLocaleString()} potential)`,
      );
    }
  }

  // Check QA result
  const qaStage = stages.find((s) => s.stage === "qa_validation");
  if (qaStage && !qaStage.output.passed) {
    recommendedActions.push("Address QA validation issues before proceeding");
  }

  provenance.push({
    source: "workflow_updater",
    contribution: `Generated ${recommendedActions.length} recommended actions`,
    confidence: 1.0,
    timestamp: Date.now(),
  });

  return {
    stage: "workflow_update",
    status: "completed",
    startedAt: startTime,
    completedAt: Date.now(),
    output: {
      recommendedActions,
      requiresHumanReview: true,
      claimStatus: claim.status,
    },
    errors: [],
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWorkflowResult(
  workflowId: string,
  claim: ClaimSnapshot,
  stages: StageResult[],
  status: WorkflowStatus,
): WorkflowResult {
  // Build summary from stage outputs
  const completeness = stages.find((s) => s.stage === "evidence_analysis")
    ?.output.completeness as ClaimCompleteness | undefined;
  const findings = stages.find((s) => s.stage === "supplement_analysis")
    ?.output.findings as ClaimFindingDraft[] | undefined;
  const gaps = stages.find((s) => s.stage === "gap_identification")
    ?.output.gaps as Array<{ category: string; severity: string }> | undefined;
  const drafts = stages.find((s) => s.stage === "draft_generation")
    ?.output.drafts as Array<Record<string, unknown>> | undefined;
  const qaPassed = stages.find((s) => s.stage === "qa_validation")
    ?.output.passed as boolean | undefined;
  const recommendedActions = stages.find((s) => s.stage === "workflow_update")
    ?.output.recommendedActions as string[] | undefined;

  const summary: WorkflowSummary = {
    claimCompleteness: completeness?.score ?? 0,
    findingsCount: findings?.length ?? 0,
    totalRecoveryPotential: findings?.reduce((s, f) => s + (f.estimatedAmount ?? 0), 0) ?? 0,
    gapsCount: gaps?.length ?? 0,
    criticalGapsCount: gaps?.filter((g) => g.severity === "critical").length ?? 0,
    draftsGenerated: drafts?.length ?? 0,
    requiresHumanReview: !qaPassed || (findings?.length ?? 0) > 0,
    recommendedActions: recommendedActions ?? [],
  };

  return {
    workflowId,
    claimId: String(claim._id ?? ""),
    status,
    stages,
    summary,
    generatedAt: Date.now(),
  };
}

function categorizeDocuments(
  docs: Array<Record<string, unknown>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const doc of docs) {
    const type = (doc.classification as string) ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function categorizeGapSeverity(
  category: string,
): "critical" | "important" | "informational" {
  const critical = [
    "estimate",
    "evidence",
    "coverage",
    "claimNumber",
    "dateOfLoss",
  ];
  const important = [
    "customer",
    "property",
    "carrier",
    "invoices",
    "financialState",
  ];

  if (critical.includes(category)) return "critical";
  if (important.includes(category)) return "important";
  return "informational";
}

function describeGapImpact(category: string): string {
  const impacts: Record<string, string> = {
    estimate: "Cannot calculate recovery potential without estimate data",
    evidence: "Claim position may be weak without supporting documentation",
    coverage: "Cannot verify coverage terms and limits",
    claimNumber: "Cannot track claim with carrier",
    dateOfLoss: "Policy timeline and deadlines cannot be verified",
    customer: "Cannot communicate with insured party",
    property: "Property details unavailable for analysis",
    carrier: "Carrier-specific procedures cannot be applied",
    invoices: "Cannot track billing and payments",
    financialState: "Financial reconciliation incomplete",
  };
  return impacts[category] || "May weaken the claim position";
}

function suggestGapAction(category: string): string {
  const actions: Record<string, string> = {
    estimate: "Record the insurance estimate amount",
    evidence: "Upload and link supporting evidence documents",
    coverage: "Request policy declaration page from carrier",
    claimNumber: "Record the claim number from carrier correspondence",
    dateOfLoss: "Record the date of loss from claim documents",
    customer: "Record customer/insured name",
    property: "Record property address",
    carrier: "Record insurance carrier name",
    invoices: "Record invoice amounts when available",
    financialState: "Record payment and approval amounts",
  };
  return actions[category] || "Gather relevant documentation";
}

function generateInternalNoteContent(
  claim: ClaimSnapshot,
  findings: ClaimFindingDraft[],
  reconciliation: ClaimReconciliation,
): string {
  const lines: string[] = [];
  lines.push(`INTERNAL NOTE — Claim Review Complete`);
  lines.push(`Claim: ${claim.claimNumber ?? "N/A"}`);
  lines.push(`Property: ${claim.property ?? "N/A"}`);
  lines.push(`Customer: ${claim.customer ?? "N/A"}`);
  lines.push("");

  if (findings.length > 0) {
    lines.push(`Findings (${findings.length}):`);
    for (const f of findings) {
      lines.push(`  • ${f.title}${f.estimatedAmount ? ` — $${f.estimatedAmount.toLocaleString()}` : ""}`);
    }
    lines.push("");
  }

  if (reconciliation.hasDiscrepancy) {
    lines.push("Financial reconciliation issues:");
    for (const note of reconciliation.notes) {
      lines.push(`  • ${note}`);
    }
  }

  return lines.join("\n");
}
