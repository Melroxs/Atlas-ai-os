// ---------------------------------------------------------------------------
// Atlas Workforce Orchestrator — Core Types
//
// The central coordination layer that connects:
//   - User requests (voice, UI, automation)
//   - Claims context
//   - Agent capabilities
//   - Workflow execution
//   - Work queue management
//   - Communication drafting
//   - Deadline tracking
//   - Evidence intelligence
//   - Revenue recovery
//
// This orchestrator answers: "What needs to happen, why, and who does it?"
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import type { EvidenceChainLink } from "../governance/types";

// ---------------------------------------------------------------------------
// Request Types
// ---------------------------------------------------------------------------

export type CommandType =
  | "review_claim"
  | "prepare_supplement"
  | "check_status"
  | "draft_communication"
  | "identify_gaps"
  | "calculate_recovery"
  | "schedule_followup"
  | "generate_briefing"
  | "escalate"
  | "run_daily_scan"
  | "process_documents"
  | "audit_revenue";

export type TaskCategory =
  | "claim_management"
  | "supplement_specialist"
  | "revenue_recovery"
  | "project_management"
  | "estimating"
  | "customer_success"
  | "communication"
  | "evidence_intelligence"
  | "deadline_management"
  | "follow_up"
  | "autonomous_execution"
  | "human_approval";

export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "awaiting_approval"
  | "awaiting_external"
  | "blocked"
  | "failed";

export type CapabilityDomain =
  | "claims_management"
  | "supplement_specialist"
  | "revenue_recovery"
  | "project_management"
  | "estimating"
  | "customer_success";

// ---------------------------------------------------------------------------
// Orchestration Request
// ---------------------------------------------------------------------------

