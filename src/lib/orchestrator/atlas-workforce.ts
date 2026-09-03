// ---------------------------------------------------------------------------
// Atlas Workforce Orchestrator — Central Coordination Layer
//
// This is the "brain" that:
//   1. Receives commands (voice, UI, automation)
//   2. Classifies what needs to happen
//   3. Assembles context
//   4. Executes workflows
//   5. Tracks results
//   6. Creates work items
//   7. Drafts communications
//   8. Identifies deadlines
//   9. Reports what was completed
//
// The orchestrator does NOT execute directly — it coordinates existing
// engines, agents, and workflows through the Jobs system.
// ---------------------------------------------------------------------------

import type {
  OrchestrationRequest,
  OrchestrationResult,
  TaskResult,
  WorkItem,
  EvidenceRecord,
  CommunicationRecord,
  DeadlineRecord,
  ClaimIntelligenceReport,
  TaskCategory,
  TaskPriority,
  TaskStatus,
  CapabilityDomain,
  GovernanceSummary,
} from "./types";

import {
  executeGovernanceGate,
  gateCommunication,
  gateSupplement,
  gateFinancial,
  buildDefaultGovernanceKnowledgeSource,
  resolveJurisdiction,
  extractStateFromProperty,
  buildTemporalContext,
  type KnowledgeSource,
  type ComplianceContext,
  type GovernanceGateResult,
} from "../governance";
import {
  buildGovernanceRecord,
  persistGovernanceDecision,
} from "../governance/persistence";

import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
  enrichClaimFromEvidence,
  type ClaimCompleteness,
  type ClaimFindingDraft,
  type ClaimReconciliation,
} from "../insurance/logic";

import { buildWorkQueue, buildWorkQueueSummary } from "../work-queue/service";
import { trackDeadlines, buildDeadlineSummary } from "../comms/deadline-tracker";
import { generateDailyBriefing } from "../comms/daily-briefing";
import { scheduleFollowUps, buildFollowUpSummary } from "../comms/follow-up-scheduler";
import { generateDraft } from "../comms/drafting";

// ---------------------------------------------------------------------------
// Singleton orchestrator instance
// ---------------------------------------------------------------------------

let _orchestrator: AtlasWorkforce | null = null;

export function getAtlasWorkforce(): AtlasWorkforce {
  if (!_orchestrator) {
    _orchestrator = new AtlasWorkforce();
  }
  return _orchestrator;
}

// ---------------------------------------------------------------------------
// Atlas Workforce Orchestrator
// ---------------------------------------------------------------------------

export class AtlasWorkforce {
  private requestCounter = 0;
  private governanceSource: KnowledgeSource | null = null;

  private getGovernanceSource(): KnowledgeSource {
    if (!this.governanceSource) {
      this.governanceSource = buildDefaultGovernanceKnowledgeSource();
    }
    return this.governanceSource;
  }

  /**
   * Run the governance gate BEFORE a material action produces output.
   *
   * Every material action (claim review, supplement preparation, communication
   * drafting, financial calculation) passes through the governance gate, which
   * applies the authority hierarchy, jurisdiction resolution, temporal
   * validity, and the role-boundary authorization matrix.
   *
   * A gate failure is never swallowed silently: it is recorded as an UNKNOWN
   * decision with the error in the trace so the audit trail stays honest.
   */
  private async evaluateGovernance(
    request: OrchestrationRequest,
    opts: {
      actionType: string;
      claim?: ClaimSnapshot;
      financialAmount?: number;
      commType?: "carrier" | "customer" | "adjuster" | "internal" | "escalation";
      supplementPhase?: "preparation" | "submission";
      actionDescription: string;
    },
  ): Promise<{ summary: GovernanceSummary; gateResult?: GovernanceGateResult }> {
    const start = Date.now();
    const claim = opts.claim;

    // Jurisdiction is resolved from actual claim data (property address),
    // never from user input alone.
    const jurisdiction = claim?.property
      ? resolveJurisdiction({
          propertyState: extractStateFromProperty(claim.property),
          propertyAddress: claim.property ?? undefined,
        }).fullJurisdiction
      : undefined;

    const context: ComplianceContext = {
      actionType: opts.actionType,
      actionDescription: opts.actionDescription,
      claimId: claim?._id ? String(claim._id) : request.claimId,
      tenantId: request.tenantId,
      userId: request.userId,
      performingRole: "atlas",
      jurisdiction,
      temporalContext: buildTemporalContext({
        lossDate: claim?.dateOfLoss ?? undefined,
      }),
      financialAmount: opts.financialAmount,
    };

    try {
      let gateResult: GovernanceGateResult;
      if (opts.commType) {
        gateResult = await gateCommunication(
          { ...context, commType: opts.commType },
          this.getGovernanceSource(),
        );
      } else if (opts.supplementPhase) {
        gateResult = await gateSupplement(
          { ...context, phase: opts.supplementPhase },
          this.getGovernanceSource(),
        );
      } else if (opts.actionType === "financial_calculation") {
        gateResult = await gateFinancial(
          { ...context, financialType: "calculation" },
          this.getGovernanceSource(),
        );
      } else {
        gateResult = await executeGovernanceGate(
          context,
          this.getGovernanceSource(),
        );
      }

      return {
        summary: this.toGovernanceSummary(
          gateResult,
          opts.actionType,
          jurisdiction,
          Date.now() - start,
        ),
        gateResult,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        summary: {
          evaluated: true,
          actionType: opts.actionType,
          decision: "UNKNOWN",
          riskLevel: "high",
          jurisdiction,
          knowledgeReferenceDate: Date.now(),
          reason: `Governance gate failed to evaluate: ${message}`,
          applicableRules: [],
          applicableStandards: [],
          applicableRuleCount: 0,
          applicableStandardsCount: 0,
          requiredApprovals: ["human_review"],
          requiredEvidence: [],
          knowledgeGaps: [
            {
              description: `Governance evaluation failed: ${message}`,
              severity: "critical",
              requiresHumanReview: true,
            },
          ],
          knowledgeGapCount: 1,
          citations: [],
          evidenceChain: [
            {
              id: `ec-gate-fail-${Date.now()}`,
              type: "compliance_decision",
              description: `Governance gate failed for ${opts.actionType}: ${message}`,
              confidence: 0,
              timestamp: Date.now(),
            },
          ],
          evaluationTrace: [`[GOVERNANCE] Gate failed: ${message}`],
          evaluationTimeMs: Date.now() - start,
          persisted: false,
        },
      };
    }
  }

