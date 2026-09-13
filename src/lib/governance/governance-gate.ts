// ---------------------------------------------------------------------------
// Atlas Governance Engine — Governance Gate
//
// The governance gate MUST execute BEFORE any material external or
// claim-affecting action. Every Atlas action flows through:
//
//   CONTEXT
//       ↓
//   KNOWLEDGE
//       ↓
//   COMPLIANCE
//       ↓
//   AUTHORIZATION
//       ↓
//   EXECUTION (only if ALLOW)
//       ↓
//   VERIFICATION
//       ↓
//   EVIDENCE / AUDIT
//
// Material actions that MUST pass through the governance gate:
//   - External communications
//   - Supplement preparation
//   - Financial calculations
//   - Estimate outputs
//   - Claim state changes
//   - Customer communications
//   - Carrier communications
//   - Submissions
//   - Approvals
//   - External integrations
//   - Workflow completion
// ---------------------------------------------------------------------------

import type {
  ComplianceContext,
  ComplianceResult,
  GovernanceGateResult,
  EvidenceChain,
  EvidenceChainLink,
  KnowledgeGap,
  RoleBoundaryConstraint,
  AtlasExplanation,
} from "./types";

import {
  evaluateCompliance,
  type KnowledgeSource,
} from "./compliance";

// ---------------------------------------------------------------------------
// Governance Gate
// ---------------------------------------------------------------------------

/**
 * Execute the governance gate for a material Atlas action.
 *
 * @returns GovernanceGateResult indicating whether the action may proceed,
 *   along with compliance details, knowledge gaps, and evidence chain.
 */
