// ---------------------------------------------------------------------------
// Atlas Workforce — Worker Catalog
//
// One Atlas workforce, six capability domains (matching the orchestrator's
// CapabilityDomain type). Each worker is a JOB FUNCTION over the same
// underlying entities — a claim can be worked by several workers at once.
// Worker pages are compositions of existing services, never new CRUD logic.
// ---------------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import {
  ClipboardCheck,
  FileSearch,
  Handshake,
  Radar,
  Scale,
  TrendingUp,
} from "lucide-react";
import type { CapabilityDomain } from "@/lib/orchestrator/types";
import type { WorkCategory } from "@/lib/work-queue/service";

export interface WorkerDefinition {
  /** URL slug used in /dashboard/workers/<slug>. */
  slug: string;
  /** Route for this worker's page. */
  route: string;
  /** Short display name. */
  name: string;
  /** Full job title. */
  role: string;
  /** One-line product statement. */
  tagline: string;
  /** Paragraph shown at the top of the worker page. */
  description: string;
  /** Orchestrator capability domain this worker owns. */
  domain: CapabilityDomain;
  /** Icon used across nav, hub and page header. */
  icon: LucideIcon;
  /** Tailwind accent classes (border/bg/text ring). */
  accent: string;
  /** What this worker actively does for the company. */
  responsibilities: string[];
  /** Work-queue categories this worker owns in its attention queue. */
  attentionCategories: WorkCategory[];
  /** Backend services this worker composes (for the audit trail). */
  services: string[];
}