export interface OrchestrationRequest {
  id: string;
  type: CommandType;
  claimId?: string;
  tenantId: string;
  userId?: string;
  domain?: CapabilityDomain;
  input: Record<string, unknown>;
  source: "voice" | "ui" | "automation" | "system";
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Governance Summary (attached to every material orchestration result)
// ---------------------------------------------------------------------------

/** Structured reference to a knowledge object that supported a decision. */
export interface GovernanceKnowledgeRef {
  id: string;
  title: string;
  authorityLevel: string;
  authorityBasis?: string;
  citation: string;
  effectiveFrom?: number;
  jurisdiction?: string;
  confidence: number;
}

/** Structured knowledge gap discovered during evaluation. */
export interface GovernanceGapRef {
  description: string;
  severity: string;
  impact?: string;
  requiresHumanReview?: boolean;
}

/** Compact, serializable result of a governance gate evaluation. */
export interface GovernanceSummary {
  /** Whether the governance gate executed for this action. */
  evaluated: boolean;
  /** The governance action type that was evaluated. */
  actionType: string;
  /** Final gate decision. */
  decision: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK" | "UNKNOWN";
  /** Risk level assigned by the compliance evaluator. */
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  /** Jurisdiction the decision was evaluated under. */
  jurisdiction?: string;
  /** Epoch ms of the date used to filter rule validity (evaluation time —
   *  never the loss date). */
  knowledgeReferenceDate: number;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Applicable rules that supported the decision (structured provenance). */
  applicableRules: GovernanceKnowledgeRef[];
  /** Applicable industry standards that supported the decision. */
  applicableStandards: GovernanceKnowledgeRef[];
  /** Number of applicable rules surfaced by the knowledge resolution. */
  applicableRuleCount: number;
  /** Number of applicable industry standards surfaced. */
  applicableStandardsCount: number;
  /** Approvals required before this action may execute. */
  requiredApprovals: string[];
  /** Evidence required by the applicable rules. */
  requiredEvidence: string[];
  /** Knowledge gaps discovered during evaluation (structured). */
  knowledgeGaps: GovernanceGapRef[];
  /** Knowledge gaps discovered during evaluation. */
  knowledgeGapCount: number;
  /** Citations backing the decision. */
  citations: string[];
  /** Full evidence chain from context → compliance decision. */
  evidenceChain: EvidenceChainLink[];
  /** Trace of how the decision was reached. */
  evaluationTrace: string[];
  /** Gate evaluation duration in ms. */
  evaluationTimeMs: number;
  /** Whether the decision was persisted to the governance audit store. */
  persisted: boolean;
  /** Persisted governance decision id (when available). */
  decisionId?: string;
}

// ---------------------------------------------------------------------------
// Orchestration Result
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  requestId: string;
  status: "completed" | "partial" | "failed" | "awaiting_approval";
  /** Governance gate evaluation for this action (material actions only). */
  governance?: GovernanceSummary;
  completedByAtlas: TaskResult[];
  readyForHumanApproval: TaskResult[];
  waitingForExternal: TaskResult[];
  blocked: TaskResult[];
  humanActionRequired: TaskResult[];
  evidenceGenerated: EvidenceRecord[];
  communicationsGenerated: CommunicationRecord[];
  tasksCreated: WorkItem[];
  deadlinesIdentified: DeadlineRecord[];
  summary: string;
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Task Result
// ---------------------------------------------------------------------------

export interface TaskResult {
  id: string;
  category: TaskCategory;
  title: string;
  description: string;
  status: TaskStatus;
  output?: Record<string, unknown>;
  confidence: number;
  requiresHumanReview: boolean;
  evidenceUsed: string[];
  automationAvailable: boolean;
  suggestedAction?: string;
}

// ---------------------------------------------------------------------------
// Work Item (for the work queue)
// ---------------------------------------------------------------------------

export interface WorkItem {
  id: string;
  claimId?: string;
  category: TaskCategory;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  owner: "atlas" | "human" | "system";
  deadline?: string;
  dependencies?: string[];
  recommendedAction: string;
  automationAvailable: boolean;
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Evidence Record
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
  id: string;
  claimId: string;
  type: "finding" | "calculation" | "recommendation" | "communication" | "action";
  source: string;
  sourceEntity?: string;
  extractedFact: string;
  confidence: number;
  timestamp: number;
  model?: string;
  rule?: string;
}

// ---------------------------------------------------------------------------
// Communication Record
// ---------------------------------------------------------------------------

export interface CommunicationRecord {
  id: string;
  claimId: string;
  type: "carrier" | "customer" | "adjuster" | "internal" | "escalation";
  subject: string;
  body: string;
  recipient: string;
  status: "drafted" | "approved" | "sent" | "failed";
  requiresApproval: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Deadline Record
// ---------------------------------------------------------------------------

export interface DeadlineRecord {
  id: string;
  claimId: string;
  type: string;
  title: string;
  dueDate: number;
  daysUntilDue: number;
  severity: "critical" | "warning" | "info";
  requiresAction: boolean;
  suggestedAction: string;
}

// ---------------------------------------------------------------------------
// Claim Intelligence Report
// ---------------------------------------------------------------------------

export interface ClaimIntelligenceReport {
  claimId: string;
  claimNumber: string | null;
  generatedAt: number;

  // Summary
  overallStatus: string;
  readinessScore: number;
  summary: string;

  // Analysis
  completeness: {
    score: number;
    total: number;
    complete: number;
    missing: string[];
  };
  findings: Array<{
    title: string;
    category: string;
    confidence: number;
    estimatedAmount?: number;
    evidence: string[];
  }>;
  gaps: Array<{
    category: string;
    severity: string;
    description: string;
    impact: string;
  }>;
  reconciliation: {
    estimate?: number;
    paid: number;
    outstanding: number;
    hasDiscrepancy: boolean;
    notes: string[];
  };

  // Revenue
  revenueOpportunities: Array<{
    title: string;
    estimatedAmount: number;
    confidence: number;
    status: string;
  }>;
  totalRecoveryPotential: number;

  // Work
  pendingTasks: number;
  criticalTasks: number;
  overdueFollowUps: number;

  // Deadlines
  upcomingDeadlines: Array<{
    title: string;
    dueDate: number;
    daysUntilDue: number;
    severity: string;
  }>;

  // Actions
  recommendedActions: string[];
  atlasCanExecute: string[];
  requiresHumanApproval: string[];
}
