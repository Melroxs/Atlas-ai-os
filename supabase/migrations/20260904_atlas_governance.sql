-- ==========================================================================
-- Migration 20260904: Atlas Governance Persistence
--
-- Durable, tenant-isolated, auditable record of every governance decision the
-- Atlas Workforce Orchestrator produces for a material action.
--
-- Model:
--   Entity (claim / communication / supplement / financial)
--     ↓
--   Action (action_type)
--     ↓
--   Governance Evaluation (governance_decisions row)
--     ↓
--   Decision (ALLOW / REVIEW_REQUIRED / BLOCK / UNKNOWN)
--     ↓
--   Evidence / Knowledge Sources (applicable_rules, applicable_standards,
--                                 citations, evidence_references, knowledge_gaps)
--     ↓
--   Approval / Execution (approval_status, execution_status, override_*)
--     ↓
--   Audit Record (governance_events — immutable event log)
--
-- Critical invariant: UNKNOWN != ALLOW. UNKNOWN decisions are persisted with
-- execution_status = 'blocked' and require an authorized override before any
-- downstream execution may proceed. History is append-only — the original
-- decision is never mutated away; overrides are recorded as separate fields.
--
-- RLS follows the existing platform conventions (see 0021_atlas_human_reviews):
--   - service_role: full access (workers)
--   - authenticated: tenant-scoped read/insert/update via memberships
--   - super_admin: full access
-- Every mutating RPC is SECURITY DEFINER and re-verifies the caller's tenant
-- inside the function body — a client can never read or write a decision for
-- an organization it does not belong to.
--
-- NOTE ON RPC PARAMETERS: PostgREST resolves arguments against the folded
-- schema cache (unquoted identifiers lowercased). Params are declared in
-- camelCase (e.g. p_claimId → p_claimid) and the client sends camelCase keys
-- through normalizeRpcArgs() — the exact convention used across the app.
-- ==========================================================================

