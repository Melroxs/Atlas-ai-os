-- ---------------------------------------------------------------------------
-- Atlas Pilot Intelligence — CRM + Product Learning System
--
-- Internal tables for managing pilot companies, sessions, insights,
-- outcomes, and analytics. All tables are tenant-scoped via RLS.
-- ---------------------------------------------------------------------------

-- 01. Pilot Companies
CREATE TABLE IF NOT EXISTS pilot_companies (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  name         text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  website      text,
  company_type text,
  company_size text,
  claims_volume text,
  status       text DEFAULT 'prospect',
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_companies_tenant ON pilot_companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pilot_companies_status ON pilot_companies(tenant_id, status);

-- 02. Pilot Applications
CREATE TABLE IF NOT EXISTS pilot_applications (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  name              text NOT NULL,
  email             text NOT NULL,
  phone             text,
  company_name      text,
  website           text,
  role              text,
  contractor_type   text,
  company_size      text,
  claims_volume     text,
  current_workflow  text,
  atlas_interest    jsonb DEFAULT '[]'::jsonb,
  biggest_problem   text,
  why_pilot         text,
  status            text DEFAULT 'new',
  created_at        timestamptz DEFAULT now(),
  reviewed_at       timestamptz,
  reviewed_by       uuid
);

CREATE INDEX IF NOT EXISTS idx_pilot_applications_status ON pilot_applications(status);

-- 03. Pilot Sessions
CREATE TABLE IF NOT EXISTS pilot_sessions (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  company_id   uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  session_type text NOT NULL,
  title        text,
  summary      text,
  notes        text,
  attendee     text,
  scheduled_at timestamptz,
  duration_min integer,
  outcome      text,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_sessions_tenant ON pilot_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pilot_sessions_company ON pilot_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_pilot_sessions_type ON pilot_sessions(tenant_id, session_type);

-- 04. Pilot Insights
CREATE TABLE IF NOT EXISTS pilot_insights (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  company_id   uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  session_id   uuid REFERENCES pilot_sessions(id) ON DELETE SET NULL,
  insight_type text NOT NULL,
  title        text NOT NULL,
  description  text,
  priority     text DEFAULT 'medium',
  status       text DEFAULT 'open',
  source       text,
  tags         jsonb DEFAULT '[]'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_insights_tenant ON pilot_insights(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pilot_insights_type ON pilot_insights(tenant_id, insight_type);
CREATE INDEX IF NOT EXISTS idx_pilot_insights_status ON pilot_insights(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pilot_insights_company ON pilot_insights(company_id);

-- 05. Pilot Outcomes
CREATE TABLE IF NOT EXISTS pilot_outcomes (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  company_id     uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  outcome_type   text NOT NULL,
  title          text NOT NULL,
  description    text,
  financial_impact numeric,
  claim_id       uuid,
  recommendation_id uuid,
  evidence_count integer DEFAULT 0,
  status         text DEFAULT 'confirmed',
  tags           jsonb DEFAULT '[]'::jsonb,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_outcomes_tenant ON pilot_outcomes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pilot_outcomes_type ON pilot_outcomes(tenant_id, outcome_type);
CREATE INDEX IF NOT EXISTS idx_pilot_outcomes_company ON pilot_outcomes(company_id);

-- 06. Pilot Testimonials
CREATE TABLE IF NOT EXISTS pilot_testimonials (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  company_id   uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  quote        text NOT NULL,
  author_name  text,
  author_role  text,
  is_public    boolean DEFAULT false,
  tags         jsonb DEFAULT '[]'::jsonb,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_testimonials_tenant ON pilot_testimonials(tenant_id);

-- 07. Pilot Activity Log
CREATE TABLE IF NOT EXISTS pilot_activity (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(_id) ON DELETE CASCADE,
  company_id   uuid REFERENCES pilot_companies(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  title        text NOT NULL,
  description  text,
  metadata     jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pilot_activity_tenant ON pilot_activity(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pilot_activity_company ON pilot_activity(company_id);

-- ---------------------------------------------------------------------------
-- RPC Functions
-- ---------------------------------------------------------------------------

-- List pilot companies for current tenant
CREATE OR REPLACE FUNCTION pilot_companies_list()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT jsonb_agg(row_to_json(pc) ORDER BY pc.created_at DESC)
  INTO v_result
  FROM pilot_companies pc
  WHERE pc.tenant_id = v_tenant_id;
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Create a pilot company (required params first, optional last)
CREATE OR REPLACE FUNCTION pilot_companies_create(
  p_name text,
  p_contact_name text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_website text DEFAULT NULL,
  p_company_type text DEFAULT NULL,
  p_company_size text DEFAULT NULL,
  p_claims_volume text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No workspace found';
  END IF;
  INSERT INTO pilot_companies (tenant_id, name, contact_name, contact_email, contact_phone, website, company_type, company_size, claims_volume, notes)
  VALUES (v_tenant_id, p_name, p_contact_name, p_contact_email, p_contact_phone, p_website, p_company_type, p_company_size, p_claims_volume, p_notes)
  RETURNING row_to_json(pilot_companies.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Update a pilot company
CREATE OR REPLACE FUNCTION pilot_companies_update(
  p_id uuid,
  p_name text DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_website text DEFAULT NULL,
  p_company_type text DEFAULT NULL,
  p_company_size text DEFAULT NULL,
  p_claims_volume text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No workspace found';
  END IF;
  UPDATE pilot_companies SET
    name = COALESCE(p_name, name),
    contact_name = COALESCE(p_contact_name, contact_name),
    contact_email = COALESCE(p_contact_email, contact_email),
    contact_phone = COALESCE(p_contact_phone, contact_phone),
    website = COALESCE(p_website, website),
    company_type = COALESCE(p_company_type, company_type),
    company_size = COALESCE(p_company_size, company_size),
    claims_volume = COALESCE(p_claims_volume, claims_volume),
    status = COALESCE(p_status, status),
    notes = COALESCE(p_notes, notes),
    updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id
  RETURNING row_to_json(pilot_companies.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Delete a pilot company
CREATE OR REPLACE FUNCTION pilot_companies_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN false; END IF;
  DELETE FROM pilot_companies WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- List pilot sessions
CREATE OR REPLACE FUNCTION pilot_sessions_list(p_company_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT jsonb_agg(row_to_json(ps) ORDER BY ps.created_at DESC)
  INTO v_result
  FROM pilot_sessions ps
  WHERE ps.tenant_id = v_tenant_id
    AND (p_company_id IS NULL OR ps.company_id = p_company_id);
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Create a pilot session (required params first, optional last)
CREATE OR REPLACE FUNCTION pilot_sessions_create(
  p_session_type text,
  p_company_id uuid DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_summary text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_attendee text DEFAULT NULL,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_duration_min integer DEFAULT NULL,
  p_outcome text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No workspace found'; END IF;
  INSERT INTO pilot_sessions (tenant_id, company_id, session_type, title, summary, notes, attendee, scheduled_at, duration_min, outcome)
  VALUES (v_tenant_id, p_company_id, p_session_type, p_title, p_summary, p_notes, p_attendee, p_scheduled_at, p_duration_min, p_outcome)
  RETURNING row_to_json(pilot_sessions.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Delete a pilot session
CREATE OR REPLACE FUNCTION pilot_sessions_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN false; END IF;
  DELETE FROM pilot_sessions WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- List pilot insights
CREATE OR REPLACE FUNCTION pilot_insights_list(
  p_insight_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_company_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT jsonb_agg(row_to_json(pi) ORDER BY pi.created_at DESC)
  INTO v_result
  FROM pilot_insights pi
  WHERE pi.tenant_id = v_tenant_id
    AND (p_insight_type IS NULL OR pi.insight_type = p_insight_type)
    AND (p_status IS NULL OR pi.status = p_status)
    AND (p_company_id IS NULL OR pi.company_id = p_company_id);
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Create a pilot insight (required params first, optional last)
CREATE OR REPLACE FUNCTION pilot_insights_create(
  p_insight_type text,
  p_title text,
  p_company_id uuid DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_priority text DEFAULT 'medium',
  p_source text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No workspace found'; END IF;
  INSERT INTO pilot_insights (tenant_id, company_id, session_id, insight_type, title, description, priority, source)
  VALUES (v_tenant_id, p_company_id, p_session_id, p_insight_type, p_title, p_description, p_priority, p_source)
  RETURNING row_to_json(pilot_insights.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Update insight status
CREATE OR REPLACE FUNCTION pilot_insights_update_status(p_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No workspace found'; END IF;
  UPDATE pilot_insights SET status = p_status, updated_at = now()
  WHERE id = p_id AND tenant_id = v_tenant_id
  RETURNING row_to_json(pilot_insights.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Delete a pilot insight
CREATE OR REPLACE FUNCTION pilot_insights_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN false; END IF;
  DELETE FROM pilot_insights WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- List pilot outcomes
CREATE OR REPLACE FUNCTION pilot_outcomes_list(
  p_company_id uuid DEFAULT NULL,
  p_outcome_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT jsonb_agg(row_to_json(po) ORDER BY po.created_at DESC)
  INTO v_result
  FROM pilot_outcomes po
  WHERE po.tenant_id = v_tenant_id
    AND (p_company_id IS NULL OR po.company_id = p_company_id)
    AND (p_outcome_type IS NULL OR po.outcome_type = p_outcome_type);
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Create a pilot outcome (required params first, optional last)
CREATE OR REPLACE FUNCTION pilot_outcomes_create(
  p_outcome_type text,
  p_title text,
  p_company_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_financial_impact numeric DEFAULT NULL,
  p_claim_id uuid DEFAULT NULL,
  p_recommendation_id uuid DEFAULT NULL,
  p_evidence_count integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No workspace found'; END IF;
  INSERT INTO pilot_outcomes (tenant_id, company_id, outcome_type, title, description, financial_impact, claim_id, recommendation_id, evidence_count)
  VALUES (v_tenant_id, p_company_id, p_outcome_type, p_title, p_description, p_financial_impact, p_claim_id, p_recommendation_id, p_evidence_count)
  RETURNING row_to_json(pilot_outcomes.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Delete a pilot outcome
CREATE OR REPLACE FUNCTION pilot_outcomes_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN false; END IF;
  DELETE FROM pilot_outcomes WHERE id = p_id AND tenant_id = v_tenant_id;
  RETURN FOUND;
END;
$$;

-- List pilot testimonials
CREATE OR REPLACE FUNCTION pilot_testimonials_list()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT jsonb_agg(row_to_json(pt) ORDER BY pt.created_at DESC)
  INTO v_result
  FROM pilot_testimonials pt
  WHERE pt.tenant_id = v_tenant_id;
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Create a pilot testimonial (required params first, optional last)
CREATE OR REPLACE FUNCTION pilot_testimonials_create(
  p_quote text,
  p_company_id uuid DEFAULT NULL,
  p_author_name text DEFAULT NULL,
  p_author_role text DEFAULT NULL,
  p_is_public boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'No workspace found'; END IF;
  INSERT INTO pilot_testimonials (tenant_id, company_id, quote, author_name, author_role, is_public)
  VALUES (v_tenant_id, p_company_id, p_quote, p_author_name, p_author_role, p_is_public)
  RETURNING row_to_json(pilot_testimonials.*) INTO v_result;
  RETURN v_result;
END;
$$;

-- Pilot analytics overview (aggregated stats)
CREATE OR REPLACE FUNCTION pilot_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb;
BEGIN
  v_tenant_id := (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1);
  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object(
      'totalCompanies', 0, 'activeCompanies', 0, 'totalSessions', 0,
      'totalInsights', 0, 'openInsights', 0, 'totalOutcomes', 0,
      'totalRevenueRecovery', 0, 'totalTestimonials', 0,
      'insightsByType', '[]'::jsonb, 'insightsByPriority', '[]'::jsonb,
      'companiesByStatus', '[]'::jsonb, 'recentActivity', '[]'::jsonb
    );
  END IF;
  SELECT jsonb_build_object(
    'totalCompanies', (SELECT count(*) FROM pilot_companies WHERE tenant_id = v_tenant_id),
    'activeCompanies', (SELECT count(*) FROM pilot_companies WHERE tenant_id = v_tenant_id AND status = 'active'),
    'totalSessions', (SELECT count(*) FROM pilot_sessions WHERE tenant_id = v_tenant_id),
    'totalInsights', (SELECT count(*) FROM pilot_insights WHERE tenant_id = v_tenant_id),
    'openInsights', (SELECT count(*) FROM pilot_insights WHERE tenant_id = v_tenant_id AND status = 'open'),
    'totalOutcomes', (SELECT count(*) FROM pilot_outcomes WHERE tenant_id = v_tenant_id),
    'totalRevenueRecovery', COALESCE((SELECT sum(financial_impact) FROM pilot_outcomes WHERE tenant_id = v_tenant_id AND financial_impact IS NOT NULL), 0),
    'totalTestimonials', (SELECT count(*) FROM pilot_testimonials WHERE tenant_id = v_tenant_id),
    'insightsByType', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('type', insight_type, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT insight_type, count(*) as cnt FROM pilot_insights WHERE tenant_id = v_tenant_id GROUP BY insight_type) sub
    ),
    'insightsByPriority', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('priority', priority, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT priority, count(*) as cnt FROM pilot_insights WHERE tenant_id = v_tenant_id GROUP BY priority) sub
    ),
    'companiesByStatus', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT status, count(*) as cnt FROM pilot_companies WHERE tenant_id = v_tenant_id GROUP BY status) sub
    ),
    'recentActivity', (
      SELECT coalesce(jsonb_agg(row_to_json(pa) ORDER BY pa.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM pilot_activity WHERE tenant_id = v_tenant_id ORDER BY created_at DESC LIMIT 20) pa
    )
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------

ALTER TABLE pilot_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pilot_companies_tenant_isolation" ON pilot_companies;
CREATE POLICY "pilot_companies_tenant_isolation" ON pilot_companies
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "pilot_applications_authenticated" ON pilot_applications;
CREATE POLICY "pilot_applications_authenticated" ON pilot_applications
  FOR ALL USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "pilot_sessions_tenant_isolation" ON pilot_sessions;
CREATE POLICY "pilot_sessions_tenant_isolation" ON pilot_sessions
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "pilot_insights_tenant_isolation" ON pilot_insights;
CREATE POLICY "pilot_insights_tenant_isolation" ON pilot_insights
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "pilot_outcomes_tenant_isolation" ON pilot_outcomes;
CREATE POLICY "pilot_outcomes_tenant_isolation" ON pilot_outcomes
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "pilot_testimonials_tenant_isolation" ON pilot_testimonials;
CREATE POLICY "pilot_testimonials_tenant_isolation" ON pilot_testimonials
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));

DROP POLICY IF EXISTS "pilot_activity_tenant_isolation" ON pilot_activity;
CREATE POLICY "pilot_activity_tenant_isolation" ON pilot_activity
  USING (tenant_id = (SELECT "tenantId" FROM memberships WHERE "userId" = auth.uid() LIMIT 1));
