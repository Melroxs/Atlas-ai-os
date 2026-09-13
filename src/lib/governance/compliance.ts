// ---------------------------------------------------------------------------
// Atlas Governance Engine — Compliance Evaluator
//
// The compliance evaluator is the core engine that determines whether
// Atlas may execute a material action.
//
// Flow:
//   CONTEXT → KNOWLEDGE → COMPLIANCE → AUTHORIZATION → EXECUTION
//
// NEVER treats UNKNOWN as ALLOW.
// NEVER fabricates compliance findings.
// ALWAYS produces an evidence-backed audit trail.
// ---------------------------------------------------------------------------

import type {
  ComplianceContext,
  ComplianceResult,
  ComplianceDecision,
  KnowledgeObject,
  KnowledgeGap,
  RoleBoundaryConstraint,
  TemporalContext,
} from "./types";

import {
  resolveApplicableKnowledge,
  filterEffectiveAt,
  filterActive,
  sortByAuthority,
} from "./authority";
import { evaluateRoleBoundary, type ActionType } from "./role-boundary";
import { resolveJurisdiction } from "./jurisdiction";

// ---------------------------------------------------------------------------
// Knowledge Source (pluggable — wraps the existing knowledge corpus)
// ---------------------------------------------------------------------------

/**
 * Interface for retrieving knowledge objects.
 * In production, this would query the Supabase knowledge tables.
 * For now, it accepts an array of knowledge objects.
 */
export interface KnowledgeSource {
  getKnowledgeObjects(opts: {
    domain?: string;
    jurisdiction?: string;
    tenantId?: string;
  }): Promise<KnowledgeObject[]>;
}

/**
 * Default in-memory knowledge source for testing/development.
 */
