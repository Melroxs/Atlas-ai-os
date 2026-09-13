// ---------------------------------------------------------------------------
// Atlas Claim Review Job Handler
//
// This handler wires the Atlas Workforce Orchestrator into the existing
// Jobs system. When a "claim_review" job is dequeued by the Worker,
// this handler:
//   1. Loads the claim context
//   2. Invokes the orchestrator
//   3. Persists results
//   4. Creates work items
//   5. Drafts communications
//   6. Records evidence
//
// This is the bridge between:
//   - The durable Jobs infrastructure (survives page close)
//   - The Atlas Workforce Orchestrator (intelligence layer)
//   - The existing UI surfaces (dashboard, claims, recommendations)
// ---------------------------------------------------------------------------

import type {
  JobExecutionContext,
  HandlerResult,
} from "./types";
import {
  getAtlasWorkforce,
  createReviewClaimRequest,
  createPrepareSupplementRequest,
  createDraftCommunicationRequest,
  type OrchestrationResult,
  type ClaimIntelligenceReport,
} from "../orchestrator";
import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
} from "../insurance/logic";

// ---------------------------------------------------------------------------
// Job Types
// ---------------------------------------------------------------------------

export const CLAIM_REVIEW_JOB_TYPES = {
  FULL_REVIEW: "claim_review",
  SUPPLEMENT_PREP: "supplement_preparation",
  DRAFT_COMMUNICATION: "draft_communication",
  STATUS_CHECK: "claim_status_check",
  GAP_ANALYSIS: "gap_analysis",
  RECOVERY_CALC: "revenue_recovery_calc",
  DAILY_SCAN: "daily_scan",
  REVENUE_AUDIT: "revenue_audit",
} as const;

// ---------------------------------------------------------------------------
// Main Handler: Full Claim Review
// ---------------------------------------------------------------------------

/**
 * Handle a full claim review job.
 * This is the comprehensive digital employee workflow.
 */
