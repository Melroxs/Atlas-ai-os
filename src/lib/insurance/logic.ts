import {
  analyzeRecoveryOpportunities,
  type ClaimFacts,
} from "@/lib/atlas-data/everest-insurance";
import { normalizeEvidence, normalizeEvidenceRows } from "@/lib/insurance/evidence";

export const CLAIM_STATUSES = [
  "lead",
  "opened",
  "documenting",
  "estimating",
  "carrier_review",
  "supplement_identified",
  "supplement_prepared",
  "ready_for_submission",
  "submitted",
  "response_received",
  "negotiating",
  "approved",
  "work_completed",
  "billing",
  "reconciling",
  "closed",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const SUPPLEMENT_STATUSES = [
  "draft",
  "ready_for_submission",
  "submitted",
  "carrier_review",
  "approved",
  "partially_approved",
  "denied",
  "additional_docs_requested",
  "payment_received",
  "closed",
] as const;
export type SupplementStatus = (typeof SUPPLEMENT_STATUSES)[number];

/** The 20-stage revenue recovery pipeline (workflow the company runs). */
export const RECOVERY_PIPELINE = [
  "Claim identified",
  "Claim package assembled",
  "Evidence collected",
  "Estimate ingested",
  "Scope normalized",
  "Coverage / context reviewed",
  "Gap analysis performed",
  "Potential supplement items identified",
  "Evidence matched",
  "Supplement drafted",
  "Human review",
  "Customer / contractor approval",
  "Submission prepared",
  "Submission sent",
  "Carrier response tracked",
  "Approved / denied items reconciled",
  "Payment reconciled",
  "Outstanding recovery identified",
  "Follow-up scheduled",
  "Claim closed",
] as const;

export const STATUS_LABELS: Record<string, string> = {
  lead: "Lead / Loss",
  opened: "Opened",
  documenting: "Documentation",
  estimating: "Estimate",
  carrier_review: "Carrier review",
  supplement_identified: "Supplement identified",
  supplement_prepared: "Supplement prepared",
  ready_for_submission: "Ready for submission",
  submitted: "Submitted",
  response_received: "Carrier response",
  negotiating: "Negotiation / revision",
  approved: "Approved",
  work_completed: "Work completed",
  billing: "Final billing",
  reconciling: "Revenue reconciliation",
  closed: "Closed",
};

/** Honest stage-progress helper for the pipeline view. */
export function pipelineIndexFor(status?: string | null): number {
  if (!status) return 0;
  const idx = CLAIM_STATUSES.indexOf(status as ClaimStatus);
  return idx < 0 ? 0 : idx;
}

// ---------------------------------------------------------------------------
// Pure analyzers (unit tested)
// ---------------------------------------------------------------------------

export type CompletenessStatus =
  | "verified"
  | "extracted"
  | "inferred"
  | "missing"
  | "needs_review"
  | "conflicted"
  | "stale";

export interface CompletenessCategory {
  key: string;
  label: string;
  status: CompletenessStatus;
  /** What Atlas actually has / the source it came from. Never fabricated. */
  note: string;
}

export interface ClaimCompleteness {
  categories: CompletenessCategory[];
  /** Verified + extracted (usable) count. */
  complete: number;
  total: number;
  /** 0..1 — computed strictly from the rules below. */
  score: number;
  /** Deterministic summary sentence. */
  summary: string;
}

export interface ClaimSnapshot {
  /** Internal id (present when analyzing a persisted claim). */
  _id?: string;
  claimNumber?: string | null;
  dateOfLoss?: number | null;
  property?: string | null;
  causeOfLoss?: string | null;
  lossDescription?: string | null;
  customer?: string | null;
  carrier?: string | null;
  policy?: string | null;
  adjuster?: string | null;
  status?: string | null;
  estimateAmount?: number | null;
  estimateLineItemCount?: number | null;
  invoicedAmount?: number | null;
  paymentAmount?: number | null;
  approvedAmount?: number | null;
  collectedAmount?: number | null;
  openBalance?: number | null;
  deductible?: number | null;
  policyLimits?: number | null;
  scopeItems?: Array<{ name?: string; inEstimate?: boolean }> | null;
  expectedScope?: string[] | null;
  actualScope?: string[] | null;
  evidenceSummary?: string[] | null;
  evidenceDocumentIds?: unknown[] | null;
  timeline?: Array<Record<string, unknown>> | null;
  confidence?: number;
  provenance?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

const COMPLETENESS_RULES: Array<{
  key: string;
  label: string;
  has: (c: ClaimSnapshot) => boolean;
  note: (c: ClaimSnapshot) => string;
  /** Phase 14 — state override: conflicted/stale detection, evidence-based. */
  statusOverride?: (c: ClaimSnapshot) => CompletenessStatus | undefined;
}> = [
  {
    key: "claimNumber",
    label: "Claim number",
    has: (c) => Boolean(c.claimNumber?.trim()),
    note: (c) => (c.claimNumber ? `On file: ${c.claimNumber}` : "No claim number recorded."),
  },
  {
    key: "dateOfLoss",
    label: "Date of loss",
    has: (c) => typeof c.dateOfLoss === "number",
    note: (c) => (typeof c.dateOfLoss === "number" ? new Date(c.dateOfLoss).toLocaleDateString() : "No date of loss recorded."),
  },
  {
    key: "property",
    label: "Property",
    has: (c) => Boolean(c.property?.trim()),
    note: (c) => (c.property ? c.property : "No property recorded."),
  },
  {
    key: "causeOfLoss",
    label: "Cause of loss",
    has: (c) => Boolean(c.causeOfLoss?.trim()),
    note: (c) => (c.causeOfLoss ? c.causeOfLoss : "No cause of loss recorded."),
  },
  {
    key: "customer",
    label: "Customer / insured",
    has: (c) => Boolean(c.customer?.trim()),
    note: (c) => (c.customer ? c.customer : "No customer recorded."),
  },
  {
    key: "coverage",
    label: "Carrier / policy",
    has: (c) => Boolean(c.carrier?.trim() || c.policy?.trim()),
    note: (c) =>
      [c.carrier && `Carrier: ${c.carrier}`, c.policy && `Policy: ${c.policy}`]
        .filter(Boolean)
        .join(" · ") || "No carrier or policy on file.",
  },
  {
    key: "estimate",
    label: "Estimate",
    has: (c) =>
      typeof c.estimateAmount === "number" || (c.scopeItems?.length ?? 0) > 0,
    note: (c) =>
      typeof c.estimateAmount === "number"
        ? `Estimate: $${c.estimateAmount.toLocaleString()}${c.estimateLineItemCount ? ` · ${c.estimateLineItemCount} line items` : ""}`
        : "No estimate ingested yet.",
  },
  {
    key: "evidence",
    label: "Evidence documentation",
    has: (c) => (c.evidenceSummary?.length ?? 0) > 0 || (c.evidenceDocumentIds?.length ?? 0) > 0,
    note: (c) =>
      (c.evidenceSummary?.length ?? 0) > 0
        ? `Evidence categories on file: ${c.evidenceSummary!.join(", ")}`
        : "No evidence material linked yet.",
  },
  {
    key: "invoices",
    label: "Invoices / payments",
    has: (c) => typeof c.invoicedAmount === "number" || typeof c.paymentAmount === "number",
    note: (c) =>
      [
        typeof c.invoicedAmount === "number" && `Invoiced $${c.invoicedAmount.toLocaleString()}`,
        typeof c.paymentAmount === "number" && `Paid $${c.paymentAmount.toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(" · ") || "No invoice or payment recorded.",
  },
  {
    // Phase 14 — financial reconciliation state. Contradictory records are
    // labeled CONFLICTED, never silently resolved.
    key: "financialState",
    label: "Financial reconciliation",
    has: (c) =>
      typeof c.invoicedAmount === "number" ||
      typeof c.paymentAmount === "number" ||
      typeof c.approvedAmount === "number" ||
      typeof c.estimateAmount === "number",
    note: (c) => {
      const parts: string[] = [];
      if (typeof c.estimateAmount === "number") parts.push(`Estimate $${c.estimateAmount.toLocaleString()}`);
      if (typeof c.approvedAmount === "number") parts.push(`Approved $${c.approvedAmount.toLocaleString()}`);
      if (typeof c.invoicedAmount === "number") parts.push(`Invoiced $${c.invoicedAmount.toLocaleString()}`);
      if (typeof c.paymentAmount === "number") parts.push(`Paid $${c.paymentAmount.toLocaleString()}`);
      return parts.length > 0 ? parts.join(" · ") : "No financial amounts recorded.";
    },
    statusOverride: (c) => {
      const inv = c.invoicedAmount;
      const paid = c.paymentAmount;
      const approved = c.approvedAmount;
      const base = c.estimateAmount ?? approved;
      if (typeof inv === "number" && typeof approved === "number" && inv > approved + 0.01) {
        return "conflicted";
      }
      if (typeof inv === "number" && typeof base === "number" && inv > base + 0.01) {
        return "conflicted";
      }
      if (typeof inv === "number" && typeof paid === "number" && paid > inv + 0.01) {
        return "conflicted";
      }
      return undefined;
    },
  },
  {
    // Phase 14 — freshness. An open claim with no activity for 30+ days is
    // STALE (may be stalled). Never treated as current.
    key: "freshness",
    label: "Freshness",
    has: () => true,
    note: (c) => {
      if (c.status === "closed") return "Claim is closed.";
      if (typeof c.updatedAt === "number") {
        const days = Math.round((Date.now() - c.updatedAt) / 86_400_000);
        return days <= 0
          ? "Updated today."
          : `Last updated ${days} day${days === 1 ? "" : "s"} ago.`;
      }
      return "No update timestamp on file.";
    },
    statusOverride: (c) => {
      if (c.status === "closed") return "verified";
      // No timestamp means freshness cannot be established — never call it verified.
      if (typeof c.updatedAt !== "number") return "missing";
      if (Date.now() - c.updatedAt > 30 * 86_400_000) {
        return "stale";
      }
      return "verified";
    },
  },
];

/** Deterministic claim-package completeness. Never invents a percentage. */
export function analyzeClaimCompleteness(claim: ClaimSnapshot): ClaimCompleteness {
  const categories: CompletenessCategory[] = COMPLETENESS_RULES.map((rule) => {
    const present = rule.has(claim);
    const provenance = (claim.provenance ?? "").toLowerCase();
    let status: CompletenessStatus;
    if (rule.statusOverride) {
      const overridden = rule.statusOverride(claim);
      if (overridden) {
        status = overridden;
        return { key: rule.key, label: rule.label, status, note: rule.note(claim) };
      }
    }
    if (!present) status = "missing";
    else if (provenance.includes("confirmed") || provenance.includes("user-entered") || provenance.includes("created via"))
      status = "verified";
    else if (typeof claim.confidence === "number" && claim.confidence < 0.5) status = "needs_review";
    else status = "extracted";
    return { key: rule.key, label: rule.label, status, note: rule.note(claim) };
  });
  const usable = categories.filter((c) => c.status === "verified" || c.status === "extracted").length;
  const total = categories.length;
  const score = total === 0 ? 0 : usable / total;
  const missing = categories.filter(
    (c) =>
      c.status === "missing" ||
      c.status === "needs_review" ||
      c.status === "conflicted" ||
      c.status === "stale",
  ).length;
  const issues: string[] = [];
  const conflicts = categories.filter((c) => c.status === "conflicted");
  const stale = categories.filter((c) => c.status === "stale");
  if (conflicts.length > 0) {
    issues.push(
      `${conflicts.length} conflicted record${conflicts.length === 1 ? "" : "s"} (contradictory values need reconciliation)`,
    );
  }
  if (stale.length > 0) {
    issues.push(`${stale.length} stale item${stale.length === 1 ? "" : "s"} (no activity for 30+ days)`);
  }
  return {
    categories,
    complete: usable,
    total,
    score,
    summary:
      missing === 0
        ? `${usable} of ${total} required information categories are complete.`
        : `${usable} of ${total} required information categories are complete. ${missing} require${missing === 1 ? "s" : ""} attention${issues.length ? ` — ${issues.join("; ")}` : ""}.`,
  };
}

export interface ClaimFindingDraft {
  findingKey: string;
  category: string;
  title: string;
  description: string;
  affectedEstimateItem?: string;
  evidence: string[];
  source?: string;
  confidence: number;
  estimatedAmount?: number;
  limitation: string;
  recommendedNextStep: string;
}

const OPPORTUNITY_CATEGORY: Record<string, string> = {
  missing_scope: "missing_scope",
  documentation_gap: "documentation_gap",
  scope_inconsistency: "scope_inconsistency",
  unresolved_carrier_response: "unresolved_carrier_response",
  potential_underpayment: "potential_underpayment",
  workflow_delay: "workflow_delay",
  supplement_opportunity: "supplement_opportunity",
  estimate_inconsistency: "estimate_inconsistency",
  overlooked_line_item: "overlooked_line_item",
  billing_reconciliation: "billing_reconciliation",
};

/**
 * A tenant document that may carry claim facts (used by the enrichment).
 */
export interface EvidenceDocLike {
  _id: string;
  title?: string | null;
  classification?: string | null;
  /** Extracted text (chunk content joined) for fact extraction. */
  text?: string;
}

const MONEY = /\$?\s?([0-9][0-9,]*\.\d{2})/;

/** First $ amount within `window` chars after the label, or undefined. */
function amountAfter(text: string, label: RegExp): number | undefined {
  const m = label.exec(text);
  if (!m) return undefined;
  const window = text.slice(m.index, m.index + 400);
  const am = MONEY.exec(window);
  if (!am) return undefined;
  return parseFloat(am[1].replace(/,/g, ""));
}

/**
 * Ground a sparse claim snapshot in its actual evidence documents (Phase 15).
 *
 * Claims created from archive candidates start with only the identifiers
 * Atlas could prove (claim number, customer, property). The amounts and
 * scope that drive revenue-recovery analysis live in the ingested documents,
 * so this deterministically extracts them from the linked evidence text:
 * estimate total, invoice total, payment amount, documented scope line items
 * and evidence categories. Missing signals are left untouched — absence is
 * never converted into a value, and no OCR text is fabricated.
 */
export function enrichClaimFromEvidence(
  claim: ClaimSnapshot,
  docs: EvidenceDocLike[],
): ClaimSnapshot {
  let estimateAmount = claim.estimateAmount;
  let invoicedAmount = claim.invoicedAmount;
  let paymentAmount = claim.paymentAmount;
  const evidence = [...(claim.evidenceSummary ?? [])];
  const scopeNames: string[] = [];

  for (const d of docs) {
    const t = d.text ?? "";
    const c = (d.classification ?? "").toLowerCase();
    // Amount extraction is CONTENT-first, not classification-gated: a payment
    // notice or invoice that the classifier labelled "Unknown" still names
    // its own amount, and classification alone is not reliable evidence of
    // what a document contains. The classification still drives the evidence
    // category set below.
    if (typeof estimateAmount !== "number") {
      const amt = amountAfter(t, /(?:total\s+)?estimate\s*(?:total)?[:$]|estimate\s+total|total\s+estimate/i);
      if (typeof amt === "number") estimateAmount = amt;
    }
    if (typeof invoicedAmount !== "number") {
      const amt = amountAfter(t, /invoice\s+total|total\s+invoiced|invoice\s*[:$]/i);
      if (typeof amt === "number") invoicedAmount = amt;
    }
    if (typeof paymentAmount !== "number") {
      const amt = amountAfter(t, /payment\s+amount|amount\s+paid|payment\s*[:$]/i);
      if (typeof amt === "number") paymentAmount = amt;
    }
    if (c.includes("estimate") || c.includes("xactimate")) evidence.push("estimate");
    if (c.includes("invoice") || c.includes("financial") || c.includes("ledger")) evidence.push("invoice");
    if (c.includes("payment")) evidence.push("payment");
    if (c.includes("photo") || c.includes("image")) evidence.push("photos");
    if (c.includes("scope")) {
      for (const m of t.matchAll(/^\s*\d+\.\s+([A-Za-z][^\n]{3,90})/gm)) {
        const name = m[1].trim();
        if (!scopeNames.includes(name)) scopeNames.push(name);
      }
      evidence.push("scope");
    }
    if (c.includes("policy")) evidence.push("policy");
    if (c.includes("supplement")) evidence.push("supplement");
    if (c.includes("report") || c.includes("communication") || c.includes("correspondence")) {
      evidence.push("documentation");
    }
  }

  return {
    ...claim,
    estimateAmount: estimateAmount ?? claim.estimateAmount ?? null,
    invoicedAmount: invoicedAmount ?? claim.invoicedAmount ?? null,
    paymentAmount: paymentAmount ?? claim.paymentAmount ?? null,
    expectedScope:
      scopeNames.length > 0 ? [...new Set([...(claim.expectedScope ?? []), ...scopeNames])] : claim.expectedScope,
    evidenceSummary: [...new Set(evidence)],
  };
}

/**
 * Deterministic supplement/revenue-recovery analyzer. Compares available
 * evidence against the estimate, documented scope, line items and carrier
 * response, then surfaces POTENTIAL opportunities — every finding carries
 * evidence, a confidence and an honest limitation.
 */
export function buildClaimFindings(claim: ClaimSnapshot): ClaimFindingDraft[] {
  const facts: ClaimFacts = {
    expectedScope: claim.expectedScope as string[] | undefined,
    actualScope: claim.actualScope as string[] | undefined,
    evidenceSummary: claim.evidenceSummary as string[] | undefined,
    estimateAmount: claim.estimateAmount ?? undefined,
    estimateLineItemCount: claim.estimateLineItemCount ?? undefined,
    carrierResponse: undefined,
    paymentAmount: claim.paymentAmount ?? undefined,
    invoicedAmount: claim.invoicedAmount ?? undefined,
  };

  const opportunities = analyzeRecoveryOpportunities(facts);
  const drafts: ClaimFindingDraft[] = opportunities.map((o) => {
    const category = OPPORTUNITY_CATEGORY[o.type] ?? o.type;
    let estimatedAmount: number | undefined;
    if (o.type === "potential_underpayment" && typeof claim.estimateAmount === "number" && typeof claim.paymentAmount === "number") {
      estimatedAmount = Math.max(0, claim.estimateAmount - claim.paymentAmount);
    }
    if (o.type === "billing_reconciliation" && typeof claim.invoicedAmount === "number" && typeof claim.paymentAmount === "number") {
      estimatedAmount = Math.max(0, claim.invoicedAmount - claim.paymentAmount);
    }
    return {
      findingKey: `claim:${claim._id ?? "?"}:${o.type}`,
      category,
      title: o.title,
      description: o.explanation,
      evidence: o.evidence,
      source: o.type,
      confidence: o.confidence,
      estimatedAmount,
      limitation: o.limitation,
      recommendedNextStep: o.recommendedNextStep,
    };
  });

  // Line-item level check: scope items documented but not priced into the estimate.
  const scopeItems = (claim.scopeItems ?? []).filter(Boolean) as Array<{ name?: string; inEstimate?: boolean }>;
  const unpriced = scopeItems.filter((i) => i.inEstimate === false);
  if (unpriced.length > 0) {
    const names = unpriced.map((i) => i.name ?? "an item").join(", ");
    drafts.push({
      findingKey: `claim:${claim._id ?? "?"}:overlooked_line_item`,
      category: "overlooked_line_item",
      title: "Potential overlooked line item",
      description: `Scope items are documented but not priced into the current estimate: ${names}.`,
      evidence: [`Documented scope not in estimate: ${names}`],
      source: "scope_items",
      confidence: 0.55,
      limitation: "The item may be legitimately covered elsewhere in the estimate — this flags verification, not error.",
      recommendedNextStep: "Compare each unpriced scope item against the estimate line by line before drafting a supplement.",
    });
  }

  return drafts.sort((a, b) => b.confidence - a.confidence);
}

export interface ClaimReconciliation {
  estimate?: number;
  invoiced?: number;
  paid: number;
  requested: number;
  approved: number;
  denied: number;
  outstanding: number;
  notes: string[];
  hasDiscrepancy: boolean;
}

/** Estimate vs supplements vs approved vs payment vs expected recovery. */
export function reconcileClaim(
  claim: ClaimSnapshot,
  supplements: Array<{
    amount?: number | null;
    approvedAmount?: number | null;
    deniedAmount?: number | null;
    status?: string | null;
  }>,
): ClaimReconciliation {
  const notes: string[] = [];
  const paid = claim.paymentAmount ?? 0;
  const requested = supplements.reduce((s, x) => s + (x.amount ?? 0), 0);
  const approved = supplements.reduce((s, x) => s + (x.approvedAmount ?? 0), 0);
  const denied = supplements.reduce((s, x) => s + (x.deniedAmount ?? 0), 0);

  const baseline = approved > 0 ? approved : (claim.estimateAmount ?? 0);
  const outstanding = Math.max(0, baseline - paid);

  if (typeof claim.estimateAmount === "number" && requested > 0) {
    notes.push(`The supplement requested $${requested.toLocaleString()}.`);
  }
  if (approved > 0) {
    notes.push(`The carrier approved $${approved.toLocaleString()}${denied > 0 ? ` and denied $${denied.toLocaleString()}` : ""}.`);
  }
  if (paid > 0 && baseline > 0) {
    notes.push(`Payment received is $${paid.toLocaleString()}.`);
  }
  if (outstanding > 0) {
    notes.push(`$${outstanding.toLocaleString()} remains potentially outstanding.`);
  }
  // Estimate vs invoice mismatch (Phase 12 — reconciliation intelligence).
  if (
    typeof claim.estimateAmount === "number" &&
    typeof claim.invoicedAmount === "number" &&
    Math.abs(claim.estimateAmount - claim.invoicedAmount) > 0.01
  ) {
    notes.push(
      `The estimate ($${claim.estimateAmount.toLocaleString()}) and invoiced amount ($${claim.invoicedAmount.toLocaleString()}) differ — review the billing line items.`,
    );
  }
  // Billed vs paid gap (Phase 12).
  if (
    typeof claim.invoicedAmount === "number" &&
    paid > 0 &&
    claim.invoicedAmount - paid > 0.01
  ) {
    notes.push(
      `$${(claim.invoicedAmount - paid).toLocaleString()} of the invoiced total remains unpaid.`,
    );
  }
  const hasDiscrepancy =
    outstanding > 0 ||
    (approved > 0 && denied > 0 && approved + denied !== requested) ||
    notes.some((n) => /differ|remains unpaid/i.test(n));
  if (hasDiscrepancy && notes.length === 0) {
    notes.push("Recorded amounts do not fully reconcile to a zero balance.");
  }
  return {
    estimate: claim.estimateAmount ?? undefined,
    invoiced: claim.invoicedAmount ?? undefined,
    paid,
    requested,
    approved,
    denied,
    outstanding,
    notes,
    hasDiscrepancy,
  };
}

// ---------------------------------------------------------------------------
// Phase 14 — Revenue Recovery Command Center analytics (pure, unit tested)
// ---------------------------------------------------------------------------
// Every number here is derived from actual claim records. Trends are bucketed
// by real timestamps; carrier and status views aggregate the same figures the
// claims table shows — nothing is simulated or projected.

export interface RecoveryTrendPoint {
  /** "YYYY-MM" bucket key. */
  month: string;
  /** Human label, e.g. "Aug 25". */
  label: string;
  claimsCreated: number;
  findingsOpened: number;
  supplementsSubmitted: number;
}

export function monthKey(ts?: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return `${new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short" })} ${String(y).slice(2)}`;
}

/**
 * Last `months` calendar months (zero-filled) of recovery activity:
 *  claimsCreated      — claims whose createdAt falls in the bucket
 *  findingsOpened     — claimFindings whose createdAt falls in the bucket
 *  supplementsSubmitted — supplements with a submissionDate in the bucket
 * Payments are intentionally absent: there is no payment history table, so a
 * per-month payment series could not be honest. Submitted supplements use the
 * submission date, not last-update, so the series stays evidence-grounded.
 */
export function buildRecoveryTrend(
  claims: Array<{ createdAt?: number | null }>,
  findings: Array<{ createdAt?: number | null }>,
  supplements: Array<{ submissionDate?: number | null }>,
  months = 12,
): RecoveryTrendPoint[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys.map((key) => ({
    month: key,
    label: monthLabel(key),
    claimsCreated: claims.filter((c) => monthKey(c.createdAt) === key).length,
    findingsOpened: findings.filter((f) => monthKey(f.createdAt) === key).length,
    supplementsSubmitted: supplements.filter(
      (s) => typeof s.submissionDate === "number" && monthKey(s.submissionDate) === key,
    ).length,
  }));
}

export interface CarrierRecoveryBreakdown {
  carrier: string;
  claimCount: number;
  outstanding: number;
  potential: number;
}

/**
 * Outstanding + potential recovery grouped by carrier. Outstanding uses the
 * same reconcileClaim definition as the claims table (approved/estimate minus
 * payments); potential is the sum of open findings' estimated amounts. Claims
 * without a carrier are grouped under "Unknown carrier" rather than dropped.
 */
export function buildCarrierBreakdown(
  claims: Array<{
    _id?: unknown;
    carrier?: string | null;
    paymentAmount?: number | null;
    estimateAmount?: number | null;
    invoicedAmount?: number | null;
    approvedAmount?: number | null;
  }>,
  supplements: Array<{
    claimId: unknown;
    amount?: number | null;
    approvedAmount?: number | null;
    deniedAmount?: number | null;
    status?: string | null;
  }>,
  findings: Array<{
    claimId: unknown;
    status?: string | null;
    estimatedAmount?: number | null;
  }>,
): CarrierRecoveryBreakdown[] {
  const byClaim = new Map<
    string,
    {
      claim: (typeof claims)[number];
      carrier: string;
      supplements: typeof supplements;
      findings: typeof findings;
    }
  >();
  for (const c of claims) {
    const id = String(c._id);
    byClaim.set(id, {
      claim: c,
      carrier: c.carrier?.trim() ? c.carrier : "Unknown carrier",
      supplements: [],
      findings: [],
    });
  }
  for (const s of supplements) {
    const bucket = byClaim.get(String(s.claimId));
    if (bucket) bucket.supplements.push(s);
  }
  for (const f of findings) {
    const bucket = byClaim.get(String(f.claimId));
    if (bucket) bucket.findings.push(f);
  }

  const perCarrier = new Map<string, CarrierRecoveryBreakdown>();
  for (const bucket of byClaim.values()) {
    // The SAME reconcile definition as the claims table: pass the actual
    // claim record (not the bucket wrapper) so estimate/payment/approval
    // fields are honored.
    const rec = reconcileClaim(bucket.claim as never, bucket.supplements);
    const potential = bucket.findings
      .filter((f) => f.status === "open")
      .reduce((sum, f) => sum + (f.estimatedAmount ?? 0), 0);
    const current = perCarrier.get(bucket.carrier) ?? {
      carrier: bucket.carrier,
      claimCount: 0,
      outstanding: 0,
      potential: 0,
    };
    current.claimCount += 1;
    current.outstanding += rec.outstanding;
    current.potential += potential;
    perCarrier.set(bucket.carrier, current);
  }
  return [...perCarrier.values()]
    .sort((a, b) => b.outstanding + b.potential - (a.outstanding + a.potential))
    .slice(0, 8);
}

export interface RecoveryStatusDistribution {
  status: string;
  label: string;
  count: number;
}

/** Claim lifecycle distribution — counts per status, highest first. */
export function buildStatusDistribution(
  claims: Array<{ status?: string | null }>,
): RecoveryStatusDistribution[] {
  const counts = new Map<string, number>();
  for (const c of claims) {
    const status = c.status ?? "opened";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({
      status,
      label: STATUS_LABELS[status] ?? status.replace(/_/g, " "),
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Phase 12 — Claim package, timeline & supplement document builders (pure)
// ---------------------------------------------------------------------------

export type PackageFieldState =
  | "verified"
  | "derived"
  | "inferred"
  | "missing"
  | "conflicting";

export interface PackageField {
  key: string;
  label: string;
  value?: string | number | null;
  state: PackageFieldState;
  note: string;
}

export interface ClaimPackageModel {
  fields: PackageField[];
  states: Record<PackageFieldState, number>;
}

/**
 * Canonical claim package. Every material field is labeled:
 *  verified  — directly supported by source evidence / user entry
 *  derived   — calculated from verified information
 *  inferred  — reasonable interpretation that requires review
 *  missing   — not available
 *  conflicting — recorded sources disagree
 * Atlas never presents an inferred or missing value as fact.
 */
export function buildClaimPackage(
  claim: ClaimSnapshot,
  supplements: Array<{ amount?: number | null; approvedAmount?: number | null }> = [],
): ClaimPackageModel {
  const fields: PackageField[] = [];
  const num = (n?: number | null) =>
    typeof n === "number" ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : undefined;
  const date = (n?: number | null) =>
    typeof n === "number" ? new Date(n).toLocaleDateString() : undefined;
  const push = (key: string, label: string, value: string | number | undefined, state: PackageFieldState, note: string) =>
    fields.push({ key, label, value, state, note });

  push("claimNumber", "Claim number", claim.claimNumber ?? undefined, claim.claimNumber ? "verified" : "missing", claim.claimNumber ? "From claim records." : "No claim number recorded.");
  push("insured", "Insured / customer", claim.customer ?? undefined, claim.customer ? "verified" : "missing", claim.customer ? "From claim records." : "No insured recorded.");
  push("property", "Property", claim.property ?? undefined, claim.property ? "verified" : "missing", claim.property ? "From claim records." : "No property recorded.");
  push("carrier", "Carrier", claim.carrier ?? undefined, claim.carrier ? "verified" : "missing", claim.carrier ? "From claim records." : "No carrier recorded.");
  push("policy", "Policy", claim.policy ?? undefined, claim.policy ? "verified" : "missing", claim.policy ? "From claim records." : "No policy recorded.");
  push("adjuster", "Adjuster", claim.adjuster ?? undefined, claim.adjuster ? "verified" : "missing", claim.adjuster ? "From claim records." : "No adjuster recorded.");
  push("dateOfLoss", "Date of loss", date(claim.dateOfLoss), typeof claim.dateOfLoss === "number" ? "verified" : "missing", typeof claim.dateOfLoss === "number" ? "From claim records." : "No date of loss recorded.");
  push("causeOfLoss", "Cause of loss", claim.causeOfLoss ?? undefined, claim.causeOfLoss ? "verified" : "missing", claim.causeOfLoss ? "From claim records." : "No cause of loss recorded.");
  push("estimate", "Estimate", num(claim.estimateAmount), typeof claim.estimateAmount === "number" ? "verified" : "missing", typeof claim.estimateAmount === "number" ? "From the priced estimate." : "No estimate ingested yet.");
  push("approved", "Approved by carrier", num(claim.approvedAmount), typeof claim.approvedAmount === "number" ? "verified" : "missing", typeof claim.approvedAmount === "number" ? "Carrier-approved total on record." : "No carrier approval amount recorded.");
  push("invoiced", "Invoiced", num(claim.invoicedAmount), typeof claim.invoicedAmount === "number" ? "verified" : "missing", typeof claim.invoicedAmount === "number" ? "From invoice records." : "No invoice recorded.");
  push("paid", "Payment received", num(claim.paymentAmount), typeof claim.paymentAmount === "number" ? "verified" : "missing", typeof claim.paymentAmount === "number" ? "From recorded payments." : "No payment recorded.");
  push("collected", "Collected", num(claim.collectedAmount), typeof claim.collectedAmount === "number" ? "verified" : "missing", typeof claim.collectedAmount === "number" ? "Cash collected on record." : "Not separately recorded.");
  push("deductible", "Deductible", num(claim.deductible), typeof claim.deductible === "number" ? "verified" : "missing", typeof claim.deductible === "number" ? "From policy context." : "Deductible not recorded — varies by policy.");
  push("policyLimits", "Policy limits", num(claim.policyLimits), typeof claim.policyLimits === "number" ? "verified" : "missing", typeof claim.policyLimits === "number" ? "From policy context." : "Policy limits not recorded.");

  // Derived: outstanding balance = approved baseline − payments.
  const approvedBaseline = supplements.reduce((s, x) => s + (x.approvedAmount ?? 0), 0);
  const baseline = approvedBaseline > 0 ? approvedBaseline : (claim.approvedAmount ?? claim.estimateAmount ?? 0);
  const outstanding =
    typeof claim.openBalance === "number"
      ? claim.openBalance
      : Math.max(0, baseline - (claim.paymentAmount ?? 0));
  push(
    "outstanding",
    "Open balance",
    num(outstanding),
    typeof claim.openBalance === "number" ? "verified" : "derived",
    typeof claim.openBalance === "number"
      ? "Recorded on the claim."
      : "Computed as approved/estimate baseline minus payments — verify against the carrier statement.",
  );

  // Conflicting: estimate vs invoice disagree.
  if (
    typeof claim.estimateAmount === "number" &&
    typeof claim.invoicedAmount === "number" &&
    Math.abs(claim.estimateAmount - claim.invoicedAmount) > 0.01
  ) {
    push(
      "estimateVsInvoice",
      "Estimate vs invoice",
      undefined,
      "conflicting",
      `Estimate ${num(claim.estimateAmount)} differs from invoiced ${num(claim.invoicedAmount)} — sources disagree; review before billing.`,
    );
  }

  const states: Record<PackageFieldState, number> = {
    verified: 0,
    derived: 0,
    inferred: 0,
    missing: 0,
    conflicting: 0,
  };
  for (const f of fields) states[f.state] += 1;
  return { fields, states };
}

export interface ClaimTimelineEvent {
  ts: number;
  kind:
    | "claim_created"
    | "claim_updated"
    | "document"
    | "analysis"
    | "finding"
    | "supplement_drafted"
    | "supplement_submitted"
    | "supplement_response"
    | "payment"
    | "note";
  label: string;
  detail?: string;
  /** source = happened outside Atlas; atlas = Atlas-generated event. */
  source: "source" | "atlas";
}

export interface TimelineSupplementInput {
  _id?: string;
  reason?: string | null;
  status?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  submissionDate?: number | null;
  approvedAmount?: number | null;
  deniedAmount?: number | null;
}

export interface TimelineFindingInput {
  _id?: string;
  title?: string | null;
  status?: string | null;
  createdAt?: number | null;
  estimatedAmount?: number | null;
}

/**
 * Chronological, evidence-grounded claim timeline composed from actual
 * records: persisted source events, claims, findings, supplements and
 * payments. Atlas-generated events are explicitly labeled vs source events.
 */
export function buildClaimTimeline(
  claim: ClaimSnapshot,
  supplements: TimelineSupplementInput[] = [],
  findings: TimelineFindingInput[] = [],
): ClaimTimelineEvent[] {
  const events: ClaimTimelineEvent[] = [];
  if (typeof claim.createdAt === "number") {
    events.push({
      ts: claim.createdAt,
      kind: "claim_created",
      label: "Claim created",
      detail: claim.provenance ?? undefined,
      source: "atlas",
    });
  }
  // Persisted source/workspace events recorded on the claim.
  for (const raw of claim.timeline ?? []) {
    const t = raw as Record<string, unknown>;
    if (typeof t.ts !== "number") continue;
    events.push({
      ts: t.ts as number,
      kind: (t.kind as ClaimTimelineEvent["kind"]) ?? "note",
      label: String(t.label ?? "Event"),
      detail: typeof t.detail === "string" ? t.detail : undefined,
      source: t.source === "source" ? "source" : "atlas",
    });
  }
  for (const f of findings) {
    if (typeof f.createdAt !== "number") continue;
    events.push({
      ts: f.createdAt,
      kind: "finding",
      label: `Finding: ${f.title ?? "analysis item"}`,
      detail:
        typeof f.estimatedAmount === "number"
          ? `Potential amount $${f.estimatedAmount.toLocaleString()} — not guaranteed.`
          : undefined,
      source: "atlas",
    });
  }
  for (const s of supplements) {
    if (typeof s.createdAt === "number") {
      events.push({
        ts: s.createdAt,
        kind: "supplement_drafted",
        label: `Supplement drafted: ${s.reason ?? "no reason recorded"}`,
        detail: "Draft requires human review before submission.",
        source: "atlas",
      });
    }
    if (typeof s.submissionDate === "number") {
      events.push({
        ts: s.submissionDate,
        kind: "supplement_submitted",
        label: "Supplement marked for submission",
        detail: s.status ?? undefined,
        source: "source",
      });
    }
    if (
      typeof s.updatedAt === "number" &&
      (s.approvedAmount != null || s.deniedAmount != null) &&
      ["approved", "partially_approved", "denied"].includes(s.status ?? "")
    ) {
      const parts: string[] = [];
      if (s.approvedAmount != null) parts.push(`approved $${s.approvedAmount.toLocaleString()}`);
      if (s.deniedAmount != null) parts.push(`denied $${s.deniedAmount.toLocaleString()}`);
      events.push({
        ts: s.updatedAt,
        kind: "supplement_response",
        label: "Carrier response recorded",
        detail: parts.join(" · ") || undefined,
        source: "source",
      });
    }
  }
  if (typeof claim.paymentAmount === "number" && claim.paymentAmount > 0 && typeof claim.updatedAt === "number") {
    events.push({
      ts: claim.updatedAt,
      kind: "payment",
      label: `Payment recorded: $${claim.paymentAmount.toLocaleString()}`,
      detail: "Total recorded payments on the claim.",
      source: "source",
    });
  }
  // Dedupe (same ts + label) and sort chronologically.
  const seen = new Set<string>();
  return events
    .filter((e) => {
      const key = `${e.ts}:${e.kind}:${e.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}

export interface SupplementDocument {
  claimNumber: string | null;
  customer: string | null;
  property: string | null;
  carrier: string | null;
  reason: string;
  status: string;
  requestedAmount?: number;
  sections: Array<{ title: string; body: string[] }>;
  preparedAt: number;
  disclaimer: string;
}

/**
 * Structured supplement document. Never invents policy language or carrier
 * requirements — missing information is stated as missing and the document
 * always requires human review before submission.
 *
 * Every list-valued field (evidence, requestedItems, affectedLineItems,
 * scope lists) is passed through the canonical evidence decoder before it is
 * joined, so a legacy supplement row whose jsonb value is a string, a JSON
 * array-literal string, an object or missing can never crash `.join()` —
 * values are coerced, never dropped and never fabricated.
 */
export function buildSupplementDocument(
  claim: ClaimSnapshot,
  supplement: {
    reason?: string | null;
    amount?: number | null;
    affectedLineItems?: string[] | null;
    requestedItems?: string[] | null;
    evidence?: string[] | null;
    justification?: string | null;
    status?: string | null;
    createdAt?: number | null;
  },
): SupplementDocument {
  const sec = (title: string, body: string[]): { title: string; body: string[] } => ({ title, body });
  const money = (n?: number | null) =>
    typeof n === "number" ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : undefined;
  const evidence = normalizeEvidence(supplement.evidence);
  const requestedItems = normalizeEvidence(supplement.requestedItems);
  const affectedLineItems = normalizeEvidence(supplement.affectedLineItems);
  const expectedScope = normalizeEvidence(claim.expectedScope);
  const actualScope = normalizeEvidence(claim.actualScope);
  const sections: Array<{ title: string; body: string[] }> = [];

  sections.push(
    sec("Claim information", [
      `Claim number: ${claim.claimNumber ?? "—"}`,
      `Insured: ${claim.customer ?? "—"}`,
      `Property: ${claim.property ?? "—"}`,
      `Carrier: ${claim.carrier ?? "—"}`,
      `Date of loss: ${typeof claim.dateOfLoss === "number" ? new Date(claim.dateOfLoss).toLocaleDateString() : "—"}`,
      `Adjuster: ${claim.adjuster ?? "—"}`,
    ]),
  );
  sections.push(
    sec("Reason for supplement", [
      supplement.reason ?? "Reason not recorded — requires review before submission.",
    ]),
  );
  sections.push(
    sec("Original scope", [
      expectedScope.length > 0
        ? expectedScope.join("; ")
        : "Original scope not documented in Atlas.",
    ]),
  );
  sections.push(
    sec("Revised scope / items requested", [
      requestedItems.length > 0
        ? requestedItems.join("; ")
        : actualScope.length > 0
          ? `Performed scope observed: ${actualScope.join("; ")}`
          : "Revised scope not documented — requires review.",
    ]),
  );
  sections.push(
    sec("Supporting evidence", [
      evidence.length > 0
        ? evidence.join("; ")
        : "No supporting evidence attached yet — add dated photos, logs and documentation.",
    ]),
  );
  sections.push(
    sec("Affected line items", [
      affectedLineItems.length > 0
        ? affectedLineItems.join("; ")
        : "Line items not itemized — requires review against the estimate.",
    ]),
  );
  sections.push(
    sec("Justification", [
      supplement.justification ?? "No justification recorded — requires human review.",
    ]),
  );
  sections.push(
    sec("Requested amount", [
      typeof supplement.amount === "number"
        ? `${money(supplement.amount)} — calculated only where the evidence supports it; verify before submission.`
        : "Not calculated — the evidence does not yet support a defensible amount.",
    ]),
  );
  sections.push(
    sec("Limitations", [
      "This document is an Atlas draft assembled from available records. It does not constitute policy language or carrier requirements.",
      "Coverage, depreciation, deductible and jurisdiction-specific rules are NOT asserted here — they must be confirmed against the actual policy and carrier before submission.",
    ]),
  );
  sections.push(
    sec("Reviewer notes", [
      "Required before submission: confirm scope accuracy, attach proof of work, verify amounts, and obtain required approvals.",
    ]),
  );

  return {
    claimNumber: claim.claimNumber ?? null,
    customer: claim.customer ?? null,
    property: claim.property ?? null,
    carrier: claim.carrier ?? null,
    reason: supplement.reason ?? "Reason not recorded",
    status: supplement.status ?? "draft",
    requestedAmount: supplement.amount ?? undefined,
    sections,
    preparedAt: supplement.createdAt ?? Date.now(),
    disclaimer:
      "Atlas-generated draft for human review — not insurer policy, not a submission.",
  };
}

// ---------------------------------------------------------------------------
// Convex — queries
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Boundary normalization for the deployed RPC surfaces.
//
// The production RPCs return RAW jsonb rows (insurance_get_claim_package
// returns { claim, supplements, findings, evidenceDocs }; recovery analytics
// returns { claims, findings, supplements }). The pages consume DERIVED
// shapes (completeness, package model, timeline, reconciliation, trend,
// carriers, pipeline). These pure helpers enrich the raw response at the
// data boundary so a page can never crash on a missing/nested/null field,
// and so the derived numbers always come from the same deterministic rules
// the rest of the app uses.
// ---------------------------------------------------------------------------

/** Convert a raw insuranceClaims jsonb row into the analyzer snapshot. */
export function toClaimSnapshot(claim: Record<string, unknown>): ClaimSnapshot {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.map((x) => String(x ?? "")) : null;
  return {
    _id: claim._id != null ? String(claim._id) : undefined,
    claimNumber: typeof claim.claimNumber === "string" ? claim.claimNumber : null,
    dateOfLoss: num(claim.dateOfLoss),
    property: typeof claim.property === "string" ? claim.property : null,
    causeOfLoss: typeof claim.causeOfLoss === "string" ? claim.causeOfLoss : null,
    lossDescription: typeof claim.lossDescription === "string" ? claim.lossDescription : null,
    customer: typeof claim.customer === "string" ? claim.customer : null,
    carrier: typeof claim.carrier === "string" ? claim.carrier : null,
    policy: typeof claim.policy === "string" ? claim.policy : null,
    adjuster: typeof claim.adjuster === "string" ? claim.adjuster : null,
    status: typeof claim.status === "string" ? claim.status : null,
    estimateAmount: num(claim.estimateAmount),
    estimateLineItemCount: num(claim.estimateLineItemCount),
    invoicedAmount: num(claim.invoicedAmount),
    paymentAmount: num(claim.paymentAmount),
    approvedAmount: num(claim.approvedAmount),
    collectedAmount: num(claim.collectedAmount),
    openBalance: num(claim.openBalance),
    deductible: num(claim.deductible),
    policyLimits: num(claim.policyLimits),
    scopeItems: Array.isArray(claim.scopeItems)
      ? (claim.scopeItems as ClaimSnapshot["scopeItems"])
      : null,
    expectedScope: strings(claim.expectedScope),
    actualScope: strings(claim.actualScope),
    evidenceSummary: strings(claim.evidenceSummary),
    evidenceDocumentIds: Array.isArray(claim.evidenceDocumentIds)
      ? claim.evidenceDocumentIds
      : null,
    provenance: typeof claim.provenance === "string" ? claim.provenance : null,
    confidence: typeof claim.confidence === "number" ? claim.confidence : undefined,
    createdAt:
      num(claim.createdAt) ??
      (typeof claim._creationTime === "number" ? claim._creationTime : null),
    updatedAt: num(claim.updatedAt),
  };
}

/**
 * Enrich the raw insurance_get_claim_package RPC result into the full claim
 * package the Claim Package page renders. Returns null when there is no
 * claim row (the page shows an honest "not found" state). Arrays are coerced
 * to [] and the derived sections are always present, so the page never
 * crashes on a missing/nested/null field.
 */
export function normalizeClaimPackageResponse(
  raw: unknown,
): {
  claim: Record<string, unknown>;
  supplements: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  evidenceDocs: Array<Record<string, unknown>>;
  completeness: ClaimCompleteness;
  packageModel: ClaimPackageModel;
  timeline: ClaimTimelineEvent[];
  reconciliation: ClaimReconciliation;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const pkg = raw as Record<string, unknown>;
  const claim =
    pkg.claim && typeof pkg.claim === "object"
      ? (pkg.claim as Record<string, unknown>)
      : null;
  if (!claim) return null;
  const supplements = Array.isArray(pkg.supplements)
    ? (pkg.supplements as Array<Record<string, unknown>>)
    : [];
  const findings = normalizeEvidenceRows(pkg.findings);
  const evidenceDocs = Array.isArray(pkg.evidenceDocs)
    ? (pkg.evidenceDocs as Array<Record<string, unknown>>)
    : [];
  const snapshot = toClaimSnapshot(claim);
  return {
    claim,
    supplements,
    findings,
    evidenceDocs,
    completeness: analyzeClaimCompleteness(snapshot),
    packageModel: buildClaimPackage(snapshot, supplements),
    timeline: buildClaimTimeline(snapshot, supplements, findings),
    reconciliation: reconcileClaim(snapshot, supplements),
  };
}

// ---------------------------------------------------------------------------
// Claim list contract (insurance_list_claims)
// ---------------------------------------------------------------------------
// The deployed RPC returns one row per claim as a WRAPPER:
//   { claim: {…full claim row…}, findings: […], supplements: […] }
// The Claims table / Dashboard read the fields directly off the row
// (c._id, c.customer, c.completeness, …), so the raw wrapper made every
// field undefined — rows rendered as “Unnamed claim” and clicks navigated to
// `/dashboard/revenue-recovery/undefined`, which Claim Detail rejected with
// “Claim not found”. This normalizer unwraps each row at the API boundary
// and derives the aggregate fields the pages consume from the same
// deterministic builders the rest of the app uses. Nothing is fabricated:
// null/malformed responses → []; rows without a claim object are skipped.

/** Terminal claim statuses — a terminal claim is never “stalled”. */
const TERMINAL_CLAIM_STATUSES = new Set([
  "closed",
  "approved",
  "work_completed",
  "billing",
  "denied",
  "cancelled",
]);

/**
 * Normalize an insurance_list_claims response into the flat claim rows the
 * Claims table and Dashboard render. Always returns an array; the persisted
 * claim `_id` is preserved verbatim (never undefined), so list rows and the
 * detail route resolve the SAME claim.
 */
// ---------------------------------------------------------------------------
// Supplement document contract (insurance_get_supplement_document)
// ---------------------------------------------------------------------------
// The deployed RPC returns the RAW claim + supplement rows:
//   { claim: {…}, supplement: {…} }
// The dialog renders the DERIVED document (status, requestedAmount,
// disclaimer, sections). This normalizer builds that document at the data
// boundary from the raw rows through the same deterministic builder the
// workflows use, so the page can never crash on a missing `sections` field
// (the production defect: `Cannot read properties of undefined (reading
// 'map')` on ClaimDetail's supplement document dialog) and so legacy
// supplement rows (string evidence, malformed jsonb lists) render as honest
// text instead of crashing. Nothing is fabricated: a missing/empty payload
// yields null and the dialog shows its loading state.

export interface SupplementDocumentResponse {
  status?: string;
  requestedAmount?: number;
  disclaimer: string;
  sections: Array<{ title: string; body: string[] }>;
}

/**
 * Normalize an insurance_get_supplement_document RPC result into the derived
 * supplement document the dialog renders. Accepts the deployed
 * `{ claim, supplement }` wrapper AND already-flat supplement rows.
 */
export function normalizeSupplementDocumentResponse(
  raw: unknown,
): SupplementDocumentResponse | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const claim =
    r.claim && typeof r.claim === "object" && !Array.isArray(r.claim)
      ? (r.claim as Record<string, unknown>)
      : r;
  const supplement =
    r.supplement && typeof r.supplement === "object" && !Array.isArray(r.supplement)
      ? (r.supplement as Record<string, unknown>)
      : r;
  if (Object.keys(r).length === 0) return null;
  const snapshot = toClaimSnapshot(claim);
  const doc = buildSupplementDocument(snapshot, {
    reason: typeof supplement.reason === "string" ? supplement.reason : null,
    amount:
      typeof supplement.amount === "number"
        ? supplement.amount
        : typeof supplement.requestedAmount === "number"
          ? supplement.requestedAmount
          : null,
    affectedLineItems: supplement.affectedLineItems as string[] | null | undefined,
    requestedItems: supplement.requestedItems as string[] | null | undefined,
    evidence: supplement.evidence as string[] | null | undefined,
    justification:
      typeof supplement.justification === "string" ? supplement.justification : null,
    status: typeof supplement.status === "string" ? supplement.status : "draft",
    createdAt:
      typeof supplement.createdAt === "number"
        ? supplement.createdAt
        : typeof supplement._creationTime === "number"
          ? supplement._creationTime
          : null,
  });
  return {
    status: doc.status,
    requestedAmount: doc.requestedAmount,
    disclaimer: doc.disclaimer,
    sections: doc.sections,
  };
}

export function normalizeClaimListResponse(
  raw: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const wrapper = row as Record<string, unknown>;
    const claim =
      wrapper.claim && typeof wrapper.claim === "object" && !Array.isArray(wrapper.claim)
        ? (wrapper.claim as Record<string, unknown>)
        : wrapper; // already-flat rows pass through
    if (!claim._id) continue;
    const findings = normalizeEvidenceRows(wrapper.findings);
    const supplements = Array.isArray(wrapper.supplements)
      ? (wrapper.supplements as Array<Record<string, unknown>>)
      : [];
    const snapshot = toClaimSnapshot(claim);
    const completeness = analyzeClaimCompleteness(snapshot);
    const reconciliation = reconcileClaim(snapshot, supplements);
    const openFindings = findings.filter((f) => f?.status === "open").length;
    const draftSupplements = supplements.filter((s) => s?.status === "draft").length;
    const readySupplements = supplements.filter(
      (s) => s?.status === "ready_for_submission",
    ).length;
    const lastActivity = snapshot.updatedAt ?? snapshot.createdAt;
    const stalled =
      !TERMINAL_CLAIM_STATUSES.has(snapshot.status ?? "") &&
      typeof lastActivity === "number" &&
      Date.now() - lastActivity > 30 * 86_400_000;
    const needsAttention =
      openFindings > 0 ||
      readySupplements > 0 ||
      reconciliation.outstanding > 0 ||
      completeness.complete < completeness.total;
    const hasDiscrepancy =
      reconciliation.hasDiscrepancy ||
      completeness.categories.some((c) => c.status === "conflicted");
    out.push({
      ...claim,
      _id: claim._id,
      findings,
      supplements,
      completeness: completeness.complete,
      completenessTotal: completeness.total,
      openFindings,
      draftSupplements,
      readySupplements,
      outstanding: reconciliation.outstanding,
      hasDiscrepancy,
      needsAttention,
      stalled,
      isDemo: Boolean(claim.isDemo),
    });
  }
  return out;
}

/**
 * Deterministically match a claim candidate's evidence references (file paths
 * / document titles) against the tenant's real document rows. Returns unique
 * document ids; no matches → []. Matching is exact on normalized basenames,
 * with a conservative contains-fallback for longer names — never fuzzy.
 */
export function matchCandidateEvidenceDocs(
  candidate: Record<string, unknown>,
  docs: Array<Record<string, unknown>>,
): string[] {
  const norm = (s: unknown): string =>
    String(s ?? "").trim().replace(/\\/g, "/").toLowerCase();
  const basename = (s: string): string => {
    const b = s.split("/").pop() ?? s;
    return b.replace(/^\d{4}-\d{2}-\d{2}[_\- ]*/, "");
  };
  const refs: string[] = [];
  for (const v of [
    ...normalizeEvidence(candidate.filePaths),
    ...normalizeEvidence(candidate.evidence),
    ...normalizeEvidence(candidate.documentTitles),
  ]) {
    const n = norm(basename(String(v ?? "")));
    if (n && !refs.includes(n)) refs.push(n);
  }
  if (refs.length === 0) return [];
  const out: string[] = [];
  for (const doc of docs) {
    if (!doc?._id) continue;
    const id = String(doc._id);
    if (out.includes(id)) continue;
    const title = norm(basename(String(doc.title ?? "")));
    const source = norm(basename(String(doc.sourceId ?? "")));
    if (!title && !source) continue;
    const matched = refs.some((r) => {
      if (title && (r === title || title === r)) return true;
      if (source && (r === source || source === r)) return true;
      // Conservative contains-fallback for names ≥ 8 chars (e.g. a path
      // fragment vs a title) — never matches short, ambiguous strings.
      if (r.length >= 8 && title.length >= 8 && (r.includes(title) || title.includes(r))) {
        return true;
      }
      return false;
    });
    if (matched) out.push(id);
  }
  return out;
}

/** Derived recovery-analytics shape the Revenue Recovery page renders. */
export interface RecoveryAnalyticsResponse {
  recoveryPipeline: string[];
  trend: RecoveryTrendPoint[];
  carriers: CarrierRecoveryBreakdown[];
  statusDistribution: RecoveryStatusDistribution[];
}

/**
 * Build the analytics contract from the raw insurance_recovery_analytics RPC
 * result ({ claims, findings, supplements }). All numbers come from the same
 * deterministic builders the rest of the app uses; a null/malformed backend
 * response yields an honest zero-state, never a crash.
 */
export function buildRecoveryAnalytics(
  raw: unknown,
): RecoveryAnalyticsResponse {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const claims = Array.isArray(r.claims)
    ? (r.claims as Array<Record<string, unknown>>)
    : [];
  const findings = Array.isArray(r.findings)
    ? (r.findings as Array<Record<string, unknown>>)
    : [];
  const supplements = Array.isArray(r.supplements)
    ? (r.supplements as Array<Record<string, unknown>>)
    : [];
  return {
    recoveryPipeline: [...RECOVERY_PIPELINE],
    trend: buildRecoveryTrend(claims, findings, supplements),
    carriers: buildCarrierBreakdown(
      claims,
      supplements as Array<{
        claimId: unknown;
        amount?: number | null;
        approvedAmount?: number | null;
        deniedAmount?: number | null;
        status?: string | null;
      }>,
      findings as Array<{
        claimId: unknown;
        status?: string | null;
        estimatedAmount?: number | null;
      }>,
    ),
    statusDistribution: buildStatusDistribution(claims),
  };
}

/** Default zero-state for insurance_claim_counts (never null). */
export function defaultClaimCounts(): Record<string, unknown> {
  return {
    activeClaims: 0,
    openClaims: 0,
    attentionClaims: 0,
    openFindings: 0,
    drafts: 0,
    readyForSubmission: 0,
    submitted: 0,
    approvedAmount: 0,
    deniedAmount: 0,
    requestedAmount: 0,
    paidAmount: 0,
    outstanding: 0,
    potential: 0,
    recoveryPipeline: [...RECOVERY_PIPELINE],
  };
}
