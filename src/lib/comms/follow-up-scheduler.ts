// ---------------------------------------------------------------------------
// Atlas Follow-Up Scheduler
//
// Tracks and schedules follow-ups with:
//   - Carriers (payment status, claim decisions)
//   - Adjusters (scope discussions, inspections)
//   - Customers (status updates, document requests)
//   - Internal team (escalations, approvals)
//
// CRITICAL: All follow-ups are derived from actual claim records.
// Atlas never fabricates commitments or promises.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";
import { reconcileClaim } from "../insurance/logic";

// ---------------------------------------------------------------------------
// Follow-up types
// ---------------------------------------------------------------------------

export type FollowUpType =
  | "carrier_payment"
  | "carrier_status"
  | "adjuster_scope"
  | "adjuster_inspection"
  | "customer_update"
  | "customer_documents"
  | "internal_escalation"
  | "internal_approval"
  | "regulatory_filing";

export type FollowUpPriority = "urgent" | "high" | "medium" | "low";

export type FollowUpStatus = "pending" | "scheduled" | "completed" | "overdue" | "cancelled";

export interface FollowUp {
  id: string;
  claimId: string;
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  carrier: string | null;
  adjuster: string | null;
  type: FollowUpType;
  title: string;
  description: string;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  dueDate: number;
  daysUntilDue: number;
  suggestedMethod: string;
  suggestedMessage: string;
  evidenceUsed: string[];
  previousFollowUps: number;
  lastFollowUpDate: number | null;
  notes: string[];
}