export async function handleClaimReviewJob(
  ctx: JobExecutionContext,
): Promise<HandlerResult> {
  const payload = ctx.job.payload as Record<string, unknown>;
  const claimId = payload.claim_id as string;
  const tenantId = ctx.job.tenant_id;
  const userId = ctx.job.user_id;

  if (!claimId) {
    return {
      success: false,
      error: {
        code: "MISSING_CLAIM_ID",
        message: "No claim_id in job payload",
        details: {},
        retryable: false,
      },
    };
  }

  // Load claim context from payload or previous steps
  const claimData = payload.claim as ClaimSnapshot | undefined;
  if (!claimData) {
    return {
      success: false,
      error: {
        code: "MISSING_CLAIM_DATA",
        message: "Claim data not provided in job payload",
        details: {},
        retryable: false,
      },
    };
  }

  // Build the orchestration request
  const request = createReviewClaimRequest(
    claimId,
    tenantId,
    claimData,
    {
      documents: payload.documents as Array<Record<string, unknown>> | undefined,
      supplements: payload.supplements as Array<Record<string, unknown>> | undefined,
      findings: payload.findings as Array<Record<string, unknown>> | undefined,
      userId: userId ?? undefined,
      source: "system",
    },
  );

  // Execute via orchestrator
  const workforce = getAtlasWorkforce();
  const result = await workforce.processRequest(request);

  // Build the claim intelligence report
  const report = buildClaimIntelligenceReport(
    claimId,
    claimData,
    result,
  );

  // Persist the report as step output
  return {
    success: true,
    result: {
      report,
      result,
      tasks_created: result.tasksCreated.length,
      communications_generated: result.communicationsGenerated.length,
      evidence_generated: result.evidenceGenerated.length,
      deadlines_identified: result.deadlinesIdentified.length,
      completed_by_atlas: result.completedByAtlas.length,
      awaiting_approval: result.readyForHumanApproval.length,
      waiting_external: result.waitingForExternal.length,
      blocked: result.blocked.length,
      human_action_required: result.humanActionRequired.length,
      summary: result.summary,
    },
    requires_human_review: result.readyForHumanApproval.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Handler: Supplement Preparation
// ---------------------------------------------------------------------------

export async function handleSupplementPrepJob(
  ctx: JobExecutionContext,
): Promise<HandlerResult> {
  const payload = ctx.job.payload as Record<string, unknown>;
  const claimId = payload.claim_id as string;
  const tenantId = ctx.job.tenant_id;
  const claimData = payload.claim as ClaimSnapshot | undefined;

  if (!claimId || !claimData) {
    return {
      success: false,
      error: {
        code: "MISSING_DATA",
        message: "Missing claim_id or claim data",
        details: {},
        retryable: false,
      },
    };
  }

  const request = createPrepareSupplementRequest(
    claimId,
    tenantId,
    claimData,
    { userId: ctx.job.user_id ?? undefined, source: "system" },
  );

  const workforce = getAtlasWorkforce();
  const result = await workforce.processRequest(request);

  return {
    success: true,
    result: {
      result,
      summary: result.summary,
      opportunities: result.tasksCreated.length,
      communications: result.communicationsGenerated.length,
    },
    requires_human_review: result.readyForHumanApproval.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Handler: Daily Scan
// ---------------------------------------------------------------------------

export async function handleDailyScanJob(
  ctx: JobExecutionContext,
): Promise<HandlerResult> {
  const payload = ctx.job.payload as Record<string, unknown>;
  const claims = payload.claims as ClaimSnapshot[] | undefined;

  if (!claims || claims.length === 0) {
    return {
      success: false,
      error: {
        code: "NO_CLAIMS",
        message: "No claims provided for daily scan",
        details: {},
        retryable: false,
      },
    };
  }

  const request = {
    id: `req:${Date.now()}:daily_scan`,
    type: "run_daily_scan" as const,
    tenantId: ctx.job.tenant_id,
    userId: ctx.job.user_id ?? undefined,
    input: { claims },
    source: "system" as const,
    timestamp: Date.now(),
  };

  const workforce = getAtlasWorkforce();
  const result = await workforce.processRequest(request);

  return {
    success: true,
    result: {
      result,
      summary: result.summary,
      claims_scanned: claims.length,
    },
    requires_human_review: false,
  };
}

// ---------------------------------------------------------------------------
// Claim Intelligence Report Builder
// ---------------------------------------------------------------------------

function buildClaimIntelligenceReport(
  claimId: string,
  claim: ClaimSnapshot,
  orchestrationResult: OrchestrationResult,
): ClaimIntelligenceReport {
  const completeness = analyzeClaimCompleteness(claim);
  const findings = buildClaimFindings(claim);
  const reconciliation = reconcileClaim(claim, []);

  const recoveryOpportunities = findings
    .filter((f) => f.confidence >= 0.5 && f.estimatedAmount && f.estimatedAmount > 0)
    .map((f) => ({
      title: f.title,
      estimatedAmount: f.estimatedAmount ?? 0,
      confidence: f.confidence,
      status: "identified",
    }));

  const totalRecoveryPotential = recoveryOpportunities.reduce(
    (sum, o) => sum + o.estimatedAmount,
    0,
  );

  return {
    claimId,
    claimNumber: claim.claimNumber ?? null,
    generatedAt: Date.now(),
    overallStatus: claim.status ?? "unknown",
    readinessScore: completeness.score,
    summary: orchestrationResult.summary,
    completeness: {
      score: completeness.score,
      total: completeness.total,
      complete: completeness.complete,
      missing: completeness.categories
        .filter((c) => c.status === "missing")
        .map((c) => c.label),
    },
    findings: findings.map((f) => ({
      title: f.title,
      category: f.category,
      confidence: f.confidence,
      estimatedAmount: f.estimatedAmount,
      evidence: f.evidence,
    })),
    gaps: completeness.categories
      .filter((c) => c.status === "missing" || c.status === "needs_review")
      .map((c) => ({
        category: c.key,
        severity: c.key === "estimate" || c.key === "evidence" ? "critical" : "important",
        description: c.note,
        impact: `Missing ${c.label.toLowerCase()}`,
      })),
    reconciliation: {
      estimate: reconciliation.estimate,
      paid: reconciliation.paid,
      outstanding: reconciliation.outstanding,
      hasDiscrepancy: reconciliation.hasDiscrepancy,
      notes: reconciliation.notes,
    },
    revenueOpportunities: recoveryOpportunities,
    totalRecoveryPotential,
    pendingTasks: orchestrationResult.tasksCreated.length,
    criticalTasks: orchestrationResult.tasksCreated.filter((t) => t.priority === "critical").length,
    overdueFollowUps: 0,
    upcomingDeadlines: orchestrationResult.deadlinesIdentified.map((d) => ({
      title: d.title,
      dueDate: d.dueDate,
      daysUntilDue: d.daysUntilDue,
      severity: d.severity,
    })),
    recommendedActions: orchestrationResult.completedByAtlas.length > 0
      ? [`Atlas completed ${orchestrationResult.completedByAtlas.length} automated tasks`]
      : [],
    atlasCanExecute: orchestrationResult.completedByAtlas.map((t) => t.title),
    requiresHumanApproval: orchestrationResult.readyForHumanApproval.map((t) => t.title),
  };
}