  /** Collapse a governance gate result into a compact, serializable summary. */
  private toGovernanceSummary(
    gate: GovernanceGateResult,
    actionType: string,
    jurisdiction: string | undefined,
    evaluationTimeMs: number,
  ): GovernanceSummary {
    return {
      evaluated: true,
      actionType,
      decision: gate.compliance.decision,
      riskLevel: gate.compliance.riskLevel,
      jurisdiction,
      knowledgeReferenceDate: Date.now(),
      reason: gate.compliance.reason,
      applicableRules: gate.compliance.applicableRules.map((r) => ({
        id: r.id,
        title: r.title,
        authorityLevel: r.authorityLevel,
        authorityBasis: r.authorityBasis,
        citation: r.citation,
        effectiveFrom: r.effectiveFrom,
        jurisdiction: r.jurisdiction,
        confidence: r.confidence,
      })),
      applicableStandards: gate.compliance.applicableStandards.map((s) => ({
        id: s.id,
        title: s.title,
        authorityLevel: s.authorityLevel,
        authorityBasis: s.authorityBasis,
        citation: s.citation,
        effectiveFrom: s.effectiveFrom,
        jurisdiction: s.jurisdiction,
        confidence: s.confidence,
      })),
      applicableRuleCount: gate.compliance.applicableRules.length,
      applicableStandardsCount: gate.compliance.applicableStandards.length,
      requiredApprovals: gate.requiredApprovals,
      requiredEvidence: gate.compliance.requiredEvidence,
      knowledgeGaps: gate.compliance.knowledgeGaps.map((g) => ({
        description: g.description,
        severity: g.severity,
        impact: g.impact,
        requiresHumanReview: g.requiresHumanReview,
      })),
      knowledgeGapCount: gate.compliance.knowledgeGaps.length,
      citations: gate.compliance.citations,
      evidenceChain: gate.evidenceChain,
      evaluationTrace: gate.compliance.evaluationTrace,
      evaluationTimeMs,
      persisted: false,
    };
  }

  /**
   * Persist a governance decision through the persistence service (best
   * effort — a persistence failure is recorded on the summary and never
   * crashes the orchestration). The decision is persisted EVEN when blocked.
   */
  private async persistGovernance(
    request: OrchestrationRequest,
    summary: GovernanceSummary,
    opts: {
      entityType: string;
      entityId: string;
      claim?: ClaimSnapshot;
      actionId?: string;
    },
  ): Promise<GovernanceSummary> {
    const claim = opts.claim;
    const record = buildGovernanceRecord(summary, {
      claimId: claim?._id ? String(claim._id) : request.claimId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      orchestrationId: request.id,
      actionId: opts.actionId,
      lossDate: claim?.dateOfLoss ?? undefined,
    });
    const outcome = await persistGovernanceDecision(record);
    if (!outcome.persisted) {
      return {
        ...summary,
        persisted: false,
        evaluationTrace: [
          ...summary.evaluationTrace,
          `[GOVERNANCE-PERSIST] Failed to persist decision: ${outcome.error ?? "unknown"}`,
        ],
      };
    }
    return { ...summary, persisted: true, decisionId: outcome.decisionId };
  }

  /** Build the evidence record for a governance gate evaluation. */
  private governanceEvidenceRecord(
    claimId: string,
    summary: GovernanceSummary,
  ): EvidenceRecord {
    return {
      id: `evidence:${claimId}:governance:${summary.actionType}`,
      claimId,
      type: "action",
      source: "governance_gate",
      extractedFact: `${summary.actionType} → ${summary.decision} (risk: ${summary.riskLevel}). ${summary.reason}`,
      confidence: summary.decision === "ALLOW" ? 1 : 0.8,
      timestamp: Date.now(),
      rule: "governance_gate",
    };
  }

  /**
   * Process an orchestration request.
   * This is the main entry point for all Atlas capabilities.
   */
  async processRequest(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const results: TaskResult[] = [];
    const evidence: EvidenceRecord[] = [];
    const communications: CommunicationRecord[] = [];
    const tasks: WorkItem[] = [];
    const deadlines: DeadlineRecord[] = [];

    try {
      // Route based on command type
      switch (request.type) {
        case "review_claim":
          return await this.reviewClaim(request);

        case "prepare_supplement":
          return await this.prepareSupplement(request);

        case "check_status":
          return await this.checkClaimStatus(request);

        case "draft_communication":
          return await this.draftCommunication(request);

        case "identify_gaps":
          return await this.identifyGaps(request);

        case "calculate_recovery":
          return await this.calculateRecovery(request);

        case "schedule_followup":
          return await this.scheduleFollowup(request);

        case "generate_briefing":
          return await this.generateBriefing(request);

        case "run_daily_scan":
          return await this.runDailyScan(request);

        case "audit_revenue":
          return await this.auditRevenue(request);

        default:
          return this.buildResult(
            request.id,
            "failed",
            [],
            [],
            [],
            [],
            `Unknown command type: ${request.type}`,
            `Failed: unknown command type ${request.type}`,
            Date.now() - startTime,
          );
      }
    } catch (error) {
      return this.buildResult(
        request.id,
        "failed",
        [],
        [],
        [],
        [],
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        Date.now() - startTime,
      );
    }
  }

