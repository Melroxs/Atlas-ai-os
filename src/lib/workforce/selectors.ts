// ---------------------------------------------------------------------------
// Atlas Workforce — Pure Selectors
//
// Derive per-worker operational views from the SAME backend data every page
// already uses (claims, work items, governance decisions, deadlines, recovery
// metrics). Pure functions → unit-testable without React or Supabase.
// ---------------------------------------------------------------------------

import type { WorkItem, WorkCategory } from "@/lib/work-queue/service";
import type { GovernanceDecisionRow } from "@/lib/governance/persistence";
import type { WorkerDefinition } from "./worker-defs";
import type { Deadline } from "@/lib/comms/deadline-tracker";
import {
  generateEstimateLineItems,
  buildEstimateSummary,
  type EstimateSummary,
} from "@/lib/orchestrator/estimator";
import type { ClaimSnapshot } from "@/lib/insurance/logic";

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/** Work items owned by a worker's attention categories, priority-sorted. */
export function filterWorkItemsByWorker(
  items: WorkItem[],
  worker: Pick<WorkerDefinition, "attentionCategories">,
  limit = 50,
): WorkItem[] {
  const own = new Set<WorkCategory>(worker.attentionCategories);
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return items
    .filter((i) => own.has(i.category))
    .sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/** Governance action types each worker owns (orchestrator action_type values). */
export function workerGovernanceActions(
  worker: Pick<WorkerDefinition, "slug">,
): string[] {
  switch (worker.slug) {
    case "claims":
      return ["claim_analysis", "coverage_determination"];
    case "supplements":
      return ["supplement_preparation"];
    case "recovery":
      return ["financial_calculation"];
    case "estimator":
      return ["estimating", "estimate_review", "financial_calculation"];
    case "customers":
      return ["communication_drafting", "communication_sending"];
    default:
      return [];
  }
}

/** Governance decisions owned by a worker, newest first. */
export function governanceForWorker(
  rows: GovernanceDecisionRow[],
  worker: Pick<WorkerDefinition, "slug">,
  limit = 25,
): GovernanceDecisionRow[] {
  const actions = new Set(workerGovernanceActions(worker));
  return rows
    .filter((r) => actions.has(r.action_type))
    .sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at))
    .slice(0, limit);
}

/** Pending (actionable) governance decisions for a worker. */
export function pendingGovernanceForWorker(
  rows: GovernanceDecisionRow[],
  worker: Pick<WorkerDefinition, "slug">,
  limit = 25,
): GovernanceDecisionRow[] {
  return governanceForWorker(rows, worker, limit).filter(
    (r) =>
      r.approval_status === "required" &&
      (r.execution_status === "awaiting_approval" || r.execution_status === "blocked"),
  );
}

// ---------------------------------------------------------------------------
// Recovery metrics (real insurance_claim_counts fields)
// ---------------------------------------------------------------------------

export interface RecoveryMetrics {
  activeClaims: number;
  attentionClaims: number;
  openFindings: number;
  supplementsDrafted: number;
  supplementsReady: number;
  supplementsSubmitted: number;
  requestedAmount: number;
  approvedAmount: number;
  deniedAmount: number;
  paidAmount: number;
  outstanding: number;
  potential: number;
}

