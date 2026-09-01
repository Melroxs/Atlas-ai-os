-- ---------------------------------------------------------------------------
-- Atlas Durable Job System — Database Migration
--
-- Creates the core tables for background job processing:
--   atlas_jobs         — durable jobs with status, payload, retry state
--   atlas_job_steps    — individual workflow steps within a job
--   atlas_job_attempts — execution attempt audit trail
--   atlas_job_events   — immutable event log for full observability
--
-- All tables enforce tenant isolation via RLS.
-- Jobs use SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent claiming.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. atlas_jobs — the central job table
-- ===========================================================================
CREATE TABLE IF NOT EXISTS atlas_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  job_type        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending','queued','processing','completed',
                    'failed','retrying','cancelled','awaiting_review'
                  )),
  priority        int NOT NULL DEFAULT 3
                  CHECK (priority BETWEEN 1 AND 5),

  idempotency_key text NOT NULL,

  payload         jsonb NOT NULL DEFAULT '{}',
  result          jsonb,
  error           jsonb,

  attempt_count   int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,

  scheduled_at    timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,

  locked_by       text,
  locked_at       timestamptz,
  lock_expires_at timestamptz,

  parent_job_id   uuid REFERENCES atlas_jobs(id) ON DELETE SET NULL,
  current_step_id uuid,

  tags            text[] NOT NULL DEFAULT '{}',

  ai_metadata     jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one active job per idempotency key per tenant.
-- Completed/failed/cancelled jobs with the same key are allowed (allows retry).
CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_jobs_idempotency_active
  ON atlas_jobs (tenant_id, idempotency_key)
  WHERE status NOT IN ('completed', 'cancelled');

-- Worker claiming: fast lookup for pending/queued jobs eligible for dequeue.
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_dequeue
  ON atlas_jobs (priority, scheduled_at, created_at)
  WHERE status IN ('pending', 'queued')
;

-- Status monitoring: for the observability dashboard.
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_status
  ON atlas_jobs (tenant_id, status, created_at DESC);

-- Job type filtering.
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_type
  ON atlas_jobs (tenant_id, job_type, status, created_at DESC);

-- Parent job lookups.
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_parent
  ON atlas_jobs (parent_job_id)
  WHERE parent_job_id IS NOT NULL;

-- Lock expiry detection (stuck-job sweep).
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_lock_expiry
  ON atlas_jobs (lock_expires_at)
  WHERE locked_by IS NOT NULL
    AND status = 'processing';

-- Scheduled jobs (cron-like).
CREATE INDEX IF NOT EXISTS idx_atlas_jobs_scheduled
  ON atlas_jobs (scheduled_at)
  WHERE status = 'pending'
    AND scheduled_at IS NOT NULL;

-- ===========================================================================
-- 2. atlas_job_steps — individual workflow steps
-- ===========================================================================
CREATE TABLE IF NOT EXISTS atlas_job_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES atlas_jobs(id) ON DELETE CASCADE,

  step_type       text NOT NULL,
  sequence        int NOT NULL DEFAULT 0,

  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending','processing','completed','failed','skipped','cancelled'
                  )),

  input           jsonb NOT NULL DEFAULT '{}',
  output          jsonb,
  error           jsonb,

  attempt_count   int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,

  started_at      timestamptz,
  completed_at    timestamptz,

  ai_metadata     jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Fast step lookup by job.
CREATE INDEX IF NOT EXISTS idx_atlas_job_steps_job
  ON atlas_job_steps (job_id, sequence);

-- Find next pending step.
CREATE INDEX IF NOT EXISTS idx_atlas_job_steps_next
  ON atlas_job_steps (job_id, sequence)
  WHERE status = 'pending';

-- ===========================================================================
-- 3. atlas_job_attempts — execution audit trail
-- ===========================================================================
CREATE TABLE IF NOT EXISTS atlas_job_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES atlas_jobs(id) ON DELETE CASCADE,
  step_id           uuid REFERENCES atlas_job_steps(id) ON DELETE CASCADE,

  attempt_number    int NOT NULL,
  worker_id         text NOT NULL,

  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','timeout')),

  duration_ms       bigint,
  error             jsonb,

  execution_metadata jsonb NOT NULL DEFAULT '{}',

  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