  /**
   * Full claim review — the comprehensive digital employee workflow.
   * This is the core capability that demonstrates Atlas understanding a claim.
   */
  async reviewClaim(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claimId = request.claimId ?? (request.input.claimId as string);

    if (!claimId) {
    return this.buildResult(
      request.id,
      "failed",
      [],
      [],
      [],
      [],
      "No claim ID provided",
      "Failed: no claim ID provided",
      0,
    );
    }

    // 1. Assemble claim context
    const claim = request.input.claim as ClaimSnapshot | undefined;
    if (!claim) {
    return this.buildResult(
      request.id,
      "failed",
      [],
      [],
      [],
      [],
      "Claim data not provided in request input",
      "Failed: claim data not provided",
      0,
    );
    }

    const documents = (request.input.documents as Array<Record<string, unknown>>) ?? [];
    const supplements = (request.input.supplements as Array<Record<string, unknown>>) ?? [];
    const existingFindings = (request.input.findings as Array<Record<string, unknown>>) ?? [];

    // 1b. GOVERNANCE GATE — evaluate the claim review action before execution
    const governance = await this.evaluateGovernance(request, {
      actionType: "claim_analysis",
      claim,
      actionDescription: `Full claim review for ${claim.claimNumber ?? claim._id ?? "unknown claim"}`,
    });
    const persistedGovernance = await this.persistGovernance(
      request,
      governance.summary,
      { entityType: "claim", entityId: claimId, claim, actionId: `review:${claimId}` },
    );

    // 2. Analyze completeness
    const completeness = analyzeClaimCompleteness(claim);

    // 3. Build findings
    const findings = buildClaimFindings(claim);

    // 4. Reconcile finances
    const reconciliation = reconcileClaim(claim, supplements);

    // 5. Track deadlines
    const claimDeadlines = trackDeadlines([claim]);

    // 6. Build work queue
    const workItems = buildWorkQueue(
      [claim],
      supplements,
      existingFindings,
    );

    // 7. Schedule follow-ups
    const followUps = scheduleFollowUps([claim]);

    // 8. Generate work items from analysis
    const tasksCreated = this.generateTasksFromAnalysis(
      claimId,
      completeness,
      findings,
      reconciliation,
      claimDeadlines,
      workItems,
    );

    // 9. Identify communications needed
    const commsNeeded = this.identifyCommunicationsNeeded(
      claimId,
      completeness,
      findings,
      reconciliation,
    );

    // 10. Build evidence records
    const evidenceRecords = this.buildEvidenceRecords(
      claimId,
      completeness,
      findings,
      reconciliation,
    );

    // 11. Generate recommendations
    const recommendations = this.generateRecommendations(
      completeness,
      findings,
      reconciliation,
      claimDeadlines,
    );

    // 12. Classify results
    const completed: TaskResult[] = [];
    const awaitingApproval: TaskResult[] = [];
    const waitingExternal: TaskResult[] = [];
    const blocked: TaskResult[] = [];
    const humanRequired: TaskResult[] = [];

    for (const task of tasksCreated) {
      const result: TaskResult = {
        id: task.id,
        category: task.category,
        title: task.title,
        description: task.description,
        status: task.status,
        confidence: 1.0,
        requiresHumanReview: task.owner === "human",
        evidenceUsed: task.evidence,
        automationAvailable: task.automationAvailable,
        suggestedAction: task.recommendedAction,
      };

      if (task.status === "completed") {
        completed.push(result);
      } else if (task.status === "awaiting_approval") {
        awaitingApproval.push(result);
      } else if (task.status === "awaiting_external") {
        waitingExternal.push(result);
      } else if (task.status === "blocked") {
        blocked.push(result);
      } else {
        humanRequired.push(result);
      }
    }

    // 13. Build summary
    const summary = this.buildClaimReviewSummary(
      completeness,
      findings,
      reconciliation,
      tasksCreated,
      claimDeadlines,
      recommendations,
    );

    return this.buildResult(
      request.id,
      "completed",
      completed,
      awaitingApproval,
      waitingExternal,
      blocked,
      humanRequired.length > 0 ? humanRequired : [],
      summary,
      Date.now() - startTime,
      [...evidenceRecords, this.governanceEvidenceRecord(claimId, persistedGovernance)],
      commsNeeded,
      tasksCreated,
      claimDeadlines.map((d) => ({
        id: d.id,
        claimId: d.claimId,
        type: d.type,
        title: d.title,
        dueDate: d.dueDate,
        daysUntilDue: d.daysUntilDue,
        severity: d.severity,
        requiresAction: d.requiresAction,
        suggestedAction: d.suggestedAction,
      })),
      persistedGovernance,
    );
  }