export interface FollowUpSummary {
  totalFollowUps: number;
  byStatus: Record<FollowUpStatus, number>;
  byType: Record<string, number>;
  byPriority: Record<FollowUpPriority, number>;
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Main follow-up scheduler
// ---------------------------------------------------------------------------

export function scheduleFollowUps(
  claims: ClaimSnapshot[],
  previousFollowUps: Array<{
    claimId: string;
    type: FollowUpType;
    completedAt?: number | null;
  }> = [],
): FollowUp[] {
  const followUps: FollowUp[] = [];
  const now = Date.now();

  for (const claim of claims) {
    // Skip closed claims
    if (claim.status === "closed" || claim.status === "approved") continue;

    const reconciliation = reconcileClaim(claim, []);
    const claimPreviousFollowUps = previousFollowUps.filter(
      (f) => String(f.claimId) === String(claim._id),
    );
    const lastFollowUp = claimPreviousFollowUps
      .filter((f) => typeof f.completedAt === "number")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];

    // 1. Carrier payment follow-up
    if (
      reconciliation.outstanding > 0 &&
      claim.status !== "submitted" &&
      claim.status !== "carrier_review"
    ) {
      followUps.push({
        id: `followup:${claim._id}:carrier:payment`,
        claimId: String(claim._id ?? ""),
        claimNumber: claim.claimNumber ?? null,
        customer: claim.customer ?? null,
        property: claim.property ?? null,
        carrier: claim.carrier ?? null,
        adjuster: claim.adjuster ?? null,
        type: "carrier_payment",
        title: `Follow up on $${reconciliation.outstanding.toLocaleString()} outstanding payment`,
        description: `Claim has $${reconciliation.outstanding.toLocaleString()} outstanding from carrier`,
        priority: reconciliation.outstanding > 10000 ? "urgent" : "high",
        status: "pending",
        dueDate: now + 7 * 24 * 60 * 60 * 1000,
        daysUntilDue: 7,
        suggestedMethod: "Email or phone call to carrier claims department",
        suggestedMessage: generatePaymentFollowUpMessage(claim, reconciliation),
        evidenceUsed: ["reconciliation"],
        previousFollowUps: claimPreviousFollowUps.filter(
          (f) => f.type === "carrier_payment",
        ).length,
        lastFollowUpDate: lastFollowUp?.completedAt ?? null,
        notes: [
          `Outstanding: $${reconciliation.outstanding.toLocaleString()}`,
          `Last follow-up: ${lastFollowUp?.completedAt ? new Date(lastFollowUp.completedAt).toLocaleDateString() : "None"}`,
        ],
      });
    }

    // 2. Carrier status follow-up (if claim is stale)
    if (typeof claim.updatedAt === "number") {
      const daysSinceUpdate = Math.round(
        (now - claim.updatedAt) / (24 * 60 * 60 * 1000),
      );
      if (daysSinceUpdate > 14 && claim.status !== "closed") {
        followUps.push({
          id: `followup:${claim._id}:carrier:status`,
          claimId: String(claim._id ?? ""),
          claimNumber: claim.claimNumber ?? null,
          customer: claim.customer ?? null,
          property: claim.property ?? null,
          carrier: claim.carrier ?? null,
          adjuster: claim.adjuster ?? null,
          type: "carrier_status",
          title: `Check status — claim inactive for ${daysSinceUpdate} days`,
          description: `No activity on this claim for ${daysSinceUpdate} days`,
          priority: daysSinceUpdate > 30 ? "high" : "medium",
          status: "pending",
          dueDate: now + 3 * 24 * 60 * 60 * 1000,
          daysUntilDue: 3,
          suggestedMethod: "Phone call to carrier or adjuster",
          suggestedMessage: generateStatusFollowUpMessage(claim),
          evidenceUsed: ["claim.updatedAt", "claim.status"],
          previousFollowUps: claimPreviousFollowUps.filter(
            (f) => f.type === "carrier_status",
          ).length,
          lastFollowUpDate: lastFollowUp?.completedAt ?? null,
          notes: [
            `Days since update: ${daysSinceUpdate}`,
            `Current status: ${claim.status}`,
          ],
        });
      }
    }

    // 3. Adjuster follow-up (if adjuster assigned and claim in estimating/carrier_review)
    if (
      claim.adjuster &&
      (claim.status === "estimating" ||
        claim.status === "carrier_review" ||
        claim.status === "supplement_identified")
    ) {
      followUps.push({
        id: `followup:${claim._id}:adjuster:scope`,
        claimId: String(claim._id ?? ""),
        claimNumber: claim.claimNumber ?? null,
        customer: claim.customer ?? null,
        property: claim.property ?? null,
        carrier: claim.carrier ?? null,
        adjuster: claim.adjuster ?? null,
        type: "adjuster_scope",
        title: `Schedule scope discussion with ${claim.adjuster}`,
        description: `Discuss scope items and estimate with assigned adjuster`,
        priority: "medium",
        status: "pending",
        dueDate: now + 5 * 24 * 60 * 60 * 1000,
        daysUntilDue: 5,
        suggestedMethod: "Email to schedule meeting or phone call",
        suggestedMessage: generateAdjusterFollowUpMessage(claim),
        evidenceUsed: ["claim.adjuster", "claim.status"],
        previousFollowUps: claimPreviousFollowUps.filter(
          (f) => f.type === "adjuster_scope",
        ).length,
        lastFollowUpDate: lastFollowUp?.completedAt ?? null,
        notes: [
          `Adjuster: ${claim.adjuster}`,
          `Current status: ${claim.status}`,
        ],
      });
    }

    // 4. Customer update
    if (
      claim.status === "supplement_submitted" ||
      claim.status === "submitted" ||
      claim.status === "response_received"
    ) {
      followUps.push({
        id: `followup:${claim._id}:customer:update`,
        claimId: String(claim._id ?? ""),
        claimNumber: claim.claimNumber ?? null,
        customer: claim.customer ?? null,
        property: claim.property ?? null,
        carrier: claim.carrier ?? null,
        adjuster: claim.adjuster ?? null,
        type: "customer_update",
        title: `Update customer on claim status`,
        description: `Provide status update to ${claim.customer ?? "customer"}`,
        priority: "low",
        status: "pending",
        dueDate: now + 7 * 24 * 60 * 60 * 1000,
        daysUntilDue: 7,
        suggestedMethod: "Email or phone call",
        suggestedMessage: generateCustomerUpdateMessage(claim),
        evidenceUsed: ["claim.status"],
        previousFollowUps: claimPreviousFollowUps.filter(
          (f) => f.type === "customer_update",
        ).length,
        lastFollowUpDate: lastFollowUp?.completedAt ?? null,
        notes: [
          `Current status: ${claim.status}`,
          `Customer: ${claim.customer ?? "Unknown"}`,
        ],
      });
    }
  }