export async function executeGovernanceGate(
  context: ComplianceContext,
  knowledgeSource: KnowledgeSource,
): Promise<GovernanceGateResult> {
  const startTime = Date.now();
  const evidenceChain: EvidenceChainLink[] = [];

  // Step 1: Record the context as the first evidence chain link
  evidenceChain.push({
    id: `ec-ctx-${Date.now()}`,
    type: "claim",
    description: `Action requested: ${context.actionType} by ${context.performingRole}`,
    confidence: 1,
    timestamp: Date.now(),
  });

  // Step 2: Run compliance evaluation
  const compliance = await evaluateCompliance(context, knowledgeSource);

  // Step 3: Record compliance decision as evidence chain link
  evidenceChain.push({
    id: `ec-comp-${Date.now()}`,
    type: "compliance_decision",
    description: `Compliance: ${compliance.decision} — ${compliance.reason}`,
    confidence: compliance.riskLevel === "none" ? 1 : 0.8,
    timestamp: Date.now(),
    parentLinkId: evidenceChain[0].id,
  });

  // Step 4: Record applicable rules as evidence chain links
  for (const rule of compliance.applicableRules.slice(0, 5)) {
    evidenceChain.push({
      id: `ec-rule-${rule.id}-${Date.now()}`,
      type: "rule",
      description: `Applied rule: ${rule.title} (${rule.citation})`,
      sourceId: rule.id,
      confidence: rule.confidence,
      timestamp: Date.now(),
      parentLinkId: evidenceChain[1].id,
    });
  }

  // Step 5: Record applicable standards
  for (const std of compliance.applicableStandards.slice(0, 5)) {
    evidenceChain.push({
      id: `ec-std-${std.id}-${Date.now()}`,
      type: "standard",
      description: `Applied standard: ${std.title}`,
      sourceId: std.id,
      confidence: std.confidence,
      timestamp: Date.now(),
      parentLinkId: evidenceChain[1].id,
    });
  }

  // Step 6: Determine required approvals
  const requiredApprovals: string[] = [];
  if (compliance.requiredApproval) {
    requiredApprovals.push(compliance.requiredApproval);
  }
  for (const rc of compliance.roleConstraints) {
    if (rc.requiresLicensedProfessional && rc.requiredLicenseType) {
      requiredApprovals.push(rc.requiredLicenseType);
    }
  }

  // Step 7: Determine if allowed
  const allowed = compliance.decision === "ALLOW";

  const evaluationTimeMs = Date.now() - startTime;

  return {
    allowed,
    compliance,
    knowledgeGaps: compliance.knowledgeGaps,
    roleConstraints: compliance.roleConstraints,
    requiredApprovals,
    evidenceChain,
    evaluationTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Governance Gate for Communication Actions
// ---------------------------------------------------------------------------

/**
 * Governance gate specifically for communication actions (sending, drafting).
 */
export async function gateCommunication(
  context: Omit<ComplianceContext, "actionType"> & {
    commType: "carrier" | "customer" | "adjuster" | "internal" | "escalation";
  },
  knowledgeSource: KnowledgeSource,
): Promise<GovernanceGateResult> {
  const actionType =
    context.commType === "internal" || context.commType === "escalation"
      ? "communication_drafting"
      : "communication_sending";

  return executeGovernanceGate(
    { ...context, actionType },
    knowledgeSource,
  );
}

// ---------------------------------------------------------------------------
// Governance Gate for Supplement Actions
// ---------------------------------------------------------------------------

/**
 * Governance gate for supplement preparation/submission.
 */
export async function gateSupplement(
  context: Omit<ComplianceContext, "actionType"> & {
    phase: "preparation" | "submission";
  },
  knowledgeSource: KnowledgeSource,
): Promise<GovernanceGateResult> {
  const actionType =
    context.phase === "submission" ? "carrier_submission" : "supplement_preparation";

  return executeGovernanceGate(
    { ...context, actionType },
    knowledgeSource,
  );
}

// ---------------------------------------------------------------------------
// Governance Gate for Financial Actions
// ---------------------------------------------------------------------------

/**
 * Governance gate for financial calculations and commitments.
 */
export async function gateFinancial(
  context: Omit<ComplianceContext, "actionType"> & {
    financialType: "calculation" | "commitment";
  },
  knowledgeSource: KnowledgeSource,
): Promise<GovernanceGateResult> {
  const actionType =
    context.financialType === "commitment"
      ? "financial_commitment"
      : "financial_calculation";

  return executeGovernanceGate(
    { ...context, actionType },
    knowledgeSource,
  );
}

// ---------------------------------------------------------------------------
// Build Atlas Explanation from Governance Result
// ---------------------------------------------------------------------------

/**
 * Build a human-readable explanation from a governance gate result.
 */
export function buildExplanation(
  gateResult: GovernanceGateResult,
  actionDescription: string,
): AtlasExplanation {
  const what = gateResult.allowed
    ? `Atlas recommends proceeding with: ${actionDescription}`
    : `Atlas cannot proceed with: ${actionDescription}`;

  const why = gateResult.compliance.reason;

  const evidence = gateResult.evidenceChain.map((link) => link.description);

  const rules = [
    ...gateResult.compliance.applicableRules.map(
      (r) => `${r.title} (${r.citation})`,
    ),
    ...gateResult.compliance.applicableStandards.map(
      (s) => `${s.title}`,
    ),
  ];

  const confidence = gateResult.evidenceChain.length > 0
    ? gateResult.evidenceChain.reduce((sum, l) => sum + l.confidence, 0) /
      gateResult.evidenceChain.length
    : 0;

  const limitations = gateResult.knowledgeGaps.map(
    (g) => `${g.description} (impact: ${g.impact})`,
  );

  const action = gateResult.allowed
    ? "Atlas may execute this action autonomously."
    : gateResult.requiredApprovals.length > 0
      ? `Requires approval from: ${gateResult.requiredApprovals.join(", ")}`
      : "Atlas cannot execute this action.";

  const humanReviewReason =
    !gateResult.allowed || gateResult.compliance.riskLevel !== "none"
      ? `Risk level: ${gateResult.compliance.riskLevel}. ${gateResult.compliance.reason}`
      : undefined;

  return {
    what,
    why,
    evidence,
    rules,
    confidence,
    limitations,
    action,
    humanReviewReason,
  };
}
