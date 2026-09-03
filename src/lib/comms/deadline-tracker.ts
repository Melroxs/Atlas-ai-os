// ---------------------------------------------------------------------------
// Atlas Deadline Tracker
//
// Tracks regulatory, filing, and contractual deadlines for claims:
//   - Statute of limitations by jurisdiction
//   - Filing deadlines
//   - Carrier response deadlines
//   - Internal SLA deadlines
//   - Follow-up deadlines
//
// CRITICAL: All deadlines are derived from actual claim records and
// configurable jurisdiction rules. Atlas never fabricates deadlines.
// ---------------------------------------------------------------------------

import type { ClaimSnapshot } from "../insurance/logic";

// ---------------------------------------------------------------------------
// Deadline types
// ---------------------------------------------------------------------------

export type DeadlineType =
  | "statute_of_limitations"
  | "filing_deadline"
  | "carrier_response"
  | "internal_sla"
  | "follow_up"
  | "payment_due"
  | "document_submission";

export type DeadlineStatus = "upcoming" | "approaching" | "overdue" | "completed";

export type DeadlineSeverity = "critical" | "warning" | "info";

export interface Deadline {
  id: string;
  claimId: string;
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  type: DeadlineType;
  title: string;
  description: string;
  dueDate: number;
  daysUntilDue: number;
  status: DeadlineStatus;
  severity: DeadlineSeverity;
  jurisdiction: string | null;
  notes: string[];
  requiresAction: boolean;
  suggestedAction: string;
}

export interface DeadlineSummary {
  totalDeadlines: number;
  byStatus: Record<DeadlineStatus, number>;
  bySeverity: Record<DeadlineSeverity, number>;
  byType: Record<string, number>;
  nextDeadline: Deadline | null;
  overdueCount: number;
  upcomingCount: number;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Default jurisdiction rules (configurable per company/claim)
// ---------------------------------------------------------------------------

export interface JurisdictionRule {
  jurisdiction: string;
  statuteOfLimitationsYears: number;
  filingDeadlineDays: number | null;
  carrierResponseDays: number;
  notes: string[];
}

export const DEFAULT_JURISDICTION_RULES: JurisdictionRule[] = [
  {
    jurisdiction: "Texas",
    statuteOfLimitationsYears: 2,
    filingDeadlineDays: null,
    carrierResponseDays: 15,
    notes: [
      "Texas Insurance Code §542 requires prompt payment",
      "2-year statute of limitations for breach of contract",
    ],
  },
  {
    jurisdiction: "Florida",
    statuteOfLimitationsYears: 5,
    filingDeadlineDays: null,
    carrierResponseDays: 30,
    notes: [
      "Florida Statute §627.70131 requires carrier to pay within 90 days",
      "5-year statute of limitations for first-party property claims",
    ],
  },
  {
    jurisdiction: "California",
    statuteOfLimitationsYears: 4,
    filingDeadlineDays: null,
    carrierResponseDays: 15,
    notes: [
      "California Insurance Code §790.03h requires prompt settlement",
      "4-year statute of limitations",
    ],
  },
  {
    jurisdiction: "New York",
    statuteOfLimitationsYears: 6,
    filingDeadlineDays: null,
    carrierResponseDays: 15,
    notes: [
      "6-year statute of limitations for breach of contract",
      "Insurance Law §2304 requires prompt claim handling",
    ],
  },
  {
    jurisdiction: "Default",
    statuteOfLimitationsYears: 4,
    filingDeadlineDays: null,
    carrierResponseDays: 30,
    notes: [
      "Default rules — verify applicable jurisdiction",
    ],
  },
];

// ---------------------------------------------------------------------------
// Main deadline tracker
// ---------------------------------------------------------------------------

export function trackDeadlines(
  claims: ClaimSnapshot[],
  rules: JurisdictionRule[] = DEFAULT_JURISDICTION_RULES,
): Deadline[] {
  const deadlines: Deadline[] = [];
  const now = Date.now();

  for (const claim of claims) {
    // Skip closed claims
    if (claim.status === "closed" || claim.status === "approved") continue;

    const jurisdiction =
      rules.find(
        (r) =>
          r.jurisdiction.toLowerCase() ===
          (claim.carrier ?? "").toLowerCase(),
      ) ?? rules.find((r) => r.jurisdiction === "Default")!;

    // 1. Statute of limitations
    if (typeof claim.dateOfLoss === "number") {
      const solDeadline =
        claim.dateOfLoss +
        jurisdiction.statuteOfLimitationsYears * 365 * 24 * 60 * 60 * 1000;
      const daysUntilSol = Math.ceil((solDeadline - now) / (24 * 60 * 60 * 1000));

      deadlines.push({
        id: `deadline:${claim._id}:sol`,
        claimId: String(claim._id ?? ""),
        claimNumber: claim.claimNumber ?? null,
        customer: claim.customer ?? null,
        property: claim.property ?? null,
        type: "statute_of_limitations",
        title: `Statute of Limitations — ${jurisdiction.jurisdiction}`,
        description: `Filing deadline expires in ${daysUntilSol} days`,
        dueDate: solDeadline,
        daysUntilDue: daysUntilSol,
        status: getDeadlineStatus(daysUntilSol),
        severity: getDeadlineSeverity(daysUntilSol, "statute_of_limitations"),
        jurisdiction: jurisdiction.jurisdiction,
        notes: jurisdiction.notes,
        requiresAction: daysUntilSol <= 90,
        suggestedAction:
          daysUntilSol <= 30
            ? "URGENT: Prepare and file suit before statute expires"
            : daysUntilSol <= 90
              ? "Begin pre-suit notice requirements and prepare filing documents"
              : "Monitor and ensure claim progresses before deadline",
      });
    }

    // 2. Carrier response deadline (if claim is in carrier_review or submitted)
    if (
      claim.status === "submitted" ||
      claim.status === "carrier_review" ||
      claim.status === "response_received"
    ) {
      if (typeof claim.updatedAt === "number") {
        const carrierDeadline =
          claim.updatedAt + jurisdiction.carrierResponseDays * 24 * 60 * 60 * 1000;
        const daysUntilCarrier = Math.ceil(
          (carrierDeadline - now) / (24 * 60 * 60 * 1000),
        );

        deadlines.push({
          id: `deadline:${claim._id}:carrier`,
          claimId: String(claim._id ?? ""),
          claimNumber: claim.claimNumber ?? null,
          customer: claim.customer ?? null,
          property: claim.property ?? null,
          type: "carrier_response",
          title: "Carrier Response Deadline",
          description: `Carrier should respond within ${jurisdiction.carrierResponseDays} days of submission`,
          dueDate: carrierDeadline,
          daysUntilDue: daysUntilCarrier,
          status: getDeadlineStatus(daysUntilCarrier),
          severity: getDeadlineSeverity(daysUntilCarrier, "carrier_response"),
          jurisdiction: jurisdiction.jurisdiction,
          notes: [
            `Carrier has ${jurisdiction.carrierResponseDays} days per ${jurisdiction.jurisdiction} regulations`,
            "If deadline passes, escalate to carrier management",
          ],
          requiresAction: daysUntilCarrier <= 7,
          suggestedAction:
            daysUntilCarrier <= 0
              ? "Carrier response overdue — escalate to management and file regulatory complaint if warranted"
              : "Prepare follow-up communication to carrier",
        });
      }
    }

    // 3. Internal SLA (staleness check)
    if (typeof claim.updatedAt === "number" && claim.status !== "closed") {
      const daysSinceUpdate = Math.round(
        (now - claim.updatedAt) / (24 * 60 * 60 * 1000),
      );
      const slaDeadline = claim.updatedAt + 30 * 24 * 60 * 60 * 1000;
      const daysUntilSla = Math.ceil(
        (slaDeadline - now) / (24 * 60 * 60 * 1000),
      );

      if (daysSinceUpdate > 20) {
        deadlines.push({
          id: `deadline:${claim._id}:sla`,
          claimId: String(claim._id ?? ""),
          claimNumber: claim.claimNumber ?? null,
          customer: claim.customer ?? null,
          property: claim.property ?? null,
          type: "internal_sla",
          title: "Internal SLA — Claim Activity",
          description: `Claim has been inactive for ${daysSinceUpdate} days`,
          dueDate: slaDeadline,
          daysUntilDue: daysUntilSla,
          status: getDeadlineStatus(daysUntilSla),
          severity: getDeadlineSeverity(daysUntilSla, "internal_sla"),
          jurisdiction: null,
          notes: [
            "Internal policy: claims should have activity every 30 days",
            "Stale claims risk missed deadlines and customer dissatisfaction",
          ],
          requiresAction: true,
          suggestedAction: "Check with carrier/adjuster for status update",
        });
      }
    }
  }

  // Sort by severity then days until due
  const severityOrder: Record<DeadlineSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  deadlines.sort((a, b) => {
    const sDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sDiff !== 0) return sDiff;
    return a.daysUntilDue - b.daysUntilDue;
  });