-- ==========================================================================
-- 1. governance_decisions — evaluation history + execution/approval state
-- ==========================================================================
CREATE TABLE IF NOT EXISTS governance_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,

  claim_id      TEXT,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  action_type   TEXT NOT NULL,

  -- The decision
  decision      TEXT NOT NULL CHECK (decision IN ('ALLOW','REVIEW_REQUIRED','BLOCK','UNKNOWN')),
  risk_level    TEXT NOT NULL DEFAULT 'none'
                CHECK (risk_level IN ('none','low','medium','high','critical')),
  jurisdiction  TEXT,
  actor_role    TEXT NOT NULL DEFAULT 'atlas',

  -- Temporal context — loss date vs rule effective date vs evaluation date.
  -- knowledge_reference_date is the date used to filter rule validity; it is
  -- the evaluation date, never the loss date (see governance/authority.ts).
  evaluated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  knowledge_reference_date TIMESTAMPTZ,
  loss_date                TIMESTAMPTZ,
  policy_period_start      TIMESTAMPTZ,
  policy_period_end        TIMESTAMPTZ,

  -- Knowledge / evidence provenance (structured — never free-text only)
  applicable_rules     JSONB NOT NULL DEFAULT '[]',
  applicable_standards JSONB NOT NULL DEFAULT '[]',
  required_approvals   TEXT[] NOT NULL DEFAULT '{}',
  knowledge_gaps       JSONB NOT NULL DEFAULT '[]',
  citations            TEXT[] NOT NULL DEFAULT '{}',
  evidence_references  JSONB NOT NULL DEFAULT '[]',
  decision_rationale   TEXT NOT NULL DEFAULT '',

  -- Engine provenance
  governance_engine        TEXT NOT NULL DEFAULT 'atlas-governance-engine-1',
  knowledge_corpus_version TEXT NOT NULL DEFAULT '1.0.0',

  -- Action linkage
  orchestration_id TEXT,
  action_id        TEXT,

  -- Deterministic dedup key: re-evaluating the same action supersedes the
  -- prior actionable row instead of creating duplicate work items.
  dedup_key TEXT NOT NULL,

  -- Execution / approval state machine
  execution_status TEXT NOT NULL DEFAULT 'not_executed'
                   CHECK (execution_status IN (
                     'not_executed','executed','awaiting_approval','approved',
                     'rejected','blocked','escalated','superseded','awaiting_external'
                   )),
  approval_status  TEXT NOT NULL DEFAULT 'not_required'
                   CHECK (approval_status IN ('not_required','required','approved','rejected')),
  approved_by   UUID REFERENCES auth.users(id),
  approved_at   TIMESTAMPTZ,
  approved_notes TEXT,

  -- Override — authorized human override of BLOCK/UNKNOWN. The original
  -- decision is preserved; the override is recorded alongside it.
  override_decision TEXT CHECK (override_decision IN ('ALLOW','REVIEW_REQUIRED','BLOCK','UNKNOWN')),
  override_reason   TEXT,
  override_by       UUID REFERENCES auth.users(id),
  overridden_at     TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_gd_tenant_claim
  ON governance_decisions (tenant_id, claim_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gd_tenant_action
  ON governance_decisions (tenant_id, action_type, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gd_actionable
  ON governance_decisions (tenant_id, evaluated_at DESC)
  WHERE approval_status = 'required' AND execution_status IN ('awaiting_approval','blocked');
CREATE INDEX IF NOT EXISTS idx_gd_dedup
  ON governance_decisions (tenant_id, dedup_key, evaluated_at DESC);

-- ==========================================================================
-- 3. governance_events — immutable audit log for governance
-- ==========================================================================
CREATE TABLE IF NOT EXISTS governance_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  decision_id UUID REFERENCES governance_decisions(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN (
    'governance.evaluated','governance.allowed','governance.review_required',
    'governance.blocked','governance.unknown','governance.approved',
    'governance.rejected','governance.escalated','governance.overridden',
    'governance.superseded'
  )),
  payload     JSONB NOT NULL DEFAULT '{}',
  actor       TEXT NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ge_decision
  ON governance_events (decision_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ge_tenant
  ON governance_events (tenant_id, created_at DESC);

-- ==========================================================================
-- 4. RLS policies
-- ==========================================================================
ALTER TABLE governance_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_events ENABLE ROW LEVEL SECURITY;

-- Service role (workers) can do everything
CREATE POLICY "service_role_all_governance_decisions"
  ON governance_decisions FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_governance_events"
  ON governance_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated users read their own tenant's decisions
CREATE POLICY "tenant_read_governance_decisions"
  ON governance_decisions FOR SELECT TO authenticated
  USING (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid() LIMIT 1
    )
  );
CREATE POLICY "tenant_read_governance_events"
  ON governance_events FOR SELECT TO authenticated
  USING (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid() LIMIT 1
    )
  );

-- Direct inserts are restricted to RPCs (SECURITY DEFINER). A client inserting
-- through the REST API must still only target its own tenant.
CREATE POLICY "tenant_insert_governance_decisions"
  ON governance_decisions FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid() LIMIT 1
    )
  );

-- Super Admin can access all governance records
CREATE POLICY "super_admin_all_governance_decisions"
  ON governance_decisions FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid() AND m.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid() AND m.role = 'super_admin'
    )
  );
CREATE POLICY "super_admin_all_governance_events"
  ON governance_events FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid() AND m.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid() AND m.role = 'super_admin'
    )
  );

-- ==========================================================================
-- 5. Tenant resolver — every governance RPC verifies the caller belongs to
--    the tenant it is touching. Super admins may pass another tenant id.
-- ==========================================================================
CREATE OR REPLACE FUNCTION governance_resolve_tenant(p_tenantId UUID DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
  v_tenant UUID;
  v_is_super_admin BOOLEAN;
BEGIN
  SELECT t._id INTO v_tenant
  FROM tenants t
  JOIN memberships m ON m."tenantId" = t._id
  WHERE m."userId" = auth.uid()
  LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'caller is not a member of any workspace';
  END IF;

  IF p_tenantId IS NOT NULL AND p_tenantId <> v_tenant THEN
    SELECT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid() AND m.role = 'super_admin'
    ) INTO v_is_super_admin;

    IF NOT v_is_super_admin THEN
      RAISE EXCEPTION 'not authorized for tenant %', p_tenantId;
    END IF;

    RETURN p_tenantId;
  END IF;

  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ==========================================================================
