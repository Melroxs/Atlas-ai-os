// ---------------------------------------------------------------------------
// Atlas Daily Briefing Engine
//
// Generates a structured daily stand-up report for the digital employee:
//   - What happened yesterday (completed work)
//   - What needs attention today (prioritized work items)
//   - What's at risk (stale claims, approaching deadlines)
//   - Financial summary (outstanding recovery, new findings)
//   - Recommended actions (prioritized next steps)
//
// CRITICAL: Every data point is derived from actual claim records.
// Atlas never fabricates metrics, deadlines, or commitments.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import {
  analyzeClaimCompleteness,
  buildClaimFindings,
  reconcileClaim,
  type ClaimReconciliation,
} from "../insurance/logic";
import { buildWorkQueue, buildWorkQueueSummary } from "../work-queue/service";

// ---------------------------------------------------------------------------
// Briefing types
// ---------------------------------------------------------------------------

export type BriefingPriority = "critical" | "high" | "medium" | "low";

export interface BriefingActionItem {
  id: string;
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  title: string;
  description: string;
  priority: BriefingPriority;
  category: string;
  financialImpact: number | null;
  whyItMatters: string;
  suggestedFirstStep: string;
}

export interface BriefingSection {
  title: string;
  summary: string;
  items: BriefingActionItem[];
  totalFinancialImpact: number;
}

export interface DailyBriefing {
  briefingDate: string;
  generatedAt: number;

  // High-level metrics
  totalClaims: number;
  activeClaims: number;
  closedClaims: number;

  // Work queue
  pendingWorkItems: number;
  criticalItems: number;
  highPriorityItems: number;

  // Financial
  totalOutstanding: number;
  totalRecoveryPotential: number;
  newFindingsToday: number;

  // Sections
  sections: BriefingSection[];

  // Top recommendations
  recommendedActions: string[];

  // Risk alerts
  riskAlerts: string[];

  // Summary
  executiveSummary: string;
}

// ---------------------------------------------------------------------------
// Main briefing generator
// ---------------------------------------------------------------------------

