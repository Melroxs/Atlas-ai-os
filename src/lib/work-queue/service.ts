// ---------------------------------------------------------------------------
// Atlas Work Queue Service
//
// Prioritized task management for the digital employee. Aggregates
// claim-level work items into a single, actionable work queue sorted
// by urgency, financial impact, and deadline proximity.
//
// Every item carries:
//   - What Atlas has already done
//   - What Atlas recommends
//   - What requires human action
//   - Evidence / provenance
//   - Financial impact estimate
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
  type ClaimCompleteness,
  type ClaimFindingDraft,
  type ClaimReconciliation,
} from "../insurance/logic";

// ---------------------------------------------------------------------------
// Work item types
// ---------------------------------------------------------------------------

export type WorkPriority = "critical" | "high" | "medium" | "low";
export type WorkCategory =
  | "missing_evidence"
  | "supplement_opportunity"
  | "financial_discrepancy"
  | "stale_claim"
  | "pending_approval"
  | "deadline_approaching"
  | "follow_up_needed"
  | "document_request"
  | "carrier_response_overdue"
  | "claim_review";

export type WorkActionable =
  | "human_action_required"
  | "atlas_can_proceed"
  | "waiting_on_external"
  | "information_needed";

export interface WorkItem {
  id: string;
  claimId: string;
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  category: WorkCategory;
  priority: WorkPriority;
  actionable: WorkActionable;
  title: string;
  description: string;
  atlasHasDone: string[];
  atlasRecommends: string[];
  humanNeedsTo: string[];
  financialImpact: number | null;
  confidence: number;
  evidenceUsed: string[];
  deadline: number | null;
  createdAt: number;
}

export interface WorkQueueSummary {
  totalItems: number;
  byPriority: Record<WorkPriority, number>;
  byCategory: Record<string, number>;
  byActionable: Record<WorkActionable, number>;
  totalFinancialImpact: number;
  oldestItemAge: number | null;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Work queue builder
// ---------------------------------------------------------------------------

export function buildWorkQueue(
  claims: ClaimSnapshot[],
  supplements: Array<Record<string, unknown>> = [],
  findings: Array<Record<string, unknown>> = [],
): WorkItem[] {
  const items: WorkItem[] = [];

  for (const claim of claims) {
    // Analyze each claim
    const completeness = analyzeClaimCompleteness(claim);
    const claimFindings = buildClaimFindings(claim);

    // Get supplements and findings for this claim
    const claimSupplements = supplements.filter(
      (s) => String(s.claimId ?? s.claim_id) === String(claim._id),
    );
    const claimFindingsPersisted = findings.filter(
      (f) => String(f.claimId ?? f.claim_id) === String(claim._id),
    );

    const reconciliation = reconcileClaim(claim, claimSupplements);

    // Generate work items from analysis
    items.push(...generateMissingEvidenceItems(claim, completeness));
    items.push(...generateSupplementItems(claim, claimFindings));
    items.push(...generateFinancialItems(claim, reconciliation));
    items.push(...generateStalenessItems(claim));
    items.push(...generateFollowUpItems(claim, reconciliation));
  }

  // Sort by priority then financial impact
  const priorityOrder: Record<WorkPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return items.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    const aAmount = a.financialImpact ?? 0;
    const bAmount = b.financialImpact ?? 0;
    return bAmount - aAmount;
  });
}

// ---------------------------------------------------------------------------
// Work item generators
// ---------------------------------------------------------------------------

function generateMissingEvidenceItems(
  claim: ClaimSnapshot,
  completeness: ClaimCompleteness,
): WorkItem[] {
  const items: WorkItem[] = [];
  const missing = completeness.categories.filter(
    (c) => c.status === "missing" || c.status === "needs_review",
  );

  for (const cat of missing) {
    const isCritical =
      cat.key === "estimate" || cat.key === "evidence" || cat.key === "coverage";

    items.push({
      id: `work:${claim._id}:missing:${cat.key}`,
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      category: "missing_evidence",
      priority: isCritical ? "critical" : "medium",
      actionable: "human_action_required",
      title: `Missing: ${cat.label}`,
      description: cat.note,
      atlasHasDone: [
        `Analyzed claim completeness (${Math.round(completeness.score * 100)}%)`,
      ],
      atlasRecommends: [`Gather ${cat.label.toLowerCase()} documentation`],
      humanNeedsTo: [`${cat.label} is missing — collect and attach to claim`],
      financialImpact: null,
      confidence: 1.0,
      evidenceUsed: [`completeness:${cat.key}`],
      deadline: null,
      createdAt: Date.now(),
    });
  }

  return items;
}

function generateSupplementItems(
  claim: ClaimSnapshot,
  findings: ClaimFindingDraft[],
): WorkItem[] {
  const items: WorkItem[] = [];

  for (const finding of findings) {
    if (finding.confidence < 0.5) continue;

    items.push({
      id: `work:${claim._id}:supplement:${finding.findingKey}`,
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      category: "supplement_opportunity",
      priority: finding.confidence >= 0.8 ? "high" : "medium",
      actionable: "human_action_required",
      title: finding.title,
      description: finding.description,
      atlasHasDone: [
        "Identified recovery opportunity from claim analysis",
        `Confidence: ${Math.round(finding.confidence * 100)}%`,
      ],
      atlasRecommends: [
        finding.recommendedNextStep,
        ...(finding.estimatedAmount
          ? [`Potential recovery: $${finding.estimatedAmount.toLocaleString()}`]
          : []),
      ],
      humanNeedsTo: [
        "Review finding and determine if supplement is warranted",
        "If yes, prepare supplement documentation",
      ],
      financialImpact: finding.estimatedAmount ?? null,
      confidence: finding.confidence,
      evidenceUsed: finding.evidence,
      deadline: null,
      createdAt: Date.now(),
    });
  }

  return items;
}

