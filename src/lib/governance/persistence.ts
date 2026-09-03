// ---------------------------------------------------------------------------
// Atlas Governance Persistence Service
//
// The ONLY bridge between governance decisions and Supabase. The governance
// engine reasons; this service stores. UI components and the orchestrator
// never write governance rows directly — everything flows through RPCs.
//
//   Atlas Workforce
//        ↓
//   Governance Engine
//        ↓
//   Governance Persistence Service   ← this module
//        ↓
//   Supabase (governance_decisions + governance_events, migration 20260904)
//
// Tenant isolation is enforced inside the SECURITY DEFINER RPCs: every call
// resolves the caller's tenant from their membership and refuses to touch any
// other tenant (super_admin excepted). The service is best-effort by design —
// a persistence failure is reported on the outcome and never crashes the
// orchestrator, but it is never silently swallowed (the failure is recorded).
// ---------------------------------------------------------------------------

import { getSupabaseClient } from "@/lib/supabase";
import { rpcCall } from "@/lib/actions/rpc";
import type { GovernanceSummary } from "../orchestrator/types";

// ---------------------------------------------------------------------------
// Engine / corpus provenance constants
// ---------------------------------------------------------------------------

export const GOVERNANCE_ENGINE_VERSION = "atlas-governance-engine-1";
export const KNOWLEDGE_CORPUS_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured input for a governance decision row (matches the RPC params). */
export interface GovernanceRecordInput {
  claimId?: string;
  entityType: string;
  entityId: string;
  actionType: string;
  decision: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK" | "UNKNOWN";
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  jurisdiction?: string;
  actorRole: string;
  /** Epoch ms of the knowledge reference (evaluation) date. */
  knowledgeReferenceDate: number;
  lossDate?: number;
  policyPeriodStart?: number;
  policyPeriodEnd?: number;
  applicableRules: Array<Record<string, unknown>>;
  applicableStandards: Array<Record<string, unknown>>;
  requiredApprovals: string[];
  knowledgeGaps: Array<Record<string, unknown>>;
  citations: string[];
  evidenceReferences: Array<Record<string, unknown>>;
  rationale: string;
  governanceEngine: string;
  knowledgeCorpusVersion: string;
  orchestrationId?: string;
  actionId?: string;
  dedupKey: string;
}

/** Persistence attempt outcome. */
export interface PersistOutcome {
  persisted: boolean;
  decisionId?: string;
  error?: string;
}