  /**
   * Prepare supplement — full supplement lifecycle.
   */
  async prepareSupplement(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claimId = request.claimId ?? (request.input.claimId as string);

    if (!claimId || !request.input.claim) {
    return this.buildResult(
      request.id,
      "failed",
      [],
      [],
      [],
      [],
      "Missing claim data for supplement preparation",
      "Failed: missing claim data for supplement preparation",
      0,
    );
    }

    const claim = request.input.claim as ClaimSnapshot;
    const findings = buildClaimFindings(claim);
    const reconciliation = reconcileClaim(claim, []);

    // Filter to supplement-worthy findings
    const supplementOpportunities = findings.filter(
      (f) => f.confidence >= 0.5 && f.estimatedAmount && f.estimatedAmount > 0,
    );

    const totalRecovery = supplementOpportunities.reduce(
      (sum, f) => sum + (f.estimatedAmount ?? 0),
      0,
    );

    // GOVERNANCE GATE — supplement preparation is a material claim-affecting
    // action and must be evaluated before output is produced.
    const governance = await this.evaluateGovernance(request, {
      actionType: "supplement_preparation",
      claim,
      supplementPhase: "preparation",
      financialAmount: totalRecovery,
      actionDescription: `Supplement preparation for ${claim.claimNumber ?? claim._id ?? "unknown claim"}`,
    });
    const persistedGovernance = await this.persistGovernance(
      request,
      governance.summary,
      { entityType: "supplement", entityId: claimId, claim, actionId: `supplement:${claimId}` },
    );

    // Generate supplement draft
    const supplementDraft = supplementOpportunities.length > 0
      ? generateDraft("supplement_narrative", {
          claim,
          findings: supplementOpportunities as unknown as Array<Record<string, unknown>>,
          reconciliation: {
            estimate: reconciliation.estimate,
            invoiced: reconciliation.invoiced,
            paid: reconciliation.paid,
            outstanding: reconciliation.outstanding,
            notes: reconciliation.notes,
            hasDiscrepancy: reconciliation.hasDiscrepancy,
          },
        })
      : null;

    const tasks: WorkItem[] = [];
    const evidence: EvidenceRecord[] = [];

    // Create tasks for each supplement opportunity
    for (const opp of supplementOpportunities) {
      tasks.push({
        id: `supplement:${claimId}:${opp.findingKey}`,
        claimId,
        category: "supplement_specialist",
        title: `Supplement opportunity: ${opp.title}`,
        description: opp.description,
        priority: opp.confidence >= 0.8 ? "high" : "medium",
        status: "pending",
        owner: "human",
        recommendedAction: opp.recommendedNextStep,
        automationAvailable: false,
        evidence: opp.evidence,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      evidence.push({
        id: `evidence:${claimId}:${opp.findingKey}`,
        claimId,
        type: "finding",
        source: opp.source ?? "claim_analysis",
        extractedFact: opp.title,
        confidence: opp.confidence,
        timestamp: Date.now(),
      });
    }

    // QA check
    const qaPassed = supplementOpportunities.every(
      (f) => f.evidence && f.evidence.length > 0,
    );

    const summary = [
      `Supplement analysis complete for claim ${claim.claimNumber ?? "N/A"}.`,
      `${supplementOpportunities.length} supplement opportunities identified.`,
      `Total recovery potential: $${totalRecovery.toLocaleString()}.`,
      qaPassed ? "All opportunities have supporting evidence." : "Some opportunities lack supporting evidence — review recommended.",
    ].join(" ");

    return this.buildResult(
      request.id,
      supplementOpportunities.length > 0 ? "completed" : "completed",
      [{
        id: `supplement_prep:${claimId}`,
        category: "supplement_specialist",
        title: "Supplement preparation complete",
        description: summary,
        status: "completed",
        output: {
          opportunities: supplementOpportunities.length,
          totalRecovery,
          draftGenerated: supplementDraft !== null,
          qaPassed,
        },
        confidence: 0.8,
        requiresHumanReview: true,
        evidenceUsed: [],
        automationAvailable: false,
      }],
      supplementOpportunities.length > 0 ? [{
        id: `supplement_approve:${claimId}`,
        category: "supplement_specialist",
        title: "Approve supplement submission",
        description: `Review and approve the supplement package ($${totalRecovery.toLocaleString()})`,
        status: "awaiting_approval",
        confidence: 0.8,
        requiresHumanReview: true,
        evidenceUsed: [],
        automationAvailable: false,
      }] : [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
      [...evidence, this.governanceEvidenceRecord(claimId, persistedGovernance)],
      supplementDraft ? [{
        id: `comm:${claimId}:supplement`,
        claimId,
        type: "carrier",
        subject: supplementDraft.subject,
        body: supplementDraft.body,
        recipient: supplementDraft.recipient.name ?? "Carrier",
        status: "drafted",
        requiresApproval: true,
        createdAt: Date.now(),
      }] : [],
      tasks,
      [],
      persistedGovernance,
    );
  }

  /**
   * Check claim status — quick status check.
   */
  async checkClaimStatus(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claim = request.input.claim as ClaimSnapshot | undefined;

    if (!claim) {
      return this.buildResult(
        request.id,
        "failed",
        [],
        [],
        [],
        [],
        "No claim data provided",
        "Failed: no claim data provided",
        0,
      );
    }

    const completeness = analyzeClaimCompleteness(claim);
    const reconciliation = reconcileClaim(claim, []);

    const summary = `Claim ${claim.claimNumber ?? "N/A"} — Status: ${claim.status ?? "Unknown"}, Readiness: ${Math.round(completeness.score * 100)}%, Outstanding: $${reconciliation.outstanding.toLocaleString()}`;

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `status:${claim._id}`,
        category: "claim_management",
        title: "Claim status check",
        description: summary,
        status: "completed",
        output: {
          status: claim.status,
          readiness: completeness.score,
          outstanding: reconciliation.outstanding,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
    );
  }

  /**
   * Draft communication — create a draft based on claim context.
   */
  async draftCommunication(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claim = request.input.claim as ClaimSnapshot | undefined;
    const draftType = request.input.draftType as "supplement_narrative" | "carrier_correspondence" | "customer_status_update" | "adjuster_followup" | "internal_note" | "escalation_message" | "payment_followup" | "document_request";

    if (!claim || !draftType) {
    return this.buildResult(
      request.id,
      "failed",
      [],
      [],
      [],
      [],
      "Missing claim data or draft type",
      "Failed: missing claim data or draft type",
      0,
    );
    }

    const draft = generateDraft(draftType, {
      claim,
      findings: request.input.findings as Array<Record<string, unknown>> | undefined,
      reconciliation: request.input.reconciliation as {
        estimate?: number;
        invoiced?: number;
        paid: number;
        outstanding: number;
        notes: string[];
        hasDiscrepancy: boolean;
      } | undefined,
      completeness: request.input.completeness as {
        score: number;
        summary: string;
      } | undefined,
    });

    // GOVERNANCE GATE — external communications are material actions and must
    // be evaluated before output is produced.
    const commType = draftType.includes("customer") ? "customer" :
      draftType.includes("carrier") ? "carrier" :
      draftType.includes("adjuster") ? "adjuster" :
      draftType.includes("escalation") ? "escalation" : "internal";
    const governance = await this.evaluateGovernance(request, {
      actionType:
        commType === "internal" || commType === "escalation"
          ? "communication_drafting"
          : "communication_sending",
      claim,
      commType,
      actionDescription: `Draft ${draftType.replace(/_/g, " ")} for claim ${claim.claimNumber ?? claim._id ?? "unknown claim"}`,
    });
    const persistedGovernance = await this.persistGovernance(
      request,
      governance.summary,
      {
        entityType: "communication",
        entityId: `${String(claim._id ?? "")}:${draftType}`,
        claim,
        actionId: `draft:${claim._id}:${draftType}`,
      },
    );

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `draft:${claim._id}:${draftType}`,
        category: "communication",
        title: `Draft: ${draftType.replace(/_/g, " ")}`,
        description: draft.subject,
        status: "completed",
        output: {
          subject: draft.subject,
          body: draft.body,
          recipient: draft.recipient,
          disclaimers: draft.disclaimers,
        },
        confidence: 0.9,
        requiresHumanReview: true,
        evidenceUsed: draft.evidenceUsed,
        automationAvailable: false,
      }],
      [{
        id: `draft_approve:${claim._id}:${draftType}`,
        category: "communication",
        title: `Approve draft: ${draftType.replace(/_/g, " ")}`,
        description: `Review and approve the ${draftType.replace(/_/g, " ")} for claim ${claim.claimNumber ?? "N/A"}`,
        status: "awaiting_approval",
        confidence: 0.9,
        requiresHumanReview: true,
        evidenceUsed: [],
        automationAvailable: false,
      }],
      [],
      [],
      `Draft generated: ${draft.subject}`,
      `Draft generated: ${draft.subject}`,
      Date.now() - startTime,
      [this.governanceEvidenceRecord(String(claim._id ?? ""), persistedGovernance)],
      [{
        id: `comm:${claim._id}:${draftType}:${Date.now()}`,
        claimId: String(claim._id ?? ""),
        type: commType,
        subject: draft.subject,
        body: draft.body,
        recipient: draft.recipient.name ?? draft.recipient.role,
        status: "drafted",
        requiresApproval: true,
        createdAt: Date.now(),
      }],
      undefined,
      undefined,
      persistedGovernance,
    );
  }