function generateFinancialItems(
  claim: ClaimSnapshot,
  reconciliation: ClaimReconciliation,
): WorkItem[] {
  const items: WorkItem[] = [];

  if (reconciliation.hasDiscrepancy) {
    items.push({
      id: `work:${claim._id}:financial:reconciliation`,
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      category: "financial_discrepancy",
      priority: reconciliation.outstanding > 10000 ? "critical" : "high",
      actionable: "human_action_required",
      title: `Financial discrepancy — $${reconciliation.outstanding.toLocaleString()} outstanding`,
      description: reconciliation.notes.join(" "),
      atlasHasDone: [
        "Performed financial reconciliation",
        `Outstanding: $${reconciliation.outstanding.toLocaleString()}`,
      ],
      atlasRecommends: [
        "Review financial records against carrier statement",
        "Investigate discrepancy and determine root cause",
      ],
      humanNeedsTo: [
        "Verify financial figures against source documents",
        "Determine if follow-up with carrier is needed",
      ],
      financialImpact: reconciliation.outstanding,
      confidence: 1.0,
      evidenceUsed: ["reconciliation"],
      deadline: null,
      createdAt: Date.now(),
    });
  }

  return items;
}

function generateStalenessItems(claim: ClaimSnapshot): WorkItem[] {
  const items: WorkItem[] = [];

  if (
    claim.status === "closed" ||
    typeof claim.updatedAt !== "number"
  ) {
    return items;
  }

  const daysSinceUpdate = Math.round(
    (Date.now() - claim.updatedAt) / 86_400_000,
  );

  if (daysSinceUpdate > 30) {
    items.push({
      id: `work:${claim._id}:stale`,
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      category: "stale_claim",
      priority: daysSinceUpdate > 60 ? "high" : "medium",
      actionable: "human_action_required",
      title: `Claim inactive for ${daysSinceUpdate} days`,
      description: `This claim has not been updated in ${daysSinceUpdate} days. It may be stalled.`,
      atlasHasDone: [
        `Detected ${daysSinceUpdate} days since last update`,
        `Current status: ${claim.status}`,
      ],
      atlasRecommends: [
        "Check with carrier for status update",
        "Follow up with adjuster if available",
      ],
      humanNeedsTo: [
        "Investigate why this claim has been inactive",
        "Take appropriate action to move the claim forward",
      ],
      financialImpact: null,
      confidence: 1.0,
      evidenceUsed: ["claim.updatedAt", "claim.status"],
      deadline: null,
      createdAt: Date.now(),
    });
  }

  return items;
}

function generateFollowUpItems(
  claim: ClaimSnapshot,
  reconciliation: ClaimReconciliation,
): WorkItem[] {
  const items: WorkItem[] = [];

  if (
    reconciliation.outstanding > 0 &&
    claim.status !== "closed" &&
    claim.status !== "approved"
  ) {
    items.push({
      id: `work:${claim._id}:followup:outstanding`,
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      category: "follow_up_needed",
      priority: "medium",
      actionable: "human_action_required",
      title: `Follow up on $${reconciliation.outstanding.toLocaleString()} outstanding`,
      description: "There is an outstanding balance that may require carrier follow-up.",
      atlasHasDone: [
        `Identified $${reconciliation.outstanding.toLocaleString()} outstanding`,
      ],
      atlasRecommends: [
        "Schedule follow-up with carrier",
        "Prepare documentation for follow-up",
      ],
      humanNeedsTo: [
        "Initiate follow-up communication with carrier",
        "Document any carrier response",
      ],
      financialImpact: reconciliation.outstanding,
      confidence: 1.0,
      evidenceUsed: ["reconciliation"],
      deadline: null,
      createdAt: Date.now(),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function buildWorkQueueSummary(items: WorkItem[]): WorkQueueSummary {
  const byPriority: Record<WorkPriority, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const byCategory: Record<string, number> = {};
  const byActionable: Record<WorkActionable, number> = {
    human_action_required: 0,
    atlas_can_proceed: 0,
    waiting_on_external: 0,
    information_needed: 0,
  };

  let totalFinancialImpact = 0;
  let oldestAge: number | null = null;

  for (const item of items) {
    byPriority[item.priority] += 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    byActionable[item.actionable] += 1;

    if (item.financialImpact) {
      totalFinancialImpact += item.financialImpact;
    }

    const age = Date.now() - item.createdAt;
    if (oldestAge === null || age > oldestAge) {
      oldestAge = age;
    }
  }

  return {
    totalItems: items.length,
    byPriority,
    byCategory,
    byActionable,
    totalFinancialImpact,
    oldestItemAge: oldestAge,
    generatedAt: Date.now(),
  };
}