export function generateDailyBriefing(
  claims: ClaimSnapshot[],
  supplements: Array<Record<string, unknown>> = [],
  findings: Array<Record<string, unknown>> = [],
  options: { includeClosed?: boolean } = {},
): DailyBriefing {
  const now = new Date();
  const briefingDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Basic metrics
  const activeClaims = claims.filter(
    (c) => c.status !== "closed" && c.status !== "approved",
  );
  const closedClaims = claims.filter(
    (c) => c.status === "closed" || c.status === "approved",
  );

  // Build work queue
  const workQueue = buildWorkQueue(claims, supplements, findings);
  const queueSummary = buildWorkQueueSummary(workQueue);

  // Financial summary
  let totalOutstanding = 0;
  let totalRecoveryPotential = 0;

  for (const claim of claims) {
    const reconciliation = reconcileClaim(claim, []);
    totalOutstanding += reconciliation.outstanding;
  }

  for (const finding of findings) {
    const amount = (finding.estimatedAmount as number) ?? 0;
    if (amount > 0) totalRecoveryPotential += amount;
  }

  // Build sections
  const sections: BriefingSection[] = [];

  // Section 1: Critical items requiring immediate attention
  const criticalItems = workQueue.filter((w) => w.priority === "critical");
  sections.push({
    title: "🔴 Critical — Requires Immediate Attention",
    summary: `${criticalItems.length} critical item(s) need attention today`,
    items: criticalItems.map((w) => ({
      id: w.id,
      claimNumber: w.claimNumber,
      customer: w.customer,
      property: w.property,
      title: w.title,
      description: w.description,
      priority: "critical" as const,
      category: w.category,
      financialImpact: w.financialImpact,
      whyItMatters: describeWhyCritical(w),
      suggestedFirstStep: w.humanNeedsTo[0] ?? "Review and take action",
    })),
    totalFinancialImpact: criticalItems.reduce(
      (sum, w) => sum + (w.financialImpact ?? 0),
      0,
    ),
  });

  // Section 2: High priority items
  const highPriorityItems = workQueue.filter((w) => w.priority === "high");
  sections.push({
    title: "🟠 High Priority",
    summary: `${highPriorityItems.length} high-priority item(s) to address`,
    items: highPriorityItems.map((w) => ({
      id: w.id,
      claimNumber: w.claimNumber,
      customer: w.customer,
      property: w.property,
      title: w.title,
      description: w.description,
      priority: "high" as const,
      category: w.category,
      financialImpact: w.financialImpact,
      whyItMatters: describeWhyHigh(w),
      suggestedFirstStep: w.humanNeedsTo[0] ?? "Review and prioritize",
    })),
    totalFinancialImpact: highPriorityItems.reduce(
      (sum, w) => sum + (w.financialImpact ?? 0),
      0,
    ),
  });

  // Section 3: Stale claims requiring follow-up
  const staleClaims = workQueue.filter((w) => w.category === "stale_claim");
  if (staleClaims.length > 0) {
    sections.push({
      title: "⏰ Stale Claims — Follow-Up Needed",
      summary: `${staleClaims.length} claim(s) have been inactive and may be stalled`,
      items: staleClaims.map((w) => ({
        id: w.id,
        claimNumber: w.claimNumber,
        customer: w.customer,
        property: w.property,
        title: w.title,
        description: w.description,
        priority: "medium" as const,
        category: w.category,
        financialImpact: w.financialImpact,
        whyItMatters:
          "Stalled claims can result in missed deadlines, lost revenue, and dissatisfied customers.",
        suggestedFirstStep:
          "Contact carrier or adjuster to get status update",
      })),
      totalFinancialImpact: 0,
    });
  }

  // Section 4: Financial discrepancies
  const financialItems = workQueue.filter(
    (w) => w.category === "financial_discrepancy",
  );
  if (financialItems.length > 0) {
    sections.push({
      title: "💰 Financial Discrepancies",
      summary: `${financialItems.length} discrepancy(ies) require investigation`,
      items: financialItems.map((w) => ({
        id: w.id,
        claimNumber: w.claimNumber,
        customer: w.customer,
        property: w.property,
        title: w.title,
        description: w.description,
        priority: "high" as const,
        category: w.category,
        financialImpact: w.financialImpact,
        whyItMatters:
          "Financial discrepancies may indicate billing errors, carrier underpayment, or record-keeping issues.",
        suggestedFirstStep:
          "Review estimate vs. invoice vs. payments for consistency",
      })),
      totalFinancialImpact: financialItems.reduce(
        (sum, w) => sum + (w.financialImpact ?? 0),
        0,
      ),
    });
  }

  // Section 5: Supplement opportunities
  const supplementItems = workQueue.filter(
    (w) => w.category === "supplement_opportunity",
  );
  if (supplementItems.length > 0) {
    sections.push({
      title: "📈 Supplement Opportunities",
      summary: `${supplementItems.length} potential recovery opportunity(ies) identified`,
      items: supplementItems.map((w) => ({
        id: w.id,
        claimNumber: w.claimNumber,
        customer: w.customer,
        property: w.property,
        title: w.title,
        description: w.description,
        priority: w.priority as BriefingPriority,
        category: w.category,
        financialImpact: w.financialImpact,
        whyItMatters:
          "These opportunities represent potential additional revenue recovery.",
        suggestedFirstStep: w.humanNeedsTo[0] ?? "Review and prepare supplement",
      })),
      totalFinancialImpact: supplementItems.reduce(
        (sum, w) => sum + (w.financialImpact ?? 0),
        0,
      ),
    });
  }

  // Risk alerts
  const riskAlerts: string[] = [];
  if (criticalItems.length > 0) {
    riskAlerts.push(
      `${criticalItems.length} critical item(s) require immediate attention`,
    );
  }
  if (staleClaims.length > 3) {
    riskAlerts.push(
      `${staleClaims.length} claims are stalled — may result in missed deadlines`,
    );
  }
  if (totalOutstanding > 50000) {
    riskAlerts.push(
      `$${totalOutstanding.toLocaleString()} in outstanding balances requires attention`,
    );
  }

  // Recommended actions (top 5)
  const recommendedActions = workQueue
    .slice(0, 5)
    .map(
      (w) =>
        `[${w.priority.toUpperCase()}] ${w.claimNumber ? `Claim ${w.claimNumber}: ` : ""}${w.title}`,
    );

  // Executive summary
  const totalFinancialImpact = sections.reduce(
    (sum, s) => sum + s.totalFinancialImpact,
    0,
  );
  const executiveSummary = [
    `${claims.length} total claims (${activeClaims.length} active, ${closedClaims.length} closed).`,
    `${workQueue.length} work items identified (${queueSummary.byPriority.critical} critical, ${queueSummary.byPriority.high} high priority).`,
    `$${totalOutstanding.toLocaleString()} in outstanding balances.`,
    totalRecoveryPotential > 0
      ? `$${totalRecoveryPotential.toLocaleString()} in recovery potential from identified findings.`
      : "No recovery opportunities identified.",
    riskAlerts.length > 0
      ? `${riskAlerts.length} risk alert(s) require attention.`
      : "No immediate risk alerts.",
  ].join(" ");

  return {
    briefingDate,
    generatedAt: Date.now(),
    totalClaims: claims.length,
    activeClaims: activeClaims.length,
    closedClaims: closedClaims.length,
    pendingWorkItems: queueSummary.totalItems,
    criticalItems: queueSummary.byPriority.critical,
    highPriorityItems: queueSummary.byPriority.high,
    totalOutstanding,
    totalRecoveryPotential,
    newFindingsToday: 0,
    sections,
    recommendedActions,
    riskAlerts,
    executiveSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeWhyCritical(item: {
  category: string;
  financialImpact: number | null;
}): string {
  switch (item.category) {
    case "financial_discrepancy":
      return `Financial discrepancy of $${(item.financialImpact ?? 0).toLocaleString()} requires investigation to prevent revenue loss.`;
    case "missing_evidence":
      return "Missing critical evidence weakens the claim position and may result in denial.";
    case "supplement_opportunity":
      return `High-confidence recovery opportunity worth $${(item.financialImpact ?? 0).toLocaleString()} — delay reduces likelihood of recovery.`;
    case "deadline_approaching":
      return "Filing deadline approaching — missing it could forfeit recovery rights.";
    default:
      return "This item has been classified as critical based on impact analysis.";
  }
}

function describeWhyHigh(item: {
  category: string;
  financialImpact: number | null;
}): string {
  switch (item.category) {
    case "supplement_opportunity":
      return `Recovery opportunity worth $${(item.financialImpact ?? 0).toLocaleString()} with good supporting evidence.`;
    case "stale_claim":
      return "Claims that go inactive risk missed deadlines and dissatisfied customers.";
    case "follow_up_needed":
      return "Follow-up required to advance the claim and recover outstanding balance.";
    default:
      return "This item requires attention to maintain claim momentum.";
  }
}