export function createInMemoryKnowledgeSource(
  objects: KnowledgeObject[],
): KnowledgeSource {
  return {
    async getKnowledgeObjects(opts) {
      return objects.filter((obj) => {
        if (opts.domain && obj.domain !== opts.domain) return false;
        if (opts.jurisdiction && obj.jurisdiction !== opts.jurisdiction) return false;
        return true;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Compliance Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate compliance for a proposed Atlas action.
 *
 * This is the central compliance gate. Every material Atlas action must
 * pass through this evaluator before execution.
 */
export async function evaluateCompliance(
  context: ComplianceContext,
  knowledgeSource: KnowledgeSource,
): Promise<ComplianceResult> {
  const trace: string[] = [];
  const citations: string[] = [];
  const knowledgeGaps: KnowledgeGap[] = [];
  const roleConstraints: RoleBoundaryConstraint[] = [];
  const applicableRules: KnowledgeObject[] = [];
  const applicableStandards: KnowledgeObject[] = [];
  const requiredEvidence: string[] = [];

  trace.push(`[COMPLIANCE] Evaluating action: ${context.actionType}`);
  trace.push(`[COMPLIANCE] Performing role: ${context.performingRole}`);
  trace.push(`[COMPLIANCE] Tenant: ${context.tenantId}`);

  // --- Step 1: Resolve Jurisdiction ---
  const jurisdiction = context.jurisdiction || "";
  trace.push(`[COMPLIANCE] Jurisdiction: ${jurisdiction || "unresolved"}`);

  // --- Step 2: Resolve Temporal Context ---
  const temporal = context.temporalContext;
  trace.push(
    `[COMPLIANCE] Loss date: ${temporal.lossDate ? new Date(temporal.lossDate).toISOString() : "unknown"}`,
  );
  trace.push(
    `[COMPLIANCE] Current date: ${new Date(temporal.currentDate).toISOString()}`,
  );

  // --- Step 3: Retrieve Applicable Knowledge ---
  let allKnowledge: KnowledgeObject[] = [];
  try {
    allKnowledge = await knowledgeSource.getKnowledgeObjects({
      domain: context.actionType,
      jurisdiction,
      tenantId: context.tenantId,
    });
    trace.push(`[COMPLIANCE] Retrieved ${allKnowledge.length} knowledge objects`);
  } catch (err) {
    trace.push(`[COMPLIANCE] Knowledge retrieval failed: ${err}`);
    knowledgeGaps.push({
      id: `gap-knowledge-retrieval-${Date.now()}`,
      description: "Failed to retrieve knowledge objects from the knowledge source.",
      impact: "Cannot evaluate compliance without applicable knowledge.",
      canContinueSafely: false,
      requiresHumanReview: true,
      triggeredBy: "knowledge_retrieval",
      severity: "critical",
    });
  }

  // --- Step 4: Resolve Applicable Knowledge ---
  const { applicable, gaps: resolutionGaps, warnings } =
    resolveApplicableKnowledge(allKnowledge, {
      jurisdiction,
      temporalContext: temporal,
      domain: context.actionType,
    });

  knowledgeGaps.push(...resolutionGaps);
  trace.push(
    `[COMPLIANCE] After resolution: ${applicable.length} applicable, ${resolutionGaps.length} gaps`,
  );

  // Separate rules and standards
  for (const obj of applicable) {
    if (obj.authorityLevel === "industry_standard") {
      applicableStandards.push(obj);
    } else {
      applicableRules.push(obj);
    }
    if (obj.citation) {
      citations.push(obj.citation);
    }
  }

  // --- Step 5: Evaluate Role Boundary ---
  const roleConstraint = evaluateRoleBoundary(
    context.actionType as ActionType,
    context.performingRole,
    {
      knowledgeObjects: applicable,
      involvedAmount: context.financialAmount,
      jurisdiction,
    },
  );
  roleConstraints.push(roleConstraint);
  trace.push(
    `[COMPLIANCE] Role boundary: ${roleConstraint.authorization} — ${roleConstraint.reason}`,
  );

  // --- Step 6: Determine Required Evidence ---
  // Collect required evidence from applicable rules
  for (const rule of applicable) {
    if (rule.requiredEvidence) {
      requiredEvidence.push(...rule.requiredEvidence);
    }
  }
  // Deduplicate
  const uniqueEvidence = [...new Set(requiredEvidence)];
  trace.push(
    `[COMPLIANCE] Required evidence: ${uniqueEvidence.length} items`,
  );

  // --- Step 7: Check Knowledge Gaps Impact ---
  let knowledgeBlocks = false;
  for (const gap of knowledgeGaps) {
    if (gap.severity === "critical" && !gap.canContinueSafely) {
      knowledgeBlocks = true;
      trace.push(`[COMPLIANCE] Knowledge gap BLOCKS action: ${gap.description}`);
    }
  }

  // --- Step 8: Determine Risk Level ---
  let riskLevel: "none" | "low" | "medium" | "high" | "critical" = "none";

  if (roleConstraint.authorization === "PROHIBITED") {
    riskLevel = "critical";
  } else if (roleConstraint.authorization === "UNKNOWN") {
    riskLevel = "high";
  } else if (roleConstraint.authorization === "LICENSED_PROFESSIONAL_REQUIRED") {
    riskLevel = "high";
  } else if (roleConstraint.authorization === "REVIEW_REQUIRED") {
    riskLevel = "medium";
  } else if (knowledgeBlocks) {
    riskLevel = "high";
  } else if (knowledgeGaps.length > 0) {
    riskLevel = "low";
  } else if (context.financialAmount && context.financialAmount > 10000) {
    riskLevel = "low";
  }

  trace.push(`[COMPLIANCE] Risk level: ${riskLevel}`);

  // --- Step 9: Final Compliance Decision ---
  let decision: ComplianceDecision;
  let reason: string;
  let requiredApproval: string | undefined;

  if (roleConstraint.authorization === "PROHIBITED") {
    decision = "BLOCK";
    reason = `Action "${context.actionType}" is PROHIBITED for role "${context.performingRole}". ${roleConstraint.reason}`;
  } else if (roleConstraint.authorization === "UNKNOWN") {
    decision = "UNKNOWN";
    reason = `No authorization rule defined for this action/role combination. Cannot treat as ALLOW.`;
  } else if (roleConstraint.authorization === "LICENSED_PROFESSIONAL_REQUIRED") {
    decision = "REVIEW_REQUIRED";
    reason = `Action requires licensed professional review: ${roleConstraint.requiredLicenseType || "unknown license"}. ${roleConstraint.reason}`;
    requiredApproval = roleConstraint.requiredLicenseType;
  } else if (roleConstraint.authorization === "REVIEW_REQUIRED") {
    decision = "REVIEW_REQUIRED";
    reason = `Action requires human review before execution. ${roleConstraint.reason}`;
    requiredApproval = "human_review";
  } else if (knowledgeBlocks) {
    decision = "BLOCK";
    const criticalGaps = knowledgeGaps.filter(
      (g) => g.severity === "critical" && !g.canContinueSafely,
    );
    reason = `Action blocked by critical knowledge gaps: ${criticalGaps.map((g) => g.description).join("; ")}`;
  } else if (
    roleConstraint.authorization === "ALLOW" &&
    knowledgeGaps.length === 0
  ) {
    decision = "ALLOW";
    reason =
      "Action is authorized and no knowledge gaps prevent execution.";
  } else if (
    roleConstraint.authorization === "ALLOW" &&
    knowledgeGaps.length > 0
  ) {
    // Allowed but with knowledge gaps → still ALLOW but note the gaps
    decision = "ALLOW";
    reason = `Action is authorized. ${knowledgeGaps.length} knowledge gap(s) noted but do not block execution.`;
  } else {
    decision = "UNKNOWN";
    reason = "Unable to determine compliance status.";
  }

  trace.push(`[COMPLIANCE] Final decision: ${decision}`);
  trace.push(`[COMPLIANCE] Reason: ${reason}`);

  return {
    decision,
    reason,
    applicableRules,
    applicableStandards,
    requiredEvidence: uniqueEvidence,
    requiredApproval,
    roleConstraints,
    riskLevel,
    knowledgeGaps,
    citations,
    evaluationTrace: trace,
  };
}