-- Attempt lookup by job/step.
CREATE INDEX IF NOT EXISTS idx_atlas_job_attempts_job
  ON atlas_job_attempts (job_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_atlas_job_attempts_step
  ON atlas_job_attempts (step_id)
  WHERE step_id IS NOT NULL;

-- ===========================================================================
-- 4. atlas_job_events — immutable execution/audit trail
-- ===========================================================================
CREATE TABLE IF NOT EXISTS atlas_job_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES atlas_jobs(id) ON DELETE CASCADE,
  step_id     uuid,

  event_type  text NOT NULL
              CHECK (event_type IN (
                'job_created','job_queued','job_started','job_completed',
                'job_failed','job_retrying','job_cancelled','job_awaiting_review',
                'step_started','step_completed','step_failed','step_skipped',
                'human_review_requested','human_approval','human_rejection'
              )),

  payload     jsonb NOT NULL DEFAULT '{}',
  actor       text NOT NULL DEFAULT 'system',

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Event stream by job (chronological).
CREATE INDEX IF NOT EXISTS idx_atlas_job_events_job
  ON atlas_job_events (job_id, created_at DESC);

-- Event type filtering for observability.
CREATE INDEX IF NOT EXISTS idx_atlas_job_events_type
  ON atlas_job_events (event_type, created_at DESC);

-- ===========================================================================
-- 5. auto-update updated_at triggers
-- ===========================================================================
CREATE OR REPLACE FUNCTION atlas_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_atlas_jobs_updated_at
  BEFORE UPDATE ON atlas_jobs
  FOR EACH ROW EXECUTE FUNCTION atlas_set_updated_at();

CREATE TRIGGER trg_atlas_job_steps_updated_at
  BEFORE UPDATE ON atlas_job_steps
  FOR EACH ROW EXECUTE FUNCTION atlas_set_updated_at();

-- ===========================================================================
-- 6. Row-Level Security policies
-- ===========================================================================
ALTER TABLE atlas_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE atlas_job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE atlas_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE atlas_job_events ENABLE ROW LEVEL SECURITY;

-- Service role (Edge Functions) can do everything.
CREATE POLICY atlas_jobs_service_all ON atlas_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY atlas_job_steps_service_all ON atlas_job_steps
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY atlas_job_attempts_service_all ON atlas_job_attempts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY atlas_job_events_service_all ON atlas_job_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can see jobs for their tenant.
-- The tenant_id is set by the RPC functions (not user-supplied).
CREATE POLICY atlas_jobs_tenant_read ON atlas_jobs
  FOR SELECT
  TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    OR (auth.jwt() ->> 'user_role') = 'super_admin'
  );

CREATE POLICY atlas_job_steps_tenant_read ON atlas_job_steps
  FOR SELECT
  TO authenticated
  USING (
    job_id IN (
      SELECT id FROM atlas_jobs
      WHERE tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
         OR (auth.jwt() ->> 'user_role') = 'super_admin'
    )
  );

CREATE POLICY atlas_job_attempts_tenant_read ON atlas_job_attempts
  FOR SELECT
  TO authenticated
  USING (
    job_id IN (
      SELECT id FROM atlas_jobs
      WHERE tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
         OR (auth.jwt() ->> 'user_role') = 'super_admin'
    )
  );

CREATE POLICY atlas_job_events_tenant_read ON atlas_job_events
  FOR SELECT
  TO authenticated
  USING (
    job_id IN (
      SELECT id FROM atlas_jobs
      WHERE tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
         OR (auth.jwt() ->> 'user_role') = 'super_admin'
    )
  );

-- ===========================================================================
-- 7. RPC Functions — Job lifecycle management
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- jobs_create_job — Enqueue a new job (idempotent on idempotency_key)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_create_job(
  p_tenant_id    uuid,
  p_job_type     text,
  p_idempotency_key text,
  p_user_id      uuid DEFAULT NULL,
  p_priority     int DEFAULT 3,
  p_payload      jsonb DEFAULT '{}',
  p_max_attempts int DEFAULT 3,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_parent_job_id uuid DEFAULT NULL,
  p_tags         text[] DEFAULT '{}'
)
RETURNS jsonb AS $$
DECLARE
  v_job_id uuid;
  v_deduplicated boolean := false;
  v_existing jsonb;
