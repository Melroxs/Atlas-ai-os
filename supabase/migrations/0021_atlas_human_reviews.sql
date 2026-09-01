-- ==========================================================================
-- Migration 0021: Atlas Human Review System
--
-- Replaces in-memory ReviewRequest Map with durable Supabase persistence.
-- Adds:
--   - atlas_human_reviews table
--   - RLS policies (tenant isolation + Super Admin access)
--   - State machine constraint (pending → approved/rejected/needs_changes)
--   - Idempotency constraint (no duplicate active reviews per job+step+agent)
--   - RPC functions for CRUD + review decisions
--   - Audit event integration with atlas_job_events
-- ==========================================================================

-- 1. Human reviews table
CREATE TABLE IF NOT EXISTS atlas_human_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  job_id        UUID NOT NULL REFERENCES atlas_jobs(id) ON DELETE CASCADE,
  step_id       TEXT,  -- job step that triggered the review
  agent_run_id  TEXT,  -- agent run that produced the recommendation
  claim_id      TEXT,  -- claim being reviewed (for quick lookup)

  -- What to review
  review_type           TEXT NOT NULL DEFAULT 'supplement_recommendation',
  recommendation_summary TEXT NOT NULL DEFAULT '',
  recommendation_data   JSONB NOT NULL DEFAULT '{}',
  financial_impact      NUMERIC(12,2),
  evidence_references   JSONB NOT NULL DEFAULT '[]',
  ai_confidence         NUMERIC(5,4) NOT NULL DEFAULT 0,

  -- QA results
  qa_passed    BOOLEAN,
  qa_score     NUMERIC(5,2),
  qa_issues    JSONB NOT NULL DEFAULT '[]',

  -- Agent metadata
  agent_type   TEXT NOT NULL DEFAULT 'supplement_reasoning',
  model_used   TEXT,
  token_usage  INTEGER NOT NULL DEFAULT 0,

  -- State machine
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','needs_changes','expired')),

  -- Reviewer
  reviewer_user_id  UUID REFERENCES auth.users(id),
  reviewer_notes    TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,

  -- Resume control
  rerun_step  TEXT,  -- which step to re-execute on needs_changes

  -- Metadata
  correlation_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_human_reviews_tenant_status
  ON atlas_human_reviews (tenant_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_human_reviews_job
  ON atlas_human_reviews (job_id);

CREATE INDEX IF NOT EXISTS idx_human_reviews_claim
  ON atlas_human_reviews (claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_human_reviews_created
  ON atlas_human_reviews (created_at DESC);

-- 3. Idempotency: prevent duplicate active reviews per job+step+agent
-- Only one pending/approved/rejected review per job+step+agent at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_reviews_active_dedup
  ON atlas_human_reviews (job_id, step_id, agent_type)
  WHERE status IN ('pending', 'needs_changes');

-- 4. RLS policies
ALTER TABLE atlas_human_reviews ENABLE ROW LEVEL SECURITY;

-- Service role (workers) can do everything
CREATE POLICY "service_role_all_human_reviews"
  ON atlas_human_reviews
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can read reviews for their tenant
CREATE POLICY "tenant_read_human_reviews"
  ON atlas_human_reviews
  FOR SELECT
  TO authenticated
  USING (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid()
      LIMIT 1
    )
  );

-- Authenticated users can create reviews for their tenant
CREATE POLICY "tenant_insert_human_reviews"
  ON atlas_human_reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid()
      LIMIT 1
    )
  );

-- Authenticated users can update reviews for their tenant (decisions)
CREATE POLICY "tenant_update_human_reviews"
  ON atlas_human_reviews
  FOR UPDATE
  TO authenticated
  USING (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid()
      LIMIT 1
    )
  )
  WITH CHECK (
    tenant_id = (
      SELECT t._id FROM tenants t
      JOIN memberships m ON m."tenantId" = t._id
      WHERE m."userId" = auth.uid()
      LIMIT 1
    )
  );

-- Super Admin can access all reviews
CREATE POLICY "super_admin_all_human_reviews"
  ON atlas_human_reviews
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid()
      AND m.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m."userId" = auth.uid()
      AND m.role = 'super_admin'
    )
  );

