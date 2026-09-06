// ---------------------------------------------------------------------------
// Knowledge-gap normalization — application boundary for persisted JSONB.
//
// The governance audit table stores `knowledge_gaps JSONB NOT NULL DEFAULT '[]'`.
// Postgres guarantees the DEFAULT is an array, but:
//   - legacy/seed rows can carry a non-array JSONB value ({}
//     scalar, or stale writes from before the array invariant was enforced), and
//   - the Supabase RPC layer can return the raw JSONB value as-is.
//
// The runtime contract is: every consumer of governance decision rows receives
// a canonical `KnowledgeGapRow[]`. This module is the single place that converts
// the unknown DB value into that array, so the UI (AtlasReviewPanel,
// WorkQueue, etc.) never calls `.map/.filter/.length` on a non-array.
//
// Why a dedicated type instead of reusing the in-memory `KnowledgeGap`:
//   - persisted rows store the compact gap *reference* shape that the
//     orchestrator serializes (`description`, `severity`, `impact?`,
//     `requiresHumanReview?`) — see GovernanceGapRef and buildGovernanceRecord.
//   - the full `KnowledgeGap` carries workflow-facing fields (id, canContinueSafely,
//     triggeredBy) that are not persisted in the audit table. We keep the two
//     shapes distinct so nothing is silently invented.
// ---------------------------------------------------------------------------

import type { KnowledgeGap } from "./types";

// ---------------------------------------------------------------------------
// Canonical persisted-gap shape
// ---------------------------------------------------------------------------

/** Shape of a knowledge-gap reference as persisted in the governance audit table. */
export interface KnowledgeGapRow {
  description: string;
  severity: string;
  impact?: string;
  requiresHumanReview?: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const INVALID_LOG_THRESHOLD =
  typeof process !== "undefined" && (process as { env?: Record<string, unknown> }).env?.["NODE_ENV"] === "development";

/**
 * Convert an unknown DB value into a canonical `KnowledgeGapRow[]`.
 *
 * Semantics (mirrors the registry pattern used elsewhere in Atlas):
 *   - valid array of gap objects → normalized array (string fields coerced)
 *   - JSON string containing an array → parsed + normalized
 *   - null / undefined / missing → []
 *   - unexpected object / primitive / malformed JSON → [] with a one-time dev
 *     diagnostic so a bad persisted row is discoverable rather than silently
 *     hidden.
 *
 * This never throws: a malformed historical governance row must never crash the
 * Atlas Review Panel or the Work Queue.
 */
export function normalizeKnowledgeGaps(value: unknown): KnowledgeGapRow[] {
  if (value == null) return [];

  // Already an array of gap references?
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(normalizeGap);
  }

  // JSON string that may contain an array?
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      logInvalid("knowledge_gaps JSON string failed to parse", value);
      return [];
    }
    return normalizeKnowledgeGaps(parsed);
  }

  // Unexpected shape (object, primitive, etc.).
  logInvalid("knowledge_gaps is not an array or JSON-string array", String(value));
  return [];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function normalizeGap(item: Record<string, unknown>): KnowledgeGapRow {
  return {
    description: String(item.description ?? item.title ?? item.label ?? "Unspecified knowledge gap"),
    severity: String(item.severity ?? item.level ?? "unknown"),
    impact: typeof item.impact === "string" ? item.impact : undefined,
    requiresHumanReview:
      item.requiresHumanReview === true
        ? true
        : item.requiresHumanReview === false
          ? false
          : undefined,
  };
}