BEGIN
  -- Idempotency check: return existing active job if one exists.
  SELECT id INTO v_job_id
  FROM atlas_jobs
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key
    AND status NOT IN ('completed', 'cancelled')
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    v_deduplicated := true;
    SELECT jsonb_build_object(
      'job_id', j.id,
      'deduplicated', true
    ) INTO v_existing
    FROM atlas_jobs j WHERE j.id = v_job_id;
    RETURN v_existing;
  END IF;

  -- Insert the new job.
  INSERT INTO atlas_jobs (
    tenant_id, user_id, job_type, status, priority,
    idempotency_key, payload, max_attempts,
    scheduled_at, parent_job_id, tags
  ) VALUES (
    p_tenant_id, p_user_id, p_job_type, 'pending', p_priority,
    p_idempotency_key, p_payload, p_max_attempts,
    p_scheduled_at, p_parent_job_id, p_tags
  )
  RETURNING id INTO v_job_id;

  -- Emit creation event.
  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  VALUES (v_job_id, 'job_created', jsonb_build_object(
    'job_type', p_job_type,
    'priority', p_priority,
    'idempotency_key', p_idempotency_key
  ), COALESCE(p_user_id::text, 'system'));

  -- Move to queued status.
  UPDATE atlas_jobs SET status = 'queued' WHERE id = v_job_id;

  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  VALUES (v_job_id, 'job_queued', jsonb_build_object('job_type', p_job_type), 'system');

  RETURN jsonb_build_object('job_id', v_job_id, 'deduplicated', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_create_step — Add a step to an existing job
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_create_step(
  p_job_id       uuid,
  p_step_type    text,
  p_sequence     int,
  p_input        jsonb DEFAULT '{}',
  p_max_attempts int DEFAULT 3
)
RETURNS jsonb AS $$
DECLARE
  v_step_id uuid;
BEGIN
  INSERT INTO atlas_job_steps (job_id, step_type, sequence, input, max_attempts)
  VALUES (p_job_id, p_step_type, p_sequence, p_input, p_max_attempts)
  RETURNING id INTO v_step_id;

  RETURN jsonb_build_object('step_id', v_step_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_dequeue — Claim the next available job for a worker (SKIP LOCKED)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_dequeue(
  p_worker_id    text,
  p_job_types    text[] DEFAULT NULL,
  p_max_jobs     int DEFAULT 1
)
RETURNS jsonb AS $$
DECLARE
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
  v_lock_timeout interval := interval '5 minutes';
BEGIN
  FOR v_row IN
    SELECT j.id
    FROM atlas_jobs j
    WHERE j.status IN ('pending', 'queued')
      AND (j.scheduled_at IS NULL OR j.scheduled_at <= now())
      AND (p_job_types IS NULL OR j.job_type = ANY(p_job_types))
    ORDER BY j.priority ASC, j.scheduled_at ASC NULLS FIRST, j.created_at ASC
    LIMIT p_max_jobs
    FOR UPDATE OF j SKIP LOCKED
  LOOP
    -- Lock and start processing.
    UPDATE atlas_jobs
    SET status = 'processing',
        locked_by = p_worker_id,
        locked_at = now(),
        lock_expires_at = now() + v_lock_timeout,
        started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END,
        attempt_count = attempt_count + 1
    WHERE id = v_row.id
    RETURNING id INTO v_row.id;

    -- Emit started event.
    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (v_row.id, 'job_started', jsonb_build_object('worker_id', p_worker_id), p_worker_id);

    -- Emit attempt record.
    INSERT INTO atlas_job_attempts (job_id, worker_id, attempt_number, status)
    SELECT v_row.id, p_worker_id, j.attempt_count, 'running'
    FROM atlas_jobs j WHERE j.id = v_row.id;

    v_jobs := v_jobs || to_jsonb(v_row.id);
  END LOOP;

  RETURN jsonb_build_object('jobs', v_jobs, 'count', jsonb_array_length(v_jobs));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_complete_job — Mark a job as completed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_complete_job(
  p_job_id   uuid,
  p_result   jsonb DEFAULT '{}',
  p_ai_metadata jsonb DEFAULT NULL
)
RETURNS jsonb AS $$
BEGIN
  UPDATE atlas_jobs
  SET status = 'completed',
      result = p_result,
      ai_metadata = COALESCE(p_ai_metadata, ai_metadata),
      completed_at = now(),
      locked_by = NULL,
      locked_at = NULL,
      lock_expires_at = NULL
  WHERE id = p_job_id;

  -- Close the current attempt.
  UPDATE atlas_job_attempts
  SET status = 'completed',
      completed_at = now(),
      duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
  WHERE job_id = p_job_id
    AND status = 'running';

  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  VALUES (p_job_id, 'job_completed', jsonb_build_object('result_size', pg_column_size(p_result)), 'system');

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_fail_job — Mark a job as failed (or retrying if attempts remain)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_fail_job(
  p_job_id   uuid,
  p_error    jsonb,
  p_retryable boolean DEFAULT true
)
RETURNS jsonb AS $$
DECLARE
  v_job record;
  v_next_scheduled timestamptz;
BEGIN
  SELECT * INTO v_job FROM atlas_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;

  -- Close the current attempt.
  UPDATE atlas_job_attempts
  SET status = 'failed',
      completed_at = now(),
      error = p_error,
      duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
  WHERE job_id = p_job_id
    AND status = 'running';

  -- Decide: retry or fail permanently.
  IF p_retryable
     AND v_job.attempt_count < v_job.max_attempts
  THEN
    -- Exponential backoff: base 15s * 2^(attempt-1), capped at 1 hour.
    v_next_scheduled := now() + LEAST(
      interval '15 seconds' * power(2, v_job.attempt_count - 1),
      interval '1 hour'
    );

    UPDATE atlas_jobs
    SET status = 'retrying',
        error = p_error,
        scheduled_at = v_next_scheduled,
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL
    WHERE id = p_job_id;

    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (p_job_id, 'job_retrying', jsonb_build_object(
      'attempt', v_job.attempt_count,
      'max_attempts', v_job.max_attempts,
      'next_scheduled_at', v_next_scheduled,
      'error', p_error
    ), 'system');

    RETURN jsonb_build_object('ok', true, 'retrying', true, 'next_scheduled_at', v_next_scheduled);
  ELSE
    -- Permanent failure.
    UPDATE atlas_jobs
    SET status = 'failed',
        error = p_error,
        completed_at = now(),
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL
    WHERE id = p_job_id;

    INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
    VALUES (p_job_id, 'job_failed', jsonb_build_object(
      'attempt', v_job.attempt_count,
      'error', p_error
    ), 'system');

    RETURN jsonb_build_object('ok', true, 'retrying', false);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_complete_step — Mark a step as completed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_complete_step(
  p_step_id  uuid,
  p_output   jsonb DEFAULT '{}',
  p_ai_metadata jsonb DEFAULT NULL
)
RETURNS jsonb AS $$
BEGIN
  UPDATE atlas_job_steps
  SET status = 'completed',
      output = p_output,
      ai_metadata = COALESCE(p_ai_metadata, ai_metadata),
      completed_at = now()
  WHERE id = p_step_id;

  INSERT INTO atlas_job_events (job_id, step_id, event_type, payload, actor)
  SELECT job_id, p_step_id, 'step_completed', jsonb_build_object(
    'step_type', step_type,
    'sequence', sequence
  ), 'system'
  FROM atlas_job_steps WHERE id = p_step_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_fail_step — Mark a step as failed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_fail_step(
  p_step_id  uuid,
  p_error    jsonb
)
RETURNS jsonb AS $$
BEGIN
  UPDATE atlas_job_steps
  SET status = 'failed',
      error = p_error,
      completed_at = now()
  WHERE id = p_step_id;

  INSERT INTO atlas_job_events (job_id, step_id, event_type, payload, actor)
  SELECT job_id, p_step_id, 'step_failed', jsonb_build_object(
    'step_type', step_type,
    'sequence', sequence,
    'error', p_error
  ), 'system'
  FROM atlas_job_steps WHERE id = p_step_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_retry_step — Reset a step for retry (from failed state)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_retry_step(
  p_step_id uuid
)
RETURNS jsonb AS $$
BEGIN
  UPDATE atlas_job_steps
  SET status = 'pending',
      error = NULL,
      started_at = NULL,
      completed_at = NULL
  WHERE id = p_step_id
    AND status = 'failed';

  INSERT INTO atlas_job_events (job_id, step_id, event_type, payload, actor)
  SELECT job_id, p_step_id, 'step_started', jsonb_build_object(
    'step_type', step_type,
    'retry', true
  ), 'system'
  FROM atlas_job_steps WHERE id = p_step_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_cancel_job — Cancel a job and all its pending steps
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_cancel_job(
  p_job_id uuid
)
RETURNS jsonb AS $$
BEGIN
  UPDATE atlas_jobs
  SET status = 'cancelled',
      completed_at = now(),
      locked_by = NULL,
      locked_at = NULL,
      lock_expires_at = NULL
  WHERE id = p_job_id
    AND status NOT IN ('completed', 'cancelled');

  UPDATE atlas_job_steps
  SET status = 'cancelled'
  WHERE job_id = p_job_id
    AND status IN ('pending', 'processing');

  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  VALUES (p_job_id, 'job_cancelled', '{}', 'system');

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_get_job — Get a job with its steps
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_get_job(
  p_job_id uuid
)
RETURNS jsonb AS $$
DECLARE
  v_job jsonb;
  v_steps jsonb;
BEGIN
  SELECT to_jsonb(j.*) INTO v_job
  FROM atlas_jobs j WHERE j.id = p_job_id;

  IF v_job IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_agg(to_jsonb(s.*) ORDER BY s.sequence)
  INTO v_steps
  FROM atlas_job_steps s WHERE s.job_id = p_job_id;

  v_job := v_job || jsonb_build_object('steps', COALESCE(v_steps, '[]'::jsonb));

  RETURN v_job;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_list_jobs — List jobs with filtering
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_list_jobs(
  p_status     text DEFAULT NULL,
  p_job_type   text DEFAULT NULL,
  p_limit      int DEFAULT 50,
  p_offset     int DEFAULT 0
)
RETURNS jsonb AS $$
BEGIN
  RETURN (
    SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.created_at DESC)
    FROM (
      SELECT *
      FROM atlas_jobs
      WHERE (p_status IS NULL OR status = p_status)
        AND (p_job_type IS NULL OR job_type = p_job_type)
      ORDER BY created_at DESC
      LIMIT p_limit
      OFFSET p_offset
    ) t
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_get_events — Get the event trail for a job
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_get_events(
  p_job_id uuid,
  p_limit  int DEFAULT 100
)
RETURNS jsonb AS $$
BEGIN
  RETURN (
    SELECT jsonb_agg(to_jsonb(e.*) ORDER BY e.created_at ASC)
    FROM (
      SELECT *
      FROM atlas_job_events
      WHERE job_id = p_job_id
      ORDER BY created_at ASC
      LIMIT p_limit
    ) e
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_unlock_stuck — Reclaim jobs locked by dead workers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_unlock_stuck(
  p_stale_after interval DEFAULT interval '10 minutes'
)
RETURNS jsonb AS $$
DECLARE
  v_count int;
BEGIN
  WITH unlocked AS (
    UPDATE atlas_jobs
    SET status = 'retrying',
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        scheduled_at = now()
    WHERE status = 'processing'
      AND lock_expires_at < now()
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM unlocked;

  -- Emit events for unlocked jobs.
  INSERT INTO atlas_job_events (job_id, event_type, payload, actor)
  SELECT u.id, 'job_retrying', jsonb_build_object('reason', 'stuck_job_unlocked'), 'system'
  FROM (SELECT id FROM atlas_jobs WHERE locked_by IS NULL AND status = 'retrying' AND updated_at > now() - interval '1 minute') u;

  RETURN jsonb_build_object('unlocked', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- jobs_stats — Aggregate stats for the observability dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_stats()
RETURNS jsonb AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'total', count(*),
      'by_status', (
        SELECT jsonb_object_agg(status, cnt)
        FROM (
          SELECT status, count(*) as cnt
          FROM atlas_jobs
          GROUP BY status
        ) s
      ),
      'by_type', (
        SELECT jsonb_object_agg(job_type, cnt)
        FROM (
          SELECT job_type, count(*) as cnt
          FROM atlas_jobs
          GROUP BY job_type
        ) t
      ),
      'avg_duration_ms', (
        SELECT AVG(duration_ms)
        FROM atlas_job_attempts
        WHERE status = 'completed' AND completed_at > now() - interval '24 hours'
      ),
      'queue_depth', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status IN ('pending', 'queued')
      ),
      'processing_count', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status = 'processing'
      ),
      'failed_24h', (
        SELECT count(*)
        FROM atlas_jobs
        WHERE status = 'failed'
          AND updated_at > now() - interval '24 hours'
      )
    )
    FROM atlas_jobs
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