  /**
   * Identify gaps — find missing evidence and scope.
   */
  async identifyGaps(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claim = request.input.claim as ClaimSnapshot | undefined;

    if (!claim) {
      return this.buildResult(
        request.id,
        "failed",
        [],
        [],
        [],
        [],
        "No claim data provided",
        "Failed: no claim data provided",
        0,
      );
    }

    const completeness = analyzeClaimCompleteness(claim);
    const missing = completeness.categories.filter(
      (c) => c.status === "missing" || c.status === "needs_review",
    );

    const tasks: WorkItem[] = missing.map((cat) => ({
      id: `gap:${claim._id}:${cat.key}`,
      claimId: String(claim._id ?? ""),
      category: "evidence_intelligence" as TaskCategory,
      title: `Missing: ${cat.label}`,
      description: cat.note,
      priority: (cat.key === "estimate" || cat.key === "evidence") ? "critical" as TaskPriority : "medium" as TaskPriority,
      status: "pending" as TaskStatus,
      owner: "human" as const,
      recommendedAction: `Gather ${cat.label.toLowerCase()} documentation`,
      automationAvailable: false,
      evidence: [`completeness:${cat.key}`],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const summary = `${missing.length} evidence gaps identified. ${missing.filter((c) => c.status === "missing").length} critical items missing.`;

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `gaps:${claim._id}`,
        category: "evidence_intelligence",
        title: "Gap analysis complete",
        description: summary,
        status: "completed",
        output: {
          gaps: missing.length,
          completeness: completeness.score,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
      [],
      [],
      tasks,
    );
  }

  /**
   * Calculate recovery — deterministic revenue calculation.
   */
  async calculateRecovery(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claim = request.input.claim as ClaimSnapshot | undefined;

    if (!claim) {
      return this.buildResult(
        request.id,
        "failed",
        [],
        [],
        [],
        [],
        "No claim data provided",
        "Failed: no claim data provided",
        0,
      );
    }

    const reconciliation = reconcileClaim(claim, []);
    const findings = buildClaimFindings(claim);
    const recoveryPotential = findings
      .filter((f) => f.confidence >= 0.5)
      .reduce((sum, f) => sum + (f.estimatedAmount ?? 0), 0);

    // GOVERNANCE GATE — financial calculations are material actions and must
    // be evaluated before output is produced.
    const governance = await this.evaluateGovernance(request, {
      actionType: "financial_calculation",
      claim,
      financialAmount: recoveryPotential,
      actionDescription: `Revenue recovery calculation for claim ${claim.claimNumber ?? claim._id ?? "unknown claim"}`,
    });
    const persistedGovernance = await this.persistGovernance(
      request,
      governance.summary,
      { entityType: "financial", entityId: String(claim._id ?? ""), claim, actionId: `recovery:${claim._id}` },
    );

    const evidence: EvidenceRecord[] = [{
      id: `recovery:${claim._id}`,
      claimId: String(claim._id ?? ""),
      type: "calculation",
      source: "reconcileClaim",
      extractedFact: `Outstanding: $${reconciliation.outstanding.toLocaleString()}, Recovery potential: $${recoveryPotential.toLocaleString()}`,
      confidence: 1.0,
      timestamp: Date.now(),
      rule: "reconcileClaim",
    }];

    const summary = [
      `Revenue recovery analysis for claim ${claim.claimNumber ?? "N/A"}.`,
      `Outstanding balance: $${reconciliation.outstanding.toLocaleString()}.`,
      `Recovery potential: $${recoveryPotential.toLocaleString()}.`,
      reconciliation.hasDiscrepancy ? "Discrepancies detected — review recommended." : "Financial records consistent.",
    ].join(" ");

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `recovery:${claim._id}`,
        category: "revenue_recovery",
        title: "Revenue recovery analysis",
        description: summary,
        status: "completed",
        output: {
          outstanding: reconciliation.outstanding,
          recoveryPotential,
          hasDiscrepancy: reconciliation.hasDiscrepancy,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
      [...evidence, this.governanceEvidenceRecord(String(claim._id ?? ""), persistedGovernance)],
      [],
      [],
      [],
      persistedGovernance,
    );
  }

  /**
   * Schedule followup — create a follow-up task.
   */
  async scheduleFollowup(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claim = request.input.claim as ClaimSnapshot | undefined;

    if (!claim) {
      return this.buildResult(
        request.id,
        "failed",
        [],
        [],
        [],
        [],
        "No claim data provided",
        "Failed: no claim data provided",
        0,
      );
    }

    const followUps = scheduleFollowUps([claim]);
    const summary = `${followUps.length} follow-ups scheduled for claim ${claim.claimNumber ?? "N/A"}.`;

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `followups:${claim._id}`,
        category: "follow_up",
        title: "Follow-ups scheduled",
        description: summary,
        status: "completed",
        output: {
          followUpCount: followUps.length,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
    );
  }

  /**
   * Generate briefing — daily stand-up report.
   */
  async generateBriefing(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claims = (request.input.claims as ClaimSnapshot[]) ?? [];
    const supplements = (request.input.supplements as Array<Record<string, unknown>>) ?? [];
    const findings = (request.input.findings as Array<Record<string, unknown>>) ?? [];

    const briefing = generateDailyBriefing(claims, supplements, findings);

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `briefing:${Date.now()}`,
        category: "project_management",
        title: "Daily briefing generated",
        description: briefing.executiveSummary,
        status: "completed",
        output: briefing as unknown as Record<string, unknown>,
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      briefing.executiveSummary,
      briefing.executiveSummary,
      Date.now() - startTime,
    );
  }

  /**
   * Run daily scan — scan all claims for issues.
   */
  async runDailyScan(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claims = (request.input.claims as ClaimSnapshot[]) ?? [];

    // Track deadlines across all claims
    const allDeadlines = trackDeadlines(claims);

    // Build work queue
    const workQueue = buildWorkQueue(claims);
    const queueSummary = buildWorkQueueSummary(workQueue);

    // Schedule follow-ups
    const followUps = scheduleFollowUps(claims);
    const followUpSummary = buildFollowUpSummary(followUps);

    const summary = [
      `Daily scan complete for ${claims.length} claims.`,
      `${queueSummary.totalItems} work items (${queueSummary.byPriority.critical} critical).`,
      `${allDeadlines.length} deadlines (${allDeadlines.filter((d) => d.severity === "critical").length} critical).`,
      `${followUpSummary.totalFollowUps} follow-ups (${followUpSummary.overdueCount} overdue).`,
    ].join(" ");

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `dailyscan:${Date.now()}`,
        category: "project_management",
        title: "Daily scan complete",
        description: summary,
        status: "completed",
        output: {
          claimsScanned: claims.length,
          workItems: queueSummary.totalItems,
          criticalItems: queueSummary.byPriority.critical,
          deadlines: allDeadlines.length,
          followUps: followUpSummary.totalFollowUps,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
    );
  }

  /**
   * Audit revenue — comprehensive revenue analysis.
   */
  async auditRevenue(
    request: OrchestrationRequest,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const claims = (request.input.claims as ClaimSnapshot[]) ?? [];

    let totalOutstanding = 0;
    let totalRecoveryPotential = 0;

    for (const claim of claims) {
      const reconciliation = reconcileClaim(claim, []);
      const findings = buildClaimFindings(claim);

      totalOutstanding += reconciliation.outstanding;
      totalRecoveryPotential += findings
        .filter((f) => f.confidence >= 0.5)
        .reduce((sum, f) => sum + (f.estimatedAmount ?? 0), 0);
    }

    const summary = [
      `Revenue audit for ${claims.length} claims.`,
      `Total outstanding: $${totalOutstanding.toLocaleString()}.`,
      `Total recovery potential: $${totalRecoveryPotential.toLocaleString()}.`,
    ].join(" ");

    return this.buildResult(
      request.id,
      "completed",
      [{
        id: `revenue_audit:${Date.now()}`,
        category: "revenue_recovery",
        title: "Revenue audit complete",
        description: summary,
        status: "completed",
        output: {
          claimsAudited: claims.length,
          totalOutstanding,
          totalRecoveryPotential,
        },
        confidence: 1.0,
        requiresHumanReview: false,
        evidenceUsed: [],
        automationAvailable: true,
      }],
      [],
      [],
      [],
      summary,
      summary,
      Date.now() - startTime,
    );
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private generateTasksFromAnalysis(
    claimId: string,
    completeness: ClaimCompleteness,
    findings: ClaimFindingDraft[],
    reconciliation: ClaimReconciliation,
    deadlines: Array<{ id: string; title: string; severity: string; requiresAction: boolean; suggestedAction: string }>,
    workItems: Array<{ id: string; title: string; description: string; category: string; priority: string; actionable: string }>,
  ): WorkItem[] {
    const tasks: WorkItem[] = [];

    // Tasks from missing evidence
    const missing = completeness.categories.filter(
      (c) => c.status === "missing" || c.status === "needs_review",
    );
    for (const cat of missing) {
      tasks.push({
        id: `task:${claimId}:missing:${cat.key}`,
        claimId,
        category: "evidence_intelligence",
        title: `Gather ${cat.label}`,
        description: cat.note,
        priority: (cat.key === "estimate" || cat.key === "evidence") ? "critical" : "medium",
        status: "pending",
        owner: "human",
        recommendedAction: `Collect and attach ${cat.label.toLowerCase()} documentation`,
        automationAvailable: false,
        evidence: [`completeness:${cat.key}`],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Tasks from findings
    for (const finding of findings) {
      if (finding.confidence >= 0.5) {
        tasks.push({
          id: `task:${claimId}:finding:${finding.findingKey}`,
          claimId,
          category: "supplement_specialist",
          title: finding.title,
          description: finding.description,
          priority: finding.confidence >= 0.8 ? "high" : "medium",
          status: "pending",
          owner: "human",
          recommendedAction: finding.recommendedNextStep,
          automationAvailable: false,
          evidence: finding.evidence,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    // Tasks from financial discrepancies
    if (reconciliation.hasDiscrepancy) {
      tasks.push({
        id: `task:${claimId}:financial`,
        claimId,
        category: "revenue_recovery",
        title: "Review financial discrepancy",
        description: reconciliation.notes.join(" "),
        priority: reconciliation.outstanding > 10000 ? "critical" : "high",
        status: "pending",
        owner: "human",
        recommendedAction: "Investigate financial discrepancy",
        automationAvailable: false,
        evidence: ["reconciliation"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Tasks from deadlines
    for (const deadline of deadlines) {
      if (deadline.requiresAction && deadline.severity === "critical") {
        tasks.push({
          id: `task:${claimId}:deadline:${deadline.id}`,
          claimId,
          category: "deadline_management",
          title: deadline.title,
          description: deadline.suggestedAction,
          priority: "critical",
          status: "pending",
          owner: "human",
          deadline: new Date(Date.now() + ((deadline as unknown as { daysUntilDue: number }).daysUntilDue ?? 0) * 86400000).toISOString(),
          recommendedAction: deadline.suggestedAction,
          automationAvailable: false,
          evidence: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    return tasks;
  }

  private identifyCommunicationsNeeded(
    claimId: string,
    completeness: ClaimCompleteness,
    findings: ClaimFindingDraft[],
    reconciliation: ClaimReconciliation,
  ): CommunicationRecord[] {
    const comms: CommunicationRecord[] = [];

    // Document request if missing evidence
    const missing = completeness.categories.filter(
      (c) => c.status === "missing",
    );
    if (missing.length > 0) {
      comms.push({
        id: `comm:${claimId}:doc_request`,
        claimId,
        type: "customer",
        subject: `Document Request — Claim ${claimId}`,
        body: `We need the following documents: ${missing.map((c) => c.label).join(", ")}`,
        recipient: "customer",
        status: "drafted",
        requiresApproval: true,
        createdAt: Date.now(),
      });
    }

    return comms;
  }

  private buildEvidenceRecords(
    claimId: string,
    completeness: ClaimCompleteness,
    findings: ClaimFindingDraft[],
    reconciliation: ClaimReconciliation,
  ): EvidenceRecord[] {
    const records: EvidenceRecord[] = [];

    records.push({
      id: `evidence:${claimId}:completeness`,
      claimId,
      type: "calculation",
      source: "analyzeClaimCompleteness",
      extractedFact: `Completeness score: ${Math.round(completeness.score * 100)}%`,
      confidence: 1.0,
      timestamp: Date.now(),
      rule: "analyzeClaimCompleteness",
    });

    for (const finding of findings) {
      records.push({
        id: `evidence:${claimId}:${finding.findingKey}`,
        claimId,
        type: "finding",
        source: finding.source ?? "claim_analysis",
        extractedFact: finding.title,
        confidence: finding.confidence,
        timestamp: Date.now(),
      });
    }

    if (reconciliation.hasDiscrepancy) {
      records.push({
        id: `evidence:${claimId}:reconciliation`,
        claimId,
        type: "calculation",
        source: "reconcileClaim",
        extractedFact: `Outstanding: $${reconciliation.outstanding.toLocaleString()}`,
        confidence: 1.0,
        timestamp: Date.now(),
        rule: "reconcileClaim",
      });
    }

    return records;
  }

  private generateRecommendations(
    completeness: ClaimCompleteness,
    findings: ClaimFindingDraft[],
    reconciliation: ClaimReconciliation,
    deadlines: Array<{ severity: string; requiresAction: boolean; suggestedAction: string }>,
  ): string[] {
    const recommendations: string[] = [];

    if (completeness.score < 0.5) {
      recommendations.push("Claim readiness is critically low — gather missing evidence immediately.");
    }

    const highConfidenceFindings = findings.filter((f) => f.confidence >= 0.8);
    if (highConfidenceFindings.length > 0) {
      recommendations.push(`${highConfidenceFindings.length} high-confidence supplement opportunities identified.`);
    }

    if (reconciliation.hasDiscrepancy) {
      recommendations.push("Financial discrepancy detected — review and reconcile.");
    }

    const criticalDeadlines = deadlines.filter((d) => d.severity === "critical");
    if (criticalDeadlines.length > 0) {
      recommendations.push(`${criticalDeadlines.length} critical deadlines approaching.`);
    }

    return recommendations;
  }

  private buildClaimReviewSummary(
    completeness: ClaimCompleteness,
    findings: ClaimFindingDraft[],
    reconciliation: ClaimReconciliation,
    tasks: WorkItem[],
    deadlines: Array<{ severity: string }>,
    recommendations: string[],
  ): string {
    const criticalTasks = tasks.filter((t) => t.priority === "critical").length;
    const criticalDeadlines = deadlines.filter((d) => d.severity === "critical").length;

    return [
      `Claim review complete.`,
      `Readiness: ${Math.round(completeness.score * 100)}%.`,
      `${findings.length} findings identified.`,
      `${tasks.length} tasks created (${criticalTasks} critical).`,
      `${deadlines.length} deadlines tracked (${criticalDeadlines} critical).`,
      `${recommendations.length} recommendations.`,
      reconciliation.hasDiscrepancy ? "Financial discrepancy detected." : "",
    ].filter(Boolean).join(" ");
  }

  private buildResult(
    requestId: string,
    status: OrchestrationResult["status"],
    completed: TaskResult[] = [],
    awaitingApproval: TaskResult[] = [],
    waitingExternal: TaskResult[] = [],
    blocked: TaskResult[] = [],
    humanRequired: TaskResult[] | string = [],
    summary = "",
    executionTimeMs = 0,
    evidence: EvidenceRecord[] = [],
    communications: CommunicationRecord[] = [],
    tasks: WorkItem[] = [],
    deadlines: DeadlineRecord[] = [],
    governance?: GovernanceSummary,
  ): OrchestrationResult {
    return {
      requestId,
      status,
      completedByAtlas: completed,
      readyForHumanApproval: awaitingApproval,
      waitingForExternal: waitingExternal,
      blocked: Array.isArray(blocked) ? blocked : [],
      humanActionRequired: Array.isArray(humanRequired) ? humanRequired : [],
      evidenceGenerated: evidence,
      communicationsGenerated: communications,
      tasksCreated: tasks,
      deadlinesIdentified: deadlines,
      governance,
      summary,
      executionTimeMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

export function createReviewClaimRequest(
  claimId: string,
  tenantId: string,
  claim: ClaimSnapshot,
  options: {
    documents?: Array<Record<string, unknown>>;
    supplements?: Array<Record<string, unknown>>;
    findings?: Array<Record<string, unknown>>;
    userId?: string;
    source?: "voice" | "ui" | "automation" | "system";
  } = {},
): OrchestrationRequest {
  return {
    id: `req:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type: "review_claim",
    claimId,
    tenantId,
    userId: options.userId,
    input: {
      claim,
      documents: options.documents ?? [],
      supplements: options.supplements ?? [],
      findings: options.findings ?? [],
    },
    source: options.source ?? "ui",
    timestamp: Date.now(),
  };
}

export function createPrepareSupplementRequest(
  claimId: string,
  tenantId: string,
  claim: ClaimSnapshot,
  options: {
    userId?: string;
    source?: "voice" | "ui" | "automation" | "system";
  } = {},
): OrchestrationRequest {
  return {
    id: `req:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type: "prepare_supplement",
    claimId,
    tenantId,
    userId: options.userId,
    input: { claim },
    source: options.source ?? "ui",
    timestamp: Date.now(),
  };
}

export function createDraftCommunicationRequest(
  claimId: string,
  tenantId: string,
  claim: ClaimSnapshot,
  draftType: "supplement_narrative" | "carrier_correspondence" | "customer_status_update" | "adjuster_followup" | "internal_note" | "escalation_message" | "payment_followup" | "document_request",
  options: {
    findings?: Array<Record<string, unknown>>;
    reconciliation?: Record<string, unknown>;
    completeness?: { score: number; summary: string };
    userId?: string;
    source?: "voice" | "ui" | "automation" | "system";
  } = {},
): OrchestrationRequest {
  return {
    id: `req:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type: "draft_communication",
    claimId,
    tenantId,
    userId: options.userId,
    input: {
      claim,
      draftType,
      findings: options.findings,
      reconciliation: options.reconciliation,
      completeness: options.completeness,
    },
    source: options.source ?? "ui",
    timestamp: Date.now(),
  };
}