function logInvalid(label: string, value: string): void {
  if (!INVALID_LOG_THRESHOLD) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[atlas-governance] malformed knowledge_gaps — ${label}: ${value.slice(0, 300)}`,
  );
}

// ---------------------------------------------------------------------------
// Row-level normalization (governance decision rows)
// ---------------------------------------------------------------------------

/**
 * Guaranteed-array view of a persisted `GovernanceDecisionRow`.
 *
 * This is the shape the UI should consume. It preserves the original DB field
 * names for provenance but ensures every JSONB array field is actually an array
 * at runtime — including `knowledge_gaps`, `applicable_rules`,
 * `applicable_standards`, and `evidence_references`.
 */
export interface NormalizedGovernanceDecisionRow {
  id: string;
  tenant_id: string;
  claim_id: string | null;
  entity_type: string;
  entity_id: string;
  action_type: string;
  decision: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK" | "UNKNOWN";
  risk_level: string;
  jurisdiction: string | null;
  actor_role: string;
  evaluated_at: string;
  knowledge_reference_date: string | null;
  loss_date: string | null;
  policy_period_start: string | null;
  policy_period_end: string | null;
  /** Always an array. */
  applicableRules: Array<Record<string, unknown>>;
  /** Always an array. */
  applicableStandards: Array<Record<string, unknown>>;
  requiredApprovals: string[];
  /** Always an array — the field that crashed at runtime. */
  knowledgeGaps: KnowledgeGapRow[];
  evidenceReferences: Array<Record<string, unknown>>;
  decision_rationale: string;
  governance_engine: string;
  knowledge_corpus_version: string;
  orchestration_id: string | null;
  action_id: string | null;
  dedup_key: string;
  execution_status:
    | "not_executed"
    | "executed"
    | "awaiting_approval"
    | "approved"
    | "rejected"
    | "blocked"
    | "escalated"
    | "superseded"
    | "awaiting_external";
  approval_status: "not_required" | "required" | "approved" | "rejected";
  approved_by: string | null;
  approved_at: string | null;
  approved_notes: string | null;
  override_decision: string | null;
  override_reason: string | null;
  override_by: string | null;
  overridden_at: string | null;
  created_at: string;
  updated_at: string;
}

/* *
 * Normalize a raw governance decision row from the DB/RPC into a row whose
 * JSONB array fields are guaranteed to be arrays.
 *
 * The input may be a typed `GovernanceDecisionRow` from the persistence module
 * or any unknown/malformed object; the output is always a fully normalized row.
 */
export function normalizeGovernanceDecisionRow(
  row: unknown,
): NormalizedGovernanceDecisionRow {
  // One safe boundary cast: after this we read only string/number/array fields
  // through a compatible index signature, and every JSONB array field is run
  // through a normalizer that tolerates non-array input.
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    tenant_id: String(r.tenant_id ?? ""),
    claim_id: r.claim_id == null ? null : String(r.claim_id),
    entity_type: String(r.entity_type ?? ""),
    entity_id: String(r.entity_id ?? ""),
    action_type: String(r.action_type ?? ""),
    decision: decisionFromString(r.decision),
    risk_level: String(r.risk_level ?? "none"),
    jurisdiction: r.jurisdiction == null ? null : String(r.jurisdiction),
    actor_role: String(r.actor_role ?? "atlas"),
    evaluated_at: String(r.evaluated_at ?? ""),
    knowledge_reference_date:
      r.knowledge_reference_date == null ? null : String(r.knowledge_reference_date),
    loss_date: r.loss_date == null ? null : String(r.loss_date),
    policy_period_start:
      r.policy_period_start == null ? null : String(r.policy_period_start),
    policy_period_end:
      r.policy_period_end == null ? null : String(r.policy_period_end),
    applicableRules: normalizeArrayOfRecords(r.applicable_rules),
    applicableStandards: normalizeArrayOfRecords(r.applicable_standards),
    requiredApprovals: normalizeStringArray(r.required_approvals),
    knowledgeGaps: normalizeKnowledgeGaps(r.knowledge_gaps),
    evidenceReferences: normalizeArrayOfRecords(r.evidence_references),
    decision_rationale: String(r.decision_rationale ?? ""),
    governance_engine: String(r.governance_engine ?? "atlas-governance-engine-1"),
    knowledge_corpus_version: String(r.knowledge_corpus_version ?? "1.0.0"),
    orchestration_id:
      r.orchestration_id == null ? null : String(r.orchestration_id),
    action_id: r.action_id == null ? null : String(r.action_id),
    dedup_key: String(r.dedup_key ?? ""),
    execution_status: executionStatusFromString(r.execution_status),
    approval_status: approvalStatusFromString(r.approval_status),
    approved_by: r.approved_by == null ? null : String(r.approved_by),
    approved_at: r.approved_at == null ? null : String(r.approved_at),
    approved_notes: r.approved_notes == null ? null : String(r.approved_notes),
    override_decision:
      r.override_decision == null ? null : String(r.override_decision),
    override_reason:
      r.override_reason == null ? null : String(r.override_reason),
    override_by: r.override_by == null ? null : String(r.override_by),
    overridden_at: r.overridden_at == null ? null : String(r.overridden_at),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

/**
 * Re-export the canonical full-shape type for consumers that need it (e.g.
 * workflow-facing gap displays). Imported from the existing governance types
 * so there is a single source of truth for the richer model.
 */
export type { KnowledgeGap };

// ---------------------------------------------------------------------------
// Small helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

function decisionFromString(v: unknown): NormalizedGovernanceDecisionRow["decision"] {
  if (v === "ALLOW" || v === "REVIEW_REQUIRED" || v === "BLOCK" || v === "UNKNOWN") {
    return v;
  }
  return "UNKNOWN";
}

function executionStatusFromString(v: unknown): NormalizedGovernanceDecisionRow["execution_status"] {
  const map: Record<string, NormalizedGovernanceDecisionRow["execution_status"]> = {
    not_executed: "not_executed",
    executed: "executed",
    awaiting_approval: "awaiting_approval",
    approved: "approved",
    rejected: "rejected",
    blocked: "blocked",
    escalated: "escalated",
    superseded: "superseded",
    awaiting_external: "awaiting_external",
  };
  return map[String(v)] ?? "not_executed";
}

function approvalStatusFromString(v: unknown): NormalizedGovernanceDecisionRow["approval_status"] {
  const map: Record<string, NormalizedGovernanceDecisionRow["approval_status"]> = {
    not_required: "not_required",
    required: "required",
    approved: "approved",
    rejected: "rejected",
  };
  return map[String(v)] ?? "not_required";
}

function normalizeArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) as Array<Record<string, unknown>>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return normalizeArrayOfRecords(parsed);
    } catch {
      logInvalid("JSONB array field failed to parse (applicable_rules / standards / evidence_references)", String(value));
      return [];
    }
  }
  logInvalid("JSONB array field is not an array", String(value));
  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return normalizeStringArray(parsed);
    } catch {
      logInvalid("text[] field failed to parse (citations / required_approvals)", String(value));
      return [];
    }
  }
  return [];
}