export const WORKERS: WorkerDefinition[] = [
  {
    slug: "claims",
    route: "/dashboard/workers/claims",
    name: "Claims Manager",
    role: "Insurance Claims Manager",
    tagline: "Every claim reconstructed, complete, and moving.",
    description:
      "Atlas keeps the claims book in order: it reconstructs claims from ingested evidence, tracks completeness, flags missing information, and surfaces claims that need attention or are at risk.",
    domain: "claims_management",
    icon: Radar,
    accent: "border-teal-400/30 bg-teal-400/10 text-teal-600 dark:text-teal-300",
    responsibilities: [
      "Reconstruct claims from ingested documents",
      "Track claim completeness and missing evidence",
      "Flag new, incomplete, at-risk and stalled claims",
      "Attach documents and evidence to the right claim",
    ],
    attentionCategories: ["missing_evidence", "claim_review", "stale_claim"],
    services: [
      "insurance_list_claims",
      "insurance_get_claim_package",
      "insurance_list_claim_candidates",
      "work-queue service (buildWorkQueue)",
    ],
  },
  {
    slug: "supplements",
    route: "/dashboard/workers/supplements",
    name: "Supplement Specialist",
    role: "Supplement Specialist",
    tagline: "Finding the money the carrier's estimate left out.",
    description:
      "Atlas analyzes each claim against its evidence, detects discrepancies and omissions, runs gap analysis, prepares supplement documentation, and routes it through governance for human review before anything is submitted.",
    domain: "supplement_specialist",
    icon: FileSearch,
    accent: "border-violet-400/30 bg-violet-400/10 text-violet-600 dark:text-violet-300",
    responsibilities: [
      "Detect supplement opportunities from claim findings",
      "Compare scope against evidence and estimates",
      "Prepare supplement documentation for review",
      "Route prepared supplements through governance approval",
    ],
    attentionCategories: ["supplement_opportunity", "financial_discrepancy"],
    services: [
      "insurance_list_claims",
      "insurance_upsert_findings (analysis)",
      "orchestrator prepareSupplement (governance-gated)",
      "governance persistence (supplement_preparation)",
    ],
  },
  {
    slug: "recovery",
    route: "/dashboard/workers/recovery",
    name: "Revenue Recovery",
    role: "Revenue Recovery Coordinator",
    tagline: "Where is the company leaving recoverable revenue on the table?",
    description:
      "Atlas tracks the full recovery lifecycle — potential recovery, outstanding balances, stalled claims, carrier response, and follow-up requirements — so no recoverable dollar goes quiet.",
    domain: "revenue_recovery",
    icon: TrendingUp,
    accent: "border-emerald-400/30 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300",
    responsibilities: [
      "Quantify potential recovery per claim",
      "Track outstanding balances and financial discrepancies",
      "Surface stalled claims and overdue carrier responses",
      "Schedule follow-ups and keep the recovery pipeline moving",
    ],
    attentionCategories: [
      "financial_discrepancy",
      "follow_up_needed",
      "carrier_response_overdue",
      "stale_claim",
    ],
    services: [
      "insurance_list_claims",
      "insurance_recovery_analytics",
      "insurance_claim_counts",
      "work-queue service",
      "follow-up scheduler",
    ],
  },
  {
    slug: "projects",
    route: "/dashboard/workers/projects",
    name: "Project Manager",
    role: "Project Manager",
    tagline: "What needs to happen next to keep every project moving?",
    description:
      "Atlas monitors operational execution across the book: milestones, deadlines, overdue items, blockers, and the next action every claim needs to stay on track.",
    domain: "project_management",
    icon: ClipboardCheck,
    accent: "border-sky-400/30 bg-sky-400/10 text-sky-600 dark:text-sky-300",
    responsibilities: [
      "Track claim deadlines (statute, policy period, follow-up)",
      "Surface overdue items and blockers",
      "Identify the next action per project",
      "Watch workflow instances and pending approvals",
    ],
    attentionCategories: ["deadline_approaching", "stale_claim", "follow_up_needed"],
    services: [
      "deadline tracker (trackDeadlines)",
      "insurance_list_claims",
      "workflows_list_instances",
      "workflows_list_approvals",
    ],
  },
  {
    slug: "estimator",
    route: "/dashboard/workers/estimator",
    name: "Estimator",
    role: "Estimator / Estimating Specialist",
    tagline: "Scope review and line-item intelligence, ready for Xactimate.",
    description:
      "Atlas analyzes scope, reconstructs it from evidence, identifies omissions, and prepares review-ready estimate line items. It does NOT modify Xactimate — a human estimator reviews and enters the work.",
    domain: "estimating",
    icon: Scale,
    accent: "border-amber-400/30 bg-amber-400/10 text-amber-600 dark:text-amber-300",
    responsibilities: [
      "Reconstruct scope from evidence",
      "Identify estimate omissions and discrepancies",
      "Recommend line items with quantities and support",
      "Prepare an estimator review package (human enters into Xactimate)",
    ],
    attentionCategories: ["financial_discrepancy", "missing_evidence"],
    services: [
      "orchestrator estimator (generateEstimateLineItems)",
      "insurance_list_claims",
      "insurance_get_claim_package",
    ],
  },
  {
    slug: "customers",
    route: "/dashboard/workers/customers",
    name: "Customer Success",
    role: "Customer Success Manager",
    tagline: "Customers informed, never left wondering.",
    description:
      "Atlas watches the customer experience across every claim: who needs an update, what communication is overdue, and which drafted messages need human approval before they can be sent.",
    domain: "customer_success",
    icon: Handshake,
    accent: "border-rose-400/30 bg-rose-400/10 text-rose-600 dark:text-rose-300",
    responsibilities: [
      "Surface customers overdue for an update",
      "Draft customer status communications (governance-gated)",
      "Track customer-impacting milestones and issues",
      "Keep a communication history per claim",
    ],
    attentionCategories: ["follow_up_needed", "deadline_approaching", "document_request"],
    services: [
      "orchestrator draftCommunication (governance-gated)",
      "follow-up scheduler",
      "deadline tracker",
      "insurance_list_claims",
    ],
  },
];

export const WORKERS_BY_SLUG: Record<string, WorkerDefinition> = Object.fromEntries(
  WORKERS.map((w) => [w.slug, w]),
);