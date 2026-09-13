// ---------------------------------------------------------------------------
// Atlas Governance Engine — Role Boundary Engine
//
// Atlas must recognize when it is approaching a professional boundary.
//
// Atlas MAY:
//   - Analyze policy language and identify potentially relevant provisions
//   - Identify potential coverage issues based on policy terms
//   - Calculate potential recovery amounts
//   - Identify evidence gaps
//   - Draft communications for human review
//
// Atlas MUST NOT:
//   - Claim "coverage is legally owed"
//   - Make legal conclusions
//   - Practice law without a license
//   - Make binding medical/engineering determinations
//   - Execute external submissions without authorization
//
// UNKNOWN must NEVER be treated as ALLOW.
// ---------------------------------------------------------------------------

import type {
  AtlasRole,
  ActionAuthorization,
  RoleBoundaryConstraint,
  KnowledgeObject,
  KnowledgeGap,
} from "./types";

// ---------------------------------------------------------------------------
// Action Classification
// ---------------------------------------------------------------------------

export type ActionType =
  | "claim_analysis"
  | "policy_interpretation"
  | "coverage_determination"
  | "estimate_calculation"
  | "supplement_preparation"
  | "communication_drafting"
  | "communication_sending"
  | "carrier_submission"
  | "financial_calculation"
  | "deadline_management"
  | "evidence_analysis"
  | "gap_identification"
  | "revenue_recovery_calculation"
  | "compliance_check"
  | "jurisdiction_analysis"
  | "regulatory_lookup"
  | "customer_notification"
  | "adjuster_coordination"
  | "project_scheduling"
  | "quality_assurance"
  | "escalation"
  | "legal_conclusion"
  | "medical_determination"
  | "engineering_determination"
  | "financial_commitment"
  | "contract_execution";

// ---------------------------------------------------------------------------
// Role-Action Authorization Matrix
// ---------------------------------------------------------------------------

interface RoleActionEntry {
  authorization: ActionAuthorization;
  requiresLicensedProfessional: boolean;
  requiredLicenseType?: string;
  reason: string;
}

/**
 * Atlas's authorization matrix for different action types.
 * When Atlas acts as "restoration_contractor" (the most common mode),
 * certain actions require escalation.
 */
const ATLAS_AUTHORIZATION_MATRIX: Partial<
  Record<ActionType, Partial<Record<AtlasRole, RoleActionEntry>>>
> = {
  // --- Analysis (generally allowed) ---
  claim_analysis: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may analyze claim data to identify patterns and gaps.",
    },
  },
  policy_interpretation: {
    atlas: {
      authorization: "REVIEW_REQUIRED",
      requiresLicensedProfessional: false,
      reason:
        "Atlas may identify potentially relevant policy provisions but must not make legal coverage conclusions.",
    },
  },
  coverage_determination: {
    atlas: {
      authorization: "LICENSED_PROFESSIONAL_REQUIRED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "insurance_adjuster_or_public_adjuster",
      reason:
        "Binding coverage determinations require a licensed professional. Atlas may present analysis for review.",
    },
  },
  estimate_calculation: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may calculate estimates based on available data and standards.",
    },
  },
  supplement_preparation: {
    atlas: {
      authorization: "REVIEW_REQUIRED",
      requiresLicensedProfessional: false,
      reason: "Atlas may prepare supplement documentation but it must be reviewed before submission.",
    },
  },

  // --- Communication ---
  communication_drafting: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may draft communications for human review and approval.",
    },
  },
  communication_sending: {
    atlas: {
      authorization: "REVIEW_REQUIRED",
      requiresLicensedProfessional: false,
      reason: "Communications must be approved by a human before sending.",
    },
  },
  carrier_submission: {
    atlas: {
      authorization: "REVIEW_REQUIRED",
      requiresLicensedProfessional: false,
      reason: "Carrier submissions require human authorization.",
    },
  },

  // --- Financial ---
  financial_calculation: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may perform financial calculations based on documented inputs.",
    },
  },
  revenue_recovery_calculation: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may calculate potential revenue recovery based on documented scope gaps.",
    },
  },
  financial_commitment: {
    atlas: {
      authorization: "PROHIBITED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "authorized_officer",
      reason: "Atlas cannot make binding financial commitments on behalf of the company.",
    },
  },

  // --- Evidence & Analysis ---
  evidence_analysis: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may analyze evidence to identify facts, gaps, and contradictions.",
    },
  },
  gap_identification: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may identify evidence gaps and recommend actions.",
    },
  },
  compliance_check: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may evaluate compliance against known rules and standards.",
    },
  },
  jurisdiction_analysis: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may resolve jurisdiction and identify applicable rules.",
    },
  },
  regulatory_lookup: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may retrieve regulatory information from the knowledge corpus.",
    },
  },

  // --- Project Management ---
  deadline_management: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may track and alert on deadlines.",
    },
  },
  project_scheduling: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may manage project schedules and task assignments.",
    },
  },
  quality_assurance: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may perform quality checks against standards and requirements.",
    },
  },

  // --- Escalation ---
  escalation: {
    atlas: {
      authorization: "ALLOW",
      requiresLicensedProfessional: false,
      reason: "Atlas may escalate issues that require human judgment.",
    },
  },

  // --- PROHIBITED for Atlas ---
  legal_conclusion: {
    atlas: {
      authorization: "PROHIBITED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "attorney",
      reason:
        "Atlas cannot make legal conclusions. It may present analysis for attorney review.",
    },
  },
  medical_determination: {
    atlas: {
      authorization: "PROHIBITED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "licensed_medical_professional",
      reason: "Atlas cannot make medical determinations.",
    },
  },
  engineering_determination: {
    atlas: {
      authorization: "PROHIBITED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "licensed_engineer",
      reason:
        "Structural/engineering determinations require a licensed professional.",
    },
  },
  contract_execution: {
    atlas: {
      authorization: "PROHIBITED",
      requiresLicensedProfessional: true,
      requiredLicenseType: "authorized_officer",
      reason: "Atlas cannot execute contracts.",
    },
  },
};