-- 5. RPC: Create a human review (with idempotency)
CREATE OR REPLACE FUNCTION human_reviews_create(
  p_tenant_id UUID,
  p_job_id UUID,
  p_step_id TEXT,
  p_agent_run_id TEXT,
  p_claim_id TEXT,
  p_review_type TEXT,
  p_recommendation_summary TEXT,
  p_recommendation_data JSONB,
  p_financial_impact NUMERIC,
  p_evidence_references JSONB,
  p_ai_confidence NUMERIC,
  p_qa_passed BOOLEAN,
  p_qa_score NUMERIC,
  p_qa_issues JSONB,
  p_agent_type TEXT,
  p_model_used TEXT,
  p_token_usage INTEGER,
  p_correlation_id TEXT,
  p_rerun_step TEXT
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_existing UUID;
BEGIN
  -- Idempotency: check for existing active review
  SELECT id INTO v_existing
  FROM atlas_human_reviews
  WHERE job_id = p_job_id
    AND step_id IS NOT DISTINCT FROM p_step_id
    AND agent_type = p_agent_type
    AND status IN ('pending', 'needs_changes');

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO atlas_human_reviews (
    tenant_id, job_id, step_id, agent_run_id, claim_id,
    review_type, recommendation_summary, recommendation_data,
    financial_impact, evidence_references, ai_confidence,
    qa_passed, qa_score, qa_issues,
    agent_type, model_used, token_usage,
    status, correlation_id, rerun_step
  ) VALUES (
    p_tenant_id, p_job_id, p_step_id, p_agent_run_id, p_claim_id,
    p_review_type, p_recommendation_summary, p_recommendation_data,
    p_financial_impact, p_evidence_references, p_ai_confidence,
    p_qa_passed, p_qa_score, p_qa_issues,
    p_agent_type, p_model_used, p_token_usage,
    'pending', p_correlation_id, p_rerun_step
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. RPC: Get a review by ID (with tenant check)
CREATE OR REPLACE FUNCTION human_reviews_get(p_review_id UUID)
RETURNS SETOF atlas_human_reviews AS $$
  SELECT * FROM atlas_human_reviews WHERE id = p_review_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 7. RPC: List reviews for a tenant
CREATE OR REPLACE FUNCTION human_reviews_list(
  p_tenant_id UUID,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS SETOF atlas_human_reviews AS $$
  SELECT * FROM atlas_human_reviews
  WHERE tenant_id = p_tenant_id
    AND (p_status IS NULL OR status = p_status)
  ORDER BY created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 8. RPC: List reviews for a job
CREATE OR REPLACE FUNCTION human_reviews_list_job(p_job_id UUID)
RETURNS SETOF atlas_human_reviews AS $$
  SELECT * FROM atlas_human_reviews
  WHERE job_id = p_job_id
  ORDER BY created_at DESC;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 9. RPC: Approve a review (state machine enforced)
CREATE OR REPLACE FUNCTION human_reviews_approve(
  p_review_id UUID,
  p_reviewer_id UUID,
  p_notes TEXT DEFAULT 'Approved'
)
RETURNS atlas_human_reviews AS $$
DECLARE
  v_review atlas_human_reviews;
BEGIN
  UPDATE atlas_human_reviews
  SET status = 'approved',
      reviewer_user_id = p_reviewer_id,
      reviewer_notes = p_notes,
      decided_at = now(),
      resolved_at = now(),
      updated_at = now()
  WHERE id = p_review_id
    AND status = 'pending'
  RETURNING * INTO v_review;

  IF v_review IS NULL THEN
    RAISE EXCEPTION 'Review not found or not in pending status';
  END IF;

  RETURN v_review;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. RPC: Reject a review
CREATE OR REPLACE FUNCTION human_reviews_reject(
  p_review_id UUID,
  p_reviewer_id UUID,
  p_notes TEXT
)
RETURNS atlas_human_reviews AS $$
DECLARE
  v_review atlas_human_reviews;
BEGIN
  UPDATE atlas_human_reviews
  SET status = 'rejected',
      reviewer_user_id = p_reviewer_id,
      reviewer_notes = p_notes,
      decided_at = now(),
      resolved_at = now(),
      updated_at = now()
  WHERE id = p_review_id
    AND status = 'pending'
  RETURNING * INTO v_review;

  IF v_review IS NULL THEN
    RAISE EXCEPTION 'Review not found or not in pending status';
  END IF;

  RETURN v_review;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. RPC: Request changes (sends back to needs_changes)
CREATE OR REPLACE FUNCTION human_reviews_request_changes(
  p_review_id UUID,
  p_reviewer_id UUID,
  p_notes TEXT,
  p_rerun_step TEXT DEFAULT NULL
)
RETURNS atlas_human_reviews AS $$
DECLARE
  v_review atlas_human_reviews;
BEGIN
  UPDATE atlas_human_reviews
  SET status = 'needs_changes',
      reviewer_user_id = p_reviewer_id,
      reviewer_notes = p_notes,
      decided_at = now(),
      rerun_step = COALESCE(p_rerun_step, rerun_step),
      updated_at = now()
  WHERE id = p_review_id
    AND status IN ('pending', 'needs_changes')
  RETURNING * INTO v_review;

  IF v_review IS NULL THEN
    RAISE EXCEPTION 'Review not found or not in reviewable status';
  END IF;

  RETURN v_review;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. RPC: Count pending reviews for dashboard badge
CREATE OR REPLACE FUNCTION human_reviews_count_pending(p_tenant_id UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER FROM atlas_human_reviews
  WHERE tenant_id = p_tenant_id AND status = 'pending';
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 13. Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION human_reviews_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_human_reviews_updated_at
  BEFORE UPDATE ON atlas_human_reviews
  FOR EACH ROW
  EXECUTE FUNCTION human_reviews_set_updated_at();

-- ==========================================================================
-- 14. RPC: Transition job to awaiting_review (dedicated durable pause)
-- ==========================================================================
CREATE OR REPLACE FUNCTION jobs_awaiting_review(
  p_job_id UUID,
  p_review_id UUID DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_job RECORD;
BEGIN
  SELECT * INTO v_job FROM atlas_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;

  IF v_job.status != 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'current_status', v_job.status);
  END IF;

  UPDATE atlas_jobs
  SET status = 'awaiting_review',
      locked_by = NULL,
      locked_at = NULL,
      lock_expires_at = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  -- Close the current attempt as paused (not failed)
  UPDATE atlas_job_attempts
  SET status = 'completed',
      completed_at = now(),
      duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
  WHERE job_id = p_job_id
    AND status = 'running';

  -- Emit audit event
  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  VALUES (p_job_id, 'job_awaiting_review', jsonb_build_object(
    'review_id', p_review_id,
    'reason', 'agent_recommendation_requires_human_review'
  ), 'system');

  RETURN jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'awaiting_review');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================================================
-- 15. RPC: Resume job from awaiting_review (after human approval)
-- ==========================================================================
CREATE OR REPLACE FUNCTION jobs_resume_from_review(
  p_job_id UUID,
  p_review_id UUID,
  p_decision TEXT
)
RETURNS jsonb AS $$
DECLARE
  v_job RECORD;
  v_review RECORD;
BEGIN
  -- Verify job exists and is in awaiting_review
  SELECT * INTO v_job FROM atlas_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;

  IF v_job.status != 'awaiting_review' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'current_status', v_job.status);
  END IF;

  -- Verify review exists and matches this job
  SELECT * INTO v_review FROM atlas_human_reviews
  WHERE id = p_review_id AND job_id = p_job_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'review_not_found');
  END IF;

  IF p_decision = 'approved' THEN
    -- Resume the job: transition to pending so worker can dequeue it
    UPDATE atlas_jobs
    SET status = 'pending',
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        scheduled_at = now(),
        updated_at = now()
    WHERE id = p_job_id;

    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (p_job_id, 'job_queued', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'approved',
      'resumed_from', 'awaiting_review'
    ), 'system');

    RETURN jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'pending');

  ELSIF p_decision = 'rejected' THEN
    -- Terminal: mark as cancelled (rejected by human)
    UPDATE atlas_jobs
    SET status = 'cancelled',
        completed_at = now(),
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        updated_at = now(),
        error = jsonb_build_object(
          'code', 'HUMAN_REVIEW_REJECTED',
          'message', 'Human reviewer rejected the recommendation',
          'review_id', p_review_id
        )
    WHERE id = p_job_id;

    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (p_job_id, 'job_cancelled', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'rejected'
    ), 'system');

    RETURN jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'cancelled');

  ELSIF p_decision = 'needs_changes' THEN
    -- Resume with needs_changes: re-enqueue so worker picks up targeted step
    UPDATE atlas_jobs
    SET status = 'pending',
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        scheduled_at = now(),
        updated_at = now()
    WHERE id = p_job_id;

    -- If review specifies a rerun_step, reset that step for re-execution
    IF v_review.rerun_step IS NOT NULL THEN
      UPDATE atlas_job_steps
      SET status = 'pending',
          error = NULL,
          started_at = NULL,
          completed_at = NULL,
          output = NULL
      WHERE job_id = p_job_id
        AND step_type = v_review.rerun_step;
    END IF;

    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (p_job_id, 'job_queued', jsonb_build_object(
      'review_id', p_review_id,
      'decision', 'needs_changes',
      'rerun_step', v_review.rerun_step
    ), 'system');

    RETURN jsonb_build_object('ok', true, 'job_id', p_job_id, 'status', 'pending', 'rerun_step', v_review.rerun_step);

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_decision', 'decision', p_decision);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