  // Sort by priority then due date
  const priorityOrder: Record<FollowUpPriority, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  followUps.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return a.daysUntilDue - b.daysUntilDue;
  });

  return followUps;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function buildFollowUpSummary(followUps: FollowUp[]): FollowUpSummary {
  const byStatus: Record<FollowUpStatus, number> = {
    pending: 0,
    scheduled: 0,
    completed: 0,
    overdue: 0,
    cancelled: 0,
  };
  const byType: Record<string, number> = {};
  const byPriority: Record<FollowUpPriority, number> = {
    urgent: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  let overdueCount = 0;
  let dueTodayCount = 0;
  let dueThisWeekCount = 0;

  for (const f of followUps) {
    byStatus[f.status] += 1;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
    byPriority[f.priority] += 1;

    if (f.status === "overdue") overdueCount += 1;
    if (f.daysUntilDue <= 0) dueTodayCount += 1;
    if (f.daysUntilDue <= 7) dueThisWeekCount += 1;
  }

  return {
    totalFollowUps: followUps.length,
    byStatus,
    byType,
    byPriority,
    overdueCount,
    dueTodayCount,
    dueThisWeekCount,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Message generators
// ---------------------------------------------------------------------------

function generatePaymentFollowUpMessage(
  claim: ClaimSnapshot,
  reconciliation: { outstanding: number; estimate?: number; invoiced?: number; paid: number },
): string {
  const lines: string[] = [];
  lines.push(`RE: Claim ${claim.claimNumber ?? "N/A"} — Payment Status`);
  lines.push("");
  lines.push(
    `We are writing to follow up on payment status for the above-referenced claim.`,
  );
  lines.push("");
  lines.push("Current financial summary:");
  if (typeof reconciliation.estimate === "number")
    lines.push(`  Estimate: $${reconciliation.estimate.toLocaleString()}`);
  if (typeof reconciliation.invoiced === "number")
    lines.push(`  Invoiced: $${reconciliation.invoiced.toLocaleString()}`);
  lines.push(`  Paid to date: $${reconciliation.paid.toLocaleString()}`);
  lines.push(`  Outstanding: $${reconciliation.outstanding.toLocaleString()}`);
  lines.push("");
  lines.push(
    "We respectfully request an update on the payment status and timeline for resolution.",
  );
  return lines.join("\n");
}

function generateStatusFollowUpMessage(claim: ClaimSnapshot): string {
  const lines: string[] = [];
  lines.push(`RE: Claim ${claim.claimNumber ?? "N/A"} — Status Update Request`);
  lines.push("");
  lines.push(
    `We are writing to inquire about the current status of the above-referenced claim.`,
  );
  lines.push("");
  lines.push(`Property: ${claim.property ?? "N/A"}`);
  lines.push(`Insured: ${claim.customer ?? "N/A"}`);
  lines.push(`Current status in our system: ${claim.status ?? "Unknown"}`);
  lines.push("");
  lines.push(
    "Please provide an update on the claim's current status and any outstanding items.",
  );
  return lines.join("\n");
}

function generateAdjusterFollowUpMessage(claim: ClaimSnapshot): string {
  const lines: string[] = [];
  lines.push(`Dear ${claim.adjuster},`);
  lines.push("");
  lines.push(
    `I hope this message finds you well. I'm writing regarding Claim ${claim.claimNumber ?? "N/A"} for the property at ${claim.property ?? "the insured property"}.`,
  );
  lines.push("");
  lines.push("We would like to schedule a time to discuss:");
  lines.push("  • Current estimate and scope review");
  lines.push("  • Any scope items that may require additional coverage");
  lines.push("  • Outstanding documentation requirements");
  lines.push("");
  lines.push("Please let me know your availability for a brief call or meeting.");
  return lines.join("\n");
}

function generateCustomerUpdateMessage(claim: ClaimSnapshot): string {
  const lines: string[] = [];
  lines.push(`Dear ${claim.customer ?? "Valued Customer"},`);
  lines.push("");
  lines.push(
    `We wanted to provide you with an update on your insurance claim (Claim #${claim.claimNumber ?? "N/A"}).`,
  );
  lines.push("");
  lines.push(`Current status: ${claim.status?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? "In progress"}`);
  lines.push("");
  lines.push("We continue to work on your claim and will notify you immediately of any updates.");
  lines.push("");
  lines.push("If you have any questions, please don't hesitate to reach out.");
  return lines.join("\n");
}