// ---------------------------------------------------------------------------
// Role Boundary Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether Atlas can perform the given action in the given role.
 */
export function evaluateRoleBoundary(
  actionType: ActionType,
  performingRole: AtlasRole,
  context?: {
    knowledgeObjects?: KnowledgeObject[];
    involvedAmount?: number;
    jurisdiction?: string;
  },
): RoleBoundaryConstraint {
  const matrixEntry = ATLAS_AUTHORIZATION_MATRIX[actionType]?.[performingRole];

  if (!matrixEntry) {
    // Unknown combination → treat as UNKNOWN (NOT as ALLOW)
    return {
      actionType,
      performingRole,
      authorization: "UNKNOWN",
      reason: `No authorization rule defined for action "${actionType}" with role "${performingRole}". Cannot proceed without human determination.`,
      sourceKnowledgeIds: [],
      requiresLicensedProfessional: true,
    };
  }

  // Check if applicable knowledge supports or contradicts
  const sourceKnowledgeIds =
    context?.knowledgeObjects?.map((k) => k.id) || [];

  return {
    actionType,
    performingRole,
    authorization: matrixEntry.authorization,
    reason: matrixEntry.reason,
    sourceKnowledgeIds,
    requiresLicensedProfessional: matrixEntry.requiresLicensedProfessional,
    requiredLicenseType: matrixEntry.requiredLicenseType,
  };
}

/**
 * Get all action types that Atlas is prohibited from performing.
 */
export function getProhibitedActions(): ActionType[] {
  const prohibited: ActionType[] = [];
  for (const [action, roles] of Object.entries(ATLAS_AUTHORIZATION_MATRIX)) {
    if (roles.atlas?.authorization === "PROHIBITED") {
      prohibited.push(action as ActionType);
    }
  }
  return prohibited;
}

/**
 * Get all action types that require review before execution.
 */
export function getReviewRequiredActions(): ActionType[] {
  const reviewRequired: ActionType[] = [];
  for (const [action, roles] of Object.entries(ATLAS_AUTHORIZATION_MATRIX)) {
    if (roles.atlas?.authorization === "REVIEW_REQUIRED") {
      reviewRequired.push(action as ActionType);
    }
  }
  return reviewRequired;
}

/**
 * Check if a specific knowledge gap affects the authorization.
 */
export function checkKnowledgeGapImpact(
  gap: KnowledgeGap,
  actionType: ActionType,
): {
  blocksAction: boolean;
  reason: string;
} {
  if (gap.severity === "critical" && gap.canContinueSafely === false) {
    return {
      blocksAction: true,
      reason: `Critical knowledge gap: ${gap.description}. ${gap.impact}`,
    };
  }

  if (
    actionType === "coverage_determination" ||
    actionType === "legal_conclusion"
  ) {
    return {
      blocksAction: true,
      reason:
        "Knowledge gaps in coverage/legal analysis must be resolved before Atlas can provide guidance.",
    };
  }

  return {
    blocksAction: false,
    reason: `Knowledge gap identified but action can proceed with caution: ${gap.description}`,
  };
}