/** Row shape returned by the governance_* RPCs (snake_case as stored). */
export interface GovernanceDecisionRow {
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
  applicable_rules: Array<Record<string, unknown>>;
  applicable_standards: Array<Record<string, unknown>>;
  required_approvals: string[];
  knowledge_gaps: Array<Record<string, unknown>>;
  citations: string[];
  evidence_references: Array<Record<string, unknown>>;
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

export interface GovernanceEventRow {
  id: string;
  tenant_id: string;
  decision_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (unit-testable, no I/O)
// ---------------------------------------------------------------------------

/**
 * Deterministic dedup key for an evaluated action. Re-evaluating the same
 * action+entity produces the same key, which the persistence layer uses to
 * supersede prior actionable rows instead of creating duplicate work items.
 */
export function buildDedupKey(
  actionType: string,
  entityType: string,
  entityId: string,
): string {
  return `${actionType}|${entityType}|${entityId}`;
}

/** Build a persistence record from a governance summary (pure). */
export function buildGovernanceRecord(
  summary: GovernanceSummary,
  opts: {
    claimId?: string;
    entityType: string;
    entityId: string;
    orchestrationId?: string;
    actionId?: string;
    lossDate?: number;
    policyPeriodStart?: number;
    policyPeriodEnd?: number;
  },
): GovernanceRecordInput {
  return {
    claimId: opts.claimId,
    entityType: opts.entityType,
    entityId: opts.entityId,
    actionType: summary.actionType,
    decision: summary.decision,
    riskLevel: summary.riskLevel,
    jurisdiction: summary.jurisdiction,
    actorRole: "atlas",
    knowledgeReferenceDate: summary.knowledgeReferenceDate,
    lossDate: opts.lossDate,
    policyPeriodStart: opts.policyPeriodStart,
    policyPeriodEnd: opts.policyPeriodEnd,
    applicableRules: summary.applicableRules.map((r) => ({ ...r })),
    applicableStandards: summary.applicableStandards.map((s) => ({ ...s })),
    requiredApprovals: [...summary.requiredApprovals],
    knowledgeGaps: summary.knowledgeGaps.map((g) => ({ ...g })),
    citations: [...summary.citations],
    evidenceReferences: summary.requiredEvidence.map((e) => ({ ref: e })),
    rationale: summary.reason,
    governanceEngine: GOVERNANCE_ENGINE_VERSION,
    knowledgeCorpusVersion: KNOWLEDGE_CORPUS_VERSION,
    orchestrationId: opts.orchestrationId,
    actionId: opts.actionId,
    dedupKey: buildDedupKey(summary.actionType, opts.entityType, opts.entityId),
  };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/** The Supabase client, but only when an authenticated session exists.
 *  Governance records are tenant-scoped; without a session there is nothing
 *  to persist to and the RPC would fail anyway. */
async function getAuthedClient() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session ? supabase : null;
  } catch {
    // Non-browser environments without session storage: treat as unauthenticated.
    return null;
  }
}

function epochToIso(value?: number): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

/**
 * Persist a governance decision. Best-effort: returns { persisted: false }
 * with the reason when Supabase is unavailable or the RPC fails — callers must
 * record the failure, never pretend persistence happened.
 */
export async function persistGovernanceDecision(
  record: GovernanceRecordInput,
): Promise<PersistOutcome> {
  const supabase = await getAuthedClient();
  if (!supabase) {
    return { persisted: false, error: "no_authenticated_session" };
  }

  try {
    const id = await rpcCall(supabase, "governance_record_decision", {
      claimId: record.claimId ?? null,
      entityType: record.entityType,
      entityId: record.entityId,
      actionType: record.actionType,
      decision: record.decision,
      riskLevel: record.riskLevel,
      jurisdiction: record.jurisdiction ?? null,
      actorRole: record.actorRole,
      knowledgeReferenceDate: epochToIso(record.knowledgeReferenceDate),
      lossDate: epochToIso(record.lossDate),
      policyPeriodStart: epochToIso(record.policyPeriodStart),
      policyPeriodEnd: epochToIso(record.policyPeriodEnd),
      applicableRules: JSON.stringify(record.applicableRules),
      applicableStandards: JSON.stringify(record.applicableStandards),
      requiredApprovals: record.requiredApprovals,
      knowledgeGaps: JSON.stringify(record.knowledgeGaps),
      citations: record.citations,
      evidenceReferences: JSON.stringify(record.evidenceReferences),
      decisionRationale: record.rationale,
      governanceEngine: record.governanceEngine,
      knowledgeCorpusVersion: record.knowledgeCorpusVersion,
      orchestrationId: record.orchestrationId ?? null,
      actionId: record.actionId ?? null,
      dedupKey: record.dedupKey,
    });
    return { persisted: true, decisionId: String(id) };
  } catch (err) {
    return {
      persisted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fetch one decision by id (tenant-scoped server-side). */
export async function getGovernanceDecision(
  decisionId: string,
): Promise<GovernanceDecisionRow | null> {
  const supabase = await getAuthedClient();
  if (!supabase) return null;
  try {
    const rows = (await rpcCall(supabase, "governance_get_decision", {
      decisionId,
    })) as GovernanceDecisionRow[] | null;
    return rows && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/** List governance decisions for a claim / action / entity (tenant-scoped). */
export async function listGovernanceDecisions(opts: {
  claimId?: string;
  actionType?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<GovernanceDecisionRow[]> {
  const supabase = await getAuthedClient();
  if (!supabase) return [];
  try {
    const rows = (await rpcCall(supabase, "governance_list_decisions", {
      claimId: opts.claimId ?? null,
      actionType: opts.actionType ?? null,
      entityType: opts.entityType ?? null,
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
    })) as GovernanceDecisionRow[] | null;
    return rows ?? [];
  } catch {
    return [];
  }
}

/** Latest decision for a claim/action (tenant-scoped). */
export async function getLatestGovernanceDecision(opts: {
  claimId?: string;
  actionType?: string;
} = {}): Promise<GovernanceDecisionRow | null> {
  const supabase = await getAuthedClient();
  if (!supabase) return null;
  try {
    const rows = (await rpcCall(supabase, "governance_latest_decision", {
      claimId: opts.claimId ?? null,
      actionType: opts.actionType ?? null,
    })) as GovernanceDecisionRow[] | null;
    return rows && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * List actionable governance work — decisions that still need a human:
 * REVIEW_REQUIRED awaiting approval, BLOCK or UNKNOWN awaiting escalation or
 * an authorized override. Feeds the governance-aware work queue.
 */
export async function listActionableGovernance(
  limit = 50,
): Promise<GovernanceDecisionRow[]> {
  const supabase = await getAuthedClient();
  if (!supabase) return [];
  try {
    const rows = (await rpcCall(supabase, "governance_list_actionable", {
      limit,
    })) as GovernanceDecisionRow[] | null;
    return rows ?? [];
  } catch {
    return [];
  }
}

/** List the immutable audit events for a decision (tenant-scoped). */
export async function listGovernanceEvents(
  decisionId: string,
): Promise<GovernanceEventRow[]> {
  const supabase = await getAuthedClient();
  if (!supabase) return [];
  try {
    const rows = (await rpcCall(supabase, "governance_list_events", {
      decisionId,
    })) as GovernanceEventRow[] | null;
    return rows ?? [];
  } catch {
    return [];
  }
}

/**
 * Human decision on an actionable governance record.
 *
 * - 'approved': approves a REVIEW_REQUIRED decision.
 * - 'rejected': rejects it.
 * - 'escalated': escalates it.
 * - overrideDecision: required (with super_admin/atlas_admin role) to unblock
 *   a BLOCK or UNKNOWN decision; the override is recorded alongside the
 *   original decision — history is never mutated.
 */
export async function decideGovernanceDecision(
  decisionId: string,
  decision: "approved" | "rejected" | "escalated",
  notes?: string,
  overrideDecision?: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK" | "UNKNOWN",
): Promise<{ ok: boolean; error?: string; row?: GovernanceDecisionRow }> {
  const supabase = await getAuthedClient();
  if (!supabase) return { ok: false, error: "no_authenticated_session" };
  try {
    const row = (await rpcCall(supabase, "governance_decide", {
      decisionId,
      decision,
      notes: notes ?? null,
      overrideDecision: overrideDecision ?? null,
    })) as GovernanceDecisionRow;
    return { ok: true, row };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}