/** Map the raw claim-counts row into worker-facing financial intelligence. */
export function buildRecoveryMetrics(counts: Record<string, unknown> | null | undefined): RecoveryMetrics {
  const num = (k: string): number =>
    typeof counts?.[k] === "number" ? (counts[k] as number) : 0;
  return {
    activeClaims: num("activeClaims"),
    attentionClaims: num("attentionClaims"),
    openFindings: num("openFindings"),
    supplementsDrafted: num("drafts"),
    supplementsReady: num("readyForSubmission"),
    supplementsSubmitted: num("submitted"),
    requestedAmount: num("requestedAmount"),
    approvedAmount: num("approvedAmount"),
    deniedAmount: num("deniedAmount"),
    paidAmount: num("paidAmount"),
    outstanding: num("outstanding"),
    potential: num("potential"),
  };
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export interface DeadlineView {
  critical: Deadline[];
  warning: Deadline[];
  upcoming: Deadline[];
  overdue: number;
}

/** Group tracked deadlines into critical / warning / upcoming buckets. */
export function buildDeadlineView(deadlines: Deadline[]): DeadlineView {
  const sorted = [...deadlines].sort((a, b) => a.dueDate - b.dueDate);
  const now = Date.now();
  return {
    critical: sorted.filter((d) => d.severity === "critical"),
    warning: sorted.filter((d) => d.severity === "warning"),
    upcoming: sorted.filter((d) => d.severity === "info" && d.dueDate > now),
    overdue: sorted.filter((d) => d.dueDate < now).length,
  };
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export interface EstimateReviewRow {
  claimId: string;
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  estimateAmount: number | null;
  lineItemCount: number;
  needsReview: number;
  summary: EstimateSummary;
}

/**
 * Build the estimator's review queue from claims that carry estimate data.
 * Runs the real estimator engine (generateEstimateLineItems) — output is
 * review-ready data for a human estimator, never a claim of Xactimate access.
 */
export function buildEstimateReview(
  claims: ClaimSnapshot[],
  limit = 50,
): EstimateReviewRow[] {
  const rows: EstimateReviewRow[] = [];
  for (const claim of claims) {
    if (typeof claim.estimateAmount !== "number" && !claim.scopeItems?.length) {
      continue;
    }
    const lineItems = generateEstimateLineItems(claim);
    if (lineItems.length === 0 && typeof claim.estimateAmount !== "number") {
      continue;
    }
    const summary = buildEstimateSummary(
      String(claim._id ?? ""),
      claim.claimNumber ?? null,
      lineItems,
    );
    const needsReview = lineItems.filter(
      (l) => l.requiredHumanAction || l.status === "unsupported" || l.status === "disputed",
    ).length;
    rows.push({
      claimId: String(claim._id ?? ""),
      claimNumber: claim.claimNumber ?? null,
      customer: claim.customer ?? null,
      property: claim.property ?? null,
      estimateAmount: claim.estimateAmount ?? null,
      lineItemCount: lineItems.length,
      needsReview,
      summary,
    });
  }
  return rows
    .sort((a, b) => b.needsReview - a.needsReview || (b.estimateAmount ?? 0) - (a.estimateAmount ?? 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Claims views
// ---------------------------------------------------------------------------

export type ClaimAttentionTag =
  | "incomplete"
  | "at_risk"
  | "stalled"
  | "ready"
  | "new";

export interface ClaimViewRow {
  claim: ClaimSnapshot;
  attention: ClaimAttentionTag | null;
  outstanding: number | null;
}

const CLAIM_STATUSES = new Set([
  "open", "active", "in_progress", "review", "approved", "pending", "awaiting_approval",
]);

/** Tag a claim by operational attention. Pure — no fabricated metrics. */
export function tagClaimAttention(claim: ClaimSnapshot): ClaimAttentionTag | null {
  const status = String(claim.status ?? "").toLowerCase();
  const updated = typeof claim.updatedAt === "number" ? claim.updatedAt : 0;
  const staleDays = updated > 0 ? Math.round((Date.now() - updated) / 86_400_000) : null;

  if (!CLAIM_STATUSES.has(status) && status !== "closed" && status !== "rejected" && status !== "") {
    return "at_risk";
  }
  if (staleDays !== null && staleDays > 60) return "stalled";
  if (staleDays !== null && staleDays > 30) return "at_risk";
  return null;
}

/** Claims sorted by attention (at_risk > stalled > incomplete > new > ready). */
export function buildClaimView(claims: ClaimSnapshot[], limit = 100): ClaimViewRow[] {
  const order: Record<ClaimAttentionTag, number> = {
    at_risk: 0,
    incomplete: 1,
    stalled: 2,
    new: 3,
    ready: 4,
  };
  return claims
    .map((claim) => {
      const outstanding =
        typeof claim.openBalance === "number"
          ? claim.openBalance
          : typeof claim.collectedAmount === "number" &&
              typeof claim.paymentAmount === "number"
            ? claim.paymentAmount - claim.collectedAmount
            : null;
      return { claim, attention: tagClaimAttention(claim), outstanding };
    })
    .sort((a, b) => {
      const aRank = a.attention ? (order[a.attention] ?? 9) : 9;
      const bRank = b.attention ? (order[b.attention] ?? 9) : 9;
      return aRank - bRank;
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Scalable collections
// ---------------------------------------------------------------------------

export interface CollectionGroup<T> {
  key: string;
  label: string;
  count: number;
  items: T[];
}

/**
 * Group flat records by a derived key (e.g. top-level folder of a path).
 * Groups preserve first-seen order; items keep their order.
 */
export function groupByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  labelOf?: (key: string, group: T[]) => string,
): CollectionGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item) || "(root)";
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return Array.from(map.entries()).map(([key, group]) => ({
    key,
    label: labelOf ? labelOf(key, group) : key,
    count: group.length,
    items: group,
  }));
}

/** Stable client-side search across string fields. */
export function filterBySearch<T>(
  items: T[],
  query: string,
  fields: Array<(item: T) => string | null | undefined>,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) =>
    fields.some((f) => (f(item) ?? "").toLowerCase().includes(q)),
  );
}

/** Deterministic pagination slice. */
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, (page - 1) * pageSize);
  return items.slice(start, start + pageSize);
}

export function totalPages(count: number, pageSize: number): number {
  return Math.max(1, Math.ceil(count / pageSize));
}

/** First path segment of an archive file path — the collection label. */
export function topFolder(path: string | null | undefined): string {
  const clean = (path ?? "").replace(/^\/+/, "");
  const idx = clean.indexOf("/");
  if (idx === -1) return clean || "(root)";
  return clean.slice(0, idx);
}