  return deadlines;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function buildDeadlineSummary(deadlines: Deadline[]): DeadlineSummary {
  const byStatus: Record<DeadlineStatus, number> = {
    upcoming: 0,
    approaching: 0,
    overdue: 0,
    completed: 0,
  };
  const bySeverity: Record<DeadlineSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  const byType: Record<string, number> = {};

  for (const d of deadlines) {
    byStatus[d.status] += 1;
    bySeverity[d.severity] += 1;
    byType[d.type] = (byType[d.type] ?? 0) + 1;
  }

  return {
    totalDeadlines: deadlines.length,
    byStatus,
    bySeverity,
    byType,
    nextDeadline: deadlines[0] ?? null,
    overdueCount: byStatus.overdue,
    upcomingCount: byStatus.upcoming + byStatus.approaching,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeadlineStatus(daysUntilDue: number): DeadlineStatus {
  if (daysUntilDue < 0) return "overdue";
  if (daysUntilDue <= 7) return "approaching";
  return "upcoming";
}

function getDeadlineSeverity(
  daysUntilDue: number,
  type: DeadlineType,
): DeadlineSeverity {
  if (type === "statute_of_limitations") {
    if (daysUntilDue <= 30) return "critical";
    if (daysUntilDue <= 90) return "warning";
    return "info";
  }
  if (type === "carrier_response") {
    if (daysUntilDue <= 0) return "critical";
    if (daysUntilDue <= 7) return "warning";
    return "info";
  }
  if (type === "internal_sla") {
    if (daysUntilDue <= 0) return "critical";
    if (daysUntilDue <= 7) return "warning";
    return "info";
  }
  if (daysUntilDue <= 0) return "critical";
  if (daysUntilDue <= 14) return "warning";
  return "info";
}