-- 6. RPC: record a governance decision (idempotent for actionable work)
-- ==========================================================================
CREATE OR REPLACE FUNCTION governance_record_decision(
  p_claimId TEXT DEFAULT NULL,
  p_entityType TEXT DEFAULT 'claim',
  p_entityId TEXT DEFAULT '',
  p_actionType TEXT DEFAULT '',
  p_decision TEXT DEFAULT 'UNKNOWN',
  p_riskLevel TEXT DEFAULT 'none',
  p_jurisdiction TEXT DEFAULT NULL,
  p_actorRole TEXT DEFAULT 'atlas',
  p_knowledgeReferenceDate TIMESTAMPTZ DEFAULT NULL,
  p_lossDate TIMESTAMPTZ DEFAULT NULL,
  p_policyPeriodStart TIMESTAMPTZ DEFAULT NULL,
  p_policyPeriodEnd TIMESTAMPTZ DEFAULT NULL,
  p_applicableRules JSONB DEFAULT '[]',
  p_applicableStandards JSONB DEFAULT '[]',
  p_requiredApprovals TEXT[] DEFAULT '{}',
  p_knowledgeGaps JSONB DEFAULT '[]',
  p_citations TEXT[] DEFAULT '{}',
  p_evidenceReferences JSONB DEFAULT '[]',
  p_decisionRationale TEXT DEFAULT '',
  p_governanceEngine TEXT DEFAULT 'atlas-governance-engine-1',
  p_knowledgeCorpusVersion TEXT DEFAULT '1.0.0',
  p_orchestrationId TEXT DEFAULT NULL,
  p_actionId TEXT DEFAULT NULL,
  p_dedupKey TEXT DEFAULT NULL,
  p_tenantId UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_tenant UUID;
  v_id UUID;
  v_dedup TEXT;
  v_execution TEXT;
  v_approval TEXT;
  v_event TEXT;
BEGIN
  v_tenant := governance_resolve_tenant(p_tenantId);
  v_dedup := COALESCE(
    NULLIF(p_dedupKey, ''),
    p_actionType || '|' || p_entityType || '|' || COALESCE(p_entityId, '')
  );

  -- Decision → execution/approval state mapping.
  -- UNKNOWN maps to blocked: UNKNOWN != ALLOW, always.
  IF p_decision = 'ALLOW' THEN
    v_execution := 'not_executed'; v_approval := 'not_required'; v_event := 'governance.allowed';
  ELSIF p_decision = 'REVIEW_REQUIRED' THEN
    v_execution := 'awaiting_approval'; v_approval := 'required'; v_event := 'governance.review_required';
  ELSIF p_decision = 'BLOCK' THEN
    v_execution := 'blocked'; v_approval := 'required'; v_event := 'governance.blocked';
  ELSE
    v_execution := 'blocked'; v_approval := 'required'; v_event := 'governance.unknown';
  END IF;

  -- Deterministic dedup: re-evaluating the same action supersedes the prior
  -- actionable row (work item) instead of creating a duplicate. History is
  -- preserved — the superseded row is never deleted.
  UPDATE governance_decisions
  SET execution_status = 'superseded', updated_at = now()
  WHERE tenant_id = v_tenant
    AND dedup_key = v_dedup
    AND approval_status = 'required'
    AND execution_status IN ('awaiting_approval','blocked');

  INSERT INTO governance_decisions (
    tenant_id, claim_id, entity_type, entity_id, action_type,
    decision, risk_level, jurisdiction, actor_role,
    evaluated_at, knowledge_reference_date, loss_date,
    policy_period_start, policy_period_end,
    applicable_rules, applicable_standards, required_approvals, knowledge_gaps,
    citations, evidence_references, decision_rationale,
    governance_engine, knowledge_corpus_version,
    orchestration_id, action_id, dedup_key,
    execution_status, approval_status
  ) VALUES (
    v_tenant, p_claimId, p_entityType, p_entityId, p_actionType,
    p_decision, p_riskLevel, p_jurisdiction, p_actorRole,
    now(), p_knowledgeReferenceDate, p_lossDate,
    p_policyPeriodStart, p_policyPeriodEnd,
    COALESCE(p_applicableRules, '[]'), COALESCE(p_applicableStandards, '[]'),
    COALESCE(p_requiredApprovals, '{}'), COALESCE(p_knowledgeGaps, '[]'),
    COALESCE(p_citations, '{}'), COALESCE(p_evidenceReferences, '[]'),
    COALESCE(p_decisionRationale, ''),
    p_governanceEngine, p_knowledgeCorpusVersion,
    p_orchestrationId, p_actionId, v_dedup,
    v_execution, v_approval
  )
  RETURNING id INTO v_id;

  -- Audit event
  INSERT INTO governance_events (tenant_id, decision_id, event_type, payload, actor)
  VALUES (v_tenant, v_id, v_event, jsonb_build_object(
    'action_type', p_actionType,
    'decision', p_decision,
    'risk_level', p_riskLevel,
    'jurisdiction', p_jurisdiction,
    'dedup_key', v_dedup,
    'rationale', p_decisionRationale
  ), p_actorRole);

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================================================
-- 7. RPC: get / list / latest / actionable
-- ==========================================================================
CREATE OR REPLACE FUNCTION governance_get_decision(
  p_decisionId UUID,
  p_tenantId UUID DEFAULT NULL
)
RETURNS SETOF governance_decisions AS $$
  SELECT gd.* FROM governance_decisions gd
  WHERE gd.id = p_decisionId
    AND gd.tenant_id = governance_resolve_tenant(p_tenantId);
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION governance_list_decisions(
  p_tenantId UUID DEFAULT NULL,
  p_claimId TEXT DEFAULT NULL,
  p_actionType TEXT DEFAULT NULL,
  p_entityType TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS SETOF governance_decisions AS $$
  SELECT gd.* FROM governance_decisions gd
  WHERE gd.tenant_id = governance_resolve_tenant(p_tenantId)
    AND (p_claimId IS NULL OR gd.claim_id = p_claimId)
    AND (p_actionType IS NULL OR gd.action_type = p_actionType)
    AND (p_entityType IS NULL OR gd.entity_type = p_entityType)
  ORDER BY gd.evaluated_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION governance_latest_decision(
  p_tenantId UUID DEFAULT NULL,
  p_claimId TEXT DEFAULT NULL,
  p_actionType TEXT DEFAULT NULL
)
RETURNS SETOF governance_decisions AS $$
  SELECT gd.* FROM governance_decisions gd
  WHERE gd.tenant_id = governance_resolve_tenant(p_tenantId)
    AND (p_claimId IS NULL OR gd.claim_id = p_claimId)
    AND (p_actionType IS NULL OR gd.action_type = p_actionType)
  ORDER BY gd.evaluated_at DESC
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Actionable work: decisions that still need a human (approval, escalation,
-- or knowledge-gap resolution). Feeds the governance-aware work queue.
CREATE OR REPLACE FUNCTION governance_list_actionable(
  p_tenantId UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50
)
RETURNS SETOF governance_decisions AS $$
  SELECT gd.* FROM governance_decisions gd
  WHERE gd.tenant_id = governance_resolve_tenant(p_tenantId)
    AND gd.approval_status = 'required'
    AND gd.execution_status IN ('awaiting_approval','blocked')
  ORDER BY gd.evaluated_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION governance_list_events(
  p_decisionId UUID,
  p_tenantId UUID DEFAULT NULL
)
RETURNS SETOF governance_events AS $$
  SELECT ge.* FROM governance_events ge
  JOIN governance_decisions gd ON gd.id = ge.decision_id
  WHERE ge.decision_id = p_decisionId
    AND gd.tenant_id = governance_resolve_tenant(p_tenantId)
  ORDER BY ge.created_at ASC;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ==========================================================================
-- 8. RPC: human decision — approve / reject / escalate (+ override)
-- ==========================================================================
-- BLOCK and UNKNOWN can never be plain-approved: they require an override
-- decision from a super_admin or atlas_admin, and the override is recorded
-- alongside the original decision (history is never mutated).
CREATE OR REPLACE FUNCTION governance_decide(
  p_decisionId UUID,
  p_decision TEXT,            -- 'approved' | 'rejected' | 'escalated'
  p_notes TEXT DEFAULT NULL,
  p_overrideDecision TEXT DEFAULT NULL,
  p_tenantId UUID DEFAULT NULL
)
RETURNS governance_decisions AS $$
DECLARE
  v_tenant UUID;
  v_row governance_decisions;
  v_role TEXT;
  v_event TEXT;
BEGIN
  v_tenant := governance_resolve_tenant(p_tenantId);

  SELECT * INTO v_row FROM governance_decisions WHERE id = p_decisionId;
  IF NOT FOUND OR v_row.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'decision not found';
  END IF;

  IF v_row.approval_status <> 'required'
     OR v_row.execution_status NOT IN ('awaiting_approval','blocked') THEN
    RAISE EXCEPTION 'decision is not actionable';
  END IF;

  IF p_decision = 'approved' AND v_row.decision IN ('BLOCK','UNKNOWN') THEN
    -- Override path: requires an authorized role and an explicit override.
    IF p_overrideDecision IS NULL THEN
      RAISE EXCEPTION 'override_decision is required to unblock a BLOCK/UNKNOWN decision';
    END IF;

    SELECT m.role INTO v_role FROM memberships m
    WHERE m."userId" = auth.uid() AND m."tenantId" = v_tenant
      AND m.role IN ('super_admin','atlas_admin')
    LIMIT 1;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'only super_admin or atlas_admin may override a BLOCK/UNKNOWN decision';
    END IF;

    UPDATE governance_decisions
    SET override_decision = p_overrideDecision,
        override_reason = p_notes,
        override_by = auth.uid(),
        overridden_at = now(),
        approved_by = auth.uid(),
        approved_at = now(),
        approved_notes = p_notes,
        approval_status = 'approved',
        execution_status = 'approved',
        updated_at = now()
    WHERE id = p_decisionId
    RETURNING * INTO v_row;

    v_event := 'governance.overridden';

  ELSIF p_decision = 'approved' THEN
    UPDATE governance_decisions
    SET approval_status = 'approved', execution_status = 'approved',
        approved_by = auth.uid(), approved_at = now(),
        approved_notes = p_notes, updated_at = now()
    WHERE id = p_decisionId
    RETURNING * INTO v_row;
    v_event := 'governance.approved';

  ELSIF p_decision = 'rejected' THEN
    UPDATE governance_decisions
    SET approval_status = 'rejected', execution_status = 'rejected',
        approved_by = auth.uid(), approved_at = now(),
        approved_notes = p_notes, updated_at = now()
    WHERE id = p_decisionId
    RETURNING * INTO v_row;
    v_event := 'governance.rejected';

  ELSIF p_decision = 'escalated' THEN
    UPDATE governance_decisions
    SET execution_status = 'escalated',
        approved_by = auth.uid(), approved_at = now(),
        approved_notes = p_notes, updated_at = now()
    WHERE id = p_decisionId
    RETURNING * INTO v_row;
    v_event := 'governance.escalated';

  ELSE
    RAISE EXCEPTION 'invalid decision';
  END IF;

  INSERT INTO governance_events (tenant_id, decision_id, event_type, payload, actor)
  VALUES (v_tenant, p_decisionId, v_event, jsonb_build_object(
    'decision', p_decision,
    'override_decision', p_overrideDecision,
    'notes', p_notes
  ), COALESCE(v_role, 'tenant_member'));

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================================================
-- 9. Trigger: auto-update updated_at
-- ==========================================================================
CREATE OR REPLACE FUNCTION governance_decisions_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_governance_decisions_updated_at ON governance_decisions;
CREATE TRIGGER trg_governance_decisions_updated_at
  BEFORE UPDATE ON governance_decisions
  FOR EACH ROW
  EXECUTE FUNCTION governance_decisions_set_updated_